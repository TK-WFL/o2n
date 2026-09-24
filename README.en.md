<div align="center">

# o2n

**Obsidian → Notion migration tool**

Move an entire vault to Notion while keeping links, folder hierarchy, frontmatter and attachments intact.

[![npm](https://img.shields.io/npm/v/@tk_wfl/o2n-cli?label=o2n-cli&color=cb3837&logo=npm)](https://www.npmjs.com/package/@tk_wfl/o2n-cli)
[![npm](https://img.shields.io/npm/v/@tk_wfl/o2n-mcp-server?label=o2n-mcp-server&color=cb3837&logo=npm)](https://www.npmjs.com/package/@tk_wfl/o2n-mcp-server)
[![CI](https://github.com/TK-WFL/o2n/actions/workflows/ci.yml/badge.svg)](https://github.com/TK-WFL/o2n/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)

English | [日本語](README.md)

</div>

---

## 🤔 Why o2n?

Notion's built-in import does not understand Obsidian-specific syntax, so the bigger the vault, the less realistic manual clean-up becomes. o2n **analyzes the whole vault first and then converts it into Notion's data model**.

| Obsidian syntax | Built-in import | o2n |
|---|:---:|:---:|
| `[[note]]` wikilinks | ❌ plain text | ✅ page-to-page links (same-name notes and `aliases` resolved) |
| `![[image.png]]` attachments | ❌ not shown | ✅ uploaded and placed where they were |
| frontmatter | ❌ raw text | ✅ page metadata or **database properties** |
| `icon` / `cover` | ❌ | ✅ page icon and cover |
| `> [!note]` callouts | ❌ plain quote | ✅ all 13 types with color/icon, foldable ones become toggles |
| `==highlight==` | ❌ | ✅ colored highlights (Obsidian 1.14) |
| folder hierarchy | ⚠️ often flattened | ✅ reproduced as a page tree |
| failure midway | 🔁 start over | ✅ `resume` continues (no duplicates) |
| unconvertible content | 🤫 silently lost | ✅ listed in the report |

---

## 🚀 Get started in 3 minutes

### 1. Get a Notion token

In the [Notion developer portal → Personal access tokens](https://www.notion.so/developers/tokens) select **New token**, pick a name and an expiration, and copy the token (it is shown only once).

```bash
export NOTION_TOKEN=ntn_xxx
```

> 💡 With a **personal access token (PAT)** there is no per-page "Connect" step, and the Free-plan block limit (see below) does not apply. Other options: [Connecting to Notion](#-connecting-to-notion).

### 2. Make a plan

```bash
npx @tk_wfl/o2n-cli plan <vaultPath> --parent <destination Notion page ID>
```

For each folder you choose "page tree" or "database" interactively (folders with consistent frontmatter are suggested as databases automatically).

### 3. Try it, then migrate

```bash
npx @tk_wfl/o2n-cli migrate <vaultPath> --dry-run   # simulate without writing
npx @tk_wfl/o2n-cli migrate <vaultPath>             # for real
npx @tk_wfl/o2n-cli verify  <vaultPath> --deep      # compare against the real Notion pages
```

If it stops halfway, `npx @tk_wfl/o2n-cli resume <vaultPath>` continues where it left off.

> 🧑‍💻 **Not comfortable with the command line?** Register o2n as an MCP server in Claude Code / Claude Desktop and just say "migrate this vault to Notion" → [Using as an MCP server](#-using-as-an-mcp-server)

---

## 📖 Commands

| Command | What it does | Main options |
|---|---|---|
| `scan <vault>` | Scan the vault and print counts and an estimated block count (no Notion access) | `--verbose` `--json` |
| `plan <vault>` | Create the migration plan (`.o2n/plan.json`) interactively | `--parent <id>` `--yes` `--embed-mode inline` `--link-style link` `--out <path>` |
| `migrate <vault>` | Migrate according to the plan | `--dry-run` `--plan <path>` `--quiet` `--verbose` |
| `resume <vault>` | Continue an interrupted or failed migration (idempotent) | `--quiet` |
| `verify <vault>` | Reconcile state with the vault; `--deep` also checks the real Notion pages | `--deep` `--json` |
| `report <vault>` | Show the latest report (`.o2n/report.md`) | |

- `migrate --dry-run` writes its report to `.o2n/report.dry-run.md` and never overwrites the real `report.md`
- `--embed-mode inline`: expand `![[note]]` embeds in place instead of linking (`![[note#heading]]` expands only that section)
- Exit codes: `0` all succeeded / `1` some failed or mismatched / `2` fatal error

---

## 🔑 Connecting to Notion

The token is always passed through the `NOTION_TOKEN` env var (never as a CLI argument — avoids leaking it into shell history).

<details>
<summary><b>Option A: personal access token (PAT) — recommended</b></summary>

In the [developer portal → Personal access tokens](https://www.notion.so/developers/tokens) select **New token**, pick a name, the Notion API capability and an expiration (7 days to 1 year).

- Writes with your own permissions, so **no per-page "Connect" step is needed**
- Expiring, and workspace admins can list and revoke it
- Not subject to the Notion Free plan block limit
- Added in May 2026; older workspace settings expose it under the "Connections" tab

</details>

<details>
<summary><b>Option B: internal integration token</b></summary>

Create a workspace-level integration and use its token (same `ntn_` format). The destination parent page must be **connected** to that integration beforehand (page `…` menu → Connections); an unconnected page causes `404 Could not find page` at `plan` / `migrate` time.

</details>

<details>
<summary><b>Option C: browser login (disabled by default)</b></summary>

```bash
npx @tk_wfl/o2n-cli login
```

Disabled by default because the old OAuth polling flow allowed token theft. Only set `O2N_ENABLE_BROWSER_LOGIN=1` when intentionally testing the new loopback handoff flow. If you used `o2n login` with an older version, revoke and re-issue the Notion token. How it works is described under "Security".

</details>

---

## 🤖 Using as an MCP server

Register `npx -y @tk_wfl/o2n-mcp-server` in the MCP settings of Claude Desktop / Claude Code.

```json
{
  "mcpServers": {
    "o2n": {
      "command": "npx",
      "args": ["-y", "@tk_wfl/o2n-mcp-server"],
      "env": {
        "NOTION_TOKEN": "ntn_xxx",
        "O2N_ALLOWED_VAULTS": "/absolute/path/to/vault"
      }
    }
  }
}
```

| Tool | Purpose |
|---|---|
| `scan_vault` | Scan the vault (read-only) |
| `get_plan` / `update_plan` | Inspect / adjust the plan (`folders` / `skipList` / `embedMode`) |
| `prepare_migration` | Freeze what will be migrated (target, destination, counts) and return a `requestId` |
| `commit_migration` | Run the frozen request; real writes require a confirmation token |
| `resume_migration` / `cancel_migration` | Continue / stop at a note boundary |
| `migration_status` / `verify_migration` / `get_report` | Progress, verification, report |

🔒 **Safety by design**: vaults not listed in `O2N_ALLOWED_VAULTS` cannot be accessed. Real writes are disabled by default; set `O2N_ENABLE_MCP_WRITE=1` and `O2N_MCP_WRITE_TOKEN`, then pass the confirmation token to `commit_migration`. Failures and refusals are returned with `isError`.

---

## 🔄 What gets converted

<details>
<summary><b>Open the conversion table</b></summary>

| Obsidian | In Notion |
|---|---|
| `[[note]]` | **Page mention** (shows up in Notion backlinks, follows renames). `plan --link-style link` for URL links |
| `[[note\|text]]`, `[[alias]]` via `aliases` | URL link keeping the text you wrote (resolved case-insensitively) |
| `[[note#heading]]` `[[#heading]]` `[x](note.md#heading)` | **Link to that heading** (page top if the heading is missing; reported) |
| `[[note#^id]]` | Link to the top of the page (Notion has no block references; recorded in the report) |
| `![[note]]` `![[note#heading]]` | Link by default. `--embed-mode inline` expands the body (cycles and depth > 2 fall back to a link) |
| `![[image.png\|300]]` `![fig](img/a.png)` `[doc](a.pdf)` `[[sheet.xlsx]]` | Uploaded and placed as image / PDF / audio / video / file blocks. Any format such as docx, xlsx, pptx, zip or csv (types Notion rejects are reported) |
| `[text](note.md#heading)` | Resolved like a wikilink (`.MD` too) |
| frontmatter | page_tree: leading metadata callout / database: properties (title, rich_text, number, checkbox, date, multi_select, url) |
| `icon` `cover` `banner` | Page icon (emoji, URL, vault image) and cover (URL, vault image) |
| `tags` (list or `a, b`) | multi_select |
| `> [!type]` callouts | All 13 types and aliases mapped to color/icon. `[!type]-` becomes a toggle. Code blocks and nesting are kept |
| `==text==` `==🔴text==` | Highlight (colored highlights keep their color) |
| `- [ ]` `- [x]` | To-do. `[/]` `[-]` etc. are normalized to unchecked with the original marker kept in the text |
| `#` … `####` | Headings (h5/h6 are downgraded to h4 and recorded) |
| Math `$…$` `$$…$$`, mermaid | Passed through |
| `%% comments %%` `<!-- comments -->` | Removed (even across code blocks) |
| `[^1]` footnotes, `^[inline footnotes]` | Expanded inline |
| Trailing block IDs `^abc123` | Removed (hidden in Obsidian too) |
| Inline code and code blocks | Left untouched |
| Excalidraw notes | Migrated as the exported image (`.png` / `.svg`) when one exists, otherwise skipped |
| `.canvas` `.base`, Dataview results | Unsupported (recorded in the report) |

</details>

If 60%+ of a folder's direct notes share 3 or more frontmatter keys, o2n **suggests turning that folder into a database** (you decide in `plan`).

---

## ⏱ Time and limits

- **Estimate**: 1,000 notes + 500 attachments ≈ 4,000–5,000 API calls ≈ 30–40 minutes (default 2 req/s)
- On Business or higher, `O2N_REQUESTS_PER_SECOND=8` (1–10) shortens the run. 429 responses are honored via `Retry-After`
- **Notion Free plan block limit** (since September 2026): multi-member Free workspaces have a lifetime cap of 1,000 blocks that is also enforced by the API ([reference](https://developers.notion.com/reference/workspace-block-limits)). `scan` / `plan` warn up front using the estimated block count; if the limit is hit, o2n stops immediately and `resume` continues later. PATs, paid plans and single-member Free workspaces are not affected

---

## 🛡 Security

- The token lives only in the `NOTION_TOKEN` env var or `~/.o2n/credentials.json` (mode 600)
- The vault itself is **always read-only**; o2n writes only inside `.o2n/`
- Only YAML frontmatter is parsed; `---js` / `---json` etc. skip just that note, safely
- Symlinks inside the vault are never followed. `.o2n/` and `~/.o2n/` are read and written with symlink / hardlink / TOCTOU protections
- `.o2n/state.json` is bound by signature to the vault, the plan and the Notion workspace, so mix-ups are detected
- Hardened against ReDoS from malicious vaults
- No network traffic other than the Notion API (no telemetry). npm packages are published via Trusted Publishing (OIDC) **with provenance**

<details>
<summary><b>How <code>o2n login</code> (OAuth) works and its trust model</b></summary>

- Notion OAuth (public integrations) requires a `client_secret`, which cannot ship in a CLI. Instead `services/auth-proxy` (a Cloudflare Worker) holds the secret and only exchanges the authorization code for a token
- In the new flow the CLI opens a temporary HTTP listener on `127.0.0.1`; after the exchange the Worker returns only a short-lived handoff code to loopback. The CLI POSTs its session secret plus the handoff code to the Worker, receives the token exactly once, and stores it in `~/.o2n/credentials.json`
- The `client_secret` is never present in the CLI, the MCP server or this repository (Worker environment only). The Worker never touches vault or Notion page contents
- Re-enabling it means trusting the Worker operator (TK-WFL or your own self-hosted instance). Using `NOTION_TOKEN` does not depend on that trust model. Deployment: [services/auth-proxy/README.md](services/auth-proxy/README.md)

</details>

---

## 🧑‍🔧 Development

```bash
npm install
npm run build
npm test
```

```
packages/
  core/          # scanner / planner / converter / migrator / state / notion / report
  cli/           # the o2n command (thin wrapper over core)
  mcp-server/    # stdio MCP server (thin wrapper over core)
services/
  auth-proxy/    # OAuth code-exchange proxy for `o2n login` (Cloudflare Worker)
fixtures/test-vault/  # test vault covering every supported syntax
scripts/verify-release.mjs  # pre-publish npm package content/checksum verification
docs/
  e2e.md         # manual end-to-end runbook
  questions.md   # implementation decisions and real-workspace verification notes
  spec.md        # security boundary and persisted-data specification
```

Bug reports and requests go to [Issues](https://github.com/TK-WFL/o2n/issues). If some syntax converts badly, a small snippet helps a lot.

<div align="center">

MIT License · [TK-WFL](https://github.com/TK-WFL)

</div>
