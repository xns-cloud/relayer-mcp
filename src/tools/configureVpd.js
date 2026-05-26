'use strict';

const { z } = require('zod');
const { createHttpClient } = require('../lib/httpClient');
const { acquireToken, refreshToken } = require('../lib/oidcAuth');
const sharedTokenState = require('../lib/tokenState');

const RELAYER_UI_BASE = 'http://localhost:8888';

/**
 * Tool 9: configure_vpd
 * AC-18: too-few-hosts 400 → plain re-ask naming 10/20 threshold.
 * AC-19: "use defaults" → configure_vpd("true","true") no further ask.
 * Watch item 1: trigger OIDC re-auth on 401 — never silent failure.
 *
 * Consumes relayer-ui: POST /api/v1/proxy/hostio/v1/hostio/setexpressions
 * via keycloaktoken header (OIDC-authenticated proxy).
 */
module.exports = function registerConfigureVpd(server, options = {}) {
    const http = options.httpClient || createHttpClient(options);
    const relayerUiBase = options.relayerUiBase || RELAYER_UI_BASE;
    const _acquireToken = options.acquireToken || acquireToken;
    const _refreshToken = options.refreshToken || refreshToken;
    const oidcOpts = options.oidcOptions || {};

    const _tokenState = options._tokenStateModule || sharedTokenState;
    if (options._tokenState !== undefined) {
        _tokenState.set(options._tokenState);
    }

    async function ensureToken() {
        const tokenState = _tokenState.get();
        if (tokenState && tokenState.refresh_token) {
            if (Date.now() >= tokenState.expires_at - 30000) {
                try {
                    const newState = await _refreshToken({
                        refreshToken: tokenState.refresh_token,
                        ...oidcOpts,
                    });
                    _tokenState.set(newState);
                    return newState.access_token;
                } catch {
                    _tokenState.clear();
                }
            } else {
                return tokenState.access_token;
            }
        }
        const newState = await _acquireToken(oidcOpts);
        _tokenState.set(newState);
        return newState.access_token;
    }

    server.tool(
        'configure_vpd',
        'Configure VPD (Virtual Private Datacenter) host selection for the Relayer. You can either use defaults (recommended for most users) or provide a CEL expression to filter specific hosts by tags. The Relayer requires a minimum of 10 data hosts and 20 parity hosts. If too few hosts match your filter, broaden your criteria. Requires OIDC sign-in (same session as get_host_tags).',
        {
            data_expression: z.string().describe('CEL expression for data host selection. Use "true" for default (all hosts).'),
            parity_expression: z.string().describe('CEL expression for parity host selection. Use "true" for default (all hosts).'),
        },
        async ({ data_expression, parity_expression }) => {
            try {
                let token = await ensureToken();

                const payload = {
                    data_expression,
                    parity_expression,
                };

                let { status, data } = await http.post(
                    `${relayerUiBase}/api/v1/proxy/hostio/v1/hostio/setexpressions`,
                    payload,
                    { headers: { keycloaktoken: token } },
                );

                // Watch item 1: 401 → re-auth
                if (status === 401) {
                    _tokenState.clear();
                    token = await ensureToken();
                    const retry = await http.post(
                        `${relayerUiBase}/api/v1/proxy/hostio/v1/hostio/setexpressions`,
                        payload,
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
                                error: 'Authentication failed after re-auth attempt. The OIDC token was rejected by the Relayer proxy.',
                            }),
                        }],
                        isError: true,
                    };
                }

                // AC-18: 400 with too-few-hosts → plain re-ask naming 10/20 threshold
                if (status === 400) {
                    const msg = typeof data === 'string' ? data : (data.message || data.error || JSON.stringify(data));
                    const isTooFew = /too.few|not enough|insufficient/i.test(msg);

                    if (isTooFew) {
                        return {
                            content: [{
                                type: 'text',
                                text: JSON.stringify({
                                    success: false,
                                    message: `Not enough hosts match your filter. The Relayer requires at least 10 data hosts and 20 parity hosts. Your current expression matched too few hosts. Try broadening your criteria or use defaults ("true" for both expressions).`,
                                    too_few_hosts: true,
                                    min_data_hosts: 10,
                                    min_parity_hosts: 20,
                                }, null, 2),
                            }],
                        };
                    }

                    // Other 400 — likely invalid CEL expression
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: `VPD configuration rejected: ${msg}. Check that the expression syntax is valid.`,
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
                                error: `VPD configuration failed (HTTP ${status}): ${JSON.stringify(data)}`,
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
                            message: 'VPD host selection configured successfully. The Relayer will use the specified host preferences for data storage.',
                            data_expression,
                            parity_expression,
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            error: `VPD configuration failed: ${err.message}`,
                        }),
                    }],
                    isError: true,
                };
            }
        },
    );

    return { ensureToken, getTokenState: () => _tokenState.get(), setTokenState: (s) => { _tokenState.set(s); } };
};
