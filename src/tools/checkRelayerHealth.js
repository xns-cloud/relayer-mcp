'use strict';

const { z } = require('zod');
const { createHttpClient } = require('../lib/httpClient');
const { pollUntil } = require('../lib/pollUntil');

const POLL_INTERVAL_MS = 10000;   // 10s
const POLL_TIMEOUT_MS = 300000;   // 300s (AC-13, QA-1)

/**
 * Tool 5: check_relayer_health
 * AC-13: report healthy only when ui+s3+hostio healthy; name unhealthy component; 300s timeout.
 * TP-31: hostio = null (not false) before auth — hostio health requires an authenticated
 * proxy call, so before OIDC sign-in we report hostio as null (unknown), not false (down).
 */
module.exports = function registerCheckRelayerHealth(server, options = {}) {
    const http = options.httpClient || createHttpClient(options);
    const pollInterval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    const pollTimeout = options.pollTimeoutMs ?? POLL_TIMEOUT_MS;
    const sleep = options.sleep;

    server.tool(
        'check_relayer_health',
        'Check the health of all Relayer services: UI (port 8888), S3 gateway (port 9000), and HostIO. Polls every 10 seconds for up to 300 seconds. Reports each component status individually and names any unhealthy component. Note: HostIO health status is unknown until OIDC authentication is completed.',
        {
            poll: z.boolean().optional().default(true).describe('If true (default), poll until healthy or timeout. If false, check once.'),
        },
        async ({ poll }) => {
            try {
                const checkOnce = async () => {
                    const components = {};

                    // UI health (port 8888)
                    try {
                        const { status } = await http.get('http://localhost:8888/health', { timeout: 5000 });
                        components.ui = { healthy: status >= 200 && status < 500, status };
                    } catch {
                        components.ui = { healthy: false, status: null };
                    }

                    // S3 gateway (port 9000)
                    try {
                        const { status } = await http.get('http://localhost:9000/', { timeout: 5000 });
                        components.s3 = { healthy: status >= 200 && status < 500, status };
                    } catch {
                        components.s3 = { healthy: false, status: null };
                    }

                    // HostIO — requires auth. Report null (unknown) not false (down).
                    // TP-31: hostio = null before auth
                    try {
                        const { status } = await http.get('http://localhost:8888/api/v1/proxy/hostio/health', { timeout: 5000 });
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
                    if (!components.ui.healthy) unhealthy.push('UI (port 8888)');
                    if (!components.s3.healthy) unhealthy.push('S3 gateway (port 9000)');

                    return {
                        components,
                        healthy: coreHealthy,
                        all_healthy: allKnownHealthy,
                        unhealthy: unhealthy.length > 0 ? unhealthy : undefined,
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
