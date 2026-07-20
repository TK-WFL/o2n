import { describe, expect, it, vi } from 'vitest';
import authProxy, { OAuthSessions } from '../src/index.js';
import {
  MAX_REQUEST_BODY_BYTES,
  REQUEST_BODY_TOO_LARGE,
  SESSION_TTL_MS,
  enforceRateLimit,
  isOAuthReady,
  readBoundedJson,
  sessionExpiresAt,
  type OAuthRuntimeBindings,
} from '../src/security.js';

function readyBindings(overrides: Partial<OAuthRuntimeBindings> = {}): OAuthRuntimeBindings {
  const limiter = { limit: vi.fn().mockResolvedValue({ success: true }) };
  return {
    OAUTH_ENABLED: '1',
    NOTION_CLIENT_ID: 'client-id',
    NOTION_CLIENT_SECRET: 'client-secret',
    OAUTH_SESSIONS: {},
    SESSION_RATE_LIMITER: limiter,
    CALLBACK_RATE_LIMITER: limiter,
    EXCHANGE_RATE_LIMITER: limiter,
    ...overrides,
  };
}

function createSessionHarness() {
  let storedSession: unknown;
  let transactionTail = Promise.resolve();
  const transactionApi = {
    get: vi.fn(async () => storedSession),
    put: vi.fn(async (_key: string, value: unknown) => {
      storedSession = value;
    }),
    delete: vi.fn(async () => {
      storedSession = undefined;
    }),
  };
  const storage = {
    ...transactionApi,
    setAlarm: vi.fn().mockResolvedValue(undefined),
    deleteAll: vi.fn(async () => {
      storedSession = undefined;
    }),
    deleteAlarm: vi.fn().mockResolvedValue(undefined),
    transaction: vi.fn(async (callback: (transaction: typeof transactionApi) => Promise<unknown>) => {
      const previous = transactionTail;
      let releaseTransaction!: () => void;
      transactionTail = new Promise<void>((resolve) => {
        releaseTransaction = resolve;
      });
      await previous;
      try {
        return await callback(transactionApi);
      } finally {
        releaseTransaction();
      }
    }),
  };
  const state = {
    storage,
    blockConcurrencyWhile: <T>(callback: () => Promise<T>) => callback(),
  };
  const sessions = new OAuthSessions(state as never);
  const namespace = {
    idFromName: vi.fn(() => 'session-id'),
    get: vi.fn(() => ({
      fetch: (input: string, init?: RequestInit) => sessions.fetch(new Request(input, init)),
    })),
  };
  return { namespace, sessions };
}

async function registerTestSession(sessions: OAuthSessions, state: string): Promise<void> {
  const response = await sessions.fetch(new Request('https://session/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      state,
      port: 30_000,
      secretHash: 'a'.repeat(64),
    }),
  }));
  expect(response.status).toBe(200);
}

