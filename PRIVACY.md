# Privacy Policy — XNS Relayer MCP server

**Effective 2026-08-19.** Applies to the `@xns-cloud/relayer-mcp` MCP server and the
XNS Relayer desktop extension built from it. Published at <https://xns.tech/privacy>.

## What this software is

The XNS Relayer MCP server runs entirely on your own machine. It is a local process that
an AI agent starts over stdio. It has no server of ours in the middle: there is no XNS
service that observes your conversation, your prompts, or the agent's tool calls.

## What we collect

**Nothing is collected by the MCP server itself.** It has no analytics, no telemetry, no
crash reporting, and no usage counters. It does not phone home.

Data reaches XNS only through the ordinary, visible operation of the tools you ask the
agent to run:

| Tool activity | What travels to XNS | Which service |
|---|---|---|
| Creating an account, signing in | Your email address and password, entered by you in your own browser | `auth.xns.tech` (Keycloak) |
| Claiming a Relayer to your account | The claim session and the installation's identity | `console.xns.tech` |
| Reading or changing Relayer settings, host selection, backups | The setting values you ask to read or change | `console.xns.tech` |
| Installing or updating the Relayer | An anonymous download request for the Docker Compose bundle and container images | `releases.scpri.me` |

The agent never handles your password. Sign-in happens in your browser against our
identity service, and the extension receives only a short-lived access token.

## What stays on your machine

- **Access tokens are held in memory only** and are discarded when the process exits.
  They are never written to disk.
- **S3 credentials** provisioned by `setup_cli_credentials` are written to
  `~/.xns/credentials` with file mode `0600`, on your machine, for your CLI to use.
- **Your stored objects never pass through this software's control path.** The Relayer
  you host handles your data directly.

## Network boundary

The extension refuses to connect to public addresses. It will talk only to `localhost`,
loopback, RFC 1918 private ranges (`10/8`, `172.16/12`, `192.168/16`), and `*.local`.
A Relayer on the public internet cannot be driven by this extension. The only public
hosts it contacts are the three XNS services named in the table above.

## How XNS uses and stores what it receives

Account data (email address, account identity, and the Relayers claimed to your account)
is used to operate your account, bill it, and support it. Relayer settings are stored so
your installation can be configured and recovered. We do not sell your data, and we do
not use it to train models.

## Third parties

We do not share your data with third parties for their own purposes. Our infrastructure
providers process data solely on our instructions in order to run the service.

## Retention

Account and Relayer configuration data is retained while your account is open, and is
deleted within 90 days of account closure except where we are required to keep records
for legal, tax, or accounting purposes. Local files on your machine — `~/.xns/credentials`
and the Relayer's own data — are yours; delete them whenever you like.

## Your choices

You can stop the extension at any time; nothing runs in the background. Uninstalling it
removes it entirely. To close your XNS account or request deletion of the data associated
with it, contact us at the address below.

## Contact

SCP Corp — <support@xns.tech> · <https://xns.tech>

## Changes

Material changes to this policy will be published at <https://xns.tech/privacy> with a new
effective date.
