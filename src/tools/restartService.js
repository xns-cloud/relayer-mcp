'use strict';

const { z } = require('zod');
const { createHttpClient } = require('../lib/httpClient');
const { createTokenManager } = require('../lib/ensureToken');

const RELAYER_UI_BASE = 'http://localhost:8888';

// Service names accepted by relayer-ui System.js #start/#stop switch
// (server/api/v1/System.js) — anything else falls through to "all".
const SERVICES = ['hostio', 'gateway', 's3gateway', 'database', 'all'];

/**
 * Tool 14: restart_service
 * Consumes relayer-ui: GET /api/v1/system/restart[/:service].
 * Standalone by design (not a flag on update_settings): restarting drops
 * in-flight S3 traffic, so it must be a separately confirmable step.
 */
module.exports = function registerRestartService(server, options = {}) {
    const http = options.httpClient || createHttpClient(options);
    const relayerUiBase = options.relayerUiBase || RELAYER_UI_BASE;

    const tokenMgr = createTokenManager(options);
    const { ensureToken } = tokenMgr;

    server.tool(
        'restart_service',
        'Restart a Relayer service (hostio, gateway, s3gateway, database) or all services. Disruptive: in-flight S3 requests will fail during the restart — confirm with the operator before calling. Verify recovery afterwards with check_relayer_health.',
        {
            service: z.enum(SERVICES).optional()
                .describe('Service to restart. Defaults to "all".'),
        },
        async ({ service }) => {
            try {
                const target = service && service !== 'all' ? `/${service}` : '';
                const url = `${relayerUiBase}/api/v1/system/restart${target}`;

                let token = await ensureToken();

                let { status, data } = await http.get(url, { headers: { keycloaktoken: token } });
                if (status === 401) {
                    token = await tokenMgr.reauth();
                    ({ status, data } = await http.get(url, { headers: { keycloaktoken: token } }));
                }

                if (status >= 400) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: `Restart request failed (HTTP ${status}): ${JSON.stringify(data)}`,
                            }),
                        }],
                        isError: true,
                    };
                }

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: true,
                            service: data?.service || service || 'all',
                            message: 'Restart initiated. Services take a moment to come back — verify recovery with check_relayer_health before continuing.',
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            error: `Failed to restart service: ${err.message}`,
                        }),
                    }],
                    isError: true,
                };
            }
        },
    );

    return { ensureToken, getTokenState: tokenMgr.getTokenState, setTokenState: tokenMgr.setTokenState };
};
