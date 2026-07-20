# o2n Specification

Last updated: 2026-07-20 (secure local-state I/O and OAuth proxy lifecycle hardening)

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
- `~/.o2n` has mode `0700`, must be owned by the current user, and cannot be group/other writable.
  Both secret files must be current-user-owned regular files with one hard link and no group/other
  permissions. Platforms that cannot expose an equivalent current-user ownership check fail closed.
- Legacy current-user-owned `.o2n` directories with no group/other write bits (for example `0755`
  or `0750`) are tightened in place to `0700` after identity checks. Writable, differently owned,
  or replaced directories are rejected rather than migrated.

Unsigned v1 state is rejected by migration write paths. Users must discard or explicitly migrate
old state before resuming a migration created by an older unsafe version.

## Security Boundaries

- Vault scanning never follows symlinks.
- Local state reads use no-follow file opens where supported. On every platform, pre/post-open
  `lstat` metadata must match the opened handle's device, inode, and file type, and the parent
  directory identity is revalidated before content is returned.
- Explicit plan-file reads validate every directory segment from the filesystem root through the
  parent and reject higher-ancestor symlinks, including those with existing descendants.
- Security-sensitive paths accept only current-user- or root-owned POSIX ancestors that are not
  group/other writable. A root-owned sticky directory (such as canonical `/tmp`) is allowed only
  when every following segment is current-user-owned and not group/other writable; user-owned
  writable sticky directories receive no exception.
- Writes reject symlink destinations and verify canonical containment before same-directory atomic
  replacement. Custom plan output validates every parent segment from the filesystem root, creates
  missing segments as current-user-owned `0700` directories, and rejects symlink ancestors even
  when deeper directories exist. Existing directories are never chmodded to manufacture trust.
- Atomic writes verify the temporary path and opened handle have the same single-link inode before
  writing, then verify the renamed destination still has that inode before reporting success.
  Temporary and destination files must retain the requested `0600` mode for vault, custom-plan,
  and home-secret writes, regardless of whether an owner check applies.
  Validation failures do not unlink by pathname, avoiding removal of an attacker-replaced inode;
  an untrusted or incomplete temporary file may remain for manual cleanup.
- Ancestry trust is revalidated before file opens and before/after atomic replacement. Platforms
  without an effective/current UID API fail closed for these security-sensitive operations.
- Legacy vault-local `plan.json`, `state.json`, and `report.md` files may be tightened from `0644`
  to `0600` only when current-user-owned, single-linked, and not group/other writable. This migration
  cannot undo any exposure that occurred before tightening and does not apply to home secrets,
  whose `0600` requirement remains fail-closed on read.
- MCP requires `O2N_ALLOWED_VAULTS` and compares `realpath()` values exactly.
- MCP real writes require `O2N_ENABLE_MCP_WRITE=1` and a matching `O2N_MCP_WRITE_TOKEN`.
- `start_migration` is disabled; use `prepare_migration` and `commit_migration`.
- Browser OAuth is disabled unless `O2N_ENABLE_BROWSER_LOGIN=1`.
- The auth proxy additionally requires `OAUTH_ENABLED=1`, both Cloudflare Rate Limiting bindings,
  the Durable Object binding, Client ID, and Client Secret. A missing runtime binding fails closed.
- `/session` and `/exchange` accept only bounded JSON requests and apply per-source Cloudflare rate limits.
  Request bodies are streamed and rejected with HTTP 413 as soon as they exceed 2 KiB, independently of
  `Content-Length`; the random state, one-time handoff code, and terminal-local secret remain the
  authorization controls.
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
- Streamed OAuth JSON body validation so missing or forged `Content-Length` cannot force unbounded buffering.
- Added signed state v2 and plan/state schema validation.
- Hardened MCP path and write boundaries.
- Prevented `.o2n` and user-home credential symlinks from reading or overwriting arbitrary files,
  and stopped automatic plan creation for errors other than a missing `plan.json`.
- Added no-follow fallback identity checks and safe recursive parent creation for custom plan output.
- Extended custom output ancestry checks from the filesystem root through the final parent.
- Bound atomic temporary and destination names to one verified inode and hardened home-secret
  ownership, permission, and hard-link requirements.
- Extended explicit plan reads to validate the complete parent ancestry.
- Enforced atomic file modes for vault and custom-plan writes as well as home secrets.
- Added current-user/root ancestry trust checks with a narrowly scoped root-sticky exception.
- Added identity-checked mode tightening for legacy `.o2n` directories and vault-local state files.
