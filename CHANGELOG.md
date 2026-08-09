# Changelog

## [Unreleased]

### Added

- **`install_relayer` states the binding it composed.** The success JSON now carries a
  `binding` block: the UI and S3 host→container port pairs, where those values were
  written, and an explicitly labelled `reachability` note. The installer is one of the
  three out-of-band channels an operator can consult when a connection is refused, so
  it now says what it published instead of staying silent. Reachability is labelled
  *configured — not verified from this process* and points at `docker port xns-relayer`
  on the host, rather than asserting a publication this process cannot see.
  Container ports are reported only where they are known: on the normal install they
  come from the channel compose this installer fetches, but a caller-supplied
  `compose_url` may remap them and is never read here, so those values are `null` and
  no `.env` is written on that path — the ports are passed to `docker compose` at
  runtime instead.
- **Discovery metadata for agentic clients.** npm keywords expanded from four to
  fourteen (`mcp-server`, `model-context-protocol`, `object-storage`, `s3`,
  `self-hosted`, `ai-agent`, `stdio` and others), aligned with the README, the
  official MCP Registry entry, and the xns.tech machine surfaces. The package was
  live in the registry but effectively invisible in the directories agents actually
  search.
- **README badges and a one-command install.** npm version, license, and supported
  Node badges render from live npm data (so they cannot drift), plus a
  `claude mcp add` snippet alongside the existing `claude_desktop_config.json` block.
- **`CONTRIBUTING.md` and `.github/PULL_REQUEST_TEMPLATE.md`.** A stranger arriving
  at the GitHub mirror is told plainly that the mirror is read-only, that
  development happens on GitLab, and where to file issues and merge requests.
- **Identity contract tests** (`src/__tests__/registryIdentity.test.js`). Thirteen
  tests hold `mcpName`, package name, version, and repository host in agreement
  across `package.json` and `server.json`, and guard the README's tool count and
  keyword invariants against drift.

The four discovery/documentation entries above change no runtime behavior, and
`server.json` is deliberately untouched — the repository URLs stay on GitLab, so
the MCP registry entry needs no republish.

## [0.6.1] — 2026-06-17

### Added

- **`mcpName` field (`tech.xns/relayer`).** Enables ownership verification for the
  official MCP Registry (`registry.modelcontextprotocol.io`); the registry matches
  this against the `server.json` `name`. npm versions are immutable, so this required
  a new release before the first registry publish.

## [0.6.0] — 2026-06-11

### Added

- **Day-2 management tools (12-15).** `describe_settings` / `update_settings` — a
  curated, whitelist-enforced settings surface (worker/concurrency tuning, backup
  schedule, cost center/CCID) over `GET`/`PUT /api/v1/config`; the full advanced
  catalog is deliberately not exposed, and unknown or protected keys are rejected
  with the allowed list. `restart_service` — per-service or full restart via
  `GET /api/v1/system/restart[/:service]`, standalone because it is disruptive and
  separately confirmable. `manage_backups` — list/start/restore/delete over the
  backup API, with selective-component restore (`db`, `conf`, `hostio`, `samba`).
  `update_settings` requires relayer-ui >= 3.43.3 (the `[REDACTED]` database-password
  round-trip guard).
- **`configure_vpd` `dry_run`.** Routes to HostIO's read-only evaluate endpoint
  (the VPD evaluation single-source-of-truth) and returns matched data/parity host
  counts without applying. Relayer builds that predate the endpoint report
  `preview_supported: false` instead of erroring; no MCP update is needed once the
  endpoint ships.
- **`get_host_tags` read-back.** Now also returns the currently applied VPD
  expressions (`current` with an `is_default` flag) via HostIO `getexpressions`,
  degrading to tags-only if the read-back is unavailable.

### Fixed

- **Both VPD tools were broken in <= 0.5.2 — wrong proxy path.** The tools called
  `/api/v1/proxy/hostio/v1/hostio/...`, but the relayer-ui proxy prepends
  `/v1/hostio/` to the wildcard, producing `/v1/hostio/v1/hostio/...` → HostIO 404
  (verified live). The proxy wraps that failure as HTTP 200
  `{success:false, state}`, which `get_host_tags` then returned as if it were the
  tag list. Paths corrected; proxy-wrapped failures are now detected and reported
  as errors on every HostIO call.
- **`configure_vpd` silently discarded every custom selection — wrong wire keys.**
  The payload used `{data_expression, parity_expression}`, but HostIO's
  `SetExpressionsRequest` decodes `{data, parity}`; both fields arrived empty and
  HostIO substituted the all-hosts default while the tool reported success. The
  wire payload now matches the HostIO contract (tool parameter names unchanged).

## [0.5.2] — 2026-06-09

### Fixed

