# o2n Specification

Last updated: 2026-07-20 (secure local-state I/O revision)

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
- `.o2n` must be a real directory inside the canonical vault. Symlinks are rejected for the
  directory, persisted files, and atomic-write temporary files.
- Vault-local writes use a same-directory temporary regular file followed by atomic rename.

User-home files:

- `~/.o2n/credentials.json`: optional Notion token from `o2n login`, mode `0600`.
- `~/.o2n/state-signing-key`: local HMAC key for state v2, mode `0600`.
- `~/.o2n` has mode `0700`. Existing symlinks are rejected for the directory and both files.

Unsigned v1 state is rejected by migration write paths. Users must discard or explicitly migrate
old state before resuming a migration created by an older unsafe version.

## Security Boundaries

- Vault scanning never follows symlinks.
- Local state reads use no-follow file opens where supported. On every platform, pre/post-open
  `lstat` metadata must match the opened handle's device, inode, and file type, and the parent
  directory identity is revalidated before content is returned.
- Writes reject symlink destinations and verify canonical containment before same-directory atomic
  replacement. Custom plan output validates every parent segment from the filesystem root, creates
  missing segments one at a time, and rejects symlink ancestors even when deeper directories exist.
- MCP requires `O2N_ALLOWED_VAULTS` and compares `realpath()` values exactly.
- MCP real writes require `O2N_ENABLE_MCP_WRITE=1` and a matching `O2N_MCP_WRITE_TOKEN`.
- `start_migration` is disabled; use `prepare_migration` and `commit_migration`.
- Browser OAuth is disabled unless `O2N_ENABLE_BROWSER_LOGIN=1`.
- The auth proxy removes `/poll` and stores OAuth handoff state in a Durable Object for one-time consume.
- HTML responses use `no-store`, `no-referrer`, `nosniff`, and a restrictive CSP.

## Privacy Notes

o2n does not send telemetry. Network calls during migration go to Notion APIs. The auth proxy handles
OAuth code exchange only and does not read vault contents.

## Recent Changes

- Replaced unsafe frontmatter parsing with YAML-only validation.
- Disabled vulnerable OAuth polling and added loopback handoff.
- Added signed state v2 and plan/state schema validation.
- Hardened MCP path and write boundaries.
- Prevented `.o2n` and user-home credential symlinks from reading or overwriting arbitrary files,
  and stopped automatic plan creation for errors other than a missing `plan.json`.
- Added no-follow fallback identity checks and safe recursive parent creation for custom plan output.
- Extended custom output ancestry checks from the filesystem root through the final parent.
