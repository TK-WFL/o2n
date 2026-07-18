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
- **M5 公開**: 英語README・npmパッケージ設定（本README該当セクション） ✅ / 実際の`npm publish`実行は未実施
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
npx o2n scan <vaultPath>
# または
npm install -g o2n
```

MCPサーバーは別パッケージ（`@o2n/mcp-server`）。Claude Desktop等の設定で
`npx -y @o2n/mcp-server` を起動コマンドに指定する。

## 使い方（CLI）

```bash
# 1. vaultを走査（読み取りのみ）
npx o2n scan <vaultPath>

# 2. 移行計画を対話式に生成（DB化提案の承認などを聞かれる）
npx o2n plan <vaultPath> --parent <NotionページID>

# 3. 移行実行（NOTION_TOKEN 環境変数が必須。--dry-run でシミュレーションのみ）
export NOTION_TOKEN=secret_xxx
npx o2n migrate <vaultPath> --plan <vaultPath>/.o2n/plan.json --dry-run
npx o2n migrate <vaultPath> --plan <vaultPath>/.o2n/plan.json

# 4. 中断からの再開
npx o2n resume <vaultPath>

# 5. 検証・レポート確認
npx o2n verify <vaultPath>
npx o2n report <vaultPath>
```

`NOTION_TOKEN` はinternal integrationのシークレット。環境変数でのみ受け取り、
コマンドライン引数では受け取らない（シェル履歴への漏洩防止、仕様書§8）。

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
  core/          # scanner / planner / converter / migrator / state / notion / report
  cli/           # o2n コマンド（coreの薄いラッパー）
  mcp-server/    # stdio MCPサーバー（coreの薄いラッパー）
fixtures/test-vault/  # 全構文網羅のテスト用vault（fixtures/test-vault/README.md参照）
docs/
  e2e.md         # 手動E2E手順書
  questions.md   # 実装時の質問・仕様書からの逸脱点一覧
```

## §16 未確定事項（実ワークスペースでの検証待ち）

仕様書§16はNotion API実呼び出しでの検証を求めているが、本セッションではNOTION_TOKEN未提供のため
実施できていない。仕様書の想定どおりに実装した上で、検証すべき点を以下に記録する。
検証結果は `docs/e2e.md` の手順を実行後、このセクションに追記すること。

1. **enhanced markdownの`markdown`パラメータでfile_upload idを直接参照できるか**
   → 未検証。実装は仕様書の想定どおりPass 3（添付を子ブロックとして後付け）方式を採用（`packages/core/src/migrator.ts` `runPass3`）。
     直接参照が可能と判明した場合、Pass 1に統合してPass 3を廃止できる（converter.tsの出力自体は変更不要）。
2. **enhanced markdownの数式・ハイライト（背景色）対応範囲**
   → 未検証。数式(`$...$`/`$$...$$`)はそのまま出力（`converter.ts`は変換しない）。
     ハイライト`==text==`は仕様書どおり太字へ降格して出力している。Notionが背景色ハイライトを
     enhanced markdown経由でサポートすると判明すれば、降格をやめて対応構文に置き換えられる。
3. **DB行ページ作成時（parentがdata source）にmarkdownパラメータが使えるか**
   → 未検証。実装は使える前提（`parent: { data_source_id }` + `markdown`）で`migrator.ts`の`runPass1`を書いている。
     不可と判明した場合、行本文はブロックAPIでの作成に切り替える必要がある。
4. **`POST /v1/databases` のdata source構造の正確なリクエスト/レスポンス形式**
   → 未検証。`notion-db.ts`の`createDatabaseForFolder`はレスポンスに`data_sources[0].id`があればそれを、
     無ければ`id`自体をdata source idとして使う防御的実装にしている。

## 仕様書からの実装上の逸脱点

詳細は [docs/questions.md](docs/questions.md) を参照。要点:

- Notion SDK (`@notionhq/client`) のmarkdown系メソッド有無が未確認のため、`packages/core/src/notion-client.ts`は
  SDKに依存せず`fetch`ベースの薄いHTTPクライアントとして実装した（エンドポイント・ヘッダーは§4.1準拠）。
- Pass1/Pass2のリンク・添付プレースホルダーは、エイリアス違いなど1対多の表示名を扱うため
  `⟦o2n:link:リンク先相対パス⟧`ではなく`⟦o2n:link:N⟧`（ノート内出現順連番）とし、
  実際のリンク先・表示名は構造化データ（`pendingLinks`/`pendingFiles`）で保持している。
- `state.json`に仕様書の例には無い`folders`キーを追加した（page_treeモードのフォルダ=親ページ、
  databaseモードのフォルダ=DBのID管理に必要なため）。

## npm公開手順（メンテナ向け・未実施）

このリポジトリは公開の準備（`files`指定・`publishConfig`・`prepublishOnly`・LICENSE等）のみ済んでおり、
実際の`npm publish`はまだ実行していない。公開する場合の手順:

```bash
npm login
npm run build
npm test

# @o2n/core → o2n(CLI) → @o2n/mcp-server の順に依存関係があるため、この順で公開する
npm publish --workspace packages/core
npm publish --workspace packages/cli
npm publish --workspace packages/mcp-server
```

- CLIパッケージは`npx o2n`がそのまま使えるよう、npm上のパッケージ名を unscoped の `o2n` にしてある
  （`packages/cli/package.json`）。
- `@o2n/core` と `@o2n/mcp-server` はscoped packageのため`publishConfig.access: public`を設定済み。
- バージョンを上げる場合は3パッケージとも`npm version`で揃えること（`@o2n/core`への依存範囲`^0.1.0`は
  そのままでも動くが、破壊的変更時はメジャーを揃えて上げる）。
