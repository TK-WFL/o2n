import PQueue from 'p-queue';

export const NOTION_VERSION = '2026-03-11';
const API_BASE = 'https://api.notion.com/v1';

export interface RetryOptions {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY: RetryOptions = {
  maxRetries: 5,
  initialDelayMs: 1000,
  // 2026-09-09 以降 Notion の Retry-After は最大 60 秒。異常値が来ても上限としてこの値でクランプする
  maxDelayMs: 60_000,
};

/**
 * 環境変数 O2N_REQUESTS_PER_SECOND（1〜10 の整数）からレート制御設定を作る。
 * Notion の接続ごとの上限は Free/Plus 180 req/分（3 req/秒）、Business/Enterprise 600 req/分（10 req/秒）。
 * 既定の 2 req/秒はどのプランでも安全側。Business 以上では上げて移行時間を短縮できる。
 * 不正な値は無視して既定にフォールバックする。
 */
/**
 * 移行でノートを同時に処理する数（#144）。レート設定と同じ値にする（既定 2）。実際の API 頻度は
 * NotionClient のレート制御が上限になるので、これ以上増やしても速くはならない
 */
export function noteConcurrencyFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return rateLimitFromEnv(env)?.intervalCap ?? 2;
}

export function rateLimitFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<RateLimitOptions> | undefined {
  const raw = env.O2N_REQUESTS_PER_SECOND;
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 10) return undefined;
  return { concurrency: n, interval: 1000, intervalCap: n };
}

export class NotionApiError extends Error {
  constructor(
    public status: number,
    public code: string | undefined,
    message: string,
    public raw?: unknown,
  ) {
    super(message);
    this.name = 'NotionApiError';
  }
}

/**
 * Notion Free プラン（複数メンバー）のワークスペース生涯ブロック上限（1,000）に達した。
 * 2026-09-01 から REST API でも強制され、作成系リクエストは
 * `403 restricted_resource` + `additional_data.block_limit: "block_creation"` で拒否される。
 * リトライしても解消せず、ブロックを削除しても枠は戻らない。
 * https://developers.notion.com/reference/workspace-block-limits
 */
export class NotionBlockLimitError extends NotionApiError {
  constructor(raw?: unknown) {
    super(403, 'restricted_resource', BLOCK_LIMIT_MESSAGE, raw);
    this.name = 'NotionBlockLimitError';
  }
}

export const BLOCK_LIMIT_MESSAGE =
  'Notion Free プラン（複数メンバー）のブロック上限（1,000ブロック）に達したため移行を中断しました。' +
  'ワークスペースのプランをアップグレードするか、メンバーを1人にしてから `o2n resume` で続きから再開できます。' +
  '個人アクセストークン（PAT）はこの上限の対象外です。';

function isBlockLimitBody(body: unknown): boolean {
  const b = body as { code?: string; additional_data?: { block_limit?: unknown } } | undefined;
  return b?.code === 'restricted_resource' && typeof b.additional_data?.block_limit === 'string';
}

const BEFORE_SEND_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

