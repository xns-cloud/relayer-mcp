'use strict';

const { createHttpClient } = require('../lib/httpClient');
const { createTokenManager } = require('../lib/ensureToken');
const { proxyFailure } = require('../lib/proxyError');

const RELAYER_UI_BASE = 'http://localhost:8888';

/**
 * Tool 8: get_host_tags
 * AC-17: translate plain English → CEL; operator never sees "expression".
 * Watch item 1: trigger OIDC re-auth on 401 — never silent failure.
 *
 * Consumes relayer-ui's HostIO proxy (server/api/v1/Proxy.js, wildcard route
 * GET /api/v1/proxy/hostio/* → HOSTIO /v1/hostio/<wildcard>):
 *   GET /api/v1/proxy/hostio/gettags        → { tags: [...] }
 *   GET /api/v1/proxy/hostio/getexpressions → { data, parity }   (read-back)
 *
 * PATH CONTRACT — the proxy PREPENDS /v1/hostio/ to the wildcard. Passing
 * "v1/hostio/gettags" here produced /v1/hostio/v1/hostio/gettags → HOSTIO 404,
 * which the proxy wraps as HTTP 200 {success:false, state} (see proxyError.js).
 * That double-prefix shipped in <=0.5.2 and broke both VPD tools — verified
 * live against HOSTIO 2026-06-11. Fixed in 0.6.0; do not "restore" the prefix.
 */
module.exports = function registerGetHostTags(server, options = {}) {
    const http = options.httpClient || createHttpClient(options);
    const relayerUiBase = options.relayerUiBase || RELAYER_UI_BASE;

    const tokenMgr = createTokenManager(options);
    const { ensureToken } = tokenMgr;

    server.registerTool(
        'get_host_tags',
        {
            title: 'get_host_tags',
            description: 'Get the available host tags for VPD (Virtual Private Datacenter) configuration, plus the currently applied VPD host selection. Translate tags into plain-language options for the operator — never show raw CEL expressions. Requires OIDC sign-in on first use (the user will be prompted to sign in via browser).',
            inputSchema: {
                /* no parameters */
            },
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                openWorldHint: true,
            },
        },
        async () => {
            try {
                let token = await ensureToken();

                let { status, data } = await http.get(
                    `${relayerUiBase}/api/v1/proxy/hostio/gettags`,
                    { headers: { keycloaktoken: token } },
                );

                // Watch item 1: 401 → re-auth, never silent failure
                if (status === 401) {
                    token = await tokenMgr.reauth();
                    const retry = await http.get(
                        `${relayerUiBase}/api/v1/proxy/hostio/gettags`,
                        { headers: { keycloaktoken: token } },
                    );
                    status = retry.status;
                    data = retry.data;
                }

                if (status === 401) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: 'Authentication failed after re-auth attempt. The OIDC token was rejected by the Relayer proxy. Check Keycloak client configuration.',
                            }),
                        }],
                        isError: true,
                    };
                }

                const proxyErr = proxyFailure(data);
                if (status >= 400 || proxyErr) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: `Failed to retrieve host tags${proxyErr ? ` (HostIO proxy: ${proxyErr})` : ` (HTTP ${status}): ${JSON.stringify(data)}`}`,
                            }),
                        }],
                        isError: true,
                    };
                }

                const tags = data.tags || data || [];

                // Read-back of the applied expressions — degraded, never fatal:
                // tags alone are still useful when HOSTIO read-back hiccups.
                let current = null;
                try {
                    const exprResp = await http.get(
                        `${relayerUiBase}/api/v1/proxy/hostio/getexpressions`,
                        { headers: { keycloaktoken: token } },
                    );
                    if (exprResp.status < 400 && !proxyFailure(exprResp.data)
                        && typeof exprResp.data?.data === 'string'
                        && typeof exprResp.data?.parity === 'string') {
                        current = {
                            data_expression: exprResp.data.data,
                            parity_expression: exprResp.data.parity,
                            // "true" is HOSTIO's all-hosts default (hostselection fix()).
                            is_default: exprResp.data.data === 'true' && exprResp.data.parity === 'true',
                        };
                    }
                } catch (exprErr) {
                    current = null;
                }

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: true,
                            tags,
                            current,
                            message: 'Host tags retrieved. Present these as plain-language options to the operator (e.g., "US-based hosts", "European hosts"). Never show raw tag names or CEL expressions directly. "current" is the VPD selection applied right now (is_default true = all hosts). Use configure_vpd to change it.',
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            error: `Failed to get host tags: ${err.message}`,
                        }),
                    }],
                    isError: true,
                };
            }
        },
    );

    // Expose for testing
    return { ensureToken, getTokenState: tokenMgr.getTokenState, setTokenState: tokenMgr.setTokenState };
};
