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

Requires Node.js 20+, and `NOTION_TOKEN` (or a stored `o2n login` credential) in the
environment the MCP server runs in.

MCP access requires `O2N_ALLOWED_VAULTS=/absolute/path/to/vault` (comma-separated for multiple
vaults). Real writes are disabled by default; set `O2N_ENABLE_MCP_WRITE=1` and
`O2N_MCP_WRITE_TOKEN`, review `prepare_migration`, then pass the confirmation token to
`commit_migration`.

## Tools

`scan_vault` / `get_plan` / `update_plan` / `prepare_migration` / `commit_migration` /
`migration_status` / `get_report`

See the [main README](https://github.com/TK-WFL/o2n#readme) for the full setup guide and
security model.
