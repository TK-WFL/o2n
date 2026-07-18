export interface Env {
  OAUTH_STATE: KVNamespace;
  NOTION_CLIENT_ID: string;
  NOTION_CLIENT_SECRET: string;
}

const STATE_TTL_SECONDS = 300;

interface StoredResult {
  status: 'ready' | 'error';
  token?: string;
  workspaceName?: string | null;
  workspaceIcon?: string | null;
  message?: string;
}

function html(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>o2n - Notion連携</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fafafa;color:#37352f}
.card{max-width:420px;text-align:center;padding:2rem}
h1{font-size:1.25rem}</style></head>
<body><div class="card">${body}</div></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (!state) {
    return html('<h1>エラー</h1><p>stateパラメータがありません。CLIから開始したリンクを使ってください。</p>', 400);
  }

  if (error || !code) {
    const result: StoredResult = { status: 'error', message: error ?? 'code が返されませんでした' };
    await env.OAUTH_STATE.put(state, JSON.stringify(result), { expirationTtl: STATE_TTL_SECONDS });
    return html(`<h1>連携がキャンセルされました</h1><p>このタブは閉じて構いません。ターミナルに戻ってください。</p>`);
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
    const result: StoredResult = { status: 'error', message: `Notion token exchange failed: ${tokenRes.status} ${errBody}` };
    await env.OAUTH_STATE.put(state, JSON.stringify(result), { expirationTtl: STATE_TTL_SECONDS });
    return html('<h1>連携に失敗しました</h1><p>ターミナルに戻ってエラー内容を確認してください。</p>', 502);
  }

  const tokenData = (await tokenRes.json()) as {
    access_token: string;
    workspace_name?: string | null;
    workspace_icon?: string | null;
  };

  const result: StoredResult = {
    status: 'ready',
    token: tokenData.access_token,
    workspaceName: tokenData.workspace_name ?? null,
    workspaceIcon: tokenData.workspace_icon ?? null,
  };
  await env.OAUTH_STATE.put(state, JSON.stringify(result), { expirationTtl: STATE_TTL_SECONDS });

  return html(
    `<h1>連携が完了しました ✅</h1><p>ワークスペース「${tokenData.workspace_name ?? ''}」と連携しました。このタブを閉じて、ターミナルに戻ってください。</p>`,
  );
}

async function handlePoll(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  if (!state) return json({ status: 'pending' });

  const raw = await env.OAUTH_STATE.get(state);
  if (!raw) return json({ status: 'pending' });

  // 一度取得したら削除（トークンの使い回し・漏洩リスクを避けるため）
  await env.OAUTH_STATE.delete(state);
  return json(JSON.parse(raw) as StoredResult);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/callback') {
      return handleCallback(request, env);
    }
    if (url.pathname === '/poll') {
      return handlePoll(request, env);
    }
    if (url.pathname === '/' || url.pathname === '') {
      return html('<h1>o2n auth proxy</h1><p>このサーバーは o2n CLI/MCPサーバーからのみ使用されます。</p>');
    }
    return new Response('Not found', { status: 404 });
  },
};
