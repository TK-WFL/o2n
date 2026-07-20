# Security Policy

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
