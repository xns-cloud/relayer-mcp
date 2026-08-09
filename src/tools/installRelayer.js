'use strict';

const { z } = require('zod');
const path = require('path');
const { createDockerUtil } = require('../lib/dockerUtil');

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

    server.tool(
        'install_relayer',
        'Install and start the XNS Relayer. By default fetches the canonical beta channel bundle — relayer + the Prometheus/Grafana monitoring stack — from releases.scpri.me (anonymous pull) and writes a .env, then runs docker compose up -d — the user does NOT need to author any file. Falls back to a bundled copy of the bundle if the fetch fails. Pass compose_url only to override with a custom compose.\n\nExposure decisions on this surface:\n\n1. BINDING — bind_address controls which host network interface Docker publishes ports on. Default: empty (all interfaces — the dashboard answers from any machine on the LAN with zero configuration). Set to "127.0.0.1" for loopback-only, or a specific interface IP. The value is passed to docker compose via env as BIND_ADDRESS; it takes effect only if the compose file used for the install references BIND_ADDRESS in its port declarations. The bundled fallback compose does; the channel compose and any compose_url override are fetched remotely and may not. The prerequisite check (check_prerequisites) probes port availability by binding 0.0.0.0 regardless of this setting.\n\n2. UI TLS — ui_tls_enabled describes whether the admin UI listens on HTTPS in addition to HTTP. Default: false (off). This switch is described here for decision visibility; it is NOT wired to behavior in this version — setting it to true is accepted but has no effect until a future release ships the listener. Cost when enabled: requires a TLS certificate and key provisioned on the host.\n\n3. S3 TLS — s3_tls_enabled describes whether the S3 gateway listens on HTTPS in addition to HTTP. Default: false (off). This switch is described here for decision visibility; it is NOT wired to behavior in this version — setting it to true is accepted but has no effect until a future release ships the listener. Cost when enabled: requires a TLS certificate and key provisioned on the host; S3 clients must be configured to use the HTTPS endpoint.',
        {
            install_path: z.string().optional().default('/opt/xns-relayer').describe('Directory to install the compose file into'),
            ui_port: z.number().int().min(1).max(65535).optional().default(8888).describe('Host port for the Relayer admin/customer UI (container 8888). Docker publishes this port on the interface chosen by bind_address.'),
            s3_port: z.number().int().min(1).max(65535).optional().default(9000).describe('Host port for the S3 API (container 9000). Docker publishes this port on the interface chosen by bind_address.'),
            compose_url: z.string().url().optional().describe('OPTIONAL override: URL to a custom docker-compose.yml. Omit for the normal released install. When provided, bind_address is passed to docker compose via env but the downloaded compose must use the BIND_ADDRESS variable in its port declarations for it to take effect.'),
            bind_address: z.string().optional().default('').describe('Host network interface for Docker port publication. Default: empty string (all interfaces — reachable from any machine on the LAN). Set to "127.0.0.1" for loopback-only access, or a specific interface IP to restrict reachability. This value is written into the .env and passed to docker compose via env. It is honored in the bundled fallback compose (which uses BIND_ADDRESS in its port declarations). On the default channel path and on the compose_url path, the fetched compose must reference the BIND_ADDRESS variable in its port declarations for the setting to take effect — this installer cannot verify that.'),
            ui_tls_enabled: z.boolean().optional().default(false).describe('Whether the admin UI should listen on HTTPS in addition to HTTP. Default: false (off — HTTP only). NOT WIRED in this version: accepted but has no effect until a future release ships the TLS listener. Cost when enabled: requires a TLS certificate and key provisioned on the host.'),
            s3_tls_enabled: z.boolean().optional().default(false).describe('Whether the S3 gateway should listen on HTTPS in addition to HTTP. Default: false (off — HTTP only). NOT WIRED in this version: accepted but has no effect until a future release ships the TLS listener. Cost when enabled: requires a TLS certificate and key provisioned on the host; S3 clients must be configured to use the HTTPS endpoint.'),
        },
        async ({ install_path, ui_port, s3_port, compose_url, bind_address, ui_tls_enabled, s3_tls_enabled }) => {
            try {
                const { execFile: nodeExecFile } = require('child_process');
                const execFileFn = _execFile || nodeExecFile;
                const composePath = path.join(install_path, 'docker-compose.yml');
                const envPath = path.join(install_path, '.env');

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
                        if (err) return reject(new Error(`Failed to create directory ${install_path}: ${err.message}`));
                        resolve();
                    });
                });

                const fetchCompose = (url) => new Promise((resolve, reject) => {
                    execFileFn('curl', ['-fsSL', '-o', composePath, url], { timeout: 60000 }, (err) => {
                        if (err) return reject(new Error(`Failed to download compose file: ${err.message}`));
                        resolve();
                    });
                });

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
                    const bindPrefix = bind_address ? `${bind_address}:` : '';
                    await fsp.writeFile(envPath, `UI_PORT=${ui_port}\nS3_PORT=${s3_port}\nBIND_ADDRESS=${bindPrefix}\n`);
                }

                // Run docker compose up -d. cwd + env so ${UI_PORT}/${S3_PORT}
                // interpolation and the ./data bind resolve in the install dir,
                // regardless of where the MCP process was launched.
                await docker.composeUp(composePath, {
                    cwd: install_path,
                    env: { ...process.env, UI_PORT: String(ui_port), S3_PORT: String(s3_port), BIND_ADDRESS: bind_address ? `${bind_address}:` : '' },
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
                                bind_address_applied: source === 'bundled-fallback'
                                    ? 'yes — the bundled fallback compose references BIND_ADDRESS in its port declarations'
                                    : 'unknown — the fetched compose may or may not reference BIND_ADDRESS in its port declarations; this installer does not read the fetched file',
                                ui: { host_port: ui_port, container_port: compose_url ? null : 8888 },
                                s3: { host_port: s3_port, container_port: compose_url ? null : 9000 },
                                composed_from: compose_url
                                    ? `UI_PORT=${ui_port}, S3_PORT=${s3_port}, BIND_ADDRESS=${bind_address ? `${bind_address}:` : ''} passed to docker compose (no .env written on the compose_url override path)`
                                    : `UI_PORT=${ui_port}, S3_PORT=${s3_port}, BIND_ADDRESS=${bind_address ? `${bind_address}:` : ''} written to ${envPath}`,
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
