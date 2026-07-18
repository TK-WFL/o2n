export function getToken(dryRun: boolean): string {
  const token = process.env.NOTION_TOKEN;
  if (!token && !dryRun) {
    console.error('エラー: 環境変数 NOTION_TOKEN が設定されていません（internal integrationのシークレットを設定してください）');
    process.exit(2);
  }
  return token ?? 'dry-run-placeholder-token';
}
