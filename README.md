# o2n

[English](README.en.md) | 日本語

Obsidian vault を Notion ワークスペースへ、フォルダ構造・ノート間リンク（wikilink）・
frontmatter・添付ファイルを保ったまま移行するツール。CLIとMCPサーバー（Claude Desktop / Claude Code向け）の
両方から使える。

- リポジトリ: https://github.com/TK-WFL/o2n
- ライセンス: [MIT](LICENSE)

## インストール

```bash
# CLI
npx @tk_wfl/o2n-cli scan <vaultPath>
# またはグローバルインストール
npm install -g @tk_wfl/o2n-cli
```

MCPサーバーは別パッケージ（`@tk_wfl/o2n-mcp-server`）。Claude Desktop / Claude Codeの設定で
`npx -y @tk_wfl/o2n-mcp-server` を起動コマンドに指定する。

Node.js 20+ が必要。

## 使い方（CLI）

### Notionとの連携（2通り）

**方法A: internal integrationトークンを直接指定（推奨）**

```bash
export NOTION_TOKEN=secret_xxx
```

`NOTION_TOKEN`環境変数が設定されていればそちらが優先される。コマンドライン引数では
受け取らない（シェル履歴への漏洩防止）。

**方法B: ブラウザでログイン（既定停止中）**

```bash
npx @tk_wfl/o2n-cli login
```

旧OAuth poll方式にトークン窃取リスクが見つかったため、ブラウザログインは既定で停止している。
検証目的で新しいloopback handoff方式を使う場合のみ、`O2N_ENABLE_BROWSER_LOGIN=1` を明示する。
旧バージョンで `o2n login` を利用した場合は、Notion側で該当トークンを失効・再発行することを推奨する。

### コマンド一覧

移行先にする親ページは、事前にNotion側で使用中のintegration（internal integrationまたは`o2n login`で
連携したintegration）に**接続（Connect）**しておく必要がある。未接続のページを指定すると、
`plan`/`migrate`実行時に`404 Could not find page`エラーになる。

```bash
# 1. vaultを走査（読み取りのみ）
npx @tk_wfl/o2n-cli scan <vaultPath>

# 2. 移行計画を対話式に生成（フォルダごとにページ階層/データベース化を選べる）
npx @tk_wfl/o2n-cli plan <vaultPath> --parent <NotionページID>

# 3. 移行実行（--dry-run でシミュレーションのみ、書き込みAPIを呼ばない）
npx @tk_wfl/o2n-cli migrate <vaultPath> --plan <vaultPath>/.o2n/plan.json --dry-run
npx @tk_wfl/o2n-cli migrate <vaultPath> --plan <vaultPath>/.o2n/plan.json

# 4. 中断からの再開（同じコマンドで冪等に完了まで進む）
npx @tk_wfl/o2n-cli resume <vaultPath>

# 5. 検証・レポート確認
npx @tk_wfl/o2n-cli verify <vaultPath>
npx @tk_wfl/o2n-cli report <vaultPath>
```

終了コード: `0`=全件成功 / `1`=一部failed / `2`=致命的エラー。

## 使い方（MCPサーバー）

Claude Desktop / Claude Code から `@tk_wfl/o2n-mcp-server` を stdio MCP サーバーとして登録する。
ツール: `scan_vault` / `get_plan` / `update_plan` / `prepare_migration` / `commit_migration` / `migration_status` / `get_report`。

MCPからvaultへアクセスするには、`O2N_ALLOWED_VAULTS=/absolute/path/to/vault` のように許可vaultを
カンマ区切りで明示する。Notionへの本実行は既定で無効で、`O2N_ENABLE_MCP_WRITE=1` と
`O2N_MCP_WRITE_TOKEN` を設定したうえで、`prepare_migration` の内容を確認してから
`commit_migration` に確認トークンを渡す必要がある。`start_migration` は安全上の理由で無効化された。

## 変換される内容

