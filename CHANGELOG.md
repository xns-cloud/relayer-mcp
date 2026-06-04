## [0.4.0] — 2026-06-04

Addresses homelab beta-tester feedback: Node 18 on stock Ubuntu, Claude Code on
a jump host with a remote Docker daemon, and install collisions with an
existing alpha-channel deployment.

### Added
- **Remote Docker host support.** The MCP now resolves WHERE the Docker daemon
  runs (honoring `DOCKER_HOST` and the active `docker context`, e.g.
  `ssh://user@host`) via `dockerUtil.getDockerHost()`:
  - `check_relayer_health` and `verify_storage` probe the Docker host instead
    of hardcoded `localhost` (override with the new `host` / existing
    `endpoint` params).
  - `check_relayer_health` gains `ui_port` / `minio_port` params matching
    `install_relayer`'s custom ports.
  - `check_prerequisites` skips the local port bind-probe when the daemon is
    remote (it would test the wrong machine) and reports the checks as skipped
    with instructions, and names the remote host in the docker check.
- **Fresh-install preflight.** `install_relayer` now detects an existing
  `xns-relayer` container — running or stopped, any channel (including alpha
  installs from `releases.scpri.me`) — via `dockerUtil.findContainer()`
  (`docker ps -a`, exact name) and fails fast with migration steps instead of a
  docker name-conflict error. `check_prerequisites` surfaces the same
  condition early as an `existing_install` warning.
- **Node version guard.** `src/index.js` checks `process.versions.node` before
  loading the SDK; on Node < 20 it exits with nvm/NodeSource install guidance
  (Ubuntu's default apt repo ships Node 18) instead of a dependency stack
  trace.
- README: Requirements section with Node 20 install one-liners, Remote Docker
  hosts guide (`docker context create --docker "host=ssh://..."`), fresh-vs-
  existing-deployment guide, troubleshooting table; tool table now lists all 11
  tools (`setup_cli_credentials` was missing).

### Fixed
- MCP server version reported over the protocol now reads from `package.json`
  instead of a hardcoded stale `'0.1.0'`.

## [0.3.0] — 2026-06-03

### Changed
- **License is now Apache-2.0** (permissive, open source) — replaces the prior
  proprietary license. Adds `LICENSE` (full Apache-2.0 text) + `NOTICE`, sets
  `package.json` `license: "Apache-2.0"`, and ships both in the npm tarball
  (`files`). The MCP can now be published to the wider world on release.
- `install_relayer` bundled compose now pins the **pre-release `:beta` channel**
  (`scprime/xns-relayer:beta`) instead of `:stable`, so alpha/beta testers
  exercise the current Relayer agentically. The image tag flips to `:stable` at
  general release — a one-line change in `src/templates/docker-compose.yml`.
  Tool params and the `compose_url` override are unchanged.
- **Packaging:** `files` now lists the runtime subdirs explicitly
  (`src/index.js`, `src/lib/`, `src/tools/`, `src/templates/`) instead of all of
  `src/`, so the published tarball no longer ships the jest suite — 38 → 24
  files, 35.2 kB → 23.8 kB packed. Removed the `.npmignore`, which was dead
  config: a `files` allowlist overrides `.npmignore`, so it never excluded the
  tests it listed. (0.3.0 is not yet published, so this folds into it.)
- **Package scope is `@xns-cloud`**: the npm org is `xns-cloud`, so the package
  publishes as `@xns-cloud/relayer-mcp`. Nothing was ever published under any
  prior scope.

## [0.2.0] — 2026-05-30

### Changed
- `install_relayer` now writes the compose file **and** `.env` for the user — a
  first-time user (who has never heard of a Relayer) no longer hand-authors
  either file. Defaults to the documented released install: Docker Hub
  `scprime/xns-relayer:stable`, relayer-only, ports 8888 (UI) + 9000 (S3).
  Mirrors https://xns.tech/docs/windows-ui/.
  - `compose_url` is now **optional** — kept only as an override for custom
    installs. Omitting it (the normal path) writes the bundled compose.
  - New optional `ui_port` / `minio_port` params (default 8888 / 9000) flow into
    the generated `.env` and the `docker compose` env, so a port conflict found
    by `check_prerequisites` can be remapped without editing files.
- Bundled released compose shipped at `src/templates/docker-compose.yml`
  (covered by `package.json` `files: ["src/"]` — verified in the npm tarball).
  SMB ports 139/445 are intentionally not exposed (445 is held by Windows SMB
  on consumer hosts and would fail the install).

### Fixed
- `index.test.js` asserted 10 registered tools; it has been 11 since
  `setup_cli_credentials` (tool 11) merged. Corrected the count + name list so
  the suite is green on the default branch.

## [0.1.0] — 2026-05-26

### Added
- Initial release of `@xns-cloud/relayer-mcp` — MCP server for XNS Relayer onboarding.
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
  - Interface designed for future extraction to `@xns-cloud/relayer-auth` (CLI reuse).
- Shared libraries: httpClient, pollUntil, dockerUtil (execFile only), s3Client.
- npx distribution: `npx @xns-cloud/relayer-mcp@latest` in Claude Desktop config.
