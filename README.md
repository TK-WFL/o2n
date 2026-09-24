<div align="center">

# o2n

**Obsidian → Notion 移行ツール**

リンク・フォルダ階層・frontmatter・添付ファイルを保ったまま、vault をまるごと Notion へ。

[![npm](https://img.shields.io/npm/v/@tk_wfl/o2n-cli?label=o2n-cli&color=cb3837&logo=npm)](https://www.npmjs.com/package/@tk_wfl/o2n-cli)
[![npm](https://img.shields.io/npm/v/@tk_wfl/o2n-mcp-server?label=o2n-mcp-server&color=cb3837&logo=npm)](https://www.npmjs.com/package/@tk_wfl/o2n-mcp-server)
[![CI](https://github.com/TK-WFL/o2n/actions/workflows/ci.yml/badge.svg)](https://github.com/TK-WFL/o2n/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)

[English](README.en.md) | 日本語

</div>

---

## 🤔 なぜ o2n？

Notion の標準インポートは Obsidian 特有の書き方を解釈しないため、大きな vault ほど手直しが現実的でなくなります。o2n は **vault 全体を解析してから Notion のデータ構造に変換**します。

| Obsidian の記法 | 標準インポート | o2n |
|---|:---:|:---:|
| `[[ノート]]` wikilink | ❌ 文字列のまま | ✅ ページ間リンク（同名ノート・`aliases` も解決） |
| `![[画像.png]]` 添付 | ❌ 表示されない | ✅ アップロードして元の位置に表示 |
| frontmatter | ❌ 生テキスト | ✅ メタ情報 or **データベースのプロパティ** |
| `icon` / `cover` | ❌ | ✅ ページのアイコン・カバー |
| `> [!note]` callout | ❌ ただの引用 | ✅ 全 13 種別を色・アイコン付きで再現、折りたたみはトグルに |
| `==ハイライト==` | ❌ | ✅ 色付きハイライト（Obsidian 1.14 対応） |
| フォルダ階層 | ⚠️ 崩れがち | ✅ ページ階層として再現 |
| 途中で失敗 | 🔁 最初から | ✅ `resume` で続きから（二重作成しない） |
| 変換できなかったもの | 🤫 黙って欠落 | ✅ レポートに一覧 |

---

## 🚀 3 分で始める

### 1. Notion のトークンを用意する

[Notion 開発者ポータル → Personal access tokens](https://www.notion.so/developers/tokens) で **New token** → 名前・有効期限を選んで作成し、表示されたトークンを控えます（作成時にしか表示されません）。

```bash
export NOTION_TOKEN=ntn_xxx
```

> 💡 **個人アクセストークン（PAT）** なら、移行先ページを integration に接続する手順が不要で、Free プランのブロック上限（後述）の対象外です。他の方法は [Notion との連携方法](#-notion-との連携方法) を参照。

### 2. 計画を作る

```bash
npx @tk_wfl/o2n-cli plan <vaultのパス> --parent <移行先 Notion ページの ID>
```

フォルダごとに「ページ階層」か「データベース」かを対話で選べます（frontmatter が揃っているフォルダは自動でデータベース化を提案）。

### 3. 試してから、移行する

```bash
npx @tk_wfl/o2n-cli migrate <vaultのパス> --dry-run   # 書き込まずにシミュレーション
npx @tk_wfl/o2n-cli migrate <vaultのパス>             # 本番
npx @tk_wfl/o2n-cli verify  <vaultのパス> --deep      # Notion の実ページと照合
```

途中で止まっても `npx @tk_wfl/o2n-cli resume <vaultのパス>` で続きから再開できます。

> 🧑‍💻 **コマンドが苦手な方へ**: Claude Code / Claude Desktop に MCP サーバーとして登録すると、「この vault を Notion に移行して」と話しかけるだけで進められます → [MCP サーバーとして使う](#-mcp-サーバーとして使う)

---

## 📖 コマンド一覧

| コマンド | 役割 | 主なオプション |
|---|---|---|
| `scan <vault>` | vault を走査して件数・推定ブロック数を表示（Notion にはアクセスしない） | `--verbose` `--json` |
| `plan <vault>` | 移行計画（`.o2n/plan.json`）を対話で作成 | `--parent <id>` `--yes` `--embed-mode inline` `--link-style link` `--out <path>` |
| `migrate <vault>` | 計画に従って移行 | `--dry-run` `--plan <path>` `--quiet` `--verbose` |
| `resume <vault>` | 中断・失敗した移行を続きから再開（冪等） | `--quiet` |
| `verify <vault>` | state と vault の突き合わせ。`--deep` で Notion の実ページとも照合 | `--deep` `--json` |
| `report <vault>` | 最新のレポート（`.o2n/report.md`）を表示 | |

- `migrate --dry-run` のレポートは `.o2n/report.dry-run.md` に書かれ、本番の `report.md` を上書きしません
- `--embed-mode inline`: `![[ノート]]` の埋め込みを、リンクではなく本文にその場で展開します（`![[ノート#見出し]]` はそのセクションのみ）
- 終了コード: `0` 全件成功 / `1` 一部失敗・不一致あり / `2` 致命的エラー

---

## 🔑 Notion との連携方法

トークンは常に `NOTION_TOKEN` 環境変数で渡します（コマンドライン引数では受け取りません — シェル履歴への漏洩防止）。

<details>
<summary><b>方法 A: 個人アクセストークン（PAT）— 推奨</b></summary>

[開発者ポータル「Personal access tokens」](https://www.notion.so/developers/tokens) で **New token** → 名前・権限（Notion API）・有効期限（7 日〜1 年）を選んで作成。

- 作成した本人がアクセスできるページにそのまま書き込めるため、**ページごとに integration を接続する手順が不要**
- 有効期限付きで、ワークスペース管理者が一覧・失効できる
- Notion Free プランのブロック上限の対象外
- 2026 年 5 月に追加された機能。古いワークスペース設定では「Connections」タブから辿れる

</details>

<details>
<summary><b>方法 B: internal integration のトークン</b></summary>

ワークスペース単位で動く integration を作り、そのトークン（同じ `ntn_` 形式）を設定します。
移行先の親ページを事前にその integration に **接続（Connect）** しておく必要があります（ページ右上の `…` → 「接続先」）。未接続のページを指定すると `plan` / `migrate` 時に `404 Could not find page` になります。

</details>

<details>
<summary><b>方法 C: ブラウザでログイン（既定停止中）</b></summary>

```bash
npx @tk_wfl/o2n-cli login
```

旧 OAuth poll 方式にトークン窃取リスクが見つかったため、既定で停止しています。検証目的で新しい loopback handoff 方式を使う場合のみ `O2N_ENABLE_BROWSER_LOGIN=1` を明示してください。旧バージョンで `o2n login` を利用した場合は、Notion 側で該当トークンを失効・再発行することを推奨します。仕組みは「セキュリティ」節の折りたたみを参照。

</details>

---

## 🤖 MCP サーバーとして使う

Claude Desktop / Claude Code の MCP 設定に `npx -y @tk_wfl/o2n-mcp-server` を登録します。

```json
{
  "mcpServers": {
    "o2n": {
      "command": "npx",
      "args": ["-y", "@tk_wfl/o2n-mcp-server"],
      "env": {
        "NOTION_TOKEN": "ntn_xxx",
        "O2N_ALLOWED_VAULTS": "/absolute/path/to/vault"
      }
    }
  }
}
```

| ツール | 役割 |
|---|---|
| `scan_vault` | vault を走査（読み取りのみ） |
| `get_plan` / `update_plan` | 計画の確認・調整（`folders` / `skipList` / `embedMode`） |
| `prepare_migration` | 移行内容（対象・移行先・件数）を固定して `requestId` を返す |
| `commit_migration` | 固定した内容を実行。本実行には確認トークンが必須 |
| `resume_migration` / `cancel_migration` | 続きから再開 / ノート境界で中断 |
| `migration_status` / `verify_migration` / `get_report` | 進捗・検証・レポート |

🔒 **安全設計**: `O2N_ALLOWED_VAULTS` に無い vault へはアクセスできません。Notion への本実行は既定で無効で、`O2N_ENABLE_MCP_WRITE=1` と `O2N_MCP_WRITE_TOKEN` を設定したうえで `commit_migration` に確認トークンを渡す必要があります。失敗・拒否の応答は `isError` 付きで返ります。

---

## 🔄 変換される内容

<details>
<summary><b>対応表を開く</b></summary>

| Obsidian | Notion での扱い |
|---|---|
| `[[ノート]]` | **ページメンション**（Notion のバックリンクに現れ、改名にも追従）。`plan --link-style link` で URL リンク |
| `[[ノート\|表示名]]`、`aliases` 経由の `[[別名]]` | 書いた表示名のままの URL リンク（大文字小文字非依存で解決） |
| `[[ノート#見出し]]` `[[#見出し]]` `[x](note.md#見出し)` | **その見出しへのリンク**（見出しが無ければページ先頭にして報告） |
| `[[ノート#^id]]` | ページ先頭へのリンク（Notion にブロック参照が無いため。レポートに記録） |
| `![[ノート]]` `![[ノート#見出し]]` | 既定はリンク。`--embed-mode inline` で本文を展開（循環・深さ 3 以上はリンク） |
| `![[画像.png\|300]]` `![図](img/a.png)` `[資料](a.pdf)` `[[表.xlsx]]` | アップロードして元の位置に画像 / PDF / 音声 / 動画 / ファイルブロック。docx・xlsx・pptx・zip・csv など任意の形式に対応（Notion が受け付けない形式はレポートに記録） |
| `[テキスト](note.md#見出し)` | wikilink と同じ解決（`.MD` も可） |
| frontmatter | page_tree: 冒頭のメタ callout / database: プロパティ（title・rich_text・number・checkbox・date・multi_select・url） |
| `icon` `cover` `banner` | ページのアイコン（絵文字・URL・vault 内画像）・カバー（URL・vault 内画像） |
| `tags`（配列 / `a, b`） | multi_select |
| `> [!type]` callout | 全 13 種別＋別名を色・アイコンに対応。`[!type]-` はトグル。コードブロックやネストも保持 |
| `==text==` `==🔴text==` | ハイライト（色付きは色を反映） |
| `- [ ]` `- [x]` | To-do。`[/]` `[-]` 等は未完了に正規化し元記号を本文に残す |
| `#` 〜 `####` | 見出し（h5/h6 は h4 に降格しレポートに記録） |
| 数式 `$…$` `$$…$$`、mermaid | そのまま保持 |
| `%% コメント %%` `<!-- コメント -->` | 削除（コードブロックをまたぐものも） |
| `[^1]` 脚注、`^[インライン脚注]` | 文中に展開 |
| 行末のブロック ID `^abc123` | 取り除く（Obsidian でも非表示のため） |
| インラインコード・コードブロック | 中身は変換しない |
| Excalidraw ノート | 同名の書き出し画像（`.png` / `.svg`）があれば画像として移行、無ければスキップ |
| `.canvas` `.base`、Dataview の実行結果 | 非対応（レポートに記録） |

</details>

フォルダ直下のノートの 60% 以上が共通の frontmatter キーを 3 つ以上持つ場合、そのフォルダの **データベース化を自動提案**します（最終判断は `plan` で行います）。

---

## ⏱ 所要時間と制限

- **目安**: 1,000 ノート＋500 添付 ≒ API 呼び出し 4,000〜5,000 回 ≒ 約 30〜40 分（既定 2 req/秒）
- Business プラン以上なら `O2N_REQUESTS_PER_SECOND=8`（1〜10）で短縮できます。429 は `Retry-After` に従って自動で待ちます
- **Notion Free プランのブロック上限**（2026 年 9 月〜）: 複数メンバーの Free ワークスペースは生涯 1,000 ブロックが API にも適用されます（[公式リファレンス](https://developers.notion.com/reference/workspace-block-limits)）。`scan` / `plan` が推定ブロック数で事前警告し、上限に達した場合は即座に中断して `resume` で再開できます。PAT・有料プラン・メンバー 1 人の Free は対象外です

---

## 🛡 セキュリティ

- トークンは環境変数 `NOTION_TOKEN` か `~/.o2n/credentials.json`（パーミッション 600）にのみ保存
- vault 本体は **常に読み取り専用**。書き込むのは `.o2n/` ディレクトリのみ
- frontmatter は YAML のみ受け付け、`---js` / `---json` などはそのノートだけを安全にスキップ
- vault 内のシンボリックリンクは辿らない。`.o2n/` と `~/.o2n/` は symlink / hardlink / TOCTOU 攻撃を防ぐ形で読み書き
- `.o2n/state.json` は vault・計画・Notion ワークスペースに署名で結合され、取り違えを検知
- 悪意のある vault で処理をハングさせる ReDoS への対策済み
- Notion API 以外への通信なし（テレメトリなし）。npm パッケージは Trusted Publishing（OIDC）で **provenance 付き**で公開

<details>
<summary><b><code>o2n login</code>（OAuth 連携）の仕組みと信頼モデル</b></summary>

- Notion の OAuth（public integration）は `client_secret` が必須なため CLI に埋め込めません。代わりに `services/auth-proxy`（Cloudflare Worker）が `client_secret` を保持し、認可コード → トークンの交換だけを代行します
- 新方式では CLI が `127.0.0.1` の一時 HTTP リスナーを開き、Worker は交換後に短寿命の handoff code だけを loopback へ返します。CLI はセッション秘密値と handoff code を Worker へ POST し、一度だけトークンを受け取って `~/.o2n/credentials.json` に保存します
- `client_secret` は CLI・MCP サーバー・このリポジトリのどこにも含まれません（Worker 環境変数のみ）。Worker は vault や Notion ページの内容にはアクセスしません
- 再有効化する場合、Worker 運用者（TK-WFL または自己ホスト）を信頼する必要があります。`NOTION_TOKEN` を使う方法はこの信頼モデルに依存しません。デプロイ手順は [services/auth-proxy/README.md](services/auth-proxy/README.md)

</details>

---

## 🧑‍🔧 開発

```bash
npm install
npm run build
npm test
```

```
packages/
  core/          # scanner / planner / converter / migrator / state / notion / report
  cli/           # o2n コマンド（core の薄いラッパー）
  mcp-server/    # stdio MCP サーバー（core の薄いラッパー）
services/
  auth-proxy/    # `o2n login` 用の OAuth コード交換代理（Cloudflare Worker）
fixtures/test-vault/  # 全構文網羅のテスト用 vault
scripts/verify-release.mjs  # npm 公開前の内容・チェックサム検証
docs/
  e2e.md         # 手動 E2E 手順書
  questions.md   # 実装判断と実ワークスペースでの検証記録
  spec.md        # セキュリティ境界・永続化データの仕様
```

不具合報告・要望は [Issues](https://github.com/TK-WFL/o2n/issues) へ。変換がうまくいかない記法があれば、その断片を添えてもらえると助かります。

<div align="center">

MIT License · [TK-WFL](https://github.com/TK-WFL)

</div>
