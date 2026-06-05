# @xns-cloud/relayer-mcp

MCP server for XNS Relayer onboarding. Provides 11 tools that let an AI agent drive the complete Relayer setup conversationally over stdio transport.

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

## Claude Desktop / Claude Code Configuration

Add to your `claude_desktop_config.json` (or `claude mcp add relayer -- npx @xns-cloud/relayer-mcp@latest` for Claude Code):

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

No separate install step required.

## Tools

| # | Tool | Purpose |
|---|------|---------|
| 1 | `check_prerequisites` | Verify Docker (local or remote), ports (8888, 9000), an existing installation, disk, and network connectivity. |
| 2 | `register_account` | Register an XNS account (email + password) via Console2. |
| 3 | `check_email_verified` | Poll email verification status (15s interval, 30-min timeout). |
| 4 | `install_relayer` | Fetch the canonical beta channel bundle — relayer + Prometheus/Grafana monitoring stack (`https://releases.scpri.me/relayer/beta/docker-compose.yml`, anonymous pull, no `docker login`) — write the `.env`, and start the containers. Falls back to a bundled service-parity copy if the fetch fails. **Fresh installs only** — see [Fresh installs vs. existing deployments](#fresh-installs-vs-existing-deployments). The user authors nothing; `compose_url` is an optional override for custom installs. |
| 5 | `check_relayer_health` | Poll UI, S3, HostIO, and the monitoring sidecars (10s interval, 300s timeout). A missing monitoring stack reports as degraded without blocking the flow. Targets the Docker host automatically. |
| 6 | `start_claim` | Initiate a claim session — returns a URL for browser confirmation. |
| 7 | `check_claim_status` | Poll claim state (STATE_1 / STATE_2 / STATE_3). |
| 8 | `get_host_tags` | Retrieve available host tags for VPD configuration. |
| 9 | `configure_vpd` | Set data/parity host selection via CEL expressions. |
| 10 | `verify_storage` | Round-trip S3 test (create bucket, put object, get object) against the S3 gateway on port 9000. |
| 11 | `setup_cli_credentials` | Provision S3 IAM credentials and write `~/.xns/credentials` so the XNS CLI works without further configuration. |

## Onboarding Flow

1. Agent checks prerequisites (Tool 1).
2. Agent registers account or skips if existing (Tool 2).
3. User clicks email verification link; agent polls (Tool 3).
4. Agent installs and starts Relayer containers (Tool 4) — it writes the
   released compose + `.env` itself; the user is never asked for a compose URL.
5. Agent polls health until UI + S3 are up (Tool 5).
6. Agent initiates claim; user opens claim URL in browser (Tools 6 + 7).
7. Agent signs in via OIDC to configure host preferences (Tools 8 + 9).
8. Agent verifies S3 storage is working (Tool 10).
9. Optionally, agent provisions CLI credentials (Tool 11).

The operator's only required actions are: clicking one email link, completing one browser sign-in, and confirming one claim.

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

`check_relayer_health` accepts a `host` override, and `verify_storage` an `endpoint` override, for setups the auto-detection can't see (port forwards, NAT).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| MCP exits with "requires Node.js 20 or newer" | Distro Node is too old (Ubuntu apt ships Node 18) | [Installing Node.js 20](#installing-nodejs-20) |
| `install_relayer` reports an existing `xns-relayer` container | A previous deployment (any channel) owns the container name | [Fresh installs vs. existing deployments](#fresh-installs-vs-existing-deployments) |
| Port 8888/9000 already in use | Another service on the Docker host (another S3-compatible service squatting 9000) | Stop it, or install with custom ports: `install_relayer` `ui_port` / `s3_port` (health checks accept the same) |
| Health checks fail but containers run on a remote Docker host | Ports 8888/9000 not reachable from the management node | Open them, or pass `host` / `endpoint` overrides |

## Authentication

Tools 8 and 9 require an OIDC token to access the HostIO proxy. The MCP acquires one automatically using Authorization Code + PKCE (S256) flow against the `scprime` Keycloak realm with the `relayer-native` public client. The user completes a browser sign-in; the MCP captures the code on a local `127.0.0.1` loopback listener and exchanges it for a token.

**Prerequisite:** The `relayer-native` public client must be registered on the Keycloak `scprime` realm (PKCE S256, redirect `http://127.0.0.1:*`).

## Development

```bash
npm install
npm test
```

Requires Node.js 20+.

## Note on `relayer-native` client

This package uses the `relayer-native` Keycloak client ID for OIDC authentication. The same client ID is intended for reuse by a future standalone Relayer CLI (`@xns-cloud/relayer-cli`), with the OIDC module (`src/lib/oidcAuth.js`) extracted to a shared `@xns-cloud/relayer-auth` package.

## License

Apache-2.0 © SCP Corp. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
