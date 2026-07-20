import {
  enforceRateLimit,
  isOAuthReady,
  readBoundedJson,
  sessionExpiresAt,
  sha256Hex,
  timingSafeEqualHex,
  type RateLimiter,
} from './security.js';

export interface Env {
  OAUTH_STATE: KVNamespace;
  OAUTH_SESSIONS: DurableObjectNamespace;
  NOTION_CLIENT_ID: string;
  NOTION_CLIENT_SECRET: string;
  OAUTH_ENABLED?: string;
  SESSION_RATE_LIMITER?: RateLimiter;
  EXCHANGE_RATE_LIMITER?: RateLimiter;
}

const LOCAL_CALLBACK_PATH = '/callback';
const MAX_FAILED_EXCHANGES = 5;
const PUBLIC_ERROR_MESSAGE = 'The request could not be processed.';

interface OAuthSession {
  state: string;
  port: number;
  secretHash: string;
  createdAt: number;
  expiresAt: number;
  token?: string;
  workspaceName?: string | null;
  handoffCode?: string;
  failedExchanges?: number;
}

interface RegisterSessionRequest {
  state: string;
  port: number;
  secretHash: string;
}

interface CompleteSessionRequest {
  token: string;
  workspaceName?: string | null;
}

interface ExchangeRequest {
  handoffCode: string;
  sessionSecret: string;
}

interface SessionPortResponse {
  port: number;
}

interface CompleteSessionResponse {
  port: number;
  handoffCode: string;
  workspaceName?: string | null;
}

interface ExchangeResponse {
  token: string;
  workspaceName?: string | null;
}

function securityHeaders(contentType: string): HeadersInit {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  };
}

function html(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>o2n - Notion連携</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fafafa;color:#37352f}
.card{max-width:420px;text-align:center;padding:2rem}
h1{font-size:1.25rem}</style></head>
<body><div class="card">${body}</div></body></html>`,
    { status, headers: securityHeaders('text/html; charset=utf-8') },
  );
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: securityHeaders('application/json') });
}

function disabled(): Response {
  return json({ error: 'oauth_unavailable', message: PUBLIC_ERROR_MESSAGE }, 503);
}

function publicError(error: string, status: number): Response {
  return json({ error, message: PUBLIC_ERROR_MESSAGE }, status);
}

function sessionStub(env: Env, state: string): DurableObjectStub {
  const id = env.OAUTH_SESSIONS.idFromName(state);
  return env.OAUTH_SESSIONS.get(id);
}

async function callSession<T>(env: Env, state: string, path: string, init?: RequestInit): Promise<T> {
  const res = await sessionStub(env, state).fetch(`https://o2n-session${path}`, init);
  if (!res.ok) throw new Error(`session request failed with status ${res.status}`);
  return (await res.json()) as T;
}

function validateState(state: unknown): state is string {
  return typeof state === 'string' && state.length >= 16 && state.length <= 128 && /^[a-zA-Z0-9._:-]+$/.test(state);
}

function validateSecretHash(secretHash: unknown): secretHash is string {
  return typeof secretHash === 'string' && /^[a-f0-9]{64}$/.test(secretHash);
}

function validatePort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535;
}