describe('OAuth security helpers', () => {
  it('セッション期限を5分後に固定する', () => {
    expect(sessionExpiresAt(1_000)).toBe(1_000 + SESSION_TTL_MS);
  });

  it('登録時に5分後のalarmを設定し、alarm発火時に全storageを削除する', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const storage = {
      get: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
      setAlarm: vi.fn().mockResolvedValue(undefined),
      deleteAll: vi.fn().mockResolvedValue(undefined),
      deleteAlarm: vi.fn().mockResolvedValue(undefined),
    };
    const sessions = new OAuthSessions({ storage } as never);
    const request = new Request('https://session/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state: '12345678-1234-4123-8123-123456789abc',
        port: 30_000,
        secretHash: 'a'.repeat(64),
      }),
    });

    const response = await sessions.fetch(request);
    expect(response.status).toBe(200);
    expect(storage.setAlarm).toHaveBeenCalledWith(10_000 + SESSION_TTL_MS);

    await sessions.alarm();
    expect(storage.deleteAll).toHaveBeenCalledOnce();
    expect(storage.deleteAlarm).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it.each([
    ['disabled', { OAUTH_ENABLED: '0' }],
    ['missing session limiter', { SESSION_RATE_LIMITER: undefined }],
    ['missing callback limiter', { CALLBACK_RATE_LIMITER: undefined }],
    ['missing exchange limiter', { EXCHANGE_RATE_LIMITER: undefined }],
    ['missing client secret', { NOTION_CLIENT_SECRET: undefined }],
  ])('設定不備をfail closedにする: %s', (_label, override) => {
    expect(isOAuthReady(readyBindings(override))).toBe(false);
  });

  it('rate limiterの拒否と障害をfail closedにする', async () => {
    const denied = { limit: vi.fn().mockResolvedValue({ success: false }) };
    const failed = { limit: vi.fn().mockRejectedValue(new Error('unavailable')) };

    await expect(enforceRateLimit(denied, 'key')).resolves.toBe('limited');
    await expect(enforceRateLimit(failed, 'key')).resolves.toBe('unavailable');
    await expect(enforceRateLimit(undefined, 'key')).resolves.toBe('unavailable');
  });

  it('並行callbackのうち最初の1件だけがNotion token exchangeへ進む', async () => {
    const state = '12345678-1234-4123-8123-123456789abc';
    const { namespace, sessions } = createSessionHarness();
    await registerTestSession(sessions, state);

    const notionFetch = vi.fn().mockResolvedValue(Response.json({
      access_token: 'notion-token',
      workspace_name: 'Workspace',
    }));
    vi.stubGlobal('fetch', notionFetch);

    try {
      const env = readyBindings({ OAUTH_SESSIONS: namespace });
      const callbackUrl = `https://auth.example.test/callback?state=${state}&code=one-time-code`;
      const responses = await Promise.all([
        authProxy.fetch(new Request(callbackUrl, { headers: { 'CF-Connecting-IP': '203.0.113.10' } }), env as never),
        authProxy.fetch(new Request(callbackUrl, { headers: { 'CF-Connecting-IP': '203.0.113.10' } }), env as never),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([302, 409]);
      expect(notionFetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('token exchange失敗後は同じsessionを再試行できない', async () => {
    const state = '12345678-1234-4123-8123-123456789abc';
    const { namespace, sessions } = createSessionHarness();
    await registerTestSession(sessions, state);
    const notionFetch = vi.fn().mockResolvedValue(new Response('rejected', { status: 400 }));
    vi.stubGlobal('fetch', notionFetch);

    try {
      const env = readyBindings({ OAUTH_SESSIONS: namespace });
      const callback = () => authProxy.fetch(
        new Request(`https://auth.example.test/callback?state=${state}&code=one-time-code`, {
          headers: { 'CF-Connecting-IP': '203.0.113.10' },
        }),
        env as never,
      );

      expect((await callback()).status).toBe(302);
      expect((await callback()).status).toBe(400);
      expect(notionFetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('cancel callbackもbeginを消費してsessionを削除する', async () => {
    const state = '12345678-1234-4123-8123-123456789abc';
    const { namespace, sessions } = createSessionHarness();
    await registerTestSession(sessions, state);
    const env = readyBindings({ OAUTH_SESSIONS: namespace });

    const cancelled = await authProxy.fetch(
      new Request(`https://auth.example.test/callback?state=${state}&error=access_denied`, {
        headers: { 'CF-Connecting-IP': '203.0.113.10' },
      }),
      env as never,
    );
    const retried = await authProxy.fetch(
      new Request(`https://auth.example.test/callback?state=${state}&code=one-time-code`, {
        headers: { 'CF-Connecting-IP': '203.0.113.10' },
      }),
      env as never,
    );

    expect(cancelled.status).toBe(302);
    expect(retried.status).toBe(400);
  });

  it('callback limiterの欠落と拒否をfail closedにする', async () => {
    const callbackUrl = 'https://auth.example.test/callback?state=12345678-1234-4123-8123-123456789abc&code=code';
    const missingResponse = await authProxy.fetch(
      new Request(callbackUrl, { headers: { 'CF-Connecting-IP': '203.0.113.10' } }),
      readyBindings({ CALLBACK_RATE_LIMITER: undefined }) as never,
    );
    expect(missingResponse.status).toBe(503);

    const denied = { limit: vi.fn().mockResolvedValue({ success: false }) };
    const deniedResponse = await authProxy.fetch(
      new Request(callbackUrl, { headers: { 'CF-Connecting-IP': '203.0.113.10' } }),
      readyBindings({ CALLBACK_RATE_LIMITER: denied }) as never,
    );
    expect(deniedResponse.status).toBe(429);
    expect(denied).toHaveProperty('limit');
    expect(denied.limit).toHaveBeenCalledOnce();
  });

  it('JSON以外、bodyなし、上限超過bodyを拒否する', async () => {
    const wrongType = new Request('https://example.test/session', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    const empty = new Request('https://example.test/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const oversized = new Request('https://example.test/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(MAX_REQUEST_BODY_BYTES) }),
    });

    await expect(readBoundedJson(wrongType)).resolves.toBeNull();
    await expect(readBoundedJson(empty)).resolves.toBeNull();
    await expect(readBoundedJson(oversized)).resolves.toBe(REQUEST_BODY_TOO_LARGE);
  });

  it('Content-Lengthなしの大容量streamを上限到達時にcancelする', async () => {
    let producedChunks = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        producedChunks += 1;
        controller.enqueue(new Uint8Array(512));
        if (producedChunks === 10) controller.close();
      },
      cancel,
    });
    const request = new Request('https://example.test/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit);

    await expect(readBoundedJson(request)).resolves.toBe(REQUEST_BODY_TOO_LARGE);
    expect(cancel).toHaveBeenCalledOnce();
    expect(producedChunks).toBeLessThan(10);
  });

  it('上限超過Content-Lengthはbodyを読む前に拒否する', async () => {
    const request = new Request('https://example.test/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(MAX_REQUEST_BODY_BYTES + 1),
      },
      body: '{}',
    });

    await expect(readBoundedJson(request)).resolves.toBe(REQUEST_BODY_TOO_LARGE);
    expect(request.bodyUsed).toBe(false);
  });

  it('上限内で断片化されたJSON streamを受け付ける', async () => {
    const encoded = new TextEncoder().encode(JSON.stringify({ value: 'ok' }));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 2));
        controller.enqueue(encoded.slice(2, 7));
        controller.enqueue(encoded.slice(7));
        controller.close();
      },
    });
    const request = new Request('https://example.test/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit);

    await expect(readBoundedJson(request)).resolves.toEqual({ value: 'ok' });
  });

  it('偽の小さいContent-Lengthでも実bodyの累計上限で拒否する', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_REQUEST_BODY_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const request = new Request('https://example.test/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '1',
      },
      body,
      duplex: 'half',
    } as RequestInit);

    await expect(readBoundedJson(request)).resolves.toBe(REQUEST_BODY_TOO_LARGE);
  });

  it('公開endpointは上限超過を固定413エラーで返す', async () => {
    const request = new Request('https://example.test/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(MAX_REQUEST_BODY_BYTES) }),
    });

    const response = await authProxy.fetch(request, readyBindings() as never);
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: 'request_too_large',
      message: 'The request could not be processed.',
    });
  });
});
