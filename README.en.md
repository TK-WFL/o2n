# o2n

English | [日本語](README.md)

A tool that migrates an Obsidian vault into a Notion workspace while preserving folder structure,
note-to-note links (wikilinks), frontmatter, and attachments.

Implemented per the spec "Obsidian→Notion Migration Tool o2n Spec v1.0" (drafted 2026-07-16), treated
as the single source of truth.

- Repository: https://github.com/TK-WFL/o2n
- License: [MIT](LICENSE)

## Implementation status

- **M1 Core MVP**: scanner / converter / migrator (Pass 1 & 2) / state / resume / CLI ✅
- **M2 Attachments**: File Upload API (single-part & multipart) + Pass 3 (attachment resolution) ✅
- **M3 Databases**: automatic database-mode suggestion + database mode + frontmatter property mapping ✅
- **M4 MCP**: `packages/mcp-server` (stdio, 6 tools) ✅
- **M5 Release**: English README, npm package metadata (this section) ✅ / actual `npm publish` not yet run
- **Report as a Notion page** (part of M5 scope): not implemented yet. The report is currently written only to the local `.o2n/report.md`.

## Setup (development)

```bash
npm install
npm run build
npm test
```

Requires Node.js 20+.

## Install (once published to npm)

```bash
npx o2n scan <vaultPath>
# or
npm install -g o2n
```

The MCP server is a separate package (`@o2n/mcp-server`). Point Claude Desktop's config at
`npx -y @o2n/mcp-server` as the launch command.

## CLI usage

```bash
# 1. Scan the vault (read-only)
npx o2n scan <vaultPath>

# 2. Generate a migration plan interactively (you'll be asked to approve database-mode suggestions)
npx o2n plan <vaultPath> --parent <NotionPageId>

# 3. Run the migration (NOTION_TOKEN env var required; --dry-run simulates without writing)
export NOTION_TOKEN=secret_xxx
npx o2n migrate <vaultPath> --plan <vaultPath>/.o2n/plan.json --dry-run
npx o2n migrate <vaultPath> --plan <vaultPath>/.o2n/plan.json

# 4. Resume an interrupted migration
npx o2n resume <vaultPath>

# 5. Verify and inspect the report
npx o2n verify <vaultPath>
npx o2n report <vaultPath>
```

`NOTION_TOKEN` is an internal integration secret. It is read only from the environment variable,
never accepted as a CLI argument (to avoid leaking it into shell history; spec §8).

Exit codes: `0` = fully succeeded, `1` = some notes failed, `2` = fatal error.

## MCP server usage

Register `packages/mcp-server/dist/index.js` as a stdio MCP server in Claude Desktop / Claude Code.
Tools: `scan_vault` / `get_plan` / `update_plan` / `start_migration` / `migration_status` / `get_report`.

`start_migration` must only be invoked after explicit user confirmation (this is also stated in the
tool's description).

## Time estimate

Per spec §10: roughly 1,000 notes + 500 attachments ≈ 4,000–5,000 API calls ≈ ~30–40 minutes at an
effective rate of 2.5 req/s.

## Repository layout

```
packages/
  core/          # scanner / planner / converter / migrator / state / notion / report
  cli/           # the o2n command (thin wrapper over core)
  mcp-server/    # stdio MCP server (thin wrapper over core)
fixtures/test-vault/  # test vault covering every supported syntax (see fixtures/test-vault/README.md)
docs/
  e2e.md         # manual end-to-end test procedure
  questions.md   # implementation-time questions and deviations from the spec
```

## §16 Open items (pending verification against a real workspace)

Spec §16 calls for verification against live Notion API calls, which wasn't possible in the session
that produced this codebase (no `NOTION_TOKEN` was available). Implementation follows the spec's
stated assumptions; the following need confirmation before relying on them in production. Record
results here after running the `docs/e2e.md` procedure.

1. **Can an uploaded file (file_upload id) be referenced directly inside the `markdown` parameter of enhanced markdown?**
   → Unverified. Implemented per the spec's fallback: Pass 3 attaches files to blocks after the fact
     (`packages/core/src/migrator.ts`, `runPass3`). If direct reference turns out to work, Pass 3 can
     be folded into Pass 1 (no change needed to `converter.ts`'s output).
2. **Scope of enhanced markdown support for math and highlight (background color)**
   → Unverified. Math (`$...$` / `$$...$$`) is passed through unchanged. Highlight (`==text==`) is
     downgraded to bold per spec. If Notion turns out to support background-color highlighting via
     enhanced markdown, the downgrade can be replaced with the native syntax.
3. **Can the `markdown` parameter be used when creating a database-row page (parent is a data source)?**
   → Unverified. Implemented assuming yes (`parent: { data_source_id }` + `markdown`) in `runPass1`.
     If not, row bodies will need to be created via the Blocks API instead.
4. **Exact request/response shape of the data source for `POST /v1/databases`**
   → Unverified. `createDatabaseForFolder` in `notion-db.ts` defensively uses `data_sources[0].id` from
     the response if present, falling back to `id` itself as the data source id.

## Deviations from the spec

See [docs/questions.md](docs/questions.md) for details. Highlights:

- Since it was unclear whether `@notionhq/client`'s markdown-related methods exist in the installed
  version, `packages/core/src/notion-client.ts` is implemented as a thin `fetch`-based HTTP client
  instead of depending on the SDK (endpoints/headers follow spec §4.1).
- Link/attachment placeholders in Pass 1/2 use `⟦o2n:link:N⟧` (a per-note sequence number) instead of
  `⟦o2n:link:<relative path>⟧`, because a single relative-path placeholder can't represent multiple
  differently-aliased links to the same note. The actual target path and display text are kept in
  structured data (`pendingLinks` / `pendingFiles`).
- Added a `folders` key to `state.json`, not present in the spec's example schema, to track the
  Notion id of each folder's container (a parent page in page_tree mode, a database in database mode).

## Publishing to npm (maintainer notes — not yet done)

This repo is publish-ready (`files` entries, `publishConfig`, `prepublishOnly`, LICENSE, etc.) but
`npm publish` has not actually been run. To publish:

```bash
npm login
npm run build
npm test

# publish in dependency order: @o2n/core -> o2n (CLI) -> @o2n/mcp-server
npm publish --workspace packages/core
npm publish --workspace packages/cli
npm publish --workspace packages/mcp-server
```

- The CLI package is published under the unscoped name `o2n` (see `packages/cli/package.json`) so that
  `npx o2n` works out of the box.
- `@o2n/core` and `@o2n/mcp-server` are scoped packages, so `publishConfig.access: public` is already set.
- When bumping versions, keep all three packages in lockstep (the `^0.1.0` dependency range on
  `@o2n/core` tolerates minor bumps, but bump the major version together on breaking changes).
