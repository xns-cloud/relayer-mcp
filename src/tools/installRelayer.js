'use strict';

const { z } = require('zod');
const path = require('path');
const net = require('net');
const { createDockerUtil } = require('../lib/dockerUtil');

const BIND_ADDRESS_HELP = 'bind_address must be empty (all interfaces), an IPv4 address (e.g. "127.0.0.1"), or a bracketed IPv6 address (e.g. "[::1]") — the Compose ports host component is an IP address, not a hostname';

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

// Canonical released install — the full beta channel bundle (relayer +
// monitoring stack). Versioned in the deploy repo, shipped to web01 by
// `deploy.py promote`, served login-free. THE default install source.
const CHANNEL_COMPOSE_URL = 'https://releases.scpri.me/relayer/beta/docker-compose.yml';

// Bundled OFFLINE FALLBACK template (ships in the npm package; package.json
// `files: ["src/"]` covers it). Written only when the channel fetch fails;
// kept service-parity with the channel bundle by the jest contract tests.
const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'docker-compose.yml');

// container_name in the bundled compose. Docker container names are unique
// per daemon, so ANY existing container with this name — running or stopped,
// alpha channel or beta — makes `docker compose up` fail with a name conflict.
const CONTAINER_NAME = 'xns-relayer';

// The machine running this MCP and the machine running the Docker daemon are
// routinely NOT the same one. Claude Desktop and Cursor run on a workstation;
// the disks live on a server. Our own README steers ephemeral-sandbox users to
// an ssh:// Docker context, and check_prerequisites' remediation text says the
// same. In that configuration every file this tool writes (mkdir, curl, the
// .env) lands HERE while composeUp starts the containers THERE.
//
// The install still works: the compose uses named volumes, so the data lives on
// the Docker host and nothing is lost. What breaks is day 2 — restart, port
// change, upgrade all need a compose file that is not on the machine running
// the containers, and if this machine is a sandbox it takes the only copy with
// it. Reporting a single install_path hides that, so the response names both
// machines instead.
const LOCAL_DOCKER_HOST = Object.freeze({ remote: false, host: 'localhost', endpoint: null });

/**
 * Resolve which machine the Docker daemon runs on, defensively.
 *
 * Advisory only — this must NEVER be the reason an install fails, so a missing
 * helper, a throwing helper, or incomplete metadata all fall back to local.
 * "remote" without a nameable host is incomplete metadata, not a remote
 * install; checkPrerequisites applies the same rule and we must not warn about
 * a machine we cannot name.
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

/**
 * Tool 4: install_relayer
 * AC-12: confirms "containers starting"; no manual shell.
 * TP-30: uses execFile, no shell (security non-negotiable).
 *
 * A first-time user has never heard of a Relayer and cannot supply a compose
 * file or a .env. So by default this tool authors both for them: it fetches
 * the CANONICAL channel bundle (relayer + Prometheus + Grafana + node-exporter
 * — the monitoring stack powers the dashboards under Monitoring in the web UI)
 * and writes a .env carrying the two ports. If the fetch fails (offline,
 * registry hiccup), the bundled service-parity template is the fallback — the
 * install still completes and the response says it fell back.
 *
 * `compose_url` stays as an optional override for internal/custom installs;
 * when given, the old download-a-URL behaviour is preserved.
 */
