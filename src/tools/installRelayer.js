'use strict';

const { z } = require('zod');
const os = require('os');
const path = require('path');
const net = require('net');
const { createDockerUtil, redactEndpoint, classifyDockerFailure } = require('../lib/dockerUtil');

const BIND_ADDRESS_HELP = 'bind_address must be empty (all interfaces), an IPv4 address (e.g. "127.0.0.1"), or a bracketed IPv6 address (e.g. "[::1]") — the Compose ports host component is an IP address, not a hostname';

// A ports list item that uses ${BIND_ADDRESS...}; a comment naming it does not count.
const PORTS_USE_BIND_ADDRESS = /^[ \t]*-[^#\n]*\$\{BIND_ADDRESS\b/m;

/** What the response says about bind_address, per compose source. */
function bindAddressApplied(source, bindAddress) {
    if (source === 'channel' && bindAddress) {
        return 'yes — the channel compose references BIND_ADDRESS in its port declarations (checked before install)';
    }
    if (source === 'channel') {
        return 'not needed — no bind_address was set, so ports are published on all interfaces';
    }
    return 'unknown — the compose_url compose may or may not reference BIND_ADDRESS in its port declarations; this installer does not read that file';
}

// R5 input boundary: this value is written verbatim into the .env the installer
// authors, and Compose auto-loads that file. An unvalidated newline injects
// further KEY=VALUE lines — including a second UI_PORT, which wins last-value
// and silently republishes on a port this tool then misreports in its own
// success JSON. A charset-only guard stops that but still accepts values Docker
// cannot bind (`[`, `999.999.999.999`, `127.0.0.1:`, raw IPv6, hostnames), which
// produce an invalid port mapping at `compose up` instead of a clear error here.
// So each documented form is validated whole.
//
// Hostnames are NOT accepted: the Compose ports short syntax defines the host
// component as an IP address (docs.docker.com/reference/compose-file/services).
// "localhost:8888:8888" is not a resolvable-then-bound mapping — it is a
// malformed one. Rejecting here is a clear error instead of a compose failure.
function isValidBindAddress(value) {
    if (value === '') return true;                 // default: all interfaces
    if (net.isIPv4(value)) return true;
    // Raw (unbracketed) IPv6 is ambiguous against the host:container port
    // separator — Docker requires brackets.
    if (value.startsWith('[') && value.endsWith(']')) {
        return net.isIPv6(value.slice(1, -1));
    }
    return false;
}

// Canonical released install — the full release channel bundle (relayer +
// monitoring stack), published on the XNS releases registry and served
// login-free. THE default install source. Its .env (COMPOSE_PROFILES and the
// rest of the release settings) sits beside it and is fetched on every run.
const CHANNEL_COMPOSE_URL = 'https://releases.xns.tech/relayer/release/docker-compose.yml';
const CHANNEL_ENV_FILE = '.env';

// Where a release .env that stops short is reported.
const BUGS_URL = require('../../package.json').bugs.url;

// container_name in the release compose. Docker container names are unique
// per daemon, so ANY existing container with this name — running or stopped,
// any channel — makes `docker compose up` fail with a name conflict.
const CONTAINER_NAME = 'xns-relayer';

// Owner read/write only for the .env this tool writes.
const ENV_FILE_MODE = 0o600;

// The machine running this MCP and the machine running the Docker daemon can
// differ (DOCKER_HOST=ssh://..., tcp://..., or an ssh Docker context). This tool
// writes docker-compose.yml and .env on THIS machine, while compose up runs on
// the Docker host, so with a remote daemon it refuses before writing anything.
const LOCAL_DOCKER_HOST = Object.freeze({ remote: false, host: 'localhost', endpoint: null });

/**
 * Resolve which machine the Docker daemon runs on, defensively.
 *
 * The result gates the install: a remote daemon makes install_relayer refuse.
 * A detection failure (missing helper, throwing helper) or incomplete metadata
 * ("remote" without a nameable host) still falls back to local and installs,
 * because refusing on a machine we cannot name would block installs on a guess
 * and give the user nothing to act on.
 */
async function resolveDockerHost(docker) {
    if (!docker || typeof docker.getDockerHost !== 'function') return LOCAL_DOCKER_HOST;
    try {
        const raw = await docker.getDockerHost();
        const host = typeof raw?.host === 'string' ? raw.host.trim() : '';
        const endpoint = raw?.endpoint ?? null;
        // Report the endpoint even when local — check_prerequisites does, and a
        // response saying "local" with no endpoint reads like detection failed.
        if (!raw?.remote || host === '' || host === 'localhost') return { ...LOCAL_DOCKER_HOST, endpoint };
        return { remote: true, host, endpoint };
    } catch {
        return LOCAL_DOCKER_HOST;
    }
}

// Caught error text never goes back to the MCP client (.coderabbit.yaml path
// rule): execFile and OS messages can carry paths and system detail. A failure
// this file raises is marked userSafe (same convention as verifyStorage.js) and
// its cause is logged to stderr.
function safeError(message, cause) {
    return Object.assign(new Error(message, { cause }), { userSafe: true });
}

// The four reasons a default install stops before it touches the install
// folder. Each names the cause and what to do; curl and OS text go to the
// server log only.
function downloadFailedMessage(host, file) {
    return `The Relayer release files could not be downloaded from ${host} (the ${file} download failed), so nothing was installed. Check that this machine reaches https://${host}, then run install_relayer again.`;
}

function incompleteEnvMessage(host) {
    return `The release .env downloaded from ${host} has no COMPOSE_PROFILES line, so the download was cut short or the published release is incomplete, and nothing was installed. Run install_relayer again; if it stops here again, report it at ${BUGS_URL}.`;
}

function bindUnsupportedMessage(bindAddress) {
    return `bind_address ${bindAddress} was requested, but the release compose file does not use BIND_ADDRESS in its port list, so the ports would be published on all interfaces. Nothing was installed. Run install_relayer again without bind_address, or pass compose_url pointing at a compose file whose ports use \${BIND_ADDRESS}.`;
}

function tempFolderMessage(tmpDir) {
    return `The release files could not be prepared on this machine: the temporary folder under ${tmpDir} could not be created or read. Nothing was installed. Check that the folder is writable and the disk is not full, then run install_relayer again.`;
}

const DOCKER_GROUP_SENTENCE = 'The Docker socket refused this user, so nothing was written and nothing was started. Add the user to the docker group (sudo usermod -aG docker $USER), then log out and back in (or reboot) and run install_relayer again.';

// Fixed sentences per classified Docker failure (dockerUtil FAILURE_PATTERNS).
// They never quote Docker's text: that goes to the server log only.
// port_in_use is not here: its sentence depends on the port (portSentence).
const FAILURE_SENTENCES = {
    permission_denied: DOCKER_GROUP_SENTENCE,
    daemon_stopped: 'Docker is not running on this machine. Start it with sudo systemctl start docker, then run install_relayer again.',
    out_of_disk: 'Docker ran out of disk space while pulling the Relayer images. Free disk space on the filesystem holding the Docker root (docker info --format {{.DockerRootDir}} shows where it is), then run install_relayer again.',
    pull_refused: 'The Relayer images could not be pulled from releases.xns.tech. Check that this machine reaches https://releases.xns.tech and that no stale registry login is stored (docker logout releases.xns.tech), then run install_relayer again.',
};

// The release compose also publishes the S3 HTTPS port. No install_relayer
// parameter moves it.
const S3_TLS_PORT = 9443;

// Port in use: name the port, the parameter that moves it, and the leftover
// Created container compose leaves behind, which a retry would collide with.
function portSentence({ port }, { ui_port, s3_port }) {
    const retry = `remove the leftover container with docker rm -f ${CONTAINER_NAME} and run install_relayer again`;
    // DECISION: no new parameter for the 9443 port. Appending S3_TLS_PORT to the
    // .env would fix one install only (the channel .env is re-fetched each run)
    // and the schema has no other per-port knob for a port the Relayer does not
    // serve plain traffic on. The sentence says to free it.
    if (port === S3_TLS_PORT) return `Port ${port} (the S3 HTTPS port) is already in use on this machine. Free it, ui_port and s3_port do not move it, then ${retry}.`;
    if (port === ui_port) return `Port ${port} is already in use on this machine. Free it or pass a different ui_port, then ${retry}.`;
    if (port === s3_port) return `Port ${port} is already in use on this machine. Free it or pass a different s3_port, then ${retry}.`;
    return `A port this install publishes is already in use on this machine. Free it or pass a different ui_port / s3_port, then ${retry}.`;
}

// The client-facing reason for a caught failure: this file's own message when
// marked userSafe, a fixed cause sentence when Docker's stderr names one, else
// the generic line.
function failureReason(err, ports) {
    if (err.userSafe) return err.message;
    const cause = classifyDockerFailure(err);
    if (cause?.key === 'port_in_use') return portSentence(cause, ports);
    if (cause) return FAILURE_SENTENCES[cause.key];
    return 'See server log for detail.';
}

function errorResponse(error) {
    return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error }) }],
        isError: true,
    };
}

