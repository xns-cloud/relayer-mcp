# @xns-cloud/relayer-mcp

[![npm version](https://img.shields.io/npm/v/@xns-cloud/relayer-mcp)](https://www.npmjs.com/package/@xns-cloud/relayer-mcp)
[![license](https://img.shields.io/npm/l/@xns-cloud/relayer-mcp)](./LICENSE)
[![node](https://img.shields.io/node/v/@xns-cloud/relayer-mcp)](https://nodejs.org/)

MCP server for [XNS Relayer](https://xns.tech) — S3-compatible decentralized object storage. Provides 15 tools that let an AI agent drive the complete Relayer setup and day-2 management conversationally over stdio transport.

```bash
npx @xns-cloud/relayer-mcp@latest
```

**Pricing:** [$6.00 per TB-month](https://xns.tech/pricing) — one rate, protection included, [$0 egress uncapped](https://xns.tech/pricing), [30-day minimum retention](https://xns.tech/pricing) with no separate early-delete fee.

## Requirements

- **Node.js 20+** — see [Installing Node.js 20](#installing-nodejs-20) if your distro ships an older version.
- **Docker Engine** — on the same machine, or on a remote host via a Docker context (see [Remote Docker hosts](#remote-docker-hosts)).

### Installing Node.js 20

Ubuntu's default apt repository only ships Node 18, which is too old. Two ways to get Node 20:

**nvm** (recommended — no root required):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
\. "$HOME/.nvm/nvm.sh" && nvm install 20
```

**NodeSource** (system-wide): follow <https://github.com/nodesource/distributions#installation-instructions>.

If you start the MCP on an older Node, it exits immediately with this same guidance instead of a dependency stack trace.

## Environment

The Relayer runs as a Docker container and persists its data in a Docker volume. If the MCP is running inside an ephemeral environment (a sandbox container, a CI runner, or a throwaway VM), any installation performed there will be lost when that environment exits. `check_prerequisites` detects this automatically and reports it as a warning with a concrete next step — it never blocks the flow.

**If your environment is ephemeral**, install on a persistent Docker host instead. The easiest path from an ephemeral sandbox is an SSH Docker context:

```bash
docker context create relayer --docker "host=ssh://user@persistent-host"
docker context use relayer
```

The MCP then drives the install on the persistent host through the SSH context. Alternatively, hand the install step to a human operator on the target machine and continue onboarding from `check_relayer_health` onwards.

**Know the tradeoff before you take this path.** With an SSH context the containers start on the remote host and the data lives in Docker volumes there, but `install_relayer` writes `docker-compose.yml` and `.env` on the machine running the MCP — not on the Docker host. That is fine for the install and fine for your data; it is not fine for day 2. Restarting, changing ports, and upgrading from the Docker host all need a compose file that host does not have. From an ephemeral sandbox it is worse: the only copy of those files exits with the sandbox, leaving a running Relayer nobody can administer.

`check_prerequisites` warns about this before anything is written, and `install_relayer` returns an `action_required` field plus a `move_files` block carrying the source machine and path, the destination machine and path, the Docker endpoint it detected, where the compose file came from, and the contents of the env file it wrote. Either run the MCP on the Docker host, or [move the install directory across](#moving-the-install-files-to-the-docker-host) as soon as the install finishes.

### Moving the install files to the Docker host

The MCP does **not** generate a copy command for you. Getting one right means guessing your scp version, shell, ssh port, bastion, sudo policy and path, and a wrong command that looks right is worse than no command. Below are three worked examples covering the common shapes — take the one that matches your setup and substitute the values from `move_files`.

Three things to know before you adapt any of them:

- **Keep the same directory name on both machines.** Compose takes the project name from the directory it runs in, and volume names are prefixed with it. Land the files in `/srv/relayer` instead of `/opt/xns-relayer` and `docker compose` there is a *different project*: it will not see the running containers, and `docker compose up` would create a second set of empty volumes and then fail, because `container_name: xns-relayer` is pinned in the compose file and that name is already taken. You get a `409 Conflict` rather than a working Relayer, plus stray empty volumes to clean up. Use the last path segment from `move_files.destination_path`. Keeping the whole path identical is safest — a compose file that binds a relative host path resolves it against the project directory.
- **Copy to the parent directory.** `scp -r /opt/xns-relayer host:/opt/xns-relayer` copies *into* an existing target, leaving the files at `/opt/xns-relayer/xns-relayer/` where `docker compose` will not find them.
- **`/opt` needs root.** If your ssh user cannot write the destination, create it first — `scp` will not create a missing parent.

**1 — SSH Docker context, default path.** The common case.

```bash
ssh -t user@docker-box 'sudo install -d -o $USER /opt/xns-relayer'
scp -r /opt/xns-relayer user@docker-box:/opt
```

**2 — Non-standard ssh port, or the Docker host behind a bastion.** Note `ssh` takes `-p` for the port and `scp` takes `-P`; `-J` is the jump host.

```bash
ssh -t -p 2222 user@docker-box 'sudo install -d -o $USER /opt/xns-relayer'
scp -P 2222 -r /opt/xns-relayer user@docker-box:/opt

# via a bastion — the prepare step needs the same -J
ssh -t -J user@bastion user@docker-box 'sudo install -d -o $USER /opt/xns-relayer'
scp -J user@bastion -r /opt/xns-relayer user@docker-box:/opt
```

**3 — No ssh route from this machine.** A `tcp://` Docker context, a key only the Docker CLI can use, or a locked-down sandbox. There are only two small files, so recreate them on the Docker host by hand.

Check `move_files.compose_source` in the response first — it tells you where your compose file came from, and the three cases need different handling:

| `compose_source` | Where to get `docker-compose.yml` |
|---|---|
| `channel` | `curl -fsSLO <compose_url>`, using the URL from `move_files.compose_url` |
| `bundled-fallback` | It came from inside the npm package on the MCP machine, not from a URL. Copy that one file across by any means you have — a clipboard paste is fine, it is a few dozen lines. |
| `compose_url` | Your own custom compose, from wherever you supplied it. |

Then, in a directory whose **last path segment matches** `move_files.destination_path`:

```bash
# on the Docker host
sudo install -d -o $USER /opt/xns-relayer
cd /opt/xns-relayer
# put docker-compose.yml here per the table above, then write the env file:
printf 'UI_PORT=8888\nS3_PORT=9000\nBIND_ADDRESS=\n' > .env
```

Use the values from `move_files.env_contents`, not the defaults above, if you installed with custom ports or a bind address. If `env_contents` is `null` the install wrote no env file (the `compose_url` path) — your compose file supplies its own values, or you export them before `docker compose up`.

Verify from the Docker host afterwards — this should list the running services rather than an error about a missing configuration file, and should show the containers that are *already up*, not propose new ones:

```bash
cd /opt/xns-relayer && docker compose ps
```

## Install

**Claude Code** (one command):

```bash
claude mcp add relayer -- npx @xns-cloud/relayer-mcp@latest
```

**Claude Desktop / any MCP client** — add to your `claude_desktop_config.json` (or equivalent):

```json
{
  "mcpServers": {
    "relayer": {
      "command": "npx",
      "args": ["@xns-cloud/relayer-mcp@latest"]
    }
  }
}
```

**Cursor** — add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "relayer": {
      "command": "npx",
      "args": ["@xns-cloud/relayer-mcp@latest"]
    }
  }
}
```

No separate install step required — npx fetches the package on demand.

## Tools

| # | Tool | Purpose |
|---|------|---------|
| 1 | `check_prerequisites` | Verify Docker (local or remote), ports (8888, 9000), an existing installation, disk, and network connectivity. |
| 2 | `start_registration` | Get the browser sign-up URL for creating an XNS account — the agent never handles credentials. |
| 3 | `check_email_verified` | Poll email verification status (15s interval, 30-min timeout). |
| 4 | `install_relayer` | Fetch the canonical beta channel bundle — relayer + Prometheus/Grafana monitoring stack (`https://releases.scpri.me/relayer/beta/docker-compose.yml`, anonymous pull, no `docker login`) — write the `.env`, and start the containers. Falls back to a bundled service-parity copy if the fetch fails. **Fresh installs only** — see [Fresh installs vs. existing deployments](#fresh-installs-vs-existing-deployments). The user authors nothing; `compose_url` is an optional override for custom installs. |
| 5 | `check_relayer_health` | Poll UI, S3, HostIO, and the monitoring sidecars (10s interval, 300s timeout). A missing monitoring stack reports as degraded without blocking the flow. Targets the Docker host automatically. |
| 6 | `start_claim` | Initiate a claim session — returns a URL for browser confirmation. |
| 7 | `check_claim_status` | Poll claim state (STATE_1 / STATE_2 / STATE_3). |
| 8 | `get_host_tags` | Retrieve available host tags for VPD configuration, plus the currently applied data/parity selection (read-back with an `is_default` flag). |
| 9 | `configure_vpd` | Set data/parity host selection via CEL expressions. `dry_run: true` previews the matched host counts without applying (requires a Relayer build with the HostIO evaluate endpoint; older builds report `preview_supported: false`). |
| 10 | `verify_storage` | Round-trip S3 test (create bucket, put object, get object) against the S3 gateway. Provisions a temporary scoped IAM credential automatically from your OIDC session — no manual key management needed. The tool attempts to remove test data and the throwaway credential after the test; a `cleanup_warning` is reported if any resource could not be removed. `relayer_ui_url` must point at a loopback or private-network host. |
| 11 | `setup_cli_credentials` | Provision S3 IAM credentials and write `~/.xns/credentials` so the XNS CLI works without further configuration. |
| 12 | `describe_settings` | List the adjustable settings — worker/concurrency tuning, backup schedule, cost center (CCID) — with current values, defaults, and guidance. The MCP deliberately exposes only this curated set, never the full advanced catalog. |
| 13 | `update_settings` | Apply a map of setting changes (whitelist-enforced). Returns `require_restart`. **Requires relayer-ui >= 3.43.3** — older servers can clobber the database password on config round-trips. |
| 14 | `restart_service` | Restart `hostio`, `gateway`, `s3gateway`, `database`, or all services. Disruptive; pairs with `check_relayer_health` to verify recovery. |
| 15 | `manage_backups` | List / start / restore / delete configuration backups. Restore is destructive and supports selective components (`db`, `conf`, `hostio`, `samba`). |

## Onboarding Flow

1. Agent checks prerequisites (Tool 1).
2. Agent gets the browser sign-up URL; user creates an account in the browser (Tool 2).
3. User clicks email verification link; agent polls (Tool 3).
4. Agent installs and starts Relayer containers (Tool 4) — it writes the
   released compose + `.env` itself; the user is never asked for a compose URL.
5. Agent polls health until UI + S3 are up (Tool 5).
6. Agent initiates claim; user opens claim URL in browser (Tools 6 + 7).
7. Agent signs in via OIDC to configure host preferences (Tools 8 + 9).
8. Agent verifies S3 storage is working (Tool 10).
9. Optionally, agent provisions CLI credentials (Tool 11).

The operator's only required actions are: clicking one email link, completing one browser sign-in, and confirming one claim.

## Day-2 Management

After onboarding, tools 12-15 cover routine adjustments: `describe_settings` → `update_settings` → `restart_service` for tuning (workers, concurrency, backup schedule, cost center), and `manage_backups` for the backup lifecycle. All four use the same OIDC session as tools 8-9. Destructive operations (restore, restart, changing the cost center) are agent-confirmed with the operator before execution — the tool descriptions and responses carry the warnings.

## Fresh installs vs. existing deployments

`install_relayer` performs **fresh installs only** — it does not upgrade an existing deployment in place. Docker container names are unique per daemon, so any existing `xns-relayer` container (running **or stopped**, any channel — including an alpha-channel install from `releases.scpri.me`) blocks the install. Both `check_prerequisites` and `install_relayer` detect this and tell you before anything breaks.

To replace an existing deployment:

```bash
docker stop xns-relayer && docker rm xns-relayer   # does NOT delete the data directory
```

then run `install_relayer` again. To keep the existing deployment, skip `install_relayer` and continue onboarding against it (`check_relayer_health` onwards).

## Remote Docker hosts

Claude Code doesn't have to run on the Docker machine. If you run it on a management node or jump host, point the Docker CLI at the remote server with an SSH context:

```bash
docker context create relayer --docker "host=ssh://user@docker-box"
docker context use relayer
```

(Requires the `docker` CLI on the management node — the [static binary](https://docs.docker.com/engine/install/binaries/) is enough — and SSH key access to the Docker host.)

The MCP detects this automatically (it honors `DOCKER_HOST` and the active Docker context):

- `install_relayer` runs `docker compose` against the remote daemon.
- `check_relayer_health` and `verify_storage` probe the **remote host's** ports 8888/9000 instead of localhost — make sure those are reachable from the management node.
- `check_prerequisites` skips the local port-availability probes (the containers bind ports on the remote host) and reports them as skipped with instructions.
- `check_prerequisites` also raises an `install_file_location` warning, and `install_relayer` returns `action_required` plus a `file_location` block naming both machines — because the install files are written on the management node while the containers run on the Docker host. See [Environment](#environment) for what to do about it.

`check_relayer_health` accepts a `host` override, and `verify_storage` an `endpoint` override, for setups the auto-detection can't see (port forwards, NAT).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| MCP exits with "requires Node.js 20 or newer" | Distro Node is too old (Ubuntu apt ships Node 18) | [Installing Node.js 20](#installing-nodejs-20) |
| `install_relayer` reports an existing `xns-relayer` container | A previous deployment (any channel) owns the container name | [Fresh installs vs. existing deployments](#fresh-installs-vs-existing-deployments) |
| Port 8888/9000 already in use | Another service on the Docker host (another S3-compatible service squatting 9000) | Stop it, or install with custom ports: `install_relayer` `ui_port` / `s3_port` (health checks accept the same) |
| Health checks fail but containers run on a remote Docker host | Ports 8888/9000 not reachable from the management node | Open them, or pass `host` / `endpoint` overrides |
| `docker compose` on the Docker host says no configuration file found, after a successful install | The MCP ran on another machine, so the compose and env files were written there | [Moving the install files to the Docker host](#moving-the-install-files-to-the-docker-host), or reinstall with the MCP running on the Docker host |
| `install_relayer` fails with "Failed to create directory … on this machine" | The install path needs root on the machine running the MCP (common on macOS/Windows workstations for paths under `/opt`) | Pass a writable `install_path`, or run the MCP on the Docker host |

## Authentication

Tools 8-9 and 12-15 require an OIDC token to access the Relayer API and HostIO proxy. The MCP acquires one automatically using Authorization Code + PKCE (S256) flow against the `scprime` Keycloak realm with the `relayer-native` public client. The user completes a browser sign-in; the MCP captures the code on a local `127.0.0.1` loopback listener and exchanges it for a token.

**Prerequisite:** The `relayer-native` public client must be registered on the Keycloak `scprime` realm (PKCE S256, redirect `http://127.0.0.1:*`).

## Development

```bash
npm install
npm test
```

Requires Node.js 20+.

## Note on `relayer-native` client

This package uses the `relayer-native` Keycloak client ID for OIDC authentication. The same client ID is intended for reuse by a future standalone Relayer CLI (`@xns-cloud/relayer-cli`), with the OIDC module (`src/lib/oidcAuth.js`) extracted to a shared `@xns-cloud/relayer-auth` package.

## Privacy Policy

Canonical policy: **<https://xns.tech/privacy-policy/>**. Product-specific detail for this
server is in [PRIVACY.md](./PRIVACY.md).

The short version:

- **No telemetry.** No analytics, crash reporting, or usage counters. It does not phone home.
- **Tokens live in memory only.** OIDC access tokens are never written to disk; they are discarded when the process exits.
- **The agent never sees your password.** Sign-in happens in your own browser against `auth.xns.tech`.
- **Private network only.** No tool can be pointed at a public Relayer: the ones taking a host argument run it through an allowlist (`localhost`, loopback, RFC 1918, `*.local`), and the rest expose no URL parameter and are fixed to `localhost`. The three XNS services it contacts are `auth.xns.tech`, `console.xns.tech`, and `releases.scpri.me`.
- **Your stored objects never pass through it.** The Relayer you host handles your data directly.

## Desktop extension (MCPB)

The same server ships as an [MCP Bundle](https://github.com/anthropics/mcpb) for one-click install in Claude Desktop. Build it from a clean checkout:

```bash
npm run bundle
```

That reinstalls production-only dependencies, validates the manifest, and writes the `.mcpb`. The MCPB CLI version is pinned in the script — do not invoke it unversioned, or the bundle you ship is not the bundle that was validated. Run `npm ci` afterwards to get the dev dependencies back for testing.

To validate the manifest alone without repacking:

```bash
npm run bundle:validate
```

`manifest.json` at the repo root is the bundle manifest. `mcpbManifest.test.js` pins its `version` and tool list to `package.json`, `server.json`, and the running server, so drift fails the suite rather than shipping.

## License

Apache-2.0 © SCP Corp. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

