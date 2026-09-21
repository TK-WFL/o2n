import { loadCredentials } from '@tk_wfl/o2n-core';

export class TokenMissingError extends Error {
  constructor() {
    super('Notionと連携されていません。環境変数 NOTION_TOKEN に個人アクセストークン（または internal integration のトークン）を設定してください。');
    this.name = 'TokenMissingError';
  }
}

/** 優先順位: NOTION_TOKEN環境変数 → `o2n login`で保存済みのOAuth認証情報 */
export async function getToken(dryRun: boolean): Promise<string> {
  const envToken = process.env.NOTION_TOKEN;
  if (envToken) return envToken;

  const stored = await loadCredentials();
  if (stored) return stored.token;

  if (!dryRun) throw new TokenMissingError();
  return 'dry-run-placeholder-token';
}