/**
 * True when `docker info` is refused by the socket's permissions. Any other
 * outcome (success, daemon down, a mock without docker()) returns false and
 * the install carries on as before; the later step reports its own cause.
 */
async function socketDenied(docker) {
    if (!docker || typeof docker.docker !== 'function') return false;
    try {
        await docker.docker(['info', '--format', '{{.ServerVersion}}']);
        return false;
    } catch (err) {
        console.error(`[install_relayer] docker info preflight: ${err.message}`);
        return classifyDockerFailure(err)?.key === 'permission_denied';
    }
}

// Append the three port lines to a fetched .env, keeping every fetched line.
function withPortLines(fetchedEnv, portLines) {
    if (fetchedEnv === '' || fetchedEnv.endsWith('\n')) return `${fetchedEnv}${portLines}`;
    return `${fetchedEnv}\n${portLines}`;
}

/**
 * Tool 4: install_relayer
 * AC-12: confirms "containers starting"; no manual shell.
 * TP-30: uses execFile, no shell (security non-negotiable).
 *
 * A first-time user has never heard of a Relayer and cannot supply a compose
 * file or a .env. So by default this tool authors both for them: it fetches
 * the CANONICAL release channel bundle (relayer, the Prometheus + Grafana +
 * node-exporter monitoring stack that powers the dashboards under Monitoring in
 * the web UI, Alertmanager, and the Loki + Alloy + audit-logrotate audit-log
 * pipeline) and its .env, then appends the two ports and the bind address to
 * that .env. Both files are downloaded into a temporary folder and checked
 * there first. If either cannot be downloaded or used, the tool stops with the
 * cause and the fix, and the install folder is left exactly as it was.
 *
 * `compose_url` stays as an optional override for internal/custom installs;
 * when given, the old download-a-URL behavior is preserved.
 */
