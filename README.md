# o2n

[English](README.en.md) | 日本語

Obsidian vault を Notion ワークスペースへ、フォルダ構造・ノート間リンク（wikilink）・
frontmatter・添付ファイルを保ったまま移行するツール。

仕様書「Obsidian→Notion移行ツール o2n 仕様書 v1.0」（2026-07-16作成）を唯一の正として実装した。

- リポジトリ: https://github.com/TK-WFL/o2n
- ライセンス: [MIT](LICENSE)

## 実装範囲（このリポジトリの状態）

- **M1 コアMVP**: scanner / converter / migrator（Pass1・Pass2）/ state / resume / CLI ✅
- **M2 添付**: File Upload API（単発・マルチパート）+ Pass3（添付解決） ✅
- **M3 DB化**: フォルダのDB化自動提案 + databaseモード + frontmatterマッピング ✅
- **M4 MCP**: `packages/mcp-server`（stdio、6ツール） ✅
- **M5 公開**: GitHub公開 ✅ / npm公開は一時ブロック中（下記「npm公開状況」参照）
- **レポートのNotionページ化**（M5スコープの一部）: 未実装。現状レポートはローカルの`.o2n/report.md`のみ。

## セットアップ（開発）

```bash
npm install
npm run build
npm test
```

Node.js 20+ が必要。

## インストール（npm公開後）

```bash
npx @tk_wfl/o2n-cli scan <vaultPath>
# または
npm install -g @tk_wfl/o2n-cli
```

MCPサーバーは別パッケージ（`@tk_wfl/o2n-mcp-server`）。Claude Desktop等の設定で
`npx -y @tk_wfl/o2n-mcp-server` を起動コマンドに指定する。

## 使い方（CLI）

### Notionとの連携（2通り）

**方法A: ブラウザでログイン（非エンジニア向け・推奨）**

```bash
npx @tk_wfl/o2n-cli login
```

ブラウザが開き、Notionワークスペースを選んで「許可」を押すだけで連携が完了する。
internal integrationの作成やシークレットのコピペは不要（詳細は後述の「OAuth連携の仕組み」参照）。
連携解除は`npx @tk_wfl/o2n-cli logout`、現在の連携先確認は`npx @tk_wfl/o2n-cli whoami`。

**方法B: internal integrationトークンを直接指定（エンジニア向け）**

```bash
export NOTION_TOKEN=secret_xxx
```

`NOTION_TOKEN`環境変数が設定されていればそちらが優先される。コマンドライン引数では
受け取らない（シェル履歴への漏洩防止、仕様書§8）。

### コマンド一覧

```bash
# 1. vaultを走査（読み取りのみ）
npx @tk_wfl/o2n-cli scan <vaultPath>

# 2. 移行計画を対話式に生成（DB化提案の承認などを聞かれる）
npx @tk_wfl/o2n-cli plan <vaultPath> --parent <NotionページID>

# 3. 移行実行（--dry-run でシミュレーションのみ）
npx @tk_wfl/o2n-cli migrate <vaultPath> --plan <vaultPath>/.o2n/plan.json --dry-run
npx @tk_wfl/o2n-cli migrate <vaultPath> --plan <vaultPath>/.o2n/plan.json

# 4. 中断からの再開
npx @tk_wfl/o2n-cli resume <vaultPath>

# 5. 検証・レポート確認
npx @tk_wfl/o2n-cli verify <vaultPath>
npx @tk_wfl/o2n-cli report <vaultPath>
```

終了コード: `0`=全件成功 / `1`=一部failed / `2`=致命的エラー。

## 使い方（MCP サーバー）

Claude Desktop / Claude Code から `packages/mcp-server/dist/index.js` を stdio MCP サーバーとして登録する。
ツール: `scan_vault` / `get_plan` / `update_plan` / `start_migration` / `migration_status` / `get_report`。

`start_migration` は必ずユーザーへの明示的な確認後に呼び出すこと（ツールdescriptionにも明記）。

## 所要時間の目安

