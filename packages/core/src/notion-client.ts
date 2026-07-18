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
  maxDelayMs: 60_000,
};

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

  constructor(opts: NotionClientOptions) {
    this.token = opts.token;
    this.dryRun = opts.dryRun ?? false;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.notionVersion = opts.notionVersion ?? NOTION_VERSION;
    this.retry = { ...DEFAULT_RETRY, ...opts.retry };
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
    const res = await this.fetchImpl(req.url, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Notion-Version': this.notionVersion,
        ...req.headers,
      },
      body: req.body,
    });

    if (res.status === 429 || res.status >= 500) {
      if (attempt >= this.retry.maxRetries) {
        const body = await safeJson(res);
        throw new NotionApiError(res.status, (body as { code?: string })?.code, `retry exhausted: ${res.status}`, body);
      }
      const retryAfterHeader = res.headers.get('Retry-After');
      const delay = retryAfterHeader
        ? Number(retryAfterHeader) * 1000
        : Math.min(this.retry.maxDelayMs, this.retry.initialDelayMs * 2 ** attempt) + Math.random() * 250;
      await sleep(delay);
      return this.executeWithRetry<T>(req, attempt + 1);
    }

    if (!res.ok) {
      const body = await safeJson(res);
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
}

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

  async getMe(): Promise<{ bot?: { workspace_limits?: { max_file_upload_size_in_bytes: number } } }> {
    return this.client.request({ method: 'GET', path: '/users/me' });
  }

  async createPageMarkdown(params: CreatePageMarkdownParams): Promise<{ id: string; url: string }> {
    return this.client.request({ method: 'POST', path: '/pages', body: params });
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

  async deleteBlock(blockId: string): Promise<void> {
    await this.client.request({ method: 'DELETE', path: `/blocks/${blockId}` });
  }

  async getBlockChildren(blockId: string): Promise<{ results: Array<{ id: string; type: string; [k: string]: unknown }> }> {
    return this.client.request({ method: 'GET', path: `/blocks/${blockId}/children` });
  }
}
