'use strict';

const { z } = require('zod');
const { createHttpClient } = require('../lib/httpClient');
const { createDockerUtil } = require('../lib/dockerUtil');
const { pollUntil } = require('../lib/pollUntil');

const POLL_INTERVAL_MS = 10000;   // 10s
const POLL_TIMEOUT_MS = 300000;   // 300s (AC-13, QA-1)

// Loopback aliases — all classify as "local", not a remote Docker host.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Normalize a user-supplied or detected host for URL composition: trim, strip
 * ANY accidental scheme prefix (http://, tcp://, ssh://…), bracket bare IPv6.
 * Prevents invalid probe URLs (and false unhealthy reports) from inputs like
 * 'http://docker-box.lan' or a pasted Docker endpoint 'tcp://10.0.0.5:2376'.
 *
 * @param {string} value
 * @returns {string}
 */
function normalizeHost(value) {
    const trimmed = String(value).trim();
    let hostname = trimmed;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
        try {
            hostname = new URL(trimmed).hostname || trimmed; // keeps IPv6 brackets
        } catch {
            hostname = trimmed;
        }
    }
    // Bare IPv6 → bracket it so http://${host}:${port} stays a valid URL.
    return hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
}

/**
 * Tool 5: check_relayer_health
 * AC-13: report healthy only when ui+s3+hostio healthy; name unhealthy component; 300s timeout.
 * TP-31: hostio = null (not false) before auth — hostio health requires an authenticated
 * proxy call, so before OIDC sign-in we report hostio as null (unknown), not false (down).
 *
 * Remote Docker: when the Docker CLI points at another machine (DOCKER_HOST or
 * an ssh:// context — e.g. Claude Code on a jump host), the containers run
 * THERE, so health probes default to that host instead of localhost.
 */
module.exports = function registerCheckRelayerHealth(server, options = {}) {
    const http = options.httpClient || createHttpClient(options);
    const docker = options.dockerUtil || createDockerUtil(options);
    const pollInterval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    const pollTimeout = options.pollTimeoutMs ?? POLL_TIMEOUT_MS;
    const sleep = options.sleep;

    server.tool(
        'check_relayer_health',
        'Check the health of all Relayer services: UI (port 8888), S3 gateway (port 9000), and HostIO. Polls every 10 seconds for up to 300 seconds. Reports each component status individually and names any unhealthy component. Targets the machine the Docker daemon runs on (auto-detected from the Docker context — supports remote ssh:// Docker hosts); pass host to override. Note: HostIO health status is unknown until OIDC authentication is completed.',
        {
            poll: z.boolean().optional().default(true).describe('If true (default), poll until healthy or timeout. If false, check once.'),
            host: z.string().trim().min(1).optional().describe('Hostname/IP where the Relayer containers run. Default: auto-detected from the Docker context (localhost, or the remote host for ssh:// / tcp:// contexts).'),
            ui_port: z.number().int().positive().optional().default(8888).describe('Host port for the Relayer UI (matches install_relayer ui_port)'),
            s3_port: z.number().int().positive().optional().default(9000).describe('Host port for the S3 API (matches install_relayer s3_port)'),
        },
        async ({ poll, host, ui_port, s3_port }) => {
            try {
                // R1: zod fills defaults in production; ?? guards direct calls.
                const uiPort = ui_port ?? 8888;
                const s3Port = s3_port ?? 9000;
                // Resolve where the containers actually run — once per call.
                const dockerHost = host ? { host, remote: !LOCAL_HOSTS.has(normalizeHost(host)) } : await docker.getDockerHost();
                const target = normalizeHost(dockerHost.host);
                const uiBase = `http://${target}:${uiPort}`;
                const s3Base = `http://${target}:${s3Port}`;

                const checkOnce = async () => {
                    const components = {};

                    // UI health
                    try {
                        const { status } = await http.get(`${uiBase}/health`, { timeout: 5000 });
                        components.ui = { healthy: status >= 200 && status < 500, status };
                    } catch {
                        components.ui = { healthy: false, status: null };
                    }

                    // S3 gateway
                    try {
                        const { status } = await http.get(`${s3Base}/`, { timeout: 5000 });
                        components.s3 = { healthy: status >= 200 && status < 500, status };
                    } catch {
                        components.s3 = { healthy: false, status: null };
                    }

                    // HostIO — requires auth. Report null (unknown) not false (down).
                    // TP-31: hostio = null before auth
                    try {
                        const { status } = await http.get(`${uiBase}/api/v1/proxy/hostio/health`, { timeout: 5000 });
                        if (status === 401) {
                            // Auth required — hostio status is unknown (not unhealthy)
                            components.hostio = { healthy: null, status: 401, note: 'Authentication required — HostIO health unknown until OIDC sign-in' };
                        } else {
                            components.hostio = { healthy: status >= 200 && status < 400, status };
                        }
                    } catch {
                        components.hostio = { healthy: null, status: null, note: 'HostIO health unknown — authentication not yet completed' };
                    }

                    // Healthy if UI and S3 are up. HostIO null (unknown) does NOT block.
                    const coreHealthy = components.ui.healthy === true && components.s3.healthy === true;
                    const allKnownHealthy = coreHealthy && components.hostio.healthy === true;

                    const unhealthy = [];
                    if (!components.ui.healthy) unhealthy.push(`UI (${target}:${uiPort})`);
                    if (!components.s3.healthy) unhealthy.push(`S3 gateway (${target}:${s3Port})`);

                    return {
                        components,
                        healthy: coreHealthy,
                        all_healthy: allKnownHealthy,
                        unhealthy: unhealthy.length > 0 ? unhealthy : undefined,
                        target_host: target,
                        remote_docker: dockerHost.remote === true || undefined,
                    };
                };

                if (!poll) {
                    const result = await checkOnce();
                    const message = result.healthy
                        ? 'Relayer core services (UI + S3) are healthy.' + (result.all_healthy ? ' HostIO is also healthy.' : ' HostIO status is pending authentication.')
                        : `Relayer is not yet healthy. Unhealthy: ${result.unhealthy.join(', ')}.`;

                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({ success: result.healthy, message, ...result }, null, 2),
                        }],
                    };
                }

                // Poll mode
                const { result, timedOut } = await pollUntil({
                    fn: async () => {
                        const check = await checkOnce();
                        if (check.healthy) return check;
                        return null;
                    },
                    intervalMs: pollInterval,
                    timeoutMs: pollTimeout,
                    sleep,
                });

                if (timedOut) {
                    const finalCheck = await checkOnce();
                    const unhealthyNames = finalCheck.unhealthy || [];
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                message: `Health check timed out after 300 seconds. Unhealthy components: ${unhealthyNames.join(', ') || 'none identified'}. Check Docker container logs for details.`,
                                ...finalCheck,
                            }, null, 2),
                        }],
                    };
                }

                const message = result.all_healthy
                    ? 'All Relayer services are healthy (UI, S3, HostIO). Ready for claim.'
                    : 'Relayer core services (UI + S3) are healthy. HostIO status pending authentication. Proceed to start_claim.';

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({ success: true, message, ...result }, null, 2),
                    }],
                };
            } catch (err) {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            error: `Health check failed: ${err.message}`,
                        }),
                    }],
                    isError: true,
                };
            }
        },
    );
};
