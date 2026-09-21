import { scanVault } from '../../scanner.js';
import { buildPlan } from '../../planner.js';
import { NotionClient, NotionApi } from '../../notion-client.js';
import { StateStore } from '../../state.js';

export interface CallRecord {
  method: string;
  path: string;
  body?: unknown;
  /** multipart/form-data の場合のフィールド（file以外） */
  form?: Record<string, string>;
}

export function createMockServer() {
  const calls: CallRecord[] = [];
  let pageCounter = 0;
  const pageBlocks = new Map<string, MockBlock[]>();
  /** GET children を1ページあたり何件返すか（Notion実機は最大100。ページネーションのテスト用） */
  let childrenPageSize = 100;
  let failNextWith429 = false;
  /** N 回目以降のブロック作成系リクエスト（POST /pages, PATCH children）を Free プランのブロック上限 403 にする */
  let blockLimitAfterCreates: number | null = null;
  let createCount = 0;
  let failNextLinkPatchWith400 = false;
  let failMarkdownPatchType: string | null = null;
  let failNextFileSendWith400 = false;
  let alwaysFailFileSend = false;

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = (init?.method ?? 'GET') as string;
    const p = u.pathname.replace('/v1', '');
    const bodyText = init?.body;
    let body: unknown;
    let form: Record<string, string> | undefined;
    if (typeof bodyText === 'string') {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = undefined;
      }
    } else if (bodyText instanceof FormData) {
      form = {};
      for (const [k, v] of bodyText.entries()) {
        if (typeof v === 'string') form[k] = v;
      }
    }
    calls.push({ method, path: p, body, form });

    if (blockLimitAfterCreates !== null && ((method === 'POST' && p === '/pages') || (method === 'PATCH' && /\/blocks\/.+\/children$/.test(p)))) {
      createCount += 1;
      if (createCount > blockLimitAfterCreates) {
        return jsonResponse(
          {
            object: 'error',
            status: 403,
            code: 'restricted_resource',
            message: 'This workspace has used all of its free blocks. Upgrade its plan in Notion to create more content.',
            additional_data: { block_limit: 'block_creation' },
          },
          403,
        );
      }
    }

    if (failNextWith429) {
      failNextWith429 = false;
      return new Response(JSON.stringify({ code: 'rate_limited' }), {
        status: 429,
        headers: { 'Retry-After': '0' },
      });
    }

    if (
      failNextLinkPatchWith400 &&
      method === 'PATCH' &&
      /\/pages\/.+\/markdown$/.test(p) &&
      (body as { type?: string })?.type === 'update_content'
    ) {
      failNextLinkPatchWith400 = false;
      return new Response(JSON.stringify({ code: 'validation_error', message: 'boom' }), { status: 400 });
    }

    if (method === 'GET' && p === '/users/me') {
      return jsonResponse({ bot: { workspace_limits: { max_file_upload_size_in_bytes: 5 * 1024 * 1024 * 1024 } } });
    }

    if (method === 'POST' && p === '/pages') {
      pageCounter += 1;
      const id = `page-${pageCounter}`;
      const markdown = (body as { markdown?: string })?.markdown ?? '';
      const blocks = extractFileBlocks(markdown, id);
      pageBlocks.set(id, blocks);
      return jsonResponse({ id, url: `https://www.notion.so/${id}` });
    }

    if (method === 'PATCH' && /\/pages\/.+\/markdown$/.test(p)) {
      if (failMarkdownPatchType && (body as { type?: string })?.type === failMarkdownPatchType) {
        return new Response(JSON.stringify({ code: 'validation_error', message: 'would delete child pages' }), { status: 400 });
      }
      return jsonResponse({});
    }
    if (method === 'PATCH' && /^\/pages\/[^/]+$/.test(p)) {
      return jsonResponse({ id: p.split('/')[2], url: `https://www.notion.so/${p.split('/')[2]}` });
    }

    if (method === 'POST' && p === '/databases') {
      pageCounter += 1;
      const id = `db-${pageCounter}`;
      return jsonResponse({ id, data_sources: [{ id: `ds-${pageCounter}` }] });
    }

    if (method === 'GET' && /\/blocks\/.+\/children$/.test(p)) {
      const blockId = p.split('/')[2] ?? '';
      const all = pageBlocks.get(blockId) ?? [];
      const start = Number(u.searchParams.get('start_cursor') ?? '0');
      const slice = all.slice(start, start + childrenPageSize);
      const hasMore = start + childrenPageSize < all.length;
      return jsonResponse({
        results: slice.map(({ children: _children, ...rest }) => rest),
        has_more: hasMore,
        next_cursor: hasMore ? String(start + childrenPageSize) : null,
      });
    }

    if (method === 'PATCH' && /\/blocks\/.+\/children$/.test(p)) {
      return jsonResponse({ results: [{ id: 'appended-block' }] });
    }

    if (method === 'PATCH' && /^\/blocks\/[^/]+$/.test(p)) {
      const blockId = p.split('/')[2] ?? '';
      for (const blocks of pageBlocks.values()) {
        const b = blocks.find((x) => x.id === blockId);
        if (b) Object.assign(b, body as Record<string, unknown>);
      }
      return jsonResponse({ id: blockId });
    }

    if (method === 'DELETE' && /\/blocks\//.test(p)) {
      const blockId = p.split('/')[2] ?? '';
      for (const blocks of pageBlocks.values()) {
        const idx = blocks.findIndex((b) => b.id === blockId);
        if (idx !== -1) blocks.splice(idx, 1);
      }
      return new Response(null, { status: 204 });
    }

    if (method === 'POST' && p === '/file_uploads') {
      return jsonResponse({ id: 'file-upload-1', upload_url: 'https://upload.example/1' });
    }

    if (method === 'POST' && /\/file_uploads\/.+\/complete$/.test(p)) {
      return jsonResponse({ id: 'file-upload-1', status: 'uploaded' });
    }

    if (method === 'POST' && /\/file_uploads\/.+\/send$/.test(p)) {
      if (alwaysFailFileSend || failNextFileSendWith400) {
        failNextFileSendWith400 = false;
        return new Response(JSON.stringify({ code: 'validation_error', message: 'content type mismatch' }), { status: 400 });
      }
      return jsonResponse({ id: 'file-upload-1', status: 'uploaded' });
    }

    return jsonResponse({});
  }) as typeof fetch;

  return {
    fetchImpl,
    calls,
    triggerNext429: () => { failNextWith429 = true; },
    triggerNextLinkPatch400: () => { failNextLinkPatchWith400 = true; },
    setAlwaysFailFileSend: (v: boolean) => { alwaysFailFileSend = v; },
    setChildrenPageSize: (n: number) => { childrenPageSize = n; },
    /** 指定 type の PATCH .../markdown を常に 400 にする */
    failMarkdownPatchOfType: (t: string | null) => { failMarkdownPatchType = t; },
    /** 指定回数のブロック作成成功後に Free プランのブロック上限 403 を返し始める（null で解除） */
    setBlockLimitAfterCreates: (n: number | null) => { blockLimitAfterCreates = n; createCount = 0; },
    /** テストからページのブロック構造を直接差し替える（ネスト構造の再現用） */
    setPageBlocks: (pageId: string, blocks: MockBlock[]) => {
      pageBlocks.set(pageId, blocks);
      for (const b of blocks) if (b.children) pageBlocks.set(b.id, b.children);
    },
    getPageBlocks: (pageId: string) => pageBlocks.get(pageId) ?? [],
  };
}

