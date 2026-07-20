# o2n

English | [日本語](README.md)

A tool that migrates an Obsidian vault into a Notion workspace while preserving folder structure,
note-to-note links (wikilinks), frontmatter, and attachments. Usable from both a CLI and an MCP
server (for Claude Desktop / Claude Code).

- Repository: https://github.com/TK-WFL/o2n
- License: [MIT](LICENSE)

## Install

```bash
# CLI
npx @tk_wfl/o2n-cli scan <vaultPath>
# or install globally
npm install -g @tk_wfl/o2n-cli
```

The MCP server is a separate package (`@tk_wfl/o2n-mcp-server`). Point Claude Desktop's / Claude
Code's config at `npx -y @tk_wfl/o2n-mcp-server` as the launch command.

Requires Node.js 20+.

## CLI usage

### Connecting to Notion (two ways)

**Option A: browser login (recommended)**

```bash
npx @tk_wfl/o2n-cli login
```

Opens a browser, you pick a workspace and click "Allow" — no internal integration or secret
copy-pasting required (see "How `o2n login` works" below). `logout` disconnects; `whoami` shows
the current connection.

**Option B: internal integration token**

```bash
export NOTION_TOKEN=secret_xxx
```

The `NOTION_TOKEN` env var takes priority over a stored login if both are present. It is never
accepted as a CLI argument (to avoid leaking it into shell history).

### Commands

```bash
# 1. Scan the vault (read-only)
npx @tk_wfl/o2n-cli scan <vaultPath>

# 2. Generate a migration plan interactively (choose page-tree vs. database per folder)
npx @tk_wfl/o2n-cli plan <vaultPath> --parent <NotionPageId>

# 3. Run the migration (--dry-run simulates without calling any write API)
npx @tk_wfl/o2n-cli migrate <vaultPath> --plan <vaultPath>/.o2n/plan.json --dry-run
npx @tk_wfl/o2n-cli migrate <vaultPath> --plan <vaultPath>/.o2n/plan.json

# 4. Resume an interrupted migration (idempotent, same command runs to completion)
npx @tk_wfl/o2n-cli resume <vaultPath>

# 5. Verify and inspect the report
npx @tk_wfl/o2n-cli verify <vaultPath>
npx @tk_wfl/o2n-cli report <vaultPath>
```

Exit codes: `0` = fully succeeded, `1` = some notes failed, `2` = fatal error.

## MCP server usage

Register `@tk_wfl/o2n-mcp-server` as a stdio MCP server in Claude Desktop / Claude Code.
Tools: `scan_vault` / `get_plan` / `update_plan` / `start_migration` / `migration_status` / `get_report`.

`start_migration` is only invoked after explicit user confirmation (stated in the tool's description).

## What gets converted

- Wikilinks (`[[note]]`, aliases, heading links, etc.) → Notion page-to-page links
- Frontmatter → in-page metadata (page-tree mode) or database properties (database mode)
- Images, PDFs, and other attachments → uploaded and shown in their original position
- Obsidian callouts → Notion callouts (icon/color per type)
- Highlights (`==text==`) → native Notion highlight
- Math (`$...$` / `$$...$$`) and mermaid code blocks → passed through as-is
- Unsupported elements (Canvas, Dataview query results, transclusion, etc.) are recorded in the report

For each folder, if 60%+ of its direct notes share 3 or more common frontmatter keys, database mode
is suggested automatically (the final call is always made by the user via `plan`).

## Time estimate

Roughly 1,000 notes + 500 attachments ≈ 4,000–5,000 API calls ≈ ~30–40 minutes at an effective
rate of 2.5 req/s.

## Repository layout

```
packages/
  core/          # scanner / planner / converter / migrator / state / notion / report / credentials
  cli/           # the o2n command (thin wrapper over core)
  mcp-server/    # stdio MCP server (thin wrapper over core)
services/
  auth-proxy/    # OAuth code-exchange proxy for `o2n login` (Cloudflare Worker)
fixtures/test-vault/  # test vault covering every supported syntax
docs/
  e2e.md         # manual end-to-end test procedure
  questions.md   # implementation decision log
```

## How `o2n login` works

- Notion's OAuth (public integration) requires a `client_secret`, which can't be embedded in the
  CLI. Instead, `services/auth-proxy` (a small Cloudflare Worker) holds the secret and only
  performs the code→token exchange.
- The CLI opens the browser to Notion's authorize screen; once approved, the Worker exchanges the
  code server-side and stores the result in Cloudflare KV for at most 5 minutes. The CLI polls for
  it and saves it to `~/.o2n/credentials.json` (mode 600). The KV entry is deleted immediately
  after one successful read.
- The `client_secret` never touches the CLI, the MCP server, or this repository (Worker
  environment variable only).
- The Worker only performs the token exchange — it never accesses vault contents or Notion pages.

See [services/auth-proxy/README.md](services/auth-proxy/README.md) for deployment steps.

## Development

```bash
npm install
npm run build
npm test
```

See [docs/questions.md](docs/questions.md) for implementation decisions and deviations from the spec.

## Security

- The Notion token is stored only in the `NOTION_TOKEN` env var or `~/.o2n/credentials.json`
  (via `o2n login`, mode 600)
- Writes are scoped to the specified parent page only
- The only path o2n writes to inside the vault is `.o2n/` (the vault itself is read-only)
- Symbolic links inside the vault are never followed (prevents reading files outside the vault)
- The MCP server verifies that a given `vaultPath` actually looks like an Obsidian vault (has a
  `.obsidian` directory) before reading or writing anything, to guard against an AI agent being
  pointed at an unintended path
- No network calls other than to the Notion API (no telemetry)

### Trust model for `o2n login` (shared auth-proxy)

By default, `o2n login` goes through a Cloudflare Worker operated by TK-WFL
(`o2n-auth-proxy.workflow-lab.workers.dev`) to handle Notion's `client_secret`. This Worker only
performs the code→token exchange and never accesses vault contents or Notion pages, but using it
does require trusting its operator. The polling parameter (`pollSecret`) is only ever matched via
a one-way sha256 hash, and the token is deleted from KV immediately after one successful read, so
a value leaked through browser history or logs alone cannot be used to steal the token. If your
security requirements call for it, self-host `services/auth-proxy` on your own Cloudflare account
and point `packages/cli/src/oauth-config.ts` at it instead (see
[services/auth-proxy/README.md](services/auth-proxy/README.md)). The `NOTION_TOKEN` env var path
(internal integration) does not depend on this trust model at all.
