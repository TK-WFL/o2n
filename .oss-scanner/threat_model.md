# Threat model

## What this project does and where untrusted input enters

o2n migrates an Obsidian vault (a folder of Markdown files and attachments) into Notion pages and databases.
It ships three npm packages and one hosted service:

- `packages/core` (`@tk_wfl/o2n-core`): scanning, Markdown/frontmatter conversion, planning, migration, Notion API client, local state and credentials.
- `packages/cli` (`@tk_wfl/o2n-cli`, command `o2n`): the interactive CLI, including `o2n login` (OAuth via loopback) and `o2n mcp ...` settings commands.
- `packages/mcp-server` (`@tk_wfl/o2n-mcp-server`): an MCP server over stdio that exposes the migration to AI agents (`scan_vault`, `prepare_migration`, `commit_migration`, `start_migration`, ...).
- `services/auth-proxy`: a Cloudflare Worker that holds the Notion OAuth client secret and hands a short-lived code back to the CLI's loopback listener.

Untrusted input:

- **Vault contents are untrusted.** A user may migrate a vault they downloaded or that someone else wrote. Note bodies, frontmatter (YAML), wikilinks, embeds, inline fields, file and folder names, symlinks and attachments are all attacker-controlled.
- **MCP tool arguments are untrusted.** The agent calling the MCP server may be steered by prompt injection (including from text inside the vault being migrated), so any `vaultPath`, plan id, plan edit or job id it passes is attacker-controlled.
- **Notion API responses** are semi-trusted (Notion itself is trusted; content stored in the workspace by other users is not).
- **HTTP requests to the auth proxy** and to the CLI's temporary `127.0.0.1` loopback listener during `o2n login` are untrusted.

Assets to protect: the user's Notion token (`NOTION_TOKEN` or `~/.o2n/credentials.json`), files outside the selected vault, the MCP settings in `~/.o2n/mcp-settings.json` (allowed vaults, write switch), and the OAuth client secret held by the Worker.

## Components that matter most / least

Most important:

- Path handling: `vault-guard.ts` (vault must contain `.obsidian`, must be under `O2N_ALLOWED_VAULTS` for MCP), `scanner.ts`, `attachments.ts` (reading or uploading files outside the vault via `..`, absolute paths, symlinks, or embeds).
- The MCP write gate: writes must stay off unless the user enabled them (`O2N_ENABLE_MCP_WRITE` / `o2n mcp write on` with a token), and an agent must not be able to widen its own access (`mcp-settings.ts`, `packages/cli/src/commands/mcp.ts`, `packages/mcp-server/src/index.ts`, `plan-store.ts`, `jobs.ts`).
- Credential handling: `credentials.ts`, `packages/cli/src/token.ts`, `packages/mcp-server/src/token.ts` (token leakage into logs, reports, Notion pages, error messages, or files with loose permissions).
- The OAuth flow: `services/auth-proxy/src` and `packages/cli/src/commands/login.ts` (state/handoff validation, replay, CSRF on the loopback listener).
- Conversion: `converter.ts`, `notion-blocks.ts`, `property-mapping.ts`, `inline-fields.ts` (crashes or hangs on hostile Markdown, ReDoS, sending content to the wrong page).

Less important: `report.ts` formatting, `verify.ts`, `scripts/`, `docs/`. `fixtures/` is test data. `node_modules/` is third-party and out of scope.

## How to exercise it

- `npm test` runs the vitest suite for all packages and the auth proxy (no network; the Notion API is mocked).
- `fixtures/test-vault` is a sample vault. `node packages/cli/dist/index.js scan fixtures/test-vault` (after `npm run build`) exercises scanning without a token.
- `node packages/mcp-server/dist/index.js` starts the MCP server on stdio; tests in `packages/mcp-server/src/*.test.ts` show how it is driven.

## How you rate severity

- Critical: leaking the Notion token or OAuth client secret to a remote party; reading or uploading arbitrary files outside the vault to Notion without user action; an MCP caller enabling writes or adding allowed vaults on its own.
- High: path traversal or symlink escape that reads local files outside the vault; bypass of `O2N_ALLOWED_VAULTS` or the `.obsidian` check; MCP write operations performed while writes are disabled; OAuth state/handoff bypass.
- Medium: token or private paths written to logs/reports; data written to the wrong Notion page; denial of service from a crafted vault (crash, hang, unbounded memory).
- Low: issues that need the attacker to already control the user's shell, home directory, or environment variables.

## Anything to leave alone

- The browser OAuth flow is disabled by default (`OAUTH_ENABLED = "0"`); report issues in it, but rate them assuming it is enabled.
- A process that can allocate a pseudo-terminal or edit `~/.o2n/mcp-settings.json` directly can change MCP settings; this is documented in SECURITY.md and is not a finding by itself.
- Notion API rate limits and Notion-side behavior are out of scope.
