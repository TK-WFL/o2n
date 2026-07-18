import { loadCredentials } from '@tk_wfl/o2n-core';

/** 優先順位: NOTION_TOKEN環境変数 → `o2n login`で保存済みのOAuth認証情報 */
export async function getToken(dryRun: boolean): Promise<string> {
  const envToken = process.env.NOTION_TOKEN;
  if (envToken) return envToken;

  const stored = await loadCredentials();
  if (stored) return stored.token;

  if (!dryRun) {
    console.error(
      'エラー: Notionと連携されていません。`o2n login` を実行するか、環境変数 NOTION_TOKEN を設定してください。',
    );
    process.exit(2);
  }
  return 'dry-run-placeholder-token';
}