function validateHandoffCode(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function validateSessionSecret(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function clientRateLimitKey(request: Request, endpoint: 'session' | 'exchange'): Promise<string> {
  const clientAddress = request.headers.get('cf-connecting-ip') ?? 'unavailable';
  return sha256Hex(`${endpoint}:${clientAddress}`);
}

async function rateLimitResponse(
  request: Request,
  limiter: RateLimiter | undefined,
  endpoint: 'session' | 'exchange',
): Promise<Response | null> {
  const result = await enforceRateLimit(limiter, await clientRateLimitKey(request, endpoint));
  if (result === 'allowed') return null;
  return publicError(result === 'limited' ? 'rate_limited' : 'oauth_unavailable', result === 'limited' ? 429 : 503);
}

function localCallbackUrl(port: number, params: Record<string, string>): string {
  const url = new URL(`http://127.0.0.1:${port}${LOCAL_CALLBACK_PATH}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

async function handleSession(request: Request, env: Env): Promise<Response> {
  if (!isOAuthReady(env)) return disabled();
  if (request.method !== 'POST') return publicError('method_not_allowed', 405);

  const limited = await rateLimitResponse(request, env.SESSION_RATE_LIMITER, 'session');
  if (limited) return limited;

  const body = await readBoundedJson(request) as Partial<RegisterSessionRequest> | null;
  if (
    !body ||
    !validateState(body.state) ||
    !validatePort(body.port) ||
    !validateSecretHash(body.secretHash)
  ) {
    return publicError('invalid_request', 400);
  }

  await callSession(env, body.state, '/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return json({ status: 'registered' });
}

async function cancelSession(env: Env, state: string): Promise<void> {
  await sessionStub(env, state).fetch('https://o2n-session/cancel', { method: 'POST' }).catch(() => undefined);
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
  if (!isOAuthReady(env)) return html('<h1>OAuthは現在利用できません</h1>', 503);

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (!state || !validateState(state)) {
    return html('<h1>リクエストを処理できませんでした</h1>', 400);
  }

  let session: SessionPortResponse;
  try {
    session = await callSession<SessionPortResponse>(env, state, '/begin');
  } catch {
    return html('<h1>リクエストを処理できませんでした</h1>', 400);
  }

  if (error || !code) {
    await cancelSession(env, state);
    return Response.redirect(localCallbackUrl(session.port, { state, error: 'authorization_failed' }), 302);
  }
  if (code.length > 2_048) {
    await cancelSession(env, state);
    return html('<h1>リクエストを処理できませんでした</h1>', 400);
  }

  const redirectUri = `${url.origin}/callback`;
  const basicAuth = btoa(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`);

  const tokenRes = await fetch('https://api.notion.com/v1/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
  });

  if (!tokenRes.ok) {
    console.error(`Notion token exchange failed with status ${tokenRes.status}`);
    await cancelSession(env, state);
    return Response.redirect(localCallbackUrl(session.port, { state, error: 'token_exchange_failed' }), 302);
  }

  const tokenData = (await tokenRes.json()) as {
    access_token?: unknown;
    workspace_name?: unknown;
  };
  if (
    typeof tokenData.access_token !== 'string' ||
    tokenData.access_token.length < 1 ||
    tokenData.access_token.length > 2_048 ||
    (tokenData.workspace_name !== undefined &&
      tokenData.workspace_name !== null &&
      (typeof tokenData.workspace_name !== 'string' || tokenData.workspace_name.length > 200))
  ) {
    await cancelSession(env, state);
    return Response.redirect(localCallbackUrl(session.port, { state, error: 'token_exchange_failed' }), 302);
  }

  let completed: CompleteSessionResponse;
  try {
    completed = await callSession<CompleteSessionResponse>(env, state, '/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: tokenData.access_token,
        workspaceName: tokenData.workspace_name ?? null,
      } satisfies CompleteSessionRequest),
    });
  } catch {
    await cancelSession(env, state);
    return Response.redirect(localCallbackUrl(session.port, { state, error: 'session_completion_failed' }), 302);
  }

  return Response.redirect(
    localCallbackUrl(completed.port, {
      state,
      handoff: completed.handoffCode,
      ...(completed.workspaceName ? { workspaceName: completed.workspaceName } : {}),
    }),
    302,
  );
}

async function handleExchange(request: Request, env: Env): Promise<Response> {
  if (!isOAuthReady(env)) return disabled();
  if (request.method !== 'POST') return publicError('method_not_allowed', 405);

  const limited = await rateLimitResponse(request, env.EXCHANGE_RATE_LIMITER, 'exchange');
  if (limited) return limited;

  const body = await readBoundedJson(request) as {
    state?: unknown;
    handoffCode?: unknown;
    sessionSecret?: unknown;
  } | null;
  if (
    !body ||
    !validateState(body.state) ||
    !validateHandoffCode(body.handoffCode) ||
    !validateSessionSecret(body.sessionSecret)
  ) {
    return publicError('invalid_request', 400);
  }

  const exchanged = await callSession<ExchangeResponse>(env, body.state, '/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handoffCode: body.handoffCode, sessionSecret: body.sessionSecret } satisfies ExchangeRequest),
  });
  return json(exchanged);
}

async function handlePoll(): Promise<Response> {
  return publicError('poll_removed', 410);
}