function causeCode(err: unknown): string | undefined {
  const cause = (err as { cause?: { code?: unknown } } | undefined)?.cause;
  const code = cause?.code ?? (err as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** fetch が投げた例外を「送信前に失敗（再送しても安全）」「送信後かもしれない」「通信以外」に分類する */
export function classifyNetworkError(err: unknown): 'before-send' | 'ambiguous' | 'other' {
  const code = causeCode(err);
  if (code && BEFORE_SEND_CODES.has(code)) return 'before-send';
  const name = (err as { name?: unknown } | undefined)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'ambiguous';
  if (err instanceof TypeError || code) return 'ambiguous'; // undici の "fetch failed"（ECONNRESET, UND_ERR_SOCKET 等）
  return 'other';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

export interface RateLimitOptions {
  concurrency: number;
  interval: number;
  intervalCap: number;
}

const DEFAULT_RATE_LIMIT: RateLimitOptions = {
  // 3req/s制限に対しマージンを取り、実効2.5req/s以下にする
  concurrency: 2,
  interval: 1000,
  intervalCap: 2,
};

export interface NotionClientOptions {
  /** 1リクエストのタイムアウト（ミリ秒）。既定 60 秒、ファイル送信（multipart）は既定 5 分 */
  timeoutMs?: number;
  uploadTimeoutMs?: number;
  token: string;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  notionVersion?: string;
  retry?: Partial<RetryOptions>;
  /** テスト等でレート制御を無効化・調整したい場合に指定 */
  rateLimit?: Partial<RateLimitOptions>;
}

export interface JsonRequestInit {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  /** クエリパラメータ */
  query?: Record<string, string | undefined>;
}

export interface RawRequestInit {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body: FormData | string | Buffer;
  headers?: Record<string, string>;
}

/**
 * §4・§10準拠のNotion APIクライアント。
 * - 並列2・実効2.5req/s以下に制御
 * - 429: Retry-After優先、なければ指数バックオフ(初期1s・最大60s・ジッター)、最大5回
 * - 5xx: 同様にリトライ
 * - dry-run時は一切fetchを呼ばず、callCountのみ加算する（テストで検証可能）
 */
export class NotionClient {
  readonly dryRun: boolean;
  callCount = 0;

  private readonly queue: PQueue;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly notionVersion: string;
  private readonly retry: RetryOptions;
  private readonly timeoutMs: number;
  private readonly uploadTimeoutMs: number;

  constructor(opts: NotionClientOptions) {
    this.token = opts.token;
    this.dryRun = opts.dryRun ?? false;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.notionVersion = opts.notionVersion ?? NOTION_VERSION;
    this.retry = { ...DEFAULT_RETRY, ...opts.retry };
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.uploadTimeoutMs = opts.uploadTimeoutMs ?? 300_000;
    const rateLimit = { ...DEFAULT_RATE_LIMIT, ...opts.rateLimit };
    this.queue = new PQueue({
      concurrency: rateLimit.concurrency,
      interval: rateLimit.interval,
      intervalCap: rateLimit.intervalCap,
    });
  }

  async request<T = unknown>(init: JsonRequestInit): Promise<T> {
    if (this.dryRun) {
      this.callCount += 1;
      return {} as T;
    }
    const qs = init.query
      ? '?' + new URLSearchParams(Object.entries(init.query).filter(([, v]) => v !== undefined) as [string, string][]).toString()
      : '';
    return this.queue.add(() =>
      this.executeWithRetry<T>({
        method: init.method,
        url: `${API_BASE}${init.path}${qs}`,
        headers: { 'Content-Type': 'application/json' },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      }),
    ) as Promise<T>;
  }

  /** バイナリ送信（File Upload の send エンドポイント）用 */
  async requestRaw<T = unknown>(init: RawRequestInit): Promise<T> {
    if (this.dryRun) {
      this.callCount += 1;
      return {} as T;
    }
    return this.queue.add(() =>
      this.executeWithRetry<T>({
        method: init.method,
        url: `${API_BASE}${init.path}`,
        headers: init.headers ?? {},
        body: init.body,
      }),
    ) as Promise<T>;
  }

  private async executeWithRetry<T>(
    req: { method: string; url: string; headers: Record<string, string>; body?: FormData | string | Buffer },
    attempt = 0,
  ): Promise<T> {
    this.callCount += 1;
    let res: Response;
    try {
      res = await this.fetchImpl(req.url, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Notion-Version': this.notionVersion,
          ...req.headers,
        },
        body: req.body,
        signal: AbortSignal.timeout(req.body instanceof FormData ? this.uploadTimeoutMs : this.timeoutMs),
      });
    } catch (err) {
      // 通信エラー（#138）: 以前は再試行せずそのノートが即 failed になり、応答の無い接続では無期限に止まっていた。
      // 接続確立前の失敗（DNS・接続拒否等）はどのメソッドでも安全に再試行できる。送信後の切断・タイムアウトは
      // Notion 側で処理済みの可能性があり、POST /pages や追記を再送すると重複するため、冪等な GET/DELETE のみ再試行する
      const kind = classifyNetworkError(err);
      if (kind === 'other') throw err;
      const retryable = kind === 'before-send' || (kind === 'ambiguous' && (req.method === 'GET' || req.method === 'DELETE'));
      if (!retryable || attempt >= this.retry.maxRetries) {
        const detail = err instanceof Error ? `${err.name}: ${err.message}${causeCode(err) ? ` (${causeCode(err)})` : ''}` : String(err);
        const hint = kind === 'ambiguous' && !retryable ? '（送信後に切断されたため、重複を避けて再送していません。resume で再実行してください）' : '';
        throw new NotionApiError(0, 'network_error', `Notion API への通信に失敗しました: ${detail}${hint}`, undefined);
      }
      await sleep(Math.min(this.retry.maxDelayMs, this.retry.initialDelayMs * 2 ** attempt) + Math.random() * 250);
      return this.executeWithRetry<T>(req, attempt + 1);
    }

    // 409 conflict_error は Notion が「再試行してよい」と案内している一時的な競合
    if (res.status === 429 || res.status === 409 || res.status >= 500) {
      if (attempt >= this.retry.maxRetries) {
        const body = await safeJson(res);
        const b = body as { code?: string; additional_data?: { rate_limit_reason?: string } } | undefined;
        // 429 本文の rate_limit_reason（接続ごと / ワークスペース共有 のどちらの上限か）を残す
        const reason = b?.additional_data?.rate_limit_reason ? ` (rate_limit_reason: ${b.additional_data.rate_limit_reason})` : '';
        throw new NotionApiError(res.status, b?.code, `retry exhausted: ${res.status}${reason}`, body);
      }
      const retryAfterHeader = res.headers.get('Retry-After');
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
      const delay = Number.isFinite(retryAfterMs) && retryAfterMs >= 0
        ? Math.min(this.retry.maxDelayMs, retryAfterMs)
        : Math.min(this.retry.maxDelayMs, this.retry.initialDelayMs * 2 ** attempt) + Math.random() * 250;
      await sleep(delay);
      return this.executeWithRetry<T>(req, attempt + 1);
    }

    if (!res.ok) {
      const body = await safeJson(res);
      if (res.status === 403 && isBlockLimitBody(body)) throw new NotionBlockLimitError(body);
      const b = body as { code?: string; message?: string };
      throw new NotionApiError(res.status, b?.code, `Notion API error ${res.status}: ${b?.message ?? res.statusText}`, body);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}

export interface CreatePageMarkdownParams {
  parent: { page_id: string } | { type: 'data_source_id'; data_source_id: string };
  markdown?: string;
  properties?: Record<string, unknown>;
  icon?: PageIcon;
  cover?: PageCover;
}

export type PageIcon =
  | { type: 'emoji'; emoji: string }
  | { type: 'external'; external: { url: string } }
  | { type: 'file_upload'; file_upload: { id: string } };
export type PageCover =
  | { type: 'external'; external: { url: string } }
  | { type: 'file_upload'; file_upload: { id: string } };

export interface UpdateContentItem {
  old_str: string;
  new_str: string;
  replace_all_matches?: boolean;
}

/**
 * §16-3検証済み（2026-07-19、実ワークスペース）: PATCH .../markdown のボディは
 * トップレベルに操作全体の `type` を持ち、対応するキー（update_content /
 * insert_content / replace_content）の中に詳細を入れるネスト構造。
 * 1回のPATCHで送れる操作は単一の種類のみ（配列で複数種類を混在できない）。
 */
export type MarkdownUpdateBody =
  | { type: 'update_content'; update_content: { content_updates: UpdateContentItem[] } }
  | { type: 'insert_content'; insert_content: { content: string; position?: { type: 'start' | 'end' }; after?: string } }
  | { type: 'replace_content'; replace_content: { new_str: string; allow_deleting_content?: boolean } };

/** §4.1のエンドポイントに対応する高レベルAPI */
export class NotionApi {
  constructor(private readonly client: NotionClient) {}

  get callCount(): number {
    return this.client.callCount;
  }

  async getMe(): Promise<{
    id?: string;
    bot?: {
      workspace_name?: string;
      workspace_limits?: { max_file_upload_size_in_bytes: number };
      owner?: { type?: string; workspace?: boolean; user?: { id?: string } };
    };
  }> {
    return this.client.request({ method: 'GET', path: '/users/me' });
  }

  async createPageMarkdown(params: CreatePageMarkdownParams): Promise<{ id: string; url: string }> {
    return this.client.request({ method: 'POST', path: '/pages', body: params });
  }

  /** ページのプロパティ（タイトル・DB行の値）を更新する。本文は updatePageMarkdown を使う */
  async updatePageProperties(
    pageId: string,
    properties: Record<string, unknown>,
    extra: { icon?: PageIcon; cover?: PageCover } = {},
  ): Promise<{ id: string; url: string }> {
    return this.client.request({ method: 'PATCH', path: `/pages/${pageId}`, body: { properties, ...extra } });
  }

  async getPage(pageId: string): Promise<{ id: string; in_trash?: boolean; url?: string }> {
    return this.client.request({ method: 'GET', path: `/pages/${pageId}` });
  }

  async getPageMarkdown(pageId: string): Promise<{ markdown: string; unknown_block_ids?: string[] }> {
    return this.client.request({ method: 'GET', path: `/pages/${pageId}/markdown` });
  }

  async updatePageMarkdown(
    pageId: string,
    body: MarkdownUpdateBody,
    allowAsync = false,
  ): Promise<{ task_id?: string; poll_after_seconds?: number }> {
    return this.client.request({
      method: 'PATCH',
      path: `/pages/${pageId}/markdown`,
      query: allowAsync ? { allow_async: 'true' } : undefined,
      body,
    });
  }

  async createDatabase(params: Record<string, unknown>): Promise<{ id: string }> {
    return this.client.request({ method: 'POST', path: '/databases', body: params });
  }

  async createFileUpload(params: {
    filename: string;
    content_type?: string;
    mode?: 'single_part' | 'multi_part';
    number_of_parts?: number;
  }): Promise<{ id: string; upload_url: string }> {
    return this.client.request({ method: 'POST', path: '/file_uploads', body: params });
  }

  async sendFileUpload(fileUploadId: string, formData: FormData): Promise<{ id: string; status: string }> {
    return this.client.requestRaw({
      method: 'POST',
      path: `/file_uploads/${fileUploadId}/send`,
      body: formData,
    });
  }

  /**
   * マルチパート（mode: 'multi_part'）は全パート送信後にこのAPIを呼ばないと
   * 完了しない（公式ガイド "Sending larger files"）。single_partでは不要。
   */
  async completeFileUpload(fileUploadId: string): Promise<{ id: string; status: string }> {
    return this.client.request({ method: 'POST', path: `/file_uploads/${fileUploadId}/complete` });
  }

  /**
   * §16検証済み（2026-07-19）: `after`パラメータは廃止済みで指定すると400になる。
   * 代わりに `position: { type: 'after_block', after_block: { id } }` を使う。
   */
  async appendBlockChildren(blockId: string, children: unknown[], afterBlockId?: string): Promise<{ results: Array<{ id: string }> }> {
    return this.client.request({
      method: 'PATCH',
      path: `/blocks/${blockId}/children`,
      body: {
        children,
        ...(afterBlockId ? { position: { type: 'after_block', after_block: { id: afterBlockId } } } : {}),
      },
    });
  }

  /** ブロックの本文（rich_text 等）を更新する。type ごとのキー（paragraph 等）は呼び出し側が組み立てる */
  async updateBlock(blockId: string, body: Record<string, unknown>): Promise<NotionBlock> {
    return this.client.request({ method: 'PATCH', path: `/blocks/${blockId}`, body });
  }

  async deleteBlock(blockId: string): Promise<void> {
    await this.client.request({ method: 'DELETE', path: `/blocks/${blockId}` });
  }

  async getBlockChildren(
    blockId: string,
    startCursor?: string,
  ): Promise<{ results: NotionBlock[]; has_more?: boolean; next_cursor?: string | null }> {
    return this.client.request({
      method: 'GET',
      path: `/blocks/${blockId}/children`,
      query: { page_size: '100', start_cursor: startCursor },
    });
  }

  /**
   * 子ブロックを全件取得する（1回のGETは最大100件。`has_more`/`next_cursor`で続きを辿る）。
   * 100ブロック超のノートで後半のプレースホルダーが見つからない不具合（#66）への対応。
   */
  async listAllBlockChildren(blockId: string): Promise<NotionBlock[]> {
    const all: NotionBlock[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.getBlockChildren(blockId, cursor);
      all.push(...page.results);
      if (!page.has_more || !page.next_cursor) break;
      cursor = page.next_cursor;
    }
    return all;
  }
}

export interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  [k: string]: unknown;
}
