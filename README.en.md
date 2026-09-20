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

**Option A: internal integration token (recommended)**

```bash
export NOTION_TOKEN=ntn_xxx
```

The `NOTION_TOKEN` env var takes priority over a stored login if both are present. It is never
accepted as a CLI argument (to avoid leaking it into shell history).

**Option B: browser login (disabled by default)**

```bash
npx @tk_wfl/o2n-cli login
```

Browser login is disabled by default because the old OAuth polling flow allowed token theft.
Only set `O2N_ENABLE_BROWSER_LOGIN=1` when you are intentionally testing the new loopback handoff
flow. If you used `o2n login` with an older version, revoke and re-issue the Notion token.

### Commands

Before running `plan`/`migrate`, the destination parent page must already be **connected** to the
integration you're using (an internal integration, or the one linked via `o2n login`) in Notion.
An unconnected page causes a `404 Could not find page` error at `plan`/`migrate` time.

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
Tools: `scan_vault` / `get_plan` / `update_plan` / `prepare_migration` / `commit_migration` / `migration_status` / `get_report`.

MCP access requires `O2N_ALLOWED_VAULTS=/absolute/path/to/vault` (comma-separated for multiple
vaults). Real writes are disabled by default; set `O2N_ENABLE_MCP_WRITE=1` and
`O2N_MCP_WRITE_TOKEN`, inspect `prepare_migration`, then pass the confirmation token to
`commit_migration`. `start_migration` is disabled for safety.

## What gets converted

- Wikilinks (`[[note]]`, display text, heading links, etc.) → Notion page-to-page links; `[[alias]]` matching a note's frontmatter `aliases` resolves to that note
- Frontmatter → in-page metadata (page-tree mode) or database properties (database mode)
- Images, PDFs, and other attachments → uploaded and shown in their original position
- Obsidian callouts → Notion callouts (all 13 official types and their aliases mapped to icon/color; unknown types fall back to gray and are reported)
- Highlights (`==text==`, including Obsidian 1.14 color highlights such as `==🔴text==`) → native Notion highlight with the matching color
- Math (`$...$` / `$$...$$`) and mermaid code blocks → passed through as-is
- Headings up to h4 (Notion's limit); h5/h6 are downgraded to h4 and recorded in the report
- Tasks (`- [ ]` / `- [x]`) → Notion to-dos. Extended states such as `[/]` or `[-]` are normalized to unchecked with the original marker kept in the text (recorded in the report)
- Inline code (`` `...` ``) and code blocks are left untouched
- Unsupported elements are recorded in the report: Canvas (`.canvas`), Bases (`.base`), Dataview query results, transclusion, etc. Excalidraw drawing notes are migrated as their exported image (`.png`/`.svg` with the same name) when one exists, otherwise skipped

For each folder, if 60%+ of its direct notes share 3 or more common frontmatter keys, database mode
is suggested automatically (the final call is always made by the user via `plan`).

## Time estimate

Roughly 1,000 notes + 500 attachments ≈ 4,000–5,000 API calls ≈ ~30–40 minutes at an effective
rate of 2.5 req/s.

The default rate is 2 req/s (Notion's per-connection limit is 180 req/min on Free/Plus and
600 req/min on Business/Enterprise). On Business or higher you can raise it with
`O2N_REQUESTS_PER_SECOND=8` (1–10) to shorten the migration; 429 responses are honored via `Retry-After`.

## Notion Free plan block limit

Since September 2026, **multi-member Free workspaces** have a lifetime cap of 1,000 blocks that is
also enforced by the API ([reference](https://developers.notion.com/reference/workspace-block-limits)).
Once reached, creation requests are rejected with `403 restricted_resource`, and deleting blocks does
not restore capacity.

- `o2n scan` / `o2n plan` print an estimated block count and warn up front when it exceeds 1,000
- If the limit is hit during migration, o2n stops immediately instead of failing note by note and
  records it under "aborted" in the report. Notes not yet started stay untouched, so after changing
  the plan you can continue with `o2n resume`
- Personal access tokens (PAT), paid plans, and single-member Free workspaces are not subject to the limit

## Repository layout

```
packages/
  core/          # scanner / planner / converter / migrator / state / notion / report / credentials
  cli/           # the o2n command (thin wrapper over core)
  mcp-server/    # stdio MCP server (thin wrapper over core)
services/
  auth-proxy/    # OAuth code-exchange proxy for `o2n login` (Cloudflare Worker)
fixtures/test-vault/  # test vault covering every supported syntax
scripts/
  verify-release.mjs  # pre-publish npm package content/checksum verification
docs/
  e2e.md         # manual end-to-end test procedure
  questions.md   # implementation decision log
  spec.md        # security boundaries and persisted-data spec
```

## How `o2n login` works

- Notion's OAuth (public integration) requires a `client_secret`, which can't be embedded in the
  CLI. Instead, `services/auth-proxy` (a small Cloudflare Worker) holds the secret and only
  performs the code→token exchange.
- The old polling flow is disabled. The new flow opens a temporary listener on `127.0.0.1`; the
  Worker exchanges the authorization code, redirects only a short-lived handoff code to loopback,
  and the CLI exchanges that code plus a local session secret for the token exactly once. The token
  is saved to `~/.o2n/credentials.json` (mode 600).
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
- Only YAML frontmatter is supported. Non-YAML frontmatter such as `---js`, `---javascript`, and
  `---json` is rejected before parsing.
- `.o2n/state.json` v2 is bound to the canonical vault path, plan hash, Notion identity, and a
  local signature.
- The only path o2n writes to inside the vault is `.o2n/` (the vault itself is read-only)
- Symbolic links inside the vault are never followed (prevents reading files outside the vault)
- Files under `.o2n/` and `~/.o2n/` are read and written with symlink, hardlink, and TOCTOU
  (swap-after-verify) protections, and kept at `0700`/`0600` permissions
- The MCP server only reads/writes vaults whose canonical `realpath()` is listed in
  `O2N_ALLOWED_VAULTS`
- No network calls other than to the Notion API (no telemetry)

### Trust model for `o2n login` (shared auth-proxy)

`o2n login` is disabled by default. If you enable it, the TK-WFL-operated or self-hosted
Cloudflare Worker handles Notion's `client_secret`, so you must trust that Worker operator. The
`NOTION_TOKEN` env var path (internal integration) does not depend on this trust model at all.
