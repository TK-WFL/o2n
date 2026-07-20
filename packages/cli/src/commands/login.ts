import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { saveCredentials, clearCredentials, loadCredentials } from '@tk_wfl/o2n-core';
import { AUTH_PROXY_URL, NOTION_OAUTH_CLIENT_ID } from '../oauth-config.js';

function openBrowser(url: string): void {
  // セキュリティ対策（外部レビュー指摘対応）: execにシェル文字列を組み立てて渡すと
  // 将来の変更でシェルインジェクションの余地が生まれうるため、execFileで
  // コマンドと引数を分離して渡す（シェルを経由しない）。
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  execFile(cmd, args, () => {
    // 開けなくても致命的ではない（URLを表示済みなので手動で開いてもらえる）
  });
}

interface ExchangeResult {
  token: string;
  workspaceName?: string | null;
}

interface LocalCallbackResult {
  handoffCode: string;
  workspaceName?: string | null;
}

interface LocalCallbackServer {
  port: number;
  waitForCallback: Promise<LocalCallbackResult>;
  close: () => Promise<void>;
}

interface ErrorResponse {
  error?: string;
  message?: string;
}

interface StoredLoginNotice {
  status: 'registered';
}

interface SessionRegisterRequest {
  state: string;
  port: number;
  secretHash: string;
}

interface ExchangeRequest {
  state: string;
  handoffCode: string;
  sessionSecret: string;
}

interface ExchangeResponse {
  token?: string;
  workspaceName?: string | null;
}

const TIMEOUT_MS = 5 * 60 * 1000;
const ENABLE_BROWSER_LOGIN_ENV = 'O2N_ENABLE_BROWSER_LOGIN';

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function sanitizeConsoleText(value: string | null | undefined): string | null {
  if (!value) return value ?? null;
  return value.replace(/[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '').replace(/[\x00-\x1f\x7f]/g, '');
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as T & ErrorResponse;
  if (!res.ok) {
    throw new Error(data.message ?? data.error ?? `request failed: ${res.status}`);
  }
  return data;
}

function disabledLoginMessage(): string {
  return [
    '`o2n login` のブラウザOAuthは、既存のpoll方式にトークン窃取リスクが見つかったため既定で停止しています。',
    '当面は Notion の internal integration token を発行し、環境変数 NOTION_TOKEN に設定してください。',
    '既に未信頼Vaultを処理した、または旧 `o2n login` を利用した場合は、Notion側で該当トークンを失効・再発行してください。',
    `新しいloopback方式を検証目的で使う場合のみ ${ENABLE_BROWSER_LOGIN_ENV}=1 を設定してください。`,
  ].join('\n');
}

function startLocalCallbackServer(expectedState: string): Promise<LocalCallbackServer> {
  let settled = false;
  let timeout: NodeJS.Timeout;
  let rejectCallback: (reason?: unknown) => void;

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (requestUrl.pathname !== '/callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      const state = requestUrl.searchParams.get('state');
      const handoffCode = requestUrl.searchParams.get('handoff');
      const error = requestUrl.searchParams.get('error');
      const workspaceName = requestUrl.searchParams.get('workspaceName');

      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>o2n login failed</h1><p>state mismatch</p>');
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          rejectCallback(new Error('state mismatch'));
        }
        return;
      }

      if (error || !handoffCode) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>o2n login failed</h1><p>Authorization failed. Return to the terminal.</p>');
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          rejectCallback(new Error(error ?? 'handoff code was not returned'));
        }
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end('<!doctype html><meta charset="utf-8"><title>o2n</title><h1>連携が完了しました</h1><p>このタブを閉じて、ターミナルに戻ってください。</p>');

      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolveCallback({ handoffCode, workspaceName });
      }
    });

    let resolveCallback: (result: LocalCallbackResult) => void;
    const waitForCallback = new Promise<LocalCallbackResult>((callbackResolve, callbackReject) => {
      resolveCallback = callbackResolve;
      rejectCallback = callbackReject;
      timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          callbackReject(new Error('OAuth callback timed out'));
        }
      }, TIMEOUT_MS);
    });

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('failed to bind local callback server'));
        return;
      }
      const close = async () => {
        clearTimeout(timeout);
        await new Promise<void>((closeResolve, closeReject) => {
          server.close((err) => (err ? closeReject(err) : closeResolve()));
        }).catch(() => undefined);
      };
      resolve({ port: (address as AddressInfo).port, waitForCallback, close });
    });
  });
}

