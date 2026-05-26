'use strict';

const { createHttpClient } = require('../lib/httpClient');
const { createTokenManager } = require('../lib/ensureToken');

const RELAYER_UI_BASE = 'http://localhost:8888';

/**
 * Tool 8: get_host_tags
 * AC-17: translate plain English → CEL; operator never sees "expression".
 * Watch item 1: trigger OIDC re-auth on 401 — never silent failure.
 *
 * Consumes relayer-ui: GET /api/v1/proxy/hostio/v1/hostio/gettags
 * via keycloaktoken header (OIDC-authenticated proxy).
 */
module.exports = function registerGetHostTags(server, options = {}) {
    const http = options.httpClient || createHttpClient(options);
    const relayerUiBase = options.relayerUiBase || RELAYER_UI_BASE;

    const tokenMgr = createTokenManager(options);
    const { ensureToken } = tokenMgr;

    server.tool(
        'get_host_tags',
        'Get the list of available host tags for VPD (Virtual Private Datacenter) configuration. Returns the raw tags that can be used to build host selection preferences. The agent should translate these tags into plain-language options for the operator — never show raw CEL expressions. Requires OIDC sign-in on first use (the user will be prompted to sign in via browser).',
        {
            /* no parameters */
        },
        async () => {
            try {
                let token = await ensureToken();

                let { status, data } = await http.get(
                    `${relayerUiBase}/api/v1/proxy/hostio/v1/hostio/gettags`,
                    { headers: { keycloaktoken: token } },
                );

                // Watch item 1: 401 → re-auth, never silent failure
                if (status === 401) {
                    token = await tokenMgr.reauth();
                    const retry = await http.get(
                        `${relayerUiBase}/api/v1/proxy/hostio/v1/hostio/gettags`,
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

                if (status >= 400) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: `Failed to retrieve host tags (HTTP ${status}): ${JSON.stringify(data)}`,
                            }),
                        }],
                        isError: true,
                    };
                }

                const tags = data.tags || data || [];

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: true,
                            tags,
                            message: 'Host tags retrieved. Present these as plain-language options to the operator (e.g., "US-based hosts", "European hosts"). Never show raw tag names or CEL expressions directly. Use configure_vpd to apply the selection.',
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
