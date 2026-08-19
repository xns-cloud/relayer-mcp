# Privacy — XNS Relayer MCP server

**The canonical XNS privacy policy is <https://xns.tech/privacy-policy/>.** It governs your
XNS account and the services this software talks to, and it takes precedence over anything
here.

This file is a product-specific supplement. It records what the MCP server itself does on
your machine — facts about this codebase, not account-level terms. Every claim below is
verifiable in the source.

## What this software is

The XNS Relayer MCP server runs entirely on your own machine. It is a local process that an
AI agent starts over stdio. No XNS service sits in the middle: nothing of ours observes your
conversation, your prompts, or the agent's tool calls.

## The server collects nothing

There is no analytics, no telemetry, no crash reporting, and no usage counter in this
package. It does not phone home.

## What leaves your machine, and where it goes

Only through the ordinary, visible operation of the tools you ask the agent to run:

| Tool activity | What travels | Which service |
|---|---|---|
| Creating an account, signing in | Your credentials, entered by you in your own browser | `auth.xns.tech` (Keycloak) |
| Claiming a Relayer to your account | The claim session and the installation's identity | `console.xns.tech` |
| Reading or changing settings, host selection, backups | The setting values you ask to read or change | `console.xns.tech` |
| Installing or updating the Relayer | An anonymous download of the Docker Compose bundle and images | `releases.scpri.me` |

The agent never handles your password. Sign-in happens in your browser against our identity
service; the extension receives only a short-lived access token.

How XNS handles what those services receive is covered by the canonical policy above.

## What stays on your machine

- **Access tokens are held in memory only** (`src/lib/tokenState.js`) and are discarded when
  the process exits. They are never written to disk.
- **S3 credentials** provisioned by `setup_cli_credentials` are written to
  `~/.xns/credentials`, mode `0600`, on your machine, for your CLI to use.
- **Your stored objects never pass through this software's control path.** The Relayer you
  host handles your data directly.

Both are yours to delete at any time.

## Network boundary

The extension refuses to connect to public addresses. It will talk only to `localhost`,
loopback, RFC 1918 private ranges (`10/8`, `172.16/12`, `192.168/16`), and `*.local`
(`src/lib/hostAllowlist.js`). A Relayer on the public internet cannot be driven by this
extension. The only public hosts it contacts are the three XNS services named above.

## Stopping it

Nothing runs in the background. Quitting the agent stops the server; uninstalling the
extension removes it entirely.

## Contact

<https://xns.tech> — see the canonical policy for the current contact address.