仕様書§10の見積もりに準拠: 1,000ノート＋500添付 ≒ API呼び出し4,000〜5,000回 ≒ 実効2.5req/sで約30〜40分。

## リポジトリ構成

```
packages/
  core/          # scanner / planner / converter / migrator / state / notion / report / credentials
  cli/           # o2n コマンド（coreの薄いラッパー）
  mcp-server/    # stdio MCPサーバー（coreの薄いラッパー）
services/
  auth-proxy/    # `o2n login`用のOAuthコード交換代理（Cloudflare Worker、詳細は同ディレクトリのREADME参照）
fixtures/test-vault/  # 全構文網羅のテスト用vault（fixtures/test-vault/README.md参照）
docs/
  e2e.md         # 手動E2E手順書
  questions.md   # 実装時の質問・仕様書からの逸脱点一覧
```

## `o2n login`（OAuth連携）の仕組み

非エンジニアでも使えるよう、internal integrationのトークン発行・コピペを不要にするOAuthログインを用意している。

- NotionのOAuth（public integration）は`client_secret`が必須でPKCE非対応のため、CLIに`client_secret`を
  埋め込むことはできない。そこで`services/auth-proxy`（Cloudflare Worker）が`client_secret`を保持し、
  認可コード→トークンの交換だけを代行する
- CLIは乱数の`state`を生成し、ブラウザでNotionの認可画面を開く。ユーザーが承認すると、登録済みの
  Workerの`/callback`にリダイレクトされ、Workerがサーバー側でトークン交換を行い、結果を
  Cloudflare KVに**最大5分**だけ保存する
- CLIは`/poll?state=...`を数秒おきにポーリングしてトークンを受け取り、`~/.o2n/credentials.json`
  （パーミッション600）に保存する。KV上のトークンは1回取得されると即削除される
- `client_secret`はCLI・MCPサーバー・このリポジトリのどこにも含まれない（Worker環境変数のみ）
- Worker自体はVaultの内容やNotionページ内容には一切アクセスしない（トークン交換のみを行う）

デプロイ手順は[services/auth-proxy/README.md](services/auth-proxy/README.md)を参照。
デプロイ前は`packages/cli/src/oauth-config.ts`がプレースホルダーのままのため、`o2n login`は
エラーメッセージを出して`NOTION_TOKEN`環境変数の利用を案内する（安全側のフォールバック）。

## §16 未確定事項（2026-07-19 実ワークスペースで検証済み）

2026-07-19、実際のNotionワークスペース（`fixtures/test-vault`を対象）に対して`migrate`を実行し、
以下を検証した。検証中に判明した実装との差分はすべて修正済み（コミット履歴参照）。

1. **enhanced markdownの`markdown`パラメータでfile_upload idを直接参照できるか**
   → 未検証のまま（今回のテストvaultの添付ファイルアップロード自体は成功したが、直接参照方式との
     比較検証はしていない）。Pass 3方式のまま運用している。
2. **enhanced markdownの数式・ハイライト（背景色）対応範囲**
   → 未検証のまま。現状どおりハイライトは太字へ降格。
3. **DB行ページ作成時（parentがdata source）にmarkdownパラメータが使えるか**
   → ✅ **検証済み・使える**。ただし`parent`に`type: 'data_source_id'`の明示が必須と判明（省略すると
     `400: body.type should be defined`）。修正済み（`migrator.ts`）。
4. **`POST /v1/databases` のdata source構造の正確なリクエスト/レスポンス形式**
   → ✅ **検証済み**。想定と異なっていた点2つを修正:
     - `parent`に`type: 'page_id'`の明示が必須（省略すると`400: body.parent.type should be defined`）
     - `properties`はトップレベルではなく`initial_data_source.properties`配下に置く必要がある
     - レスポンスの data source id は`data_sources[0].id`で取得（想定どおり）

**追加で判明した`PATCH /v1/pages/:id/markdown`の実際のボディ形式**（仕様書には無かった検証事項）:
想定していた`{ content_updates: [{ type, old_str, new_str, ... }] }`ではなく、
`{ type: 'update_content', update_content: { content_updates: [{ old_str, new_str, replace_all_matches }] } }`
という、操作全体を表す`type`をトップレベルに置きネストするラップ構造だった（`insert_content`/`replace_content`も同様）。
修正済み（`notion-client.ts`の`MarkdownUpdateBody`型）。

