## [0.1.0] — 2026-05-26

### Added
- Initial release of `@xns/relayer-mcp` — MCP server for XNS Relayer onboarding.
- 10 MCP tools (stdio transport) orchestrating end-to-end Relayer setup:
  - `check_prerequisites` — Docker, ports, disk, connectivity checks with remediation hints.
  - `register_account` — E2 account registration (POST /api/auth/register); 409 skip hint, 422 validation detail.
  - `check_email_verified` — 15s polling with 30-min timeout and auto-resend; three-state response.
  - `install_relayer` — Docker Compose download + `docker compose up -d` via execFile (no shell).
  - `check_relayer_health` — UI/S3/HostIO health polling (300s timeout); HostIO null before auth.
  - `start_claim` — Claim session initiation; 402 payment-required stop (no TTL loop).
  - `check_claim_status` — 10s claim state polling (STATE_1/2/3); 402 stop, 404 expiry.
  - `get_host_tags` — HostIO tags via OIDC-authenticated relayer-ui proxy; 401 re-auth.
  - `configure_vpd` — CEL expression submission; too-few-hosts 400 names 10/20 threshold.
  - `verify_storage` — S3 round-trip (CreateBucket/PutObject/GetObject) at localhost:9000.
- OIDC Authorization Code + PKCE (S256) token acquisition (`src/lib/oidcAuth.js`) for tools 8/9.
  - Loopback `127.0.0.1` listener, browser-based sign-in, code-to-token exchange, refresh.
  - Interface designed for future extraction to `@xns/relayer-auth` (CLI reuse).
- Shared libraries: httpClient, pollUntil, dockerUtil (execFile only), s3Client.
- npx distribution: `npx @xns/relayer-mcp@latest` in Claude Desktop config.
