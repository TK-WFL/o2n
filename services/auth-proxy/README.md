# o2n-auth-proxy

o2nのCLI/MCPサーバーがNotion OAuth（public integration）を使うための、コード交換だけを代行するCloudflare Worker。

## なぜ必要か

Notion のOAuthはPKCE非対応で、トークン交換に`client_secret`が必須。o2nはOSSのCLIとして配布されるため、
`client_secret`をコードに埋め込むことはできない。このWorkerが`client_secret`を安全に保持し、
CLIからは「認可コードを渡してトークンを受け取る」だけのやり取りにする。

## セキュリティモデル

- `client_secret`はこのWorkerの環境変数（secret）としてのみ存在し、CLI・MCPサーバー・チャット等には一切渡らない
- CLIとWorkerの間は、CLIが生成したランダムな`state`のみで紐付く（他の推測不可能な値）
- 交換済みトークンはCloudflare KVに**最大5分**だけ保持し、CLIが1回ポーリングで取得した時点で即削除する
- このWorker自体はユーザーのVault内容やNotionページ内容には一切アクセスしない（トークン交換のみ）

## セットアップ（デプロイ手順）

1. Notion で **Public integration** を作成する（[https://www.notion.so/my-integrations](https://www.notion.so/my-integrations) → New integration → Type: Public）
2. 作成後、OAuth Client ID を控える（`wrangler.toml`の`NOTION_CLIENT_ID`に設定）
3. KV Namespaceを作成する:
   ```bash
   cd services/auth-proxy
   npm install
   npx wrangler kv:namespace create OAUTH_STATE
   ```
   出力された`id`を`wrangler.toml`の`kv_namespaces[0].id`に設定する
4. Client Secretを設定する（このコマンドはターミナルへの直接入力を求められる。チャット等には貼らないこと）:
   ```bash
   npx wrangler secret put NOTION_CLIENT_SECRET
   ```
5. デプロイする:
   ```bash
   npm run deploy
   ```
6. デプロイ後に表示される`https://o2n-auth-proxy.<account>.workers.dev`のようなURLを控える
7. Notion integration設定の「Redirect URIs」に `https://<デプロイ先URL>/callback` を追加する
8. `packages/cli/src/commands/login.ts`の`AUTH_PROXY_URL`と`NOTION_CLIENT_ID`をこのURLとClient IDに更新する