async function registerOAuthSession(request: SessionRegisterRequest): Promise<void> {
  await requestJson<StoredLoginNotice>(`${AUTH_PROXY_URL}/session`, {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

async function exchangeHandoffCode(request: ExchangeRequest): Promise<ExchangeResult> {
  const data = await requestJson<ExchangeResponse>(`${AUTH_PROXY_URL}/exchange`, {
    method: 'POST',
    body: JSON.stringify(request),
  });
  if (!data.token) throw new Error('auth proxy did not return a token');
  return { token: data.token, workspaceName: data.workspaceName ?? null };
}

/**
 * NotionのOAuth（public integration）でログインする。旧poll方式は停止し、検証用に
 * 有効化された場合のみloopback handoffでトークンを受け取る。
 */
export async function loginCommand(): Promise<number> {
  if (process.env[ENABLE_BROWSER_LOGIN_ENV] !== '1') {
    console.error(disabledLoginMessage());
    return 2;
  }

  if (AUTH_PROXY_URL.includes('PLACEHOLDER') || NOTION_OAUTH_CLIENT_ID.includes('PLACEHOLDER')) {
    console.error(
      'OAuth連携先が未設定です（services/auth-proxy未デプロイ）。代わりに NOTION_TOKEN 環境変数を使ってください。',
    );
    return 2;
  }

  const state = crypto.randomUUID();
  const sessionSecret = crypto.randomBytes(32).toString('hex');
  const localServer = await startLocalCallbackServer(state);

  try {
    await registerOAuthSession({
      state,
      port: localServer.port,
      secretHash: sha256Hex(sessionSecret),
    });

    const authorizeUrl = new URL('https://api.notion.com/v1/oauth/authorize');
    authorizeUrl.searchParams.set('client_id', NOTION_OAUTH_CLIENT_ID);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('owner', 'user');
    authorizeUrl.searchParams.set('redirect_uri', `${AUTH_PROXY_URL}/callback`);
    authorizeUrl.searchParams.set('state', state);

    console.log('ブラウザでNotionの連携画面を開きます...');
    console.log(`自動で開かない場合はこちらをブラウザで開いてください:\n${authorizeUrl.toString()}\n`);
    openBrowser(authorizeUrl.toString());

    console.log('ブラウザでの承認を待っています（最大5分）...');
    const callback = await localServer.waitForCallback;
    const exchanged = await exchangeHandoffCode({
      state,
      handoffCode: callback.handoffCode,
      sessionSecret,
    });
    const workspaceName = sanitizeConsoleText(exchanged.workspaceName ?? callback.workspaceName ?? null);
    await saveCredentials({ token: exchanged.token, workspaceName, savedAt: new Date().toISOString() });
    console.log(`\n連携が完了しました。ワークスペース: ${workspaceName ?? '(不明)'}`);
    console.log('以降、NOTION_TOKEN を設定しなくても o2n コマンドがこの認証情報を自動的に使います。');
    return 0;
  } catch (err) {
    console.error(`連携に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  } finally {
    await localServer.close();
  }
}

export async function logoutCommand(): Promise<number> {
  const existing = await loadCredentials();
  if (!existing) {
    console.log('連携済みの認証情報はありません。');
    return 0;
  }
  await clearCredentials();
  console.log(`ワークスペース「${existing.workspaceName ?? '(不明)'}」との連携を解除しました。`);
  return 0;
}

export async function whoamiCommand(): Promise<number> {
  const existing = await loadCredentials();
  if (!existing) {
    console.log('未連携です。`o2n login` を実行するか、NOTION_TOKEN 環境変数を設定してください。');
    return 1;
  }
  console.log(`連携済みワークスペース: ${existing.workspaceName ?? '(不明)'}`);
  console.log(`連携日時: ${existing.savedAt}`);
  return 0;
}
