import { describe, expect, it } from 'vitest';
import { classifyNetworkError, NotionApiError, NotionClient } from '../notion-client.js';

const netErr = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });
const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

function client(steps: Array<() => Response | Promise<Response>>, extra: Record<string, unknown> = {}) {
  let i = 0;
  const calls: string[] = [];
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    calls.push(init?.method ?? 'GET');
    const step = steps[Math.min(i, steps.length - 1)]!;
    i += 1;
    return step();
  }) as typeof fetch;
  const c = new NotionClient({ token: 't', fetchImpl, retry: { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 2 }, rateLimit: { concurrency: 5, interval: 10, intervalCap: 5 }, ...extra });
  return { c, calls };
}

describe('通信エラーの再試行（#138）', () => {
  it('classifyNetworkError: 接続確立前 / 送信後かもしれない / それ以外', () => {
    expect(classifyNetworkError(netErr('ECONNREFUSED'))).toBe('before-send');
    expect(classifyNetworkError(netErr('EAI_AGAIN'))).toBe('before-send');
    expect(classifyNetworkError(netErr('ECONNRESET'))).toBe('ambiguous');
    expect(classifyNetworkError(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toBe('ambiguous');
    expect(classifyNetworkError(new RangeError('bug'))).toBe('other');
  });

  it('接続確立前の失敗は POST でも再試行して成功する', async () => {
    const { c, calls } = client([() => { throw netErr('ENOTFOUND'); }, ok]);
    await expect(c.request({ method: 'POST', path: '/pages', body: {} })).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it('送信後かもしれない切断は GET なら再試行、POST は重複を避けて再送せず network_error', async () => {
    const g = client([() => { throw netErr('ECONNRESET'); }, ok]);
    await expect(g.c.request({ method: 'GET', path: '/x' })).resolves.toEqual({ ok: true });
    const p = client([() => { throw netErr('ECONNRESET'); }, ok]);
    const err = await p.c.request({ method: 'POST', path: '/pages', body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotionApiError);
    expect((err as NotionApiError).code).toBe('network_error');
    expect((err as NotionApiError).message).toContain('重複を避けて');
    expect(p.calls).toHaveLength(1);
  });

  it('応答が来ないリクエストはタイムアウトし、GET は再試行上限で network_error', async () => {
    const hang = (_: string | URL, init?: RequestInit) =>
      new Promise<Response>((_r, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    let n = 0;
    const fetchImpl = ((u: string | URL, i?: RequestInit) => { n += 1; return hang(u, i); }) as typeof fetch;
    const c = new NotionClient({ token: 't', fetchImpl, timeoutMs: 20, retry: { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 2 }, rateLimit: { concurrency: 5, interval: 10, intervalCap: 5 } });
    const err = await c.request({ method: 'GET', path: '/x' }).catch((e: unknown) => e);
    expect((err as NotionApiError).code).toBe('network_error');
    expect(n).toBe(3);
  });

  it('409 conflict_error は再試行する', async () => {
    const { c, calls } = client([() => new Response(JSON.stringify({ code: 'conflict_error' }), { status: 409 }), ok]);
    await expect(c.request({ method: 'PATCH', path: '/pages/x', body: {} })).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it('通信以外の例外はそのまま投げる', async () => {
    const { c } = client([() => { throw new RangeError('bug'); }]);
    await expect(c.request({ method: 'GET', path: '/x' })).rejects.toBeInstanceOf(RangeError);
  });
});
