import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { saveCredentials, clearCredentials, loadCredentials } from '@tk_wfl/o2n-core';
import { AUTH_PROXY_URL, NOTION_OAUTH_CLIENT_ID } from '../oauth-config.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {
    // 開けなくても致命的ではない（URLを表示済みなので手動で開いてもらえる）
  });
}

interface PollResult {
  status: 'pending' | 'ready' | 'error';
  token?: string;
  workspaceName?: string | null;
  message?: string;
}

const POLL_INTERVAL_MS = 1500;
const TIMEOUT_MS = 5 * 60 * 1000;

/**
 * NotionのOAuth（public integration）でログインする。client_secretはCloudflare Worker
 * （AUTH_PROXY_URL）側にのみ存在し、CLIには一切渡らない。詳細は services/auth-proxy/README.md 参照。
 */
export async function loginCommand(): Promise<number> {
  if (AUTH_PROXY_URL.includes('PLACEHOLDER') || NOTION_OAUTH_CLIENT_ID.includes('PLACEHOLDER')) {
    console.error(
      'OAuth連携先が未設定です（services/auth-proxy未デプロイ）。代わりに NOTION_TOKEN 環境変数を使ってください。',
    );
    return 2;
  }

  const state = crypto.randomUUID();
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
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    let data: PollResult;
    try {
      const res = await fetch(`${AUTH_PROXY_URL}/poll?state=${encodeURIComponent(state)}`);
      data = (await res.json()) as PollResult;
    } catch {
      continue; // 一時的なネットワークエラーはリトライ
    }

    if (data.status === 'pending') continue;

    if (data.status === 'error') {
      console.error(`連携に失敗しました: ${data.message ?? '不明なエラー'}`);
      return 2;
    }

    if (data.status === 'ready' && data.token) {
      await saveCredentials({ token: data.token, workspaceName: data.workspaceName ?? null, savedAt: new Date().toISOString() });
      console.log(`\n連携が完了しました。ワークスペース: ${data.workspaceName ?? '(不明)'}`);
      console.log('以降、NOTION_TOKEN を設定しなくても o2n コマンドがこの認証情報を自動的に使います。');
      return 0;
    }
  }

  console.error('タイムアウトしました。もう一度 `o2n login` を実行してください。');
  return 2;
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
