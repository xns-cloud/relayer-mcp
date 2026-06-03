# @xns/relayer-mcp

MCP server for XNS Relayer onboarding. Provides 10 tools that let an AI agent drive the complete Relayer setup conversationally over stdio transport.

## Claude Desktop Configuration

Add to your Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "relayer": {
      "command": "npx",
      "args": ["@xns/relayer-mcp@latest"]
    }
  }
}
```

No separate install step required.

## Tools

| # | Tool | Purpose |
|---|------|---------|
| 1 | `check_prerequisites` | Verify Docker, ports (8888, 9000), disk, and network connectivity. |
| 2 | `register_account` | Register an XNS account (email + password) via Console2. |
| 3 | `check_email_verified` | Poll email verification status (15s interval, 30-min timeout). |
| 4 | `install_relayer` | Write the bundled `docker-compose.yml` + `.env` (Docker Hub `scprime/xns-relayer`, pre-release `:beta` channel) and start the containers. The user authors nothing; `compose_url` is an optional override. |
| 5 | `check_relayer_health` | Poll UI, S3, and HostIO health (10s interval, 300s timeout). |
| 6 | `start_claim` | Initiate a claim session — returns a URL for browser confirmation. |
| 7 | `check_claim_status` | Poll claim state (STATE_1 / STATE_2 / STATE_3). |
| 8 | `get_host_tags` | Retrieve available host tags for VPD configuration. |
| 9 | `configure_vpd` | Set data/parity host selection via CEL expressions. |
| 10 | `verify_storage` | Round-trip S3 test (create bucket, put object, get object) at localhost:9000. |

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

The operator's only required actions are: clicking one email link, completing one browser sign-in, and confirming one claim.

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

This package uses the `relayer-native` Keycloak client ID for OIDC authentication. The same client ID is intended for reuse by a future standalone Relayer CLI (`@xns/relayer-cli`), with the OIDC module (`src/lib/oidcAuth.js`) extracted to a shared `@xns/relayer-auth` package.

## License

Apache-2.0 © SCP Corp. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
