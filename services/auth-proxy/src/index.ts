export interface Env {
  OAUTH_STATE: KVNamespace;
  OAUTH_SESSIONS: DurableObjectNamespace;
  NOTION_CLIENT_ID: string;
  NOTION_CLIENT_SECRET: string;
  OAUTH_ENABLED?: string;
}

const STATE_TTL_SECONDS = 300;
const LOCAL_CALLBACK_PATH = '/callback';

interface OAuthSession {
  state: string;
  port: number;
  secretHash: string;
  createdAt: number;
  token?: string;
  workspaceName?: string | null;
  handoffCode?: string;
  consumed?: boolean;
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

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
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

function isOAuthEnabled(env: Env): boolean {
  return env.OAUTH_ENABLED === '1';
}

function disabled(): Response {
  return json(
    {
      error: 'oauth_disabled',
      message: 'o2n browser OAuth is disabled. Use NOTION_TOKEN until loopback OAuth is explicitly enabled.',
    },
    503,
  );
}

function badRequest(message: string): Response {
  return json({ error: 'bad_request', message }, 400);
}

function sessionStub(env: Env, state: string): DurableObjectStub {
  const id = env.OAUTH_SESSIONS.idFromName(state);
  return env.OAUTH_SESSIONS.get(id);
}

async function callSession<T>(env: Env, state: string, path: string, init?: RequestInit): Promise<T> {
  const res = await sessionStub(env, state).fetch(`https://o2n-session${path}`, init);
  const data = (await res.json().catch(() => ({}))) as T & { message?: string; error?: string };
  if (!res.ok) throw new Error(data.message ?? data.error ?? `session request failed: ${res.status}`);
  return data;
}

async function readJson<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
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

function localCallbackUrl(port: number, params: Record<string, string>): string {
  const url = new URL(`http://127.0.0.1:${port}${LOCAL_CALLBACK_PATH}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

async function handleSession(request: Request, env: Env): Promise<Response> {
  if (!isOAuthEnabled(env)) return disabled();
  if (request.method !== 'POST') return badRequest('method not allowed');

  const body = await readJson<RegisterSessionRequest>(request);
  if (!validateState(body.state)) return badRequest('invalid state');
  if (!validatePort(body.port)) return badRequest('invalid loopback port');
  if (!validateSecretHash(body.secretHash)) return badRequest('invalid session secret hash');

  await callSession(env, body.state, '/register', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return json({ status: 'registered' });
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
  if (!isOAuthEnabled(env)) return html('<h1>OAuthは現在停止中です</h1><p>NOTION_TOKEN を使用してください。</p>', 503);

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (!state || !validateState(state)) {
    return html('<h1>エラー</h1><p>stateパラメータがありません。CLIから開始したリンクを使ってください。</p>', 400);
  }

  let session: SessionPortResponse;
  try {
    session = await callSession<SessionPortResponse>(env, state, '/begin');
  } catch {
    return html('<h1>エラー</h1><p>ログインセッションが見つからないか、期限切れです。</p>', 400);
  }

  if (error || !code) {
    return Response.redirect(localCallbackUrl(session.port, { state, error: error ?? 'authorization_failed' }), 302);
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
    const errBody = await tokenRes.text();
    console.error(`Notion token exchange failed: ${tokenRes.status} ${errBody}`);
    return Response.redirect(localCallbackUrl(session.port, { state, error: 'token_exchange_failed' }), 302);
  }

  const tokenData = (await tokenRes.json()) as {
    access_token: string;
    workspace_name?: string | null;
    workspace_icon?: string | null;
  };

  const completed = await callSession<CompleteSessionResponse>(env, state, '/complete', {
    method: 'POST',
    body: JSON.stringify({
      token: tokenData.access_token,
      workspaceName: tokenData.workspace_name ?? null,
    } satisfies CompleteSessionRequest),
  });

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
  if (!isOAuthEnabled(env)) return disabled();
  if (request.method !== 'POST') return badRequest('method not allowed');

  const body = await readJson<{ state?: string; handoffCode?: string; sessionSecret?: string }>(request);
  if (!validateState(body.state)) return badRequest('invalid state');
  if (!body.handoffCode || !body.sessionSecret) return badRequest('handoffCode and sessionSecret are required');

  const exchanged = await callSession<ExchangeResponse>(env, body.state, '/exchange', {
    method: 'POST',
    body: JSON.stringify({ handoffCode: body.handoffCode, sessionSecret: body.sessionSecret } satisfies ExchangeRequest),
  });
  return json(exchanged);
}

async function handlePoll(): Promise<Response> {
  return json({ error: 'poll_removed', message: 'The insecure OAuth polling endpoint has been removed.' }, 410);
}

export class OAuthSessions {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/register') return this.register(request);
      if (url.pathname === '/begin') return this.begin();
      if (url.pathname === '/complete') return this.complete(request);
      if (url.pathname === '/exchange') return this.exchange(request);
      return json({ error: 'not_found' }, 404);
    } catch (err) {
      return json({ error: 'session_error', message: err instanceof Error ? err.message : String(err) }, 400);
    }
  }

  private async current(): Promise<OAuthSession | null> {
    const session = await this.state.storage.get<OAuthSession>('session');
    if (!session) return null;
    if (Date.now() - session.createdAt > STATE_TTL_SECONDS * 1000) {
      await this.state.storage.delete('session');
      return null;
    }
    return session;
  }

  private async register(request: Request): Promise<Response> {
    const body = await readJson<RegisterSessionRequest>(request);
    const existing = await this.current();
    if (existing && !existing.consumed) {
      return json({ error: 'session_exists', message: 'OAuth session already exists' }, 409);
    }

    const session: OAuthSession = {
      state: body.state,
      port: body.port,
      secretHash: body.secretHash,
      createdAt: Date.now(),
      consumed: false,
    };
    await this.state.storage.put('session', session);
    return json({ status: 'registered' });
  }

  private async begin(): Promise<Response> {
    const session = await this.current();
    if (!session || session.consumed) return json({ error: 'not_found' }, 404);
    return json({ port: session.port } satisfies SessionPortResponse);
  }

  private async complete(request: Request): Promise<Response> {
    const session = await this.current();
    if (!session || session.consumed) return json({ error: 'not_found' }, 404);
    const body = await readJson<CompleteSessionRequest>(request);
    if (!body.token) return badRequest('token is required');
    const handoffCode = crypto.randomUUID();

    const completed: OAuthSession = {
      ...session,
      token: body.token,
      workspaceName: body.workspaceName ?? null,
      handoffCode,
    };
    await this.state.storage.put('session', completed);
    return json({
      port: completed.port,
      handoffCode,
      workspaceName: completed.workspaceName ?? null,
    } satisfies CompleteSessionResponse);
  }

  private async exchange(request: Request): Promise<Response> {
    const session = await this.current();
    if (!session || session.consumed || !session.token || !session.handoffCode) {
      return json({ error: 'not_found' }, 404);
    }

    const body = await readJson<ExchangeRequest>(request);
    const secretHash = await sha256Hex(body.sessionSecret);
    if (body.handoffCode !== session.handoffCode || secretHash !== session.secretHash) {
      return json({ error: 'invalid_grant', message: 'invalid handoff code or session secret' }, 403);
    }

    const response: ExchangeResponse = {
      token: session.token,
      workspaceName: session.workspaceName ?? null,
    };
    await this.state.storage.put('session', { ...session, consumed: true, token: undefined });
    return json(response);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/session') {
      return handleSession(request, env);
    }
    if (url.pathname === '/callback') {
      return handleCallback(request, env);
    }
    if (url.pathname === '/exchange') {
      return handleExchange(request, env);
    }
    if (url.pathname === '/poll') {
      return handlePoll();
    }
    if (url.pathname === '/' || url.pathname === '') {
      return html('<h1>o2n auth proxy</h1><p>このサーバーは o2n CLI/MCPサーバーからのみ使用されます。</p>');
    }
    return new Response('Not found', { status: 404 });
  },
};
