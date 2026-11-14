# Security Policy

Last updated: 2026-07-20

## Supported Versions

Only the latest published version is supported for security fixes.

## Reporting a Vulnerability

Please report security issues privately by opening a GitHub security advisory for this repository.
Do not include secrets, real Notion tokens, or private vault contents in reports.

Useful details:

- affected package and version
- exact command or MCP tool used
- minimal vault fixture if relevant
- whether `o2n login`, `NOTION_TOKEN`, or MCP was involved

## Current Security Notes

- Do not process untrusted vaults with versions older than this fix release.
- If you processed an untrusted vault with an older version, revoke and re-issue the Notion token.
- If you used the old browser OAuth login flow, revoke and re-issue the stored Notion token.
- Prefer `NOTION_TOKEN` until browser OAuth has been re-enabled and verified in your deployment.
- `o2n mcp allow` and `o2n mcp write on` refuse to run without an interactive terminal, so an agent calling the CLI through an ordinary tool cannot widen its own MCP access. This is a safeguard against accidental or automated changes, not a hard boundary: a process that can allocate a pseudo-terminal or edit `~/.o2n/mcp-settings.json` directly can still change the settings. The confirmation phrase only protects real runs while the agent does not know it, so do not let an agent generate or read it.

## Operational Hardening

- Set `O2N_ALLOWED_VAULTS` for MCP usage.
- Keep MCP writes disabled unless needed; enable with `O2N_ENABLE_MCP_WRITE=1` and a strong `O2N_MCP_WRITE_TOKEN`.
- Keep `OAUTH_ENABLED = "0"` in the auth proxy until the loopback handoff deployment is validated.
- Do not commit `.env`, `~/.o2n/credentials.json`, Cloudflare secrets, or Notion tokens.

## Repository Administrator Checklist

These settings cannot be enforced by a pull request. Repository administrators must verify them in GitHub:

- Protect `main` with a ruleset or branch protection: require pull requests, required CI and CodeQL checks, conversation resolution, and no force pushes or deletions.
- Enable secret scanning, push protection, and validity checks where available.
- Enable the dependency graph, Dependabot alerts, and Dependabot security updates.
- Review weekly GitHub Actions SHA update pull requests from Dependabot; do not replace pinned SHAs with mutable tags.
- Create an `npm-publish` environment restricted to `main`, add required reviewers, prevent self-review where available, and do not store an npm token in it.
- For each npm package, configure npm trusted publishing for this repository, `.github/workflows/publish.yml`, and the `npm-publish` environment.

## npm Release Runbook

1. Set the same new version in core, CLI, and MCP package manifests. CLI and MCP must depend on `@tk_wfl/o2n-core` at `^<same version>`, and the lockfile must match. Leave `plugin/` at the previous version: its lockfile can only point at versions that are already on npm (step 8).
2. Merge the version change to `main`; never publish from a dirty local checkout.
3. Dispatch **Publish npm packages** from `main` with that exact version and approve the protected `npm-publish` environment.
4. The unprivileged verification job installs from lockfiles, runs type checks, tests, full audits, clean builds, tarball inspection, and registry collision checks. It passes only fixed-name, checksummed tarballs through an immutable Actions artifact.
5. After environment approval, the OIDC-enabled job checks out no repository code and publishes only those verified tarballs with provenance. It publishes core first, confirms that version is visible on npm, then publishes CLI and MCP.
6. If a later publish fails, do not blindly rerun: inspect npm provenance and package contents before deciding how to recover.
7. After a successful publish, a separate job (the only one with `contents: write`) creates a **draft** GitHub Release tagged `v<version>` at the published commit, with notes generated from the merged PR titles. Review the notes and press "Publish release"; nothing is public until then. If a release for that tag already exists, the job skips.
8. Pin the Claude plugin to the published version in a separate pull request: run `node scripts/pin-plugin.mjs <version>`. It refuses a version that is not on npm, sets the version in `plugin/package.json`, `plugin/.claude-plugin/plugin.json` and the `npx @tk_wfl/o2n-cli@<version>` commands in the plugin's text, and regenerates `plugin/package-lock.json` from the registry. Claude Code installs the MCP server from that lockfile with `--ignore-scripts` when a user installs the plugin, and `plugin/.mcp.json` starts it with `node` from `${CLAUDE_PLUGIN_ROOT}/node_modules`. CI installs the lockfile the same way, audits it, and starts the server. Unit tests fail if the plugin's versions disagree, point past the workspace version, or if the lockfile has a non-registry source, a missing integrity hash, or an install script.
9. After that pull request is merged, dispatch **Release Claude plugin** from `main`. It repeats the install, audit and start check, then fast-forwards the `plugin-release` branch to that commit (the only job there with `contents: write`). Anthropic's plugin directory tracks that branch.
