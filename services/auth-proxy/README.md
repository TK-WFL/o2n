# o2n-auth-proxy

o2nのCLI/MCPサーバーがNotion OAuth（public integration）を使うための、コード交換だけを代行するCloudflare Worker。

## なぜ必要か

Notion のOAuthはPKCE非対応で、トークン交換に`client_secret`が必須。o2nはOSSのCLIとして配布されるため、
`client_secret`をコードに埋め込むことはできない。このWorkerが`client_secret`を安全に保持し、
CLIからは「認可コードを安全なloopback handoffで受け取る」だけのやり取りにする。

## セキュリティモデル

- `client_secret`はこのWorkerの環境変数（secret）としてのみ存在し、CLI・MCPサーバー・チャット等には一切渡らない
- 旧 `/poll?state=...` 方式は停止済み。`/poll` は常に410を返す
- CLIは`127.0.0.1`の一時HTTPリスナー、`state`、端末ローカルのセッション秘密値を生成する
- WorkerはNotionの認可コードをトークンへ交換した後、トークンそのものではなく短寿命のhandoff codeだけを
  loopbackへリダイレクトする
- CLIはhandoff codeとセッション秘密値を`/exchange`へPOSTし、Durable Object上で一度だけトークンを取得する
- このWorker自体はユーザーのVault内容やNotionページ内容には一切アクセスしない（トークン交換のみ）
- 既定では`OAUTH_ENABLED = "0"`で無効化されている。安全性を確認してから明示的に`"1"`へ変更する

## セットアップ（デプロイ手順）

1. Notion で **Public integration** を作成する（[https://www.notion.so/my-integrations](https://www.notion.so/my-integrations) → New integration → Type: Public）
2. 作成後、OAuth Client ID を控える（`wrangler.toml`の`NOTION_CLIENT_ID`に設定）
3. KV Namespaceを作成する（旧デプロイ互換用。新しいトークン配布には使用しない）:
   ```bash
   cd services/auth-proxy
   npm install
   npx wrangler kv:namespace create OAUTH_STATE
   ```
   出力された`id`を`wrangler.toml`の`kv_namespaces[0].id`に設定する
4. Durable Object migrationが`wrangler.toml`に含まれていることを確認する:
   ```toml
   [[durable_objects.bindings]]
   name = "OAUTH_SESSIONS"
   class_name = "OAuthSessions"
   ```
5. Client Secretを設定する（このコマンドはターミナルへの直接入力を求められる。チャット等には貼らないこと）:
   ```bash
   npx wrangler secret put NOTION_CLIENT_SECRET
   ```
6. デプロイする:
   ```bash
   npm run deploy
   ```
7. デプロイ後に表示される`https://o2n-auth-proxy.<account>.workers.dev`のようなURLを控える
8. Notion integration設定の「Redirect URIs」に `https://<デプロイ先URL>/callback` を追加する
9. 安全性確認後に`wrangler.toml`の`OAUTH_ENABLED`を`"1"`へ変更して再デプロイする
10. `packages/cli/src/oauth-config.ts`の`AUTH_PROXY_URL`と`NOTION_OAUTH_CLIENT_ID`をこのURLとClient IDに更新する
