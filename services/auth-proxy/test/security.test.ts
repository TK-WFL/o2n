import { describe, expect, it, vi } from 'vitest';
import { OAuthSessions } from '../src/index.js';
import {
  MAX_REQUEST_BODY_BYTES,
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

  it('JSON以外と上限超過bodyを拒否する', async () => {
    const wrongType = new Request('https://example.test/session', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    const oversized = new Request('https://example.test/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(MAX_REQUEST_BODY_BYTES) }),
    });

    await expect(readBoundedJson(wrongType)).resolves.toBeNull();
    await expect(readBoundedJson(oversized)).resolves.toBeNull();
  });
});
