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

**方法A: ブラウザでログイン（推奨）**

```bash
npx @tk_wfl/o2n-cli login
```

ブラウザが開き、Notionワークスペースを選んで「許可」を押すだけで連携が完了する。
internal integrationの作成やシークレットのコピペは不要（仕組みは後述）。
連携解除は`logout`、現在の連携先確認は`whoami`。

**方法B: internal integrationトークンを直接指定**

```bash
export NOTION_TOKEN=secret_xxx
```

`NOTION_TOKEN`環境変数が設定されていればそちらが優先される。コマンドライン引数では
受け取らない（シェル履歴への漏洩防止）。

### コマンド一覧

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
ツール: `scan_vault` / `get_plan` / `update_plan` / `start_migration` / `migration_status` / `get_report`。

`start_migration` は必ずユーザーへの明示的な確認後に呼び出される（ツールのdescriptionにも明記）。

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
- CLIはブラウザでNotionの認可画面を開き、承認されるとWorkerがサーバー側でトークン交換を行い、
  結果をCloudflare KVに最大5分だけ保存する。CLIはポーリングで受け取り、
  `~/.o2n/credentials.json`（パーミッション600）に保存する。KV上のトークンは1回取得されると即削除される
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
- 書き込み先は指定した親ページ配下のみ
- Vaultへの書き込みは`.o2n/`ディレクトリのみ（Vault本体は読み取り専用）
- Notion API以外への通信は行わない（テレメトリなし）
