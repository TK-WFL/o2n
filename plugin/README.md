# o2n: Obsidian to Notion

o2n moves an Obsidian vault into a Notion workspace while you talk with Claude. Folders become a page tree or databases, and `[[wikilinks]]` become page mentions that show up as backlinks. Frontmatter and Dataview `key:: value` fields become database properties. Images and other attachments are uploaded to Notion.

You can scan the vault and review the plan first. A dry run shows what would happen without touching Notion. Runs are resumable: if a run stops, the next one continues where it left off, and notes you moved, renamed or edited later update the same Notion pages.

Full documentation lives in the [o2n repository](https://github.com/TK-WFL/o2n#readme). The Japanese guide is the main README there.

## Where it works

The plugin starts a local MCP server on your computer, because it has to read your vault from disk.

| Surface | Works? |
|---|---|
| Claude Code (terminal, IDE, desktop Code tab) | Yes. Claude Code asks for the settings below when you enable the plugin. |
| Cowork on your computer | Partly. Cowork does not show the settings dialog, so the allowed vault paths stay empty and every vault is refused. Use Claude Code for now. |
| Chat on claude.ai, desktop and mobile | No. Chat does not start local MCP servers. |

It needs Node.js 20 or later, because the server is started with `npx`.

## Settings

| Setting | What it does |
|---|---|
| Allowed vault paths | Absolute paths of the vaults o2n may read, separated by commas. Every other folder is refused. |
| Notion token | A Notion personal access token, which is recommended, or an internal integration token. It is stored in your system's secure credential store. Leave it empty to use a token you saved with `npx @tk_wfl/o2n-cli login --token`. |
| Allow writing to Notion | Off by default. While it is off, o2n only scans, plans and runs dry runs. |
| Confirmation phrase | At least 16 characters. A real migration starts only when Claude passes this exact phrase, so say it in chat only when you want the migration to run. |
| Notion requests per second | 1 to 10, default 2. Keep 2 or 3 on Notion Free and Plus. |

Create a personal access token in Notion under Developers, then Personal access tokens, then New token. It writes with your own permissions, so you do not need to connect pages to an integration.

## How to use it

Ask Claude something like "Scan my vault at /Users/me/Notes and plan a migration to this Notion page", and give it the page URL. Claude then works through the steps below.

1. It scans the vault and shows the folders, notes and attachments it found.
2. It proposes a plan, for example which folders become databases, and you can change it.
3. It runs a dry run and reports what would be created.
4. With writing allowed and your confirmation phrase, it runs the real migration and reports progress.
5. It checks the result against Notion and writes a report into the vault.

The tools are `scan_vault`, `get_plan`, `update_plan`, `prepare_migration`, `commit_migration`, `resume_migration`, `cancel_migration`, `migration_status`, `verify_migration` and `get_report`.

## What the plugin runs, reads, writes and sends

- **Runs**: `npx -y @tk_wfl/o2n-mcp-server` at the exact version pinned in `.mcp.json`. npx downloads that package and its dependencies from the npm registry. The package is published from the public repository with npm provenance.
- **Reads**:
  - Markdown notes and attachments inside the allowed vault paths.
  - `~/.o2n/credentials.json` when the Notion token setting is empty.
- **Writes, inside the vault**: a `.o2n/` folder with the plan, the migration state and the report.
- **Writes, in your home folder**: `~/.o2n/` holds the key that signs the migration state, and the token if you saved one with the CLI.
- **Sends**: note content, properties and attachments go only to the Notion API at `api.notion.com`, using your token. o2n has no telemetry and no other network destinations.
- **Changes in Notion**: it creates pages, databases and file uploads under the parent page you choose. When a note changed since the last run, it replaces that page's content with the new version. It never deletes or trashes Notion pages.

## License

MIT. See [LICENSE](LICENSE).

---

**日本語**：Obsidian の vault を、Claude との会話から Notion へ移行するプラグインです。フォルダ構成、ウィキリンク、frontmatter、Dataview のフィールド、添付ファイルを保ったまま移します。dry run で確認してから本実行でき、途中で止まっても続きから再開できます。使えるのは Claude Code です。設定と使い方の詳細は [リポジトリの README](https://github.com/TK-WFL/o2n#readme) を見てください。
