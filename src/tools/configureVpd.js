'use strict';

const { z } = require('zod');
const { createHttpClient } = require('../lib/httpClient');
const { createTokenManager } = require('../lib/ensureToken');
const { proxyFailure } = require('../lib/proxyError');

const RELAYER_UI_BASE = 'http://localhost:8888';

/**
 * Tool 9: configure_vpd
 * AC-18: too-few-hosts 400 → plain re-ask naming 10/20 threshold.
 * AC-19: "use defaults" → configure_vpd("true","true") no further ask.
 * Watch item 1: trigger OIDC re-auth on 401 — never silent failure.
 *
 * Consumes relayer-ui's HostIO proxy (server/api/v1/Proxy.js wildcard,
 * /api/v1/proxy/hostio/* → HOSTIO /v1/hostio/<wildcard>):
 *   POST /api/v1/proxy/hostio/setexpressions { data, parity }
 *   POST /api/v1/proxy/hostio/evaluate       { data, parity }   (dry_run)
 *
 * WIRE CONTRACT — HOSTIO's SetExpressionsRequest/EvaluateRequest JSON keys are
 * `data` and `parity` (relayer hostio/types.go), the same keys NocDashboard
 * sends. <=0.5.2 posted {data_expression, parity_expression}: HOSTIO decoded
 * both as "" and its fix() substituted the all-hosts default — every custom
 * VPD selection was silently discarded while this tool reported success
 * (verified against relayer hostselection.go fix(), 2026-06-11). The MCP
 * param names stay data_expression/parity_expression; only the wire payload
 * uses {data, parity}. Path double-prefix bug also fixed here — see
 * getHostTags.js PATH CONTRACT note.
 *
 * dry_run routes to HOSTIO's read-only Evaluate (same compile/match path as
 * apply — the VPD evaluation-SoT endpoint, relayer branch
 * vpd-e1-hostio-evaluate). On Relayer builds that predate it, the proxy wraps
 * HOSTIO's 404 as {success:false, state} → reported as preview_supported:false.
 */
module.exports = function registerConfigureVpd(server, options = {}) {
    const http = options.httpClient || createHttpClient(options);
    const relayerUiBase = options.relayerUiBase || RELAYER_UI_BASE;

    const tokenMgr = createTokenManager(options);
    const { ensureToken } = tokenMgr;

    server.tool(
        'configure_vpd',
        'Configure VPD (Virtual Private Datacenter) host selection for the Relayer, or preview it with dry_run. Use defaults ("true" for both expressions) or a CEL expression filtering hosts by tags. The Relayer requires a minimum of 10 data hosts and 20 parity hosts — if too few match, broaden the criteria. Requires OIDC sign-in (same session as get_host_tags).',
        {
            data_expression: z.string().describe('CEL expression for data host selection. Use "true" for default (all hosts).'),
            parity_expression: z.string().describe('CEL expression for parity host selection. Use "true" for default (all hosts).'),
            dry_run: z.boolean().optional().describe('Preview how many hosts match without applying anything. Not supported on Relayer versions without the evaluate endpoint.'),
        },
        async ({ data_expression, parity_expression, dry_run }) => {
            try {
                let token = await ensureToken();

                const endpoint = dry_run
                    ? `${relayerUiBase}/api/v1/proxy/hostio/evaluate`
                    : `${relayerUiBase}/api/v1/proxy/hostio/setexpressions`;

                // Wire keys per HOSTIO contract — see WIRE CONTRACT note above.
                const payload = {
                    data: data_expression,
                    parity: parity_expression,
                };

                let { status, data } = await http.post(
                    endpoint,
                    payload,
                    { headers: { keycloaktoken: token } },
                );

                // Watch item 1: 401 → re-auth
                if (status === 401) {
                    token = await tokenMgr.reauth();
                    const retry = await http.post(
                        endpoint,
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

                // The proxy wraps upstream failures (HOSTIO down, missing route,
                // compile/floor rejections) as HTTP 200 {success:false, state}.
                const proxyErr = proxyFailure(data);
                if (proxyErr) {
                    if (dry_run && /404/.test(proxyErr)) {
                        return {
                            content: [{
                                type: 'text',
                                text: JSON.stringify({
                                    success: false,
                                    preview_supported: false,
                                    message: 'This Relayer version does not support VPD preview yet (no evaluate endpoint). Re-run without dry_run to apply directly, or upgrade the Relayer.',
                                }, null, 2),
                            }],
                        };
                    }
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                message: `HostIO rejected the request (${proxyErr}). Common causes: invalid CEL syntax, or too few matching hosts — the Relayer requires at least 10 data and 20 parity hosts. Broaden the criteria or use defaults ("true" for both expressions).`,
                            }, null, 2),
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
                                error: `VPD ${dry_run ? 'preview' : 'configuration'} failed (HTTP ${status}): ${JSON.stringify(data)}`,
                            }),
                        }],
                        isError: true,
                    };
                }

                if (dry_run) {
                    // EvaluateResponse: {data:{matched,count}, parity:{matched,count}}.
                    // Counts only — matched key arrays can be hundreds of pubkeys.
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: true,
                                preview: true,
                                matched_data_hosts: data?.data?.count ?? null,
                                matched_parity_hosts: data?.parity?.count ?? null,
                                data_expression,
                                parity_expression,
                                message: 'Preview only — nothing was applied. Applying will be rejected if the matched counts fall below the Relayer\'s minimums. Re-run without dry_run to apply this selection.',
                            }, null, 2),
                        }],
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
                            error: `VPD ${dry_run ? 'preview' : 'configuration'} failed: ${err.message}`,
                        }),
                    }],
                    isError: true,
                };
            }
        },
    );

    return { ensureToken, getTokenState: tokenMgr.getTokenState, setTokenState: tokenMgr.setTokenState };
};