**この検証で見つかったバグ2件（修正済み）**:
- dry-run実行が`state.json`に偽の`pageId`等を書き込んでしまい、直後の本実行がAPIを呼ばずスキップする不具合
  （`StateStore`に`readOnly`モードを追加して修正）
- Pass2（リンク解決）が失敗すると該当ノートが`failed`状態になり、resume時にPass1で該当ページを重複作成してしまう不具合
  （Pass2失敗時は`created`のまま保持するよう修正）

## 仕様書からの実装上の逸脱点

詳細は [docs/questions.md](docs/questions.md) を参照。要点:

- Notion SDK (`@notionhq/client`) のmarkdown系メソッド有無が未確認のため、`packages/core/src/notion-client.ts`は
  SDKに依存せず`fetch`ベースの薄いHTTPクライアントとして実装した（エンドポイント・ヘッダーは§4.1準拠）。
- Pass1/Pass2のリンク・添付プレースホルダーは、エイリアス違いなど1対多の表示名を扱うため
  `⟦o2n:link:リンク先相対パス⟧`ではなく`⟦o2n:link:N⟧`（ノート内出現順連番）とし、
  実際のリンク先・表示名は構造化データ（`pendingLinks`/`pendingFiles`）で保持している。
- `state.json`に仕様書の例には無い`folders`キーを追加した（page_treeモードのフォルダ=親ページ、
  databaseモードのフォルダ=DBのID管理に必要なため）。

## npm公開状況（メンテナ向け）

2026-07-18時点、v0.1.0を`@tk_wfl/core`・`@tk_wfl/o2n`・`@tk_wfl/mcp-server`として一度公開したが、
npmアカウントのメールアドレス変更（個人情報保護のため）に伴いv0.1.0をunpublishした。npmの仕様上
「unpublish後24時間は同一パッケージ名を再利用できない」ため、`@tk_wfl/o2n-core`・`@tk_wfl/o2n-cli`・
`@tk_wfl/o2n-mcp-server`という新しい名前でv0.1.1として再公開を試みたが、**npmレジストリ側が
このアカウントの新規パッケージ作成を一時的にブロックしている**（`npm publish`が一貫して404を返す。
トークンのスコープ・権限・メール確認はすべて問題ないことを確認済み）。おそらく短時間での
publish/unpublish/rename の繰り返しを不正利用防止システムが検知したためと推測される。
時間を置いて再試行するか、npmサポート（support@npmjs.com）への問い合わせが必要。

公開自体の準備（`files`指定・`publishConfig`・`prepublishOnly`・LICENSE等）は完了している。
再試行する場合の手順:

```bash
npm login
npm run build
npm test

# @tk_wfl/o2n-core → @tk_wfl/o2n-cli (CLI) → @tk_wfl/o2n-mcp-server の順に依存関係があるため、この順で公開する
npm publish --workspace packages/core
npm publish --workspace packages/cli
npm publish --workspace packages/mcp-server
```

- CLIパッケージ名は当初unscopedの`o2n`を予定していたが、npmのタイポスクワッティング対策
  （既存の短い名前（ol, os, opn等）と類似と判定）により拒否されたため、`@tk_wfl/o2n-cli`で公開した
  （`packages/cli/package.json`）。実行コマンド自体は`npx @tk_wfl/o2n-cli`で、bin名は`o2n`のまま。
- `@tk_wfl/o2n-core`・`@tk_wfl/o2n-cli`・`@tk_wfl/o2n-mcp-server`はいずれもscoped packageのため
  `publishConfig.access: public`を設定済み。
- バージョンを上げる場合は3パッケージとも`npm version`で揃えること（`@tk_wfl/o2n-core`への依存範囲`^0.1.0`は
  そのままでも動くが、破壊的変更時はメジャーを揃えて上げる）。
