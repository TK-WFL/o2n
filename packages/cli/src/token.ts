import { resolveNotionToken } from '@tk_wfl/o2n-core';

export class TokenMissingError extends Error {
  constructor() {
    super(
      'Notionと連携されていません。`o2n login --token` で個人アクセストークン（または internal integration のトークン）を保存するか、環境変数 NOTION_TOKEN に設定してください。',
    );
    this.name = 'TokenMissingError';
  }
}

/** 優先順位: NOTION_TOKEN環境変数（空なら未設定扱い） → `o2n login` で保存済みの認証情報 */
export async function getToken(dryRun: boolean): Promise<string> {
  const resolved = await resolveNotionToken();
  if (resolved) return resolved.token;
  if (!dryRun) throw new TokenMissingError();
  return 'dry-run-placeholder-token';
}
