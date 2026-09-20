import { describe, expect, it } from 'vitest';
import { NotionApiError, NotionBlockLimitError, NotionClient } from '../notion-client.js';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** 指定した Response を順番に返す fetch。使い切ったら最後のものを繰り返す */
function fetchSequence(responses: Array<() => Response>) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const make = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    return make();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function client(fetchImpl: typeof fetch, retry = { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 5 }) {
  return new NotionClient({ token: 'tok', fetchImpl, retry, rateLimit: { concurrency: 5, interval: 10, intervalCap: 5 } });
}

describe('NotionClient: リクエスト構築', () => {
  it('Authorization / Notion-Version / Content-Type を付け、query を組み立てる', async () => {
    const { fetchImpl, calls } = fetchSequence([() => json({ ok: true })]);
    const res = await client(fetchImpl).request<{ ok: boolean }>({
      method: 'GET',
      path: '/blocks/x/children',
      query: { page_size: '100', start_cursor: undefined },
    });
    expect(res).toEqual({ ok: true });
    expect(calls[0]!.url).toBe('https://api.notion.com/v1/blocks/x/children?page_size=100');
    expect(calls[0]!.headers.Authorization).toBe('Bearer tok');
    expect(calls[0]!.headers['Notion-Version']).toBe('2026-03-11');
    expect(calls[0]!.headers['Content-Type']).toBe('application/json');
  });

  it('204 は undefined を返す', async () => {
    const { fetchImpl } = fetchSequence([() => new Response(null, { status: 204 })]);
    await expect(client(fetchImpl).request({ method: 'DELETE', path: '/blocks/x' })).resolves.toBeUndefined();
  });

  it('dryRun では fetch を呼ばず callCount だけ進む', async () => {
    const { fetchImpl, calls } = fetchSequence([() => json({})]);
    const c = new NotionClient({ token: 'tok', fetchImpl, dryRun: true });
    await c.request({ method: 'POST', path: '/pages', body: {} });
    expect(calls).toHaveLength(0);
    expect(c.callCount).toBe(1);
  });
});

describe('NotionClient: リトライ', () => {
  it('429 は Retry-After（秒）を待って再試行する', async () => {
    const { fetchImpl, calls } = fetchSequence([
      () => json({ code: 'rate_limited' }, 429, { 'Retry-After': '0' }),
      () => json({ done: true }),
    ]);
    await expect(client(fetchImpl).request({ method: 'GET', path: '/x' })).resolves.toEqual({ done: true });
    expect(calls).toHaveLength(2);
  });

  it('5xx は指数バックオフで再試行し、maxRetries を超えたら NotionApiError（retry exhausted）', async () => {
    const { fetchImpl, calls } = fetchSequence([() => json({ code: 'internal_server_error' }, 502)]);
    const err = await client(fetchImpl, { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 2 })
      .request({ method: 'GET', path: '/x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotionApiError);
    expect((err as NotionApiError).status).toBe(502);
    expect((err as NotionApiError).message).toContain('retry exhausted');
    expect(calls).toHaveLength(3); // 初回 + 2回のリトライ
  });

  it('4xx（429以外）は再試行せず即座に NotionApiError', async () => {
    const { fetchImpl, calls } = fetchSequence([() => json({ code: 'validation_error', message: 'bad' }, 400)]);
    const err = await client(fetchImpl).request({ method: 'POST', path: '/pages', body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotionApiError);
    expect((err as NotionApiError).code).toBe('validation_error');
    expect((err as NotionApiError).message).toContain('bad');
    expect(calls).toHaveLength(1);
  });
});

describe('NotionClient: Free プランのブロック上限（#70）', () => {
  it('403 restricted_resource + additional_data.block_limit は NotionBlockLimitError になり再試行しない', async () => {
    const body = {
      object: 'error',
      status: 403,
      code: 'restricted_resource',
      message: 'This workspace has used all of its free blocks.',
      additional_data: { block_limit: 'block_creation' },
    };
    const { fetchImpl, calls } = fetchSequence([() => json(body, 403)]);
    const err = await client(fetchImpl).request({ method: 'POST', path: '/pages', body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotionBlockLimitError);
    expect(err).toBeInstanceOf(NotionApiError);
    expect((err as NotionBlockLimitError).message).toContain('ブロック上限');
    expect((err as NotionBlockLimitError).message).toContain('resume');
    expect((err as NotionBlockLimitError).raw).toEqual(body);
    expect(calls).toHaveLength(1);
  });

  it('block_limit を伴わない 403 restricted_resource は通常の NotionApiError', async () => {
    const { fetchImpl } = fetchSequence([() => json({ code: 'restricted_resource', message: 'no access' }, 403)]);
    const err = await client(fetchImpl).request({ method: 'POST', path: '/pages', body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotionApiError);
    expect(err).not.toBeInstanceOf(NotionBlockLimitError);
  });
});
