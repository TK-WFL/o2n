export const SESSION_TTL_MS = 5 * 60 * 1000;
export const MAX_REQUEST_BODY_BYTES = 2_048;
export const REQUEST_BODY_TOO_LARGE = Symbol('request_body_too_large');

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface OAuthRuntimeBindings {
  OAUTH_ENABLED?: string;
  NOTION_CLIENT_ID?: string;
  NOTION_CLIENT_SECRET?: string;
  OAUTH_SESSIONS?: unknown;
  SESSION_RATE_LIMITER?: RateLimiter;
  CALLBACK_RATE_LIMITER?: RateLimiter;
  EXCHANGE_RATE_LIMITER?: RateLimiter;
}

export type RateLimitResult = 'allowed' | 'limited' | 'unavailable';

export function sessionExpiresAt(now = Date.now()): number {
  return now + SESSION_TTL_MS;
}

export function isOAuthReady(env: OAuthRuntimeBindings): boolean {
  return (
    env.OAUTH_ENABLED === '1' &&
    typeof env.NOTION_CLIENT_ID === 'string' &&
    env.NOTION_CLIENT_ID.length > 0 &&
    typeof env.NOTION_CLIENT_SECRET === 'string' &&
    env.NOTION_CLIENT_SECRET.length > 0 &&
    env.OAUTH_SESSIONS !== undefined &&
    env.SESSION_RATE_LIMITER !== undefined &&
    env.CALLBACK_RATE_LIMITER !== undefined &&
    env.EXCHANGE_RATE_LIMITER !== undefined
  );
}

export async function enforceRateLimit(
  limiter: RateLimiter | undefined,
  key: string,
): Promise<RateLimitResult> {
  if (!limiter) return 'unavailable';

  try {
    const result = await limiter.limit({ key });
    return result.success ? 'allowed' : 'limited';
  } catch {
    return 'unavailable';
  }
}

export function isJsonRequest(request: Request): boolean {
  const contentType = request.headers.get('content-type');
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

export async function readBoundedJson(
  request: Request,
): Promise<unknown | null | typeof REQUEST_BODY_TOO_LARGE> {
  if (!isJsonRequest(request)) return null;

  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) return null;
    if (length > MAX_REQUEST_BODY_BYTES) return REQUEST_BODY_TOO_LARGE;
  }

  const reader = request.body?.getReader();
  if (!reader) return null;

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return REQUEST_BODY_TOO_LARGE;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) return null;

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export async function sha256Hex(input: string): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]+$/.test(left) || !/^[a-f0-9]+$/.test(right) || left.length !== right.length) return false;

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