export class OAuthSessions {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/register') return this.register(request);
      if (url.pathname === '/begin') return this.begin();
      if (url.pathname === '/complete') return this.complete(request);
      if (url.pathname === '/exchange') {
        return this.state.blockConcurrencyWhile(() => this.exchange(request));
      }
      if (url.pathname === '/cancel') return this.cancel();
      return json({ error: 'not_found' }, 404);
    } catch {
      return publicError('session_error', 400);
    }
  }

  async alarm(): Promise<void> {
    await this.clearSession();
  }

  private async clearSession(): Promise<void> {
    await this.state.storage.deleteAll();
    await this.state.storage.deleteAlarm();
  }

  private async storeSession(session: OAuthSession): Promise<void> {
    await this.state.storage.setAlarm(session.expiresAt);
    await this.state.storage.put('session', session);
  }

  private async current(): Promise<OAuthSession | null> {
    const session = await this.state.storage.get<OAuthSession>('session');
    if (!session) return null;
    if (!Number.isFinite(session.expiresAt) || Date.now() >= session.expiresAt) {
      await this.clearSession();
      return null;
    }
    return session;
  }

  private async register(request: Request): Promise<Response> {
    const body = await readBoundedJson(request) as Partial<RegisterSessionRequest> | null;
    if (
      !body ||
      !validateState(body.state) ||
      !validatePort(body.port) ||
      !validateSecretHash(body.secretHash)
    ) {
      return publicError('invalid_request', 400);
    }

    const existing = await this.current();
    if (existing) {
      return publicError('session_exists', 409);
    }

    const now = Date.now();
    const session: OAuthSession = {
      state: body.state,
      port: body.port,
      secretHash: body.secretHash,
      createdAt: now,
      expiresAt: sessionExpiresAt(now),
      failedExchanges: 0,
    };
    await this.storeSession(session);
    return json({ status: 'registered' });
  }

  private async begin(): Promise<Response> {
    const session = await this.current();
    if (!session) return json({ error: 'not_found' }, 404);
    return json({ port: session.port } satisfies SessionPortResponse);
  }

  private async complete(request: Request): Promise<Response> {
    const session = await this.current();
    if (!session) return json({ error: 'not_found' }, 404);

    const body = await readBoundedJson(request) as Partial<CompleteSessionRequest> | null;
    if (
      !body ||
      typeof body.token !== 'string' ||
      body.token.length < 1 ||
      body.token.length > 2_048 ||
      (body.workspaceName !== undefined &&
        body.workspaceName !== null &&
        (typeof body.workspaceName !== 'string' || body.workspaceName.length > 200))
    ) {
      return publicError('invalid_request', 400);
    }

    const handoffCode = crypto.randomUUID();
    const now = Date.now();

    const completed: OAuthSession = {
      ...session,
      token: body.token,
      workspaceName: body.workspaceName ?? null,
      handoffCode,
      expiresAt: sessionExpiresAt(now),
      failedExchanges: 0,
    };
    await this.storeSession(completed);
    return json({
      port: completed.port,
      handoffCode,
      workspaceName: completed.workspaceName ?? null,
    } satisfies CompleteSessionResponse);
  }

  private async exchange(request: Request): Promise<Response> {
    const session = await this.current();
    if (!session || !session.token || !session.handoffCode) {
      return json({ error: 'not_found' }, 404);
    }

    const body = await readBoundedJson(request) as Partial<ExchangeRequest> | null;
    if (!body || !validateHandoffCode(body.handoffCode) || !validateSessionSecret(body.sessionSecret)) {
      return publicError('invalid_request', 400);
    }

    const secretHash = await sha256Hex(body.sessionSecret);
    const [handoffHash, expectedHandoffHash] = await Promise.all([
      sha256Hex(body.handoffCode),
      sha256Hex(session.handoffCode),
    ]);
    if (
      !timingSafeEqualHex(handoffHash, expectedHandoffHash) ||
      !timingSafeEqualHex(secretHash, session.secretHash)
    ) {
      const failedExchanges = (session.failedExchanges ?? 0) + 1;
      if (failedExchanges >= MAX_FAILED_EXCHANGES) {
        await this.clearSession();
      } else {
        await this.state.storage.put('session', { ...session, failedExchanges });
      }
      return publicError('invalid_grant', 403);
    }

    const response: ExchangeResponse = {
      token: session.token,
      workspaceName: session.workspaceName ?? null,
    };
    await this.clearSession();
    return json(response);
  }

  private async cancel(): Promise<Response> {
    await this.clearSession();
    return json({ status: 'cancelled' });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (url.pathname === '/session') {
        return await handleSession(request, env);
      }
      if (url.pathname === '/callback') {
        return await handleCallback(request, env);
      }
      if (url.pathname === '/exchange') {
        return await handleExchange(request, env);
      }
      if (url.pathname === '/poll') {
        return handlePoll();
      }
      if (url.pathname === '/' || url.pathname === '') {
        return html('<h1>o2n auth proxy</h1><p>このサーバーは o2n CLI/MCPサーバーからのみ使用されます。</p>');
      }
      return new Response('Not found', { status: 404 });
    } catch {
      return publicError('request_failed', 500);
    }
  },
};
