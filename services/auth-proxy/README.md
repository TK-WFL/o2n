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
- Durable Objectのセッションは登録時・トークン格納時から5分でalarmにより全削除される。交換成功時と
  OAuthキャンセル時は即座に全データとalarmを削除する
- `/session`は10回/分、`/exchange`は20回/分のCloudflare Rate Limiting bindingで送信元ごとに制限する。
  これは認証の代替ではなく、state・handoff code・端末秘密値の検証も必須
- `/exchange`の誤試行はセッションごとに5回でセッション自体を削除する
- JSON APIは`application/json`かつ2 KiB以下のみ受け付ける。bodyはstreamで累計し、`Content-Length`が
  欠落・偽装されていても上限到達時点で読込みを中止してHTTP 413で拒否する
- このWorker自体はユーザーのVault内容やNotionページ内容には一切アクセスしない（トークン交換のみ）
- 既定では`OAUTH_ENABLED = "0"`で無効化されている。rate limit binding、Durable Object、Client ID、
  Client Secretのいずれかが欠ける場合もfail closedでOAuthを拒否する

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
5. `SESSION_RATE_LIMITER`と`EXCHANGE_RATE_LIMITER`の`namespace_id`を、Cloudflare account内で
   他のRate Limiting bindingと共有しない正整数文字列へ変更する。意図せず共有すると別Workerとカウンタが混在する
6. Client Secretを設定する（このコマンドはターミナルへの直接入力を求められる。チャット等には貼らないこと）:
   ```bash
   npx wrangler secret put NOTION_CLIENT_SECRET
   ```
7. `OAUTH_ENABLED = "0"`のままデプロイする:
   ```bash
   npm run deploy
   ```
8. デプロイ後に表示される`https://o2n-auth-proxy.<account>.workers.dev`のようなURLを控える
9. Notion integration設定の「Redirect URIs」に `https://<デプロイ先URL>/callback` を追加する
10. `npm run typecheck`、`npm audit`、`npx wrangler deploy --dry-run`を実行し、全bindingが表示されることを確認する
11. Cloudflare Workers Observabilityで429と内部エラーを監視できるようにする。Rate Limiting bindingは
    Cloudflareロケーション単位の緩和策であり、セッション秘密値の代替ではない
12. 上記確認後にのみ`wrangler.toml`の`OAUTH_ENABLED`を`"1"`へ変更して再デプロイする
13. `packages/cli/src/oauth-config.ts`の`AUTH_PROXY_URL`と`NOTION_OAUTH_CLIENT_ID`をこのURLとClient IDに更新する