module.exports = function registerInstallRelayer(server, options = {}) {
    const docker = options.dockerUtil || createDockerUtil(options);
    const _execFile = options.execFile;
    const fsp = options.fs || require('fs').promises;
    const channelComposeUrl = options.channelComposeUrl || CHANNEL_COMPOSE_URL;
    // The .env lives beside the compose it configures.
    const channelEnvUrl = new URL(CHANNEL_ENV_FILE, channelComposeUrl).href;

    server.registerTool(
        'install_relayer',
        {
            title: 'Install the Relayer',
            description: 'Install and start the XNS Relayer. By default fetches the canonical release channel bundle — relayer + the Prometheus/Grafana monitoring stack — and its .env from releases.xns.tech (anonymous pull), appends the ports to that .env, then runs docker compose up -d — the user does NOT need to author any file. If the release files cannot be downloaded or used, it stops, says why and what to do, and installs nothing. A failure names its cause (port in use, image pull refused, Docker stopped, out of disk, Docker socket permission) and the command that fixes it. Pass compose_url only to override with a custom compose.\n\nIMPORTANT — two machines: this tool writes docker-compose.yml and .env on the machine running the MCP, then starts the containers on whichever machine the Docker daemon is on. When DOCKER_HOST or an ssh:// Docker context points at a daemon on another machine, the tool refuses: it writes nothing and starts nothing, and returns an error naming the Docker host. Run the MCP on the Docker host (Node.js 20 there) and install from there.\n\nExposure decisions on this surface:\n\n1. BINDING — bind_address controls which host network interface Docker publishes ports on. Default: empty (all interfaces — the dashboard answers from any machine on the LAN with zero configuration). Set to "127.0.0.1" for loopback-only, or a specific interface IP. The value is passed to docker compose via env as BIND_ADDRESS; it takes effect only if the compose file used for the install references BIND_ADDRESS in its port declarations. When bind_address is set and the release compose does not use BIND_ADDRESS in its port list, the tool stops before installing anything and says so. A compose_url override is fetched remotely and may not honor it. The prerequisite check (check_prerequisites) probes port availability by binding 0.0.0.0 regardless of this setting.\n\n2. UI TLS — ui_tls_enabled describes whether the admin UI listens on HTTPS in addition to HTTP. Default: false (off). This switch is described here for decision visibility; it is NOT wired to behavior in this version — setting it to true is accepted but has no effect until a future release ships the listener. Cost when enabled: requires a TLS certificate and key provisioned on the host.\n\n3. S3 TLS — s3_tls_enabled describes whether the S3 gateway listens on HTTPS in addition to HTTP. Default: false (off). This switch is described here for decision visibility; it is NOT wired to behavior in this version — setting it to true is accepted but has no effect until a future release ships the listener. Cost when enabled: requires a TLS certificate and key provisioned on the host; S3 clients must be configured to use the HTTPS endpoint.',
            inputSchema: {
                install_path: z.string().optional().default('/opt/xns-relayer').describe('Directory to install the compose file into'),
                ui_port: z.number().int().min(1).max(65535).optional().default(8888).describe('Host port for the Relayer admin/customer UI (container 8888). Docker publishes this port on the interface chosen by bind_address.'),
                s3_port: z.number().int().min(1).max(65535).optional().default(9000).describe('Host port for the S3 API (container 9000). Docker publishes this port on the interface chosen by bind_address.'),
                compose_url: z.string().url().optional().describe('OPTIONAL override: URL to a custom docker-compose.yml. Omit for the normal released install. When provided, bind_address is passed to docker compose via env but the downloaded compose must use the BIND_ADDRESS variable in its port declarations for it to take effect.'),
                // R5 input boundary — see isValidBindAddress above for why each
                // documented address form is validated whole rather than by charset.
                bind_address: z.string().max(255).refine(isValidBindAddress, BIND_ADDRESS_HELP).optional().default('').describe('Host network interface for Docker port publication. Default: empty string (all interfaces — reachable from any machine on the LAN). Set to "127.0.0.1" for loopback-only access, or a specific interface IP to restrict reachability. Accepted forms: empty, an IPv4 address, or a bracketed IPv6 address (e.g. "[::1]"). Hostnames are rejected — the Compose ports host component is an IP address. This value is passed to docker compose via env, and on the default path it is also written into the .env this installer authors (the compose_url override path writes no .env). On the default path the installer checks the fetched channel compose for BIND_ADDRESS and stops, installing nothing, when it is absent. On the compose_url path the fetched compose must reference the BIND_ADDRESS variable in its port declarations for the setting to take effect — this installer cannot verify that.'),
                ui_tls_enabled: z.boolean().optional().default(false).describe('Whether the admin UI should listen on HTTPS in addition to HTTP. Default: false (off — HTTP only). NOT WIRED in this version: accepted but has no effect until a future release ships the TLS listener. Cost when enabled: requires a TLS certificate and key provisioned on the host.'),
                s3_tls_enabled: z.boolean().optional().default(false).describe('Whether the S3 gateway should listen on HTTPS in addition to HTTP. Default: false (off — HTTP only). NOT WIRED in this version: accepted but has no effect until a future release ships the TLS listener. Cost when enabled: requires a TLS certificate and key provisioned on the host; S3 clients must be configured to use the HTTPS endpoint.'),
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                openWorldHint: true,
            },
        },
        async ({ install_path, ui_port, s3_port, compose_url, bind_address, ui_tls_enabled, s3_tls_enabled }) => {
            try {
                const { execFile: nodeExecFile } = require('child_process');
                const execFileFn = _execFile || nodeExecFile;
                const composePath = path.join(install_path, 'docker-compose.yml');
                const envPath = path.join(install_path, '.env');

                // Gate first: before any lookup, mkdir, download or write. The
                // files would land on this machine, not on the Docker host.
                const dockerHost = await resolveDockerHost(docker);
                if (dockerHost.remote) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: `The Docker daemon is on ${dockerHost.host}, not this machine. install_relayer would write docker-compose.yml and .env on this machine instead of on ${dockerHost.host}, so nothing was written and nothing was started.`,
                                docker_host: dockerHost.host,
                                docker_endpoint: redactEndpoint(dockerHost.endpoint),
                                remediation: `Run the MCP on ${dockerHost.host} (install Node.js 20 there and point your MCP client at it), then run install_relayer again. Or, to install on this machine, unset DOCKER_HOST or switch to the default Docker context.`,
                            }, null, 2),
                        }],
                        isError: true,
                    };
                }

                // A socket that refuses this user would make the existing-install
                // lookup below read "no container" and the install fail later at
                // compose up. Name the cause now, before anything is written.
                if (await socketDenied(docker)) {
                    return errorResponse(`Relayer installation failed: ${DOCKER_GROUP_SENTENCE}`);
                }

                // Preflight: install_relayer is for FRESH installs only — it does
                // not upgrade an existing deployment in place. An existing
                // container (running or stopped, any channel) owns the name and
                // would make compose up fail with a confusing name conflict.
                const existing = await docker.findContainer(CONTAINER_NAME);
                if (existing) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: `An existing '${CONTAINER_NAME}' container was found (status: ${existing.status}; image: ${existing.image}). install_relayer performs fresh installs only — it does not upgrade an existing deployment in place.`,
                                existing_container: existing,
                                remediation: `To replace it with this install: 1) stop and remove the existing container — docker stop ${CONTAINER_NAME} && docker rm ${CONTAINER_NAME} (this does NOT delete its data directory); 2) run install_relayer again. To keep the existing deployment instead, skip install_relayer and continue with check_relayer_health against it.`,
                            }, null, 2),
                        }],
                        isError: true,
                    };
                }

                const mkdirInstallPath = () => new Promise((resolve, reject) => {
                    execFileFn('mkdir', ['-p', install_path], {}, (err) => {
                        if (err) return reject(safeError(`Failed to create directory ${install_path} — check that the path is writable on this machine and no file sits at or along it`, err));
                        resolve();
                    });
                });

                // curl -fsSL -o <outPath> <url> (execFile, no shell). Rejects
                // with curl's own error; each caller chooses the message.
                const curlTo = (url, outPath) => new Promise((resolve, reject) => {
                    execFileFn('curl', ['-fsSL', '-o', outPath, url], { timeout: 60000 }, (err) => {
                        if (err) return reject(err);
                        resolve();
                    });
                });

                // Download the release compose and .env into an owner-only
                // temporary folder, read them and run the two checks. The folder
                // is removed whatever happens; a failed removal is logged and
                // never replaces the result.
                const stageReleaseFiles = async (bindAddress) => {
                    const host = new URL(channelComposeUrl).host;
                    const tmpDir = os.tmpdir();
                    const readStaged = (file) => fsp.readFile(file, 'utf8').catch((err) => {
                        throw safeError(tempFolderMessage(tmpDir), err);
                    });
                    let stage;
                    try {
                        stage = await fsp.mkdtemp(path.join(tmpDir, 'xns-relayer-install-'));
                    } catch (err) {
                        throw safeError(tempFolderMessage(tmpDir), err);
                    }
                    try {
                        const stagedCompose = path.join(stage, 'docker-compose.yml');
                        await curlTo(channelComposeUrl, stagedCompose).catch((err) => {
                            throw safeError(downloadFailedMessage(host, 'docker-compose.yml'), err);
                        });
                        const composeText = await readStaged(stagedCompose);
                        // A bind_address the release compose ignores would publish
                        // the ports on every interface.
                        if (bindAddress && !PORTS_USE_BIND_ADDRESS.test(composeText)) {
                            throw safeError(bindUnsupportedMessage(bindAddress));
                        }
                        const stagedEnv = path.join(stage, CHANNEL_ENV_FILE);
                        await curlTo(channelEnvUrl, stagedEnv).catch((err) => {
                            throw safeError(downloadFailedMessage(host, CHANNEL_ENV_FILE), err);
                        });
                        const fetchedEnv = await readStaged(stagedEnv);
                        // The publisher always ships this line, so its absence means a
                        // truncated or empty download. Without it no audit sidecar starts.
                        if (!/^COMPOSE_PROFILES=/m.test(fetchedEnv)) {
                            throw safeError(incompleteEnvMessage(host));
                        }
                        return { composeText, fetchedEnv };
                    } finally {
                        try {
                            await fsp.rm(stage, { recursive: true, force: true });
                        } catch (rmErr) {
                            console.error(`[install_relayer] could not remove ${stage}: ${rmErr.message}`);
                        }
                    }
                };

                const bindPrefix = bind_address ? `${bind_address}:` : '';
                let source;
                if (compose_url) {
                    // Override path: make the folder, then download a custom
                    // compose straight into it.
                    await mkdirInstallPath();
                    await curlTo(compose_url, composePath).catch((err) => {
                        throw safeError('Failed to download compose file', err);
                    });
                    source = 'compose_url';
                } else {
                    // Default path: download the release compose and its .env
                    // into a temporary folder and check them there. Only when
                    // every check passes is the install folder made and written,
                    // so a stop leaves it exactly as it was.
                    const portLines = `UI_PORT=${ui_port}\nS3_PORT=${s3_port}\nBIND_ADDRESS=${bindPrefix}\n`;
                    const { composeText, fetchedEnv } = await stageReleaseFiles(bind_address);
                    await mkdirInstallPath();
                    await fsp.writeFile(composePath, composeText);
                    // The .env holds webhook/SMTP secrets: owner-only. The mode on
                    // writeFile covers a new file; chmod covers one that existed.
                    await fsp.writeFile(envPath, withPortLines(fetchedEnv, portLines), { mode: ENV_FILE_MODE });
                    await fsp.chmod(envPath, ENV_FILE_MODE);
                    source = 'channel';
                }

                // Run docker compose up -d. cwd + env so ${UI_PORT}/${S3_PORT}
                // interpolation and the ./data bind resolve in the install dir,
                // regardless of where the MCP process was launched.
                // The .env written above owns COMPOSE_PROFILES, aliased to RELAYER_AUDIT_MODE.
                // Compose lets the process environment beat .env, so an inherited value
                // would leave the audit sink on with no sidecars to tail and rotate it.
                // compose_url writes no .env, so there the caller's value stands.
                const { COMPOSE_PROFILES: _inheritedProfiles, ...withoutProfiles } = process.env;
                await docker.composeUp(composePath, {
                    cwd: install_path,
                    env: { ...(compose_url ? process.env : withoutProfiles), UI_PORT: String(ui_port), S3_PORT: String(s3_port), BIND_ADDRESS: bindPrefix },
                });

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: true,
                            message: 'XNS Relayer containers are starting. Use check_relayer_health to monitor when all services are ready.',
                            compose_path: composePath,
                            install_path,
                            source,
                            // D5/W5: state the binding at install time, out-of-band, so a
                            // refused connection is explainable later. Two statements, never
                            // merged (PRD §7): `composed_from` is what this installer asserts
                            // it composed; `reachability` is only CONFIGURED — this process
                            // cannot verify the host actually published it, so it says so and
                            // points at `docker port` (the host-side source of truth) instead
                            // of guessing.
                            // The container ports are known only for the channel compose
                            // this installer fetches. A caller-supplied compose_url may
                            // remap them, and this process never reads that file — so it
                            // says null rather than restating 8888/9000 it cannot stand
                            // behind (correct-or-absent, same rule as the port readout).
                            binding: {
                                bind_address: bind_address || '0.0.0.0 (all interfaces)',
                                bind_address_applied: bindAddressApplied(source, bind_address),
                                ui: { host_port: ui_port, container_port: compose_url ? null : 8888 },
                                s3: { host_port: s3_port, container_port: compose_url ? null : 9000 },
                                composed_from: compose_url
                                    ? `UI_PORT=${ui_port}, S3_PORT=${s3_port}, BIND_ADDRESS=${bindPrefix} passed to docker compose (no .env written on the compose_url override path)`
                                    : `UI_PORT=${ui_port}, S3_PORT=${s3_port}, BIND_ADDRESS=${bindPrefix} written to ${envPath}`,
                                reachability: 'configured — not verified from this process; run `docker port xns-relayer` on the host to see actual Docker publication',
                            },
                            tls: {
                                ui_tls_enabled: { requested: ui_tls_enabled, effective: false, note: ui_tls_enabled ? 'Accepted but not wired in this version — no effect until a future release ships the TLS listener.' : 'Off (HTTP only).' },
                                s3_tls_enabled: { requested: s3_tls_enabled, effective: false, note: s3_tls_enabled ? 'Accepted but not wired in this version — no effect until a future release ships the TLS listener.' : 'Off (HTTP only).' },
                            },
                        }, null, 2),
                    }],
                };
            } catch (err) {
                console.error(`[install_relayer] ${err.message}${err.cause ? `: ${err.cause.message}` : ''}`);
                return errorResponse(`Relayer installation failed: ${failureReason(err, { ui_port, s3_port })}`);
            }
        },
    );
};
