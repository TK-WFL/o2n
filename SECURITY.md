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

1. Set the same new version in core, CLI, and MCP package manifests. CLI and MCP must depend on `@tk_wfl/o2n-core` at `^<same version>`, and the lockfile must match.
2. Merge the version change to `main`; never publish from a dirty local checkout.
3. Dispatch **Publish npm packages** from `main` with that exact version and approve the protected `npm-publish` environment.
4. The workflow installs from lockfiles, runs type checks, tests, full audits, clean builds, tarball inspection, and registry collision checks before publishing with OIDC provenance.
5. It publishes core first, confirms that version is visible on npm, then publishes CLI and MCP. If a later publish fails, do not blindly rerun: inspect npm provenance and package contents before deciding how to recover.
