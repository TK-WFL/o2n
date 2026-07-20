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
    EXCHANGE_RATE_LIMITER: limiter,
    ...overrides,
  };
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
