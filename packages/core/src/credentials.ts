import {
  atomicWriteHomeStateFile,
  readHomeStateFile,
  removeHomeStateFile,
} from './local-state-io.js';

export interface StoredCredentials {
  token: string;
  workspaceName?: string | null;
  savedAt: string;
}

/**
 * `o2n login --token`（または OAuth の `o2n login`）で得たトークンをホームディレクトリ配下に保存する
 * （vault内には保存しない）。CLI・MCPサーバーの両方から共有される（NOTION_TOKEN環境変数が無い場合のフォールバック用）。
 */
export async function saveCredentials(data: StoredCredentials): Promise<void> {
  await atomicWriteHomeStateFile('credentials.json', JSON.stringify(data, null, 2));
}

export async function loadCredentials(): Promise<StoredCredentials | null> {
  try {
    const raw = await readHomeStateFile('credentials.json');
    return JSON.parse(raw) as StoredCredentials;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  }
}

export async function clearCredentials(): Promise<void> {
  try {
    await removeHomeStateFile('credentials.json');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** トークンをどこから得たか */
export type NotionTokenSource = 'env' | 'stored';

export interface ResolvedNotionToken {
  token: string;
  source: NotionTokenSource;
}

/**
 * 使う Notion トークンを決める。優先順位は NOTION_TOKEN 環境変数 → 保存済みの認証情報。
 *
 * Claude のプラグインから起動されると、ユーザーがトークン欄を空のままにした場合に
 * `NOTION_TOKEN=""` が渡ってくる（Cowork は入力画面を出さないため既定値 "" が使われる）。
 * 空文字や空白だけの値は未設定として扱い、保存済みの認証情報へフォールバックする（#164）。
 */
export async function resolveNotionToken(env: NodeJS.ProcessEnv = process.env): Promise<ResolvedNotionToken | null> {
  const fromEnv = env.NOTION_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: 'env' };
  const stored = (await loadCredentials())?.token?.trim();
  if (stored) return { token: stored, source: 'stored' };
  return null;
}
