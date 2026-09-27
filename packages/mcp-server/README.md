# @tk_wfl/o2n-mcp-server

Stdio MCP server for **o2n** — migrates an Obsidian vault into a Notion workspace from a
conversation in Claude Desktop / Claude Code, while preserving folder structure, wikilinks,
frontmatter, and attachments.

- Repository / full docs: https://github.com/TK-WFL/o2n
- License: MIT

## Setup

Register `@tk_wfl/o2n-mcp-server` as a stdio MCP server:

```
npx -y @tk_wfl/o2n-mcp-server
```

Requires Node.js 20+, and `NOTION_TOKEN` in the environment the MCP server runs in, or a token
saved with `npx @tk_wfl/o2n-cli login --token` (an empty `NOTION_TOKEN` falls back to the saved one). The simplest token is a Notion **personal access token**
(developer portal → Personal access tokens → New token); it needs no per-page connect step.

MCP access requires allowed vaults: set `O2N_ALLOWED_VAULTS=/absolute/path/to/vault` (comma-separated
for multiple vaults), or save them with `npx @tk_wfl/o2n-cli mcp allow <vault>`. Real writes are disabled
by default. Enable them with `O2N_ENABLE_MCP_WRITE=1` (or `true`) and `O2N_MCP_WRITE_TOKEN`, or with
`npx @tk_wfl/o2n-cli mcp write on`, review `prepare_migration`, then pass the confirmation phrase to
`commit_migration`. Env vars with a value take precedence over the saved settings
(`~/.o2n/mcp-settings.json`). `mcp allow` and `mcp write on` only work in an interactive terminal.

## Tools

`scan_vault` / `get_plan` / `update_plan` / `prepare_migration` / `commit_migration` /
`resume_migration` / `cancel_migration` / `migration_status` / `verify_migration` (pass `deep: true` to compare against the real Notion pages) / `get_report`

See the [main README](https://github.com/TK-WFL/o2n#readme) for the full setup guide and
security model.
