import { describe, expect, it } from 'vitest';
import { NotionApiError, NotionClient, rateLimitFromEnv } from '../notion-client.js';

function fetchSequence(responses: Array<() => Response>) {
  const times: number[] = [];
  const fetchImpl = (async () => {
    times.push(Date.now());
    const make = responses[Math.min(times.length - 1, responses.length - 1)]!;
    return make();
  }) as typeof fetch;
  return { fetchImpl, times };
}
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

describe('レート制限の新仕様への追随（#72）', () => {
  it('Retry-After は maxDelayMs でクランプされる（異常に大きい値で固まらない）', async () => {
    const { fetchImpl, times } = fetchSequence([
      () => json({ code: 'rate_limited' }, 429, { 'Retry-After': '99999' }),
      () => json({ ok: true }),
    ]);
    const c = new NotionClient({ token: 't', fetchImpl, retry: { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 20 }, rateLimit: { concurrency: 5, interval: 10, intervalCap: 5 } });
    await expect(c.request({ method: 'GET', path: '/x' })).resolves.toEqual({ ok: true });
    expect(times[1]! - times[0]!).toBeLessThan(1000);
  });

  it('Retry-After が数値でなければ指数バックオフにフォールバックする', async () => {
    const { fetchImpl, times } = fetchSequence([
      () => json({ code: 'rate_limited' }, 429, { 'Retry-After': 'soon' }),
      () => json({ ok: true }),
    ]);
    const c = new NotionClient({ token: 't', fetchImpl, retry: { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 5 }, rateLimit: { concurrency: 5, interval: 10, intervalCap: 5 } });
    await expect(c.request({ method: 'GET', path: '/x' })).resolves.toEqual({ ok: true });
    expect(times).toHaveLength(2);
  });

  it('リトライ枯渇時のメッセージに rate_limit_reason を含める', async () => {
    const { fetchImpl } = fetchSequence([
      () => json({ code: 'rate_limited', additional_data: { rate_limit_reason: 'workspace_rate_limit' } }, 429, { 'Retry-After': '0' }),
    ]);
    const c = new NotionClient({ token: 't', fetchImpl, retry: { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 5 }, rateLimit: { concurrency: 5, interval: 10, intervalCap: 5 } });
    const err = await c.request({ method: 'GET', path: '/x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotionApiError);
    expect((err as NotionApiError).message).toContain('rate_limit_reason: workspace_rate_limit');
  });

  it('O2N_REQUESTS_PER_SECOND は 1〜10 の整数のみ受け付け、それ以外は既定にフォールバック', () => {
    expect(rateLimitFromEnv({})).toBeUndefined();
    expect(rateLimitFromEnv({ O2N_REQUESTS_PER_SECOND: '' })).toBeUndefined();
    expect(rateLimitFromEnv({ O2N_REQUESTS_PER_SECOND: '8' })).toEqual({ concurrency: 8, interval: 1000, intervalCap: 8 });
    expect(rateLimitFromEnv({ O2N_REQUESTS_PER_SECOND: '10' })).toEqual({ concurrency: 10, interval: 1000, intervalCap: 10 });
    for (const bad of ['0', '11', '2.5', 'fast', '-1']) expect(rateLimitFromEnv({ O2N_REQUESTS_PER_SECOND: bad })).toBeUndefined();
  });
});