export interface MockBlock {
  id: string;
  type: string;
  has_children?: boolean;
  children?: MockBlock[];
  [key: string]: unknown;
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * 実Notionワークスペースでの検証結果（2026-07-19）を反映: プレースホルダーが
 * 箇条書き行（"- ..."）にある場合、Notionはparagraphではなくbulleted_list_item
 * としてブロック化する。テストでもこれを再現し、型を限定した検索の回帰を防ぐ。
 */
export function extractFileBlocks(markdown: string, pageId: string) {
  const blocks: MockBlock[] = [];
  const re = /⟦o2n-file-\d+⟧/g;
  const lines = markdown.split('\n');
  let n = 0;
  for (const line of lines) {
    for (const m of line.matchAll(re)) {
      const isListItem = /^\s*-\s/.test(line);
      const type = isListItem ? 'bulleted_list_item' : 'paragraph';
      blocks.push({
        id: `${pageId}-block-${n}`,
        type,
        // 実機同様、プレースホルダーと同じ行の文章もブロック本文に含める
        [type]: { rich_text: [{ text: { content: line.replace(/^\s*-\s/, '').trim() } }] },
      });
      n += 1;
    }
  }
  return blocks;
}

export function withPageBlocksRewrite(
  mock: ReturnType<typeof createMockServer>,
  rewrite: (pageId: string, existing: MockBlock[]) => MockBlock[],
): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const res = await mock.fetchImpl(url, init);
    if ((init?.method ?? 'GET') === 'POST' && new URL(String(url)).pathname === '/v1/pages') {
      const { id } = (await res.clone().json()) as { id: string };
      const existing = mock.getPageBlocks(id);
      if (existing.length > 0) mock.setPageBlocks(id, rewrite(id, existing));
    }
    return res;
  }) as typeof fetch;
}


/** テスト用の inventory / plan / NotionApi / StateStore をまとめて作る */
export async function setupMigration(
  tmpDir: string,
  fetchImpl: typeof fetch,
  retry?: { maxRetries: number; initialDelayMs: number; maxDelayMs: number },
) {
  const inventory = await scanVault(tmpDir);
  const plan = buildPlan(inventory, { parentPageId: 'root-page' });
  const client = new NotionClient({ token: 'test', fetchImpl, retry, rateLimit: { concurrency: 5, interval: 10, intervalCap: 5 } });
  const api = new NotionApi(client);
  const state = await StateStore.load(tmpDir, 'root-page');
  return { inventory, plan, api, state };
}
