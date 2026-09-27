import { resolveNotionToken } from '@tk_wfl/o2n-core';

/** トークンが見つからないときの案内。プラグイン設定 / CLI での保存 / 環境変数の3経路を示す（#164） */
export const MISSING_TOKEN_MESSAGE = [
  'Notionと連携されていません。次のどれかでトークン（個人アクセストークン推奨）を渡してください。',
  '- Claude のプラグインとして使っている場合: プラグインの設定で「Notion token」を入力する（Cowork では入力画面が出ないため、次の方法を使う）',
  '- ターミナルで `npx @tk_wfl/o2n-cli login --token` を実行して保存する',
  '- 環境変数 NOTION_TOKEN に設定する',
].join('\n');

/**
 * MCP サーバーが使うトークン。NOTION_TOKEN が空（プラグインのトークン欄が未入力）なら
 * 保存済みの認証情報へフォールバックする。dry-run では無くても進められるよう仮の値を返す。
 */
export async function notionTokenFor(dryRun: boolean, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const resolved = await resolveNotionToken(env);
  if (resolved) return resolved.token;
  return dryRun ? 'dry-run-placeholder-token' : null;
}