- Wikilink（`[[ノート]]`、エイリアス、見出しリンクなど）→ Notionページ間リンク
- frontmatter → ページ内メタ情報（page_treeモード）またはデータベースのプロパティ（databaseモード）
- 画像・PDF等の添付ファイル → アップロードして元の位置に表示
- Obsidianのcallout → Notionのcallout（種別ごとの色・アイコン対応）
- ハイライト（`==text==`）→ Notionのネイティブハイライト
- 数式（`$...$` / `$$...$$`）、mermaidコードブロック → そのまま保持
- 対応していない要素（Canvas、Dataviewの実行結果、トランスクルージョン等）はレポートに記録される

フォルダごとに、直下ノートの60%以上が共通のfrontmatterキーを3つ以上持つ場合はデータベース化を自動提案する
（最終判断は`plan`コマンドでユーザーが行う）。

## 所要時間の目安

1,000ノート＋500添付 ≒ API呼び出し4,000〜5,000回 ≒ 実効2.5req/sで約30〜40分。

## リポジトリ構成

```
packages/
  core/          # scanner / planner / converter / migrator / state / notion / report / credentials
  cli/           # o2n コマンド（coreの薄いラッパー）
  mcp-server/    # stdio MCPサーバー（coreの薄いラッパー）
services/
  auth-proxy/    # `o2n login`用のOAuthコード交換代理（Cloudflare Worker）
fixtures/test-vault/  # 全構文網羅のテスト用vault
docs/
  e2e.md         # 手動E2E手順書
  questions.md   # 実装判断の記録
```

## `o2n login`（OAuth連携）の仕組み

- NotionのOAuth（public integration）は`client_secret`が必須なため、CLIに埋め込むことはできない。
  代わりに`services/auth-proxy`（Cloudflare Worker）が`client_secret`を保持し、認可コード→トークンの
  交換だけを代行する
- 旧poll方式は停止済み。新方式ではCLIが`127.0.0.1`の一時HTTPリスナーを開き、Workerは認可コードを
  トークンへ交換した後、短寿命のhandoff codeだけをloopbackへ返す。CLIは手元のセッション秘密値と
  handoff codeをWorkerへPOSTし、一度だけトークンを受け取って`~/.o2n/credentials.json`
  （パーミッション600）に保存する
- `client_secret`はCLI・MCPサーバー・このリポジトリのどこにも含まれない（Worker環境変数のみ）
- Workerはトークン交換のみを行い、Vaultの内容やNotionページ内容には一切アクセスしない

デプロイ手順は[services/auth-proxy/README.md](services/auth-proxy/README.md)を参照。

## 開発

```bash
npm install
npm run build
npm test
```

実装判断の詳細・仕様書からの差分は[docs/questions.md](docs/questions.md)を参照。

## セキュリティ

- Notionトークンは環境変数（`NOTION_TOKEN`）または`~/.o2n/credentials.json`（`o2n login`経由、パーミッション600）にのみ保存される
- frontmatterはYAMLのみ対応。`---js` / `---javascript` / `---json` などの非YAML frontmatterは安全側に拒否される
- `.o2n/state.json` はstate v2としてcanonical vault、plan hash、Notion識別子、ローカル署名で結合される
- Vaultへの書き込みは`.o2n/`ディレクトリのみ（Vault本体は読み取り専用）
- Vault内のシンボリックリンクは辿らない（vault外ファイルへのアクセス防止）
- MCPサーバーは`realpath()`済みのvaultが`O2N_ALLOWED_VAULTS`に含まれる場合のみ読み書きする
- Notion API以外への通信は行わない（テレメトリなし）

### `o2n login`（共有auth-proxy）の信頼モデル

`o2n login`は既定停止中。再有効化する場合も、TK-WFLまたは自己ホストしたCloudflare Workerが
Notionの`client_secret`を扱うため、Worker運用者を信頼する必要がある。`NOTION_TOKEN`環境変数を
使う方法（internal integration）はこの信頼モデルに依存しない。
