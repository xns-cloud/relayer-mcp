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

    server.tool(
        'install_relayer',
        'Install and start the XNS Relayer. By default fetches the canonical beta channel bundle — relayer + the Prometheus/Grafana monitoring stack — from releases.scpri.me (anonymous pull) and writes a .env, then runs docker compose up -d — the user does NOT need to author any file. Falls back to a bundled copy of the bundle if the fetch fails. Pass compose_url only to override with a custom compose.',
        {
            install_path: z.string().optional().default('/opt/xns-relayer').describe('Directory to install the compose file into'),
            ui_port: z.number().int().positive().optional().default(8888).describe('Host port for the Relayer admin/customer UI (container 8888)'),
            s3_port: z.number().int().positive().optional().default(9000).describe('Host port for the S3 API (container 9000)'),
            compose_url: z.string().url().optional().describe('OPTIONAL override: URL to a custom docker-compose.yml. Omit for the normal released install.'),
        },
        async ({ install_path, ui_port, s3_port, compose_url }) => {
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
                        await fetchCompose(CHANNEL_COMPOSE_URL);
                        source = 'channel';
                    } catch (fetchErr) {
                        const template = await fsp.readFile(TEMPLATE_PATH, 'utf8');
                        await fsp.writeFile(composePath, template);
                        source = 'bundled-fallback';
                        note = `Channel bundle fetch failed (${fetchErr.message}) — fell back to the bundled compose. Same services; re-running install later is not required.`;
                    }
                    await fsp.writeFile(envPath, `UI_PORT=${ui_port}\nS3_PORT=${s3_port}\n`);
                }

                // Run docker compose up -d. cwd + env so ${UI_PORT}/${S3_PORT}
                // interpolation and the ./data bind resolve in the install dir,
                // regardless of where the MCP process was launched.
                await docker.composeUp(composePath, {
                    cwd: install_path,
                    env: { ...process.env, UI_PORT: String(ui_port), S3_PORT: String(s3_port) },
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
