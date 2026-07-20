# @tk_wfl/o2n-cli

CLI for **o2n** — migrates an Obsidian vault into a Notion workspace while preserving folder
structure, note-to-note links (wikilinks), frontmatter, and attachments.

- Repository / full docs: https://github.com/TK-WFL/o2n
- License: MIT

## Install

```bash
npx @tk_wfl/o2n-cli scan <vaultPath>
# or
npm install -g @tk_wfl/o2n-cli
```

Requires Node.js 20+.

## Connect to Notion

```bash
export NOTION_TOKEN=secret_xxx
```

The destination parent page must already be connected to that integration in Notion
(Notion page → `...` menu → Connections).

## Commands

```bash
npx @tk_wfl/o2n-cli scan <vaultPath>
npx @tk_wfl/o2n-cli plan <vaultPath> --parent <NotionPageId>
npx @tk_wfl/o2n-cli migrate <vaultPath> --plan <vaultPath>/.o2n/plan.json --dry-run
npx @tk_wfl/o2n-cli migrate <vaultPath> --plan <vaultPath>/.o2n/plan.json
npx @tk_wfl/o2n-cli resume <vaultPath>
npx @tk_wfl/o2n-cli verify <vaultPath>
npx @tk_wfl/o2n-cli report <vaultPath>
```

Exit codes: `0` = fully succeeded, `1` = some notes failed, `2` = fatal error.

See the [main README](https://github.com/TK-WFL/o2n#readme) for the full command reference,
what gets converted, and the security model.
