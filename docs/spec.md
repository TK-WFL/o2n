# o2n Specification

Last updated: 2026-07-20 (OAuth proxy lifecycle hardening)

## Scope

o2n migrates a local Obsidian vault to Notion while preserving folder structure, wikilinks,
frontmatter-derived metadata, and supported attachments. It provides a CLI and a stdio MCP server.

Non-goals:

- Executing arbitrary Obsidian plugins, Dataview queries, or JavaScript frontmatter.
- Reading files outside the selected vault.
- Acting as a general-purpose Notion automation server.

## Primary Flows

- CLI scan: `scan <vaultPath>` reads the vault and returns inventory only.
- CLI plan: `plan <vaultPath> --parent <pageId>` writes `.o2n/plan.json`.
- CLI migrate/resume: writes Notion pages and persists `.o2n/state.json`.
- MCP read tools: require `O2N_ALLOWED_VAULTS` and operate only on canonical allowed vaults.
- MCP write flow: `prepare_migration` fixes the request details, then `commit_migration` executes it.
- OAuth login: disabled by default. When explicitly enabled, uses loopback handoff rather than public polling.

## Frontmatter Contract

Only YAML frontmatter is accepted:

- Allowed: `---`, `---yaml`, `---yml`
- Rejected before parsing: `---js`, `---javascript`, `---json`, `---toml`, and any other language tag

This prevents `gray-matter`-style JavaScript frontmatter execution and keeps vault content as data.

## Persistence

Vault-local files:

- `.o2n/plan.json`: migration plan, schema version 1.
- `.o2n/state.json`: migration state. Version 2 binds the state to:
  - canonical vault path
  - parent page ID
  - plan hash
  - Notion workspace/bot identity
  - local HMAC signature
- `.o2n/report.md`: migration report.

User-home files:

- `~/.o2n/credentials.json`: optional Notion token from `o2n login`, mode `0600`.
- `~/.o2n/state-signing-key`: local HMAC key for state v2, mode `0600`.

Unsigned v1 state is rejected by migration write paths. Users must discard or explicitly migrate
old state before resuming a migration created by an older unsafe version.

## Security Boundaries

- Vault scanning never follows symlinks.
- MCP requires `O2N_ALLOWED_VAULTS` and compares `realpath()` values exactly.
- MCP real writes require `O2N_ENABLE_MCP_WRITE=1` and a matching `O2N_MCP_WRITE_TOKEN`.
- `start_migration` is disabled; use `prepare_migration` and `commit_migration`.
- Browser OAuth is disabled unless `O2N_ENABLE_BROWSER_LOGIN=1`.
- The auth proxy additionally requires `OAUTH_ENABLED=1`, both Cloudflare Rate Limiting bindings,
  the Durable Object binding, Client ID, and Client Secret. A missing runtime binding fails closed.
- `/session` and `/exchange` accept only bounded JSON requests and apply per-source Cloudflare rate limits;
  the random state, one-time handoff code, and terminal-local secret remain the authorization controls.
- OAuth handoff state and tokens are held in a Durable Object for at most five minutes after registration or
  completion. An alarm, cancellation, too many failed exchanges, or a successful one-time exchange deletes
  all session storage; successful exchange also clears the alarm.
- Secret and handoff comparisons use fixed-format digest comparisons, and public failures do not expose
  internal exception messages.
- The auth proxy removes `/poll`; it always returns HTTP 410.
- HTML responses use `no-store`, `no-referrer`, `nosniff`, and a restrictive CSP.

## Privacy Notes

o2n does not send telemetry. Network calls during migration go to Notion APIs. The auth proxy handles
OAuth code exchange only and does not read vault contents.

## Recent Changes

- Replaced unsafe frontmatter parsing with YAML-only validation.
- Disabled vulnerable OAuth polling and added loopback handoff.
- Hardened OAuth Durable Object cleanup, bounded API inputs, abuse controls, fail-closed bindings, and
  one-time secret comparison; upgraded Wrangler to an audit-clean 4.112.0-compatible release.
- Added signed state v2 and plan/state schema validation.
- Hardened MCP path and write boundaries.
