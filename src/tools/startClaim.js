'use strict';

const { createHttpClient } = require('../lib/httpClient');

const RELAYER_UI_BASE = 'http://localhost:8888';

/**
 * Tool 6: start_claim
 * AC-14: Gate 2 dialogue: claim_url + expires_at + auto-detect.
 * AC-15a: on 402: stop polling, do NOT loop TTL, name specific action.
 *
 * Consumes relayer-ui: POST /api/v1/claim/init
 *   → {claim_id, claim_url, expires_at}
 *   → 402: payment method required (E3 not yet deployed)
 *   → 502: upstream error
 */
module.exports = function registerStartClaim(server, options = {}) {
    const http = options.httpClient || createHttpClient(options);
    const relayerUiBase = options.relayerUiBase || RELAYER_UI_BASE;

    server.tool(
        'start_claim',
        'Start a claim session to link this Relayer installation to an XNS account. Returns a claim URL that the user must open in a browser to complete the claim. The claim has an expiration time. After calling this, use check_claim_status to monitor claim progress.',
        {
            /* no parameters */
        },
        async () => {
            try {
                const { status, data } = await http.post(`${relayerUiBase}/api/v1/claim/init`, {});

                // AC-15a: 402 → stop, do NOT loop, name the action
                if (status === 402) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                continue_polling: false,
                                message: 'A payment method is required before claiming a Relayer. Please add a payment method to your account at console.xns.tech, then run start_claim again.',
                            }, null, 2),
                        }],
                    };
                }

                if (status === 502 || status >= 500) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: data.error || 'Failed to initiate claim — upstream service error. Try again in a few seconds.',
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
                                error: data.error || `Claim initiation failed (HTTP ${status}).`,
                            }),
                        }],
                        isError: true,
                    };
                }

                // Success — AC-14: present claim_url + expires_at
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: true,
                            message: `Claim session started. The user must open the following URL in a browser to complete the claim. This session expires at ${data.expires_at}.`,
                            claim_id: data.claim_id,
                            claim_url: data.claim_url,
                            expires_at: data.expires_at,
                            next_action: 'Use check_claim_status to monitor when the claim is completed.',
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            error: `Claim initiation failed: ${err.message}`,
                        }),
                    }],
                    isError: true,
                };
            }
        },
    );
};
