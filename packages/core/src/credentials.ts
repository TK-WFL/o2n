import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface StoredCredentials {
  token: string;
  workspaceName?: string | null;
  savedAt: string;
}

function credentialsPath(): string {
  return path.join(os.homedir(), '.o2n', 'credentials.json');
}

/**
 * `o2n login`（OAuth）で取得したトークンをホームディレクトリ配下に保存する（vault内には保存しない）。
 * CLI・MCPサーバーの両方から共有される（NOTION_TOKEN環境変数が無い場合のフォールバック用）。
 */
export async function saveCredentials(data: StoredCredentials): Promise<void> {
  const p = credentialsPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export async function loadCredentials(): Promise<StoredCredentials | null> {
  try {
    const raw = await fs.readFile(credentialsPath(), 'utf-8');
    return JSON.parse(raw) as StoredCredentials;
  } catch {
    return null;
  }
}

export async function clearCredentials(): Promise<void> {
  try {
    await fs.unlink(credentialsPath());
  } catch {
    // 既に無ければ何もしない
  }
}