module.exports = function registerInstallRelayer(server, options = {}) {
    const docker = options.dockerUtil || createDockerUtil(options);
    const _execFile = options.execFile;
    const fsp = options.fs || require('fs').promises;
    const channelComposeUrl = options.channelComposeUrl || CHANNEL_COMPOSE_URL;

    server.registerTool(
        'install_relayer',
        {
            title: 'install_relayer',
            description: 'Install and start the XNS Relayer. By default fetches the canonical beta channel bundle — relayer + the Prometheus/Grafana monitoring stack — from releases.scpri.me (anonymous pull) and writes a .env, then runs docker compose up -d — the user does NOT need to author any file. Falls back to a bundled copy of the bundle if the fetch fails. Pass compose_url only to override with a custom compose.\n\nIMPORTANT — two machines: this tool writes docker-compose.yml and .env on the machine running the MCP, but starts the containers on whichever machine the Docker daemon is on. With DOCKER_HOST or an ssh:// Docker context those are different machines. The install works and the data is safe (Docker named volumes on the Docker host), but the deployment cannot be restarted, re-ported, or upgraded from the Docker host until those files are copied there. When it detects a remote daemon the response leads with an action_required field, file_location names both machines, and move_files carries the source and destination plus the env-file contents. This tool deliberately does NOT generate a copy command — the correct one depends on the scp version, shell, ssh port, bastion and sudo policy in use, and a wrong command that looks right is worse than none; the README section named in the response has worked examples for the common setups. Surface action_required to the user verbatim — do not summarize it away.\n\nExposure decisions on this surface:\n\n1. BINDING — bind_address controls which host network interface Docker publishes ports on. Default: empty (all interfaces — the dashboard answers from any machine on the LAN with zero configuration). Set to "127.0.0.1" for loopback-only, or a specific interface IP. The value is passed to docker compose via env as BIND_ADDRESS; it takes effect only if the compose file used for the install references BIND_ADDRESS in its port declarations. The bundled fallback compose does; the channel compose and any compose_url override are fetched remotely and may not. The prerequisite check (check_prerequisites) probes port availability by binding 0.0.0.0 regardless of this setting.\n\n2. UI TLS — ui_tls_enabled describes whether the admin UI listens on HTTPS in addition to HTTP. Default: false (off). This switch is described here for decision visibility; it is NOT wired to behavior in this version — setting it to true is accepted but has no effect until a future release ships the listener. Cost when enabled: requires a TLS certificate and key provisioned on the host.\n\n3. S3 TLS — s3_tls_enabled describes whether the S3 gateway listens on HTTPS in addition to HTTP. Default: false (off). This switch is described here for decision visibility; it is NOT wired to behavior in this version — setting it to true is accepted but has no effect until a future release ships the listener. Cost when enabled: requires a TLS certificate and key provisioned on the host; S3 clients must be configured to use the HTTPS endpoint.',
            inputSchema: {
                install_path: z.string().optional().default('/opt/xns-relayer').describe('Directory to install the compose file into'),
                ui_port: z.number().int().min(1).max(65535).optional().default(8888).describe('Host port for the Relayer admin/customer UI (container 8888). Docker publishes this port on the interface chosen by bind_address.'),
                s3_port: z.number().int().min(1).max(65535).optional().default(9000).describe('Host port for the S3 API (container 9000). Docker publishes this port on the interface chosen by bind_address.'),
                compose_url: z.string().url().optional().describe('OPTIONAL override: URL to a custom docker-compose.yml. Omit for the normal released install. When provided, bind_address is passed to docker compose via env but the downloaded compose must use the BIND_ADDRESS variable in its port declarations for it to take effect.'),
                // R5 input boundary — see isValidBindAddress above for why each
                // documented address form is validated whole rather than by charset.
                bind_address: z.string().max(255).refine(isValidBindAddress, BIND_ADDRESS_HELP).optional().default('').describe('Host network interface for Docker port publication. Default: empty string (all interfaces — reachable from any machine on the LAN). Set to "127.0.0.1" for loopback-only access, or a specific interface IP to restrict reachability. Accepted forms: empty, an IPv4 address, or a bracketed IPv6 address (e.g. "[::1]"). Hostnames are rejected — the Compose ports host component is an IP address. This value is passed to docker compose via env, and on the channel and bundled-fallback paths it is also written into the .env this installer authors (the compose_url override path writes no .env). It is honored in the bundled fallback compose (which uses BIND_ADDRESS in its port declarations). On the default channel path and on the compose_url path, the fetched compose must reference the BIND_ADDRESS variable in its port declarations for the setting to take effect — this installer cannot verify that.'),
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

                // Resolved before the first write so every message below — the
                // mkdir error included — can name the right machine.
                const dockerHost = await resolveDockerHost(docker);
                const localDesc = dockerHost.remote
                    ? `this machine (the one running the MCP, NOT the Docker host ${dockerHost.host})`
                    : 'this machine';

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

                // Create install directory (execFile, no shell)
                await new Promise((resolve, reject) => {
                    execFileFn('mkdir', ['-p', install_path], {}, (err) => {
                        // mkdir runs HERE, not on the Docker host. On a workstation
                        // driving a remote daemon, /opt needs root and this is the
                        // first thing that fails — so name the machine that refused.
                        if (err) return reject(new Error(`Failed to create directory ${install_path} on ${localDesc}: ${err.message}`));
                        resolve();
                    });
                });

                const fetchCompose = (url) => new Promise((resolve, reject) => {
                    execFileFn('curl', ['-fsSL', '-o', composePath, url], { timeout: 60000 }, (err) => {
                        if (err) return reject(new Error(`Failed to download compose file: ${err.message}`));
                        resolve();
                    });
                });

                const bindPrefix = bind_address ? `${bind_address}:` : '';
                let envContents = null;
                let source;
                let note;
                if (compose_url) {
                    // Override path: download a custom compose (execFile, no shell).
                    await fetchCompose(compose_url);
                    source = 'compose_url';
                } else {
                    // Default path: fetch the canonical channel bundle (relayer +
                    // monitoring stack); fall back to the bundled service-parity
                    // template only when the fetch fails. Either way, author the
                    // .env so the user never writes a file.
                    try {
                        await fetchCompose(channelComposeUrl);
                        source = 'channel';
                    } catch (fetchErr) {
                        const template = await fsp.readFile(TEMPLATE_PATH, 'utf8');
                        await fsp.writeFile(composePath, template);
                        source = 'bundled-fallback';
                        note = `Channel bundle fetch failed (${fetchErr.message}) — fell back to the bundled compose. Same services; re-running install later is not required.`;
                    }
                    envContents = `UI_PORT=${ui_port}\nS3_PORT=${s3_port}\nBIND_ADDRESS=${bindPrefix}\n`;
                    await fsp.writeFile(envPath, envContents);
                }

                // Run docker compose up -d. cwd + env so ${UI_PORT}/${S3_PORT}
                // interpolation and the ./data bind resolve in the install dir,
                // regardless of where the MCP process was launched.
                await docker.composeUp(composePath, {
                    cwd: install_path,
                    env: { ...process.env, UI_PORT: String(ui_port), S3_PORT: String(s3_port), BIND_ADDRESS: bindPrefix },
                });

                // Two machines, two statements — never one install_path that is
                // only true on one of them. `action_required` leads the payload
                // when they differ so an agent relaying this cannot bury it.
                const fileLocation = {
                    same_machine: !dockerHost.remote,
                    files_written_on: dockerHost.remote
                        ? 'this machine — the one running the MCP, NOT the Docker host'
                        : 'this machine (which is also the Docker host)',
                    docker_host: dockerHost.remote ? dockerHost.host : 'localhost',
                    docker_endpoint: dockerHost.endpoint,
                    containers_running_on: dockerHost.remote ? dockerHost.host : 'this machine',
                    data_stored_on: dockerHost.remote
                        ? `${dockerHost.host} — Docker named volumes on the Docker host; no Relayer data is stored on this machine`
                        : 'this machine — Docker named volumes',
                };

                // Deliberately no generated shell command here. Getting one right
                // means guessing the user's scp version, shell, ssh port, bastion,
                // sudo policy and path — and a wrong command that looks right is
                // worse than none. State the facts instead and point at the
                // worked examples in the README, which a person can match to
                // their own setup. `move_files` carries enough to rebuild the
                // install by hand when there is no ssh route at all — but only
                // `compose_source` tells the user WHICH of the three recovery
                // paths applies, and on the compose_url path there is no env
                // file to hand back because none was written.
                const actionRequired = dockerHost.remote
                    ? `The Relayer is running on ${dockerHost.host}, but the files that define it are NOT. `
                      + `${envContents ? 'docker-compose.yml and the env file were' : 'docker-compose.yml was'} written to ${install_path} on this machine; `
                      + `${dockerHost.host} has no copy. Your data is safe — it is in Docker volumes on ${dockerHost.host}. `
                      + `What does not work until you fix this: restarting, changing ports, or upgrading from `
                      + `${dockerHost.host}, because "docker compose" there has no file to read. `
                      + `Move them now, not later — if this machine is a sandbox, CI runner, or throwaway VM, before the session ends. `
                      + `Keep the same directory name — compose takes its project name from it, and a differently-named `
                      + `directory would start a new project with empty volumes instead of attaching the existing ones. `
                      + `See "Moving the install files to the Docker host" in the relayer-mcp README for worked examples covering `
                      + `an ssh Docker context, a non-standard port or bastion, and a host you cannot ssh to from here. `
                      + `Better long-term: run this MCP on ${dockerHost.host} so the files and the containers stay together.`
                    : null;

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: true,
                            ...(actionRequired ? { action_required: actionRequired } : {}),
                            message: dockerHost.remote
                                ? `XNS Relayer containers are starting on ${dockerHost.host}. Read action_required before continuing — the install files were written on this machine, not on ${dockerHost.host}. Use check_relayer_health to monitor when all services are ready.`
                                : 'XNS Relayer containers are starting. Use check_relayer_health to monitor when all services are ready.',
                            compose_path: composePath,
                            install_path,
                            file_location: fileLocation,
                            ...(dockerHost.remote ? {
                                move_files: {
                                    source_machine: 'this machine (the one running the MCP)',
                                    source_path: install_path,
                                    destination_machine: dockerHost.host,
                                    // The last path segment is load-bearing: compose derives
                                    // the project name from it and prefixes volume names with
                                    // it, so landing the files in a differently-named directory
                                    // makes docker compose there a different project that would
                                    // create new empty volumes instead of attaching the existing
                                    // ones. Same directory name on both machines.
                                    destination_path: install_path,
                                    docker_endpoint: dockerHost.endpoint,
                                    files: envContents ? ['docker-compose.yml', '.env'] : ['docker-compose.yml'],
                                    // Which of the three recovery paths in the README applies.
                                    // 'bundled-fallback' is the one with no URL to fetch — that
                                    // compose came out of the npm package on THIS machine, so
                                    // the file itself has to travel.
                                    compose_source: source,
                                    compose_url: source === 'channel' ? channelComposeUrl
                                        : source === 'compose_url' ? compose_url
                                            : null,
                                    // null on the compose_url path: no env file is written
                                    // there, so there is nothing to hand back.
                                    env_contents: envContents,
                                    readme_section: 'Moving the install files to the Docker host',
                                },
                            } : {}),
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
                                bind_address_applied: source === 'bundled-fallback'
                                    ? 'yes — the bundled fallback compose references BIND_ADDRESS in its port declarations'
                                    : 'unknown — the fetched compose may or may not reference BIND_ADDRESS in its port declarations; this installer does not read the fetched file',
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
                            ...(note ? { note } : {}),
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            error: `Relayer installation failed: ${err.message}`,
                        }),
                    }],
                    isError: true,
                };
            }
        },
    );
};