- **`install_relayer` offline fallback no longer orphans data (tacom beta bug #2).**
  The bundled `src/templates/docker-compose.yml` used a bind mount (`./data:/relayer`)
  while the channel bundle uses the named volume `relayer_data`. Because the default
  install fetches the channel bundle and only writes this template when that fetch
  fails, an online-vs-offline install silently switched the mount target and the
  user's S3 buckets appeared to vanish (data orphaned in the unmounted volume). The
  fallback now uses the same `relayer_data` named volume as the channel bundle. A new
  storage-strategy parity test asserts the named volume + `pull_policy: always` so the
  two composes can never drift on storage again.
  - Migration note: an EXISTING offline-fallback install that already has data in a
    `./data` bind mount must not be silently switched — the install preflight already
    refuses an in-place reinstall while the container exists. To migrate, copy the
    `./data` contents into the `relayer_data` volume, or keep the old layout via a
    custom `compose_url`.

### Fixed

- **`verify_storage` self-cleanup (W3-AC1):** The tool now removes its `mcp-verify-*`
  test bucket and object in a `finally`-style block — whether the verification passes
  or fails. A cleanup failure is non-fatal: it is noted in the response as
  `cleanup_warning` and never flips a passing result to a failure.
- **`verify_storage` fullaccess credential requirement (W3-AC2):** The tool
  description now explicitly states that fullaccess credentials (the admin key pair
  from the Relayer UI IAM page) are required. Credential-error responses include a
  `credential_requirement` field repeating the requirement.
- **`verify_storage` explicit-IP guidance (W3-AC3):** When the endpoint was
  auto-detected from the Docker context, both success and failure responses include
  guidance on passing an explicit `endpoint` IP (e.g. `http://<ip>:9000`) when
  auto-detection cannot reach the host.
- **`install_relayer` injectable channel URL seam (W3-AC4):** The channel compose
  URL (`https://releases.scpri.me/relayer/beta/docker-compose.yml`) is now
  injectable via `options.channelComposeUrl` — no override produces byte-identical
  production behavior; tests can inject a custom URL without network access.
- **`s3Client` delete wrappers:** Added `deleteObject` and `deleteBucket` thin
  wrappers (using `DeleteObjectCommand` / `DeleteBucketCommand` from the AWS SDK)
  so the cleanup path in `verify_storage` can operate through the same injectable
  client interface used for create/put/get.

## [0.5.0] — 2026-06-04

### Fixed

- **`install_relayer` now installs the full channel bundle — monitoring stack
  included.** Beta-tester report: MCP installs shipped no Prometheus/Grafana,
  leaving the dashboards under Monitoring in the web UI dead. The default path
  now fetches the canonical beta channel compose
  (`https://releases.scpri.me/relayer/beta/docker-compose.yml` — relayer +
  Prometheus + Grafana + node-exporter, versioned in the deploy repo and
  shipped by `deploy.py promote`) instead of writing a relayer-only bundled
  template. The bundled template remains as an **offline fallback** only, is
  reconciled to service parity with the channel bundle (monitoring stack +
  `privileged: true`), and jest contract tests now enforce that parity so the
  relayer-only drift cannot silently return. Fallback installs say so in the
  response (`source: "bundled-fallback"` + note).

### Changed

- **`check_relayer_health` now checks the monitoring sidecars.** A missing
  Prometheus or Grafana container reports `degraded: true` with a named
  `components.monitoring` entry and a message suffix — surfaced, never
  swallowed — without blocking the core install/claim flow.

## [0.4.0] — 2026-06-04

Addresses homelab beta-tester feedback: Node 18 on stock Ubuntu, Claude Code on
a jump host with a remote Docker daemon, and install collisions with an
existing alpha-channel deployment.

### Changed

- **`install_relayer` now targets the canonical beta release channel on the XNS
  releases registry: `releases.scpri.me/xns-relayer:beta-latest`** (anonymous
  pull, no `docker login`) — replacing Docker Hub `scprime/xns-relayer:beta`.
  The Hub tag is a production *fleet* registry artifact, not a release channel;
  it had not been refreshed since 2025-08 and installs through it shipped a
  10-month-old Relayer. `compose_url` can point at the full channel bundle
  (relayer + monitoring) at
  `https://releases.scpri.me/relayer/beta/docker-compose.yml`. A regression
  test pins the bundled template to the releases registry so a Hub reference
  can never silently return. `check_prerequisites` now also probes
  `releases.scpri.me` (the registry the install pulls from) alongside
  console/auth connectivity.
- **BREAKING (vs 0.3.0): `install_relayer` param `minio_port` is now `s3_port`**,
  and the generated `.env` / compose interpolation var `MINIO_PORT` is now
  `S3_PORT`. Port 9000 is served by the Relayer **S3 Gateway**; the MinIO
  naming was legacy and is purged from the public API. MCP clients read the
  tool schema live, so agents adapt automatically; only the unpublished-channel
  0.3.0 signature is affected.

### Added

- **Remote Docker host support.** The MCP now resolves WHERE the Docker daemon
  runs (honoring `DOCKER_HOST` and the active `docker context`, e.g.
  `ssh://user@host`) via `dockerUtil.getDockerHost()`:
  - `check_relayer_health` and `verify_storage` probe the Docker host instead
    of hardcoded `localhost` (override with the new `host` / existing
    `endpoint` params).
  - `check_relayer_health` gains `ui_port` / `s3_port` params matching
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
- `check_relayer_health` host input: any scheme prefix (`http://`, `tcp://`,
  `ssh://`) is stripped before composing probe URLs, and loopback aliases
  (`127.0.0.1`, `[::1]`) classify as local, not remote.

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
