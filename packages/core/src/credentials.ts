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
 * `o2n login`（OAuth）で取得したトークンをホームディレクトリ配下に保存する（vault内には保存しない）。
 * CLI・MCPサーバーの両方から共有される（NOTION_TOKEN環境変数が無い場合のフォールバック用）。
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
