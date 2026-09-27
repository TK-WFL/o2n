# Privacy Policy

Effective: 2026-09-27

This policy covers o2n: the command-line tool `@tk_wfl/o2n-cli`, the MCP server `@tk_wfl/o2n-mcp-server`, the library `@tk_wfl/o2n-core`, and the Claude plugin in [`plugin/`](plugin/). o2n is open-source software maintained by TK-WFL. [日本語は下にあります](#プライバシーポリシー日本語).

## Summary

- o2n runs on your own computer. The developer operates no server for it and receives none of your data.
- o2n has no telemetry, analytics or crash reporting.
- o2n sends your notes only to the Notion API, using the Notion token you provide, into the Notion workspace you choose.

## What o2n reads

- The Markdown notes and attachments in the Obsidian vault you point it at. The MCP server and the Claude plugin read only vaults you have explicitly allowed.
- Your Notion token and o2n settings saved on your computer, listed below.

Your notes can contain personal data, such as names or email addresses. o2n does not look for it, extract it or treat it differently from other text.

## Where o2n sends data

- **Notion API (`api.notion.com`)**: note content, frontmatter and Dataview fields as page properties, and attachments, sent with your token. o2n also reads back page information to link, update and verify pages. Notion processes this data under its own privacy policy.
- **npm registry**: when you run o2n with `npx`, npm downloads the package from the npm registry.
- **Claude**, only when you use the MCP server or the Claude plugin: the tools return summaries to Claude, such as counts, folder names, note paths, frontmatter key names, the migration plan, progress, the report and error messages. The tools do not return the full text of your notes. Claude processes this under Anthropic's terms and privacy policy.
- **Browser login, off by default**: if you turn on the optional `o2n login` browser flow with `O2N_ENABLE_BROWSER_LOGIN=1`, a Cloudflare Worker operated by TK-WFL exchanges the Notion authorization code for a token and hands it back to your computer once. It does not see your vault or your Notion pages. `o2n login --token` and `NOTION_TOKEN` do not use it.

o2n sends nothing anywhere else.

## What o2n stores on your computer

In your vault, in the `.o2n/` folder:

- `plan.json`: the migration plan, such as folder modes and property names.
- `state.json`: which notes were migrated, with their paths, content fingerprints and Notion page IDs. It is signed to detect tampering.
- `report.md` and `report.dry-run.md`: the migration report, with note paths, Notion page URLs and warnings.
- `job.json`: the progress of a migration started from the MCP server.

In your home folder, in `~/.o2n/`, readable only by your user account:

- `credentials.json`: the Notion token and workspace name saved by `o2n login --token`.
- `mcp-settings.json`: the allowed vault paths, the write setting and the confirmation phrase saved by `o2n mcp`.
- `state-signing-key`: the key that signs `state.json`.

When you use the Claude plugin in Claude Code, the plugin settings you enter are stored by Claude Code. Sensitive settings, such as the Notion token and the confirmation phrase, go to your system's secure credential store.

## Deleting your data

- Delete the `.o2n/` folder in your vault and the `~/.o2n/` folder in your home folder.
- Run `o2n logout` to remove only the saved token, and `o2n mcp write off` to remove the confirmation phrase.
- Revoke the token in Notion's developer settings.
- Pages that o2n created stay in your Notion workspace until you delete them there.

## Children

o2n is not directed at people under 18.

## Changes and contact

Changes to this policy are made in this file, and its history is visible on GitHub. For questions, open an issue at <https://github.com/TK-WFL/o2n/issues>. Report security problems as described in [SECURITY.md](SECURITY.md).

---

# プライバシーポリシー（日本語）

施行日：2026年9月27日

このポリシーは o2n に適用されます。対象は、コマンドラインツール `@tk_wfl/o2n-cli`、MCP サーバー `@tk_wfl/o2n-mcp-server`、ライブラリ `@tk_wfl/o2n-core`、[`plugin/`](plugin/) の Claude プラグインです。o2n は TK-WFL が開発するオープンソースソフトウェアです。英語版と内容に違いがある場合は、英語版が優先します。

## 概要

- o2n は利用者のパソコンの上で動きます。開発者は o2n のためのサーバーを運営しておらず、利用者のデータを一切受け取りません。
- テレメトリ、アクセス解析、クラッシュレポートの送信はありません。
- ノートを送る先は Notion API だけです。利用者が用意したトークンで、利用者が選んだワークスペースに書き込みます。

## 読むもの

- 指定した Obsidian vault の Markdown ノートと添付ファイル。MCP サーバーと Claude プラグインは、利用者が明示的に許可した vault しか読みません。
- 利用者のパソコンに保存した Notion のトークンと o2n の設定（下記）。

ノートには人名やメールアドレスなどの個人データが含まれることがあります。o2n はそれを探したり、取り出したり、ほかの文章と区別して扱ったりはしません。

## 送る先

- **Notion API（`api.notion.com`）**：ノートの本文、frontmatter と Dataview のフィールド（ページのプロパティとして）、添付ファイルを、利用者のトークンで送ります。リンクの設定や更新、照合のために、ページの情報も読み取ります。これらのデータは Notion のプライバシーポリシーに従って扱われます。
- **npm レジストリ**：`npx` で実行すると、npm がパッケージをダウンロードします。
- **Claude**（MCP サーバーや Claude プラグインを使う場合だけ）：ツールは Claude に要約を返します。件数、フォルダ名、ノートのパス、frontmatter のキー名、移行計画、進捗、レポート、エラー文などです。ノートの本文そのものは返しません。これらは Anthropic の規約とプライバシーポリシーに従って扱われます。
- **ブラウザでのログイン（既定では停止）**：`O2N_ENABLE_BROWSER_LOGIN=1` で任意の `o2n login` を有効にした場合に限り、TK-WFL が運営する Cloudflare Worker が Notion の認可コードをトークンに交換し、一度だけ利用者のパソコンへ渡します。vault や Notion のページは見ません。`o2n login --token` と `NOTION_TOKEN` はこれを使いません。

これ以外にデータを送ることはありません。

## 利用者のパソコンに保存するもの

vault の中の `.o2n/` フォルダ：

- `plan.json`：移行計画（フォルダの扱い、プロパティ名など）
- `state.json`：移行済みのノート（パス、内容の指紋、Notion のページ ID）。改ざん検知のため署名つき
- `report.md` と `report.dry-run.md`：移行レポート（ノートのパス、Notion ページの URL、警告）
- `job.json`：MCP サーバーから始めた移行の進捗

ホームフォルダの `~/.o2n/`（利用者本人だけが読める）：

- `credentials.json`：`o2n login --token` で保存した Notion のトークンとワークスペース名
- `mcp-settings.json`：`o2n mcp` で保存した許可 vault、書き込みの設定、確認フレーズ
- `state-signing-key`：`state.json` の署名に使う鍵

Claude Code で Claude プラグインを使う場合、入力した設定は Claude Code が保存します。Notion のトークンや確認フレーズなどの秘密の設定は、OS の安全な保管場所に入ります。

## データの消し方

- vault の `.o2n/` フォルダと、ホームフォルダの `~/.o2n/` フォルダを削除してください。
- 保存したトークンだけを消すには `o2n logout`、確認フレーズを消すには `o2n mcp write off` を実行してください。
- Notion の開発者設定で、トークンを失効させてください。
- o2n が作った Notion のページは、Notion で削除するまで残ります。

## 18歳未満の方

o2n は 18 歳未満の方を対象にしていません。

## 変更と問い合わせ

このポリシーの変更はこのファイルで行い、履歴は GitHub で確認できます。問い合わせは <https://github.com/TK-WFL/o2n/issues> に issue を立ててください。セキュリティ上の問題は [SECURITY.md](SECURITY.md) の方法で報告してください。
