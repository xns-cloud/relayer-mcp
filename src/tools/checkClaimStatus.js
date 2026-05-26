'use strict';

const { z } = require('zod');
const { createHttpClient } = require('../lib/httpClient');
const { pollUntil } = require('../lib/pollUntil');

const RELAYER_UI_BASE = 'http://localhost:8888';
const POLL_INTERVAL_MS = 10000;  // 10s (AC-15)

/**
 * Tool 7: check_claim_status
 * AC-15: poll every 10s; surface STATE_1->2->3; auto-proceed on STATE_3.
 * AC-15a: 402 → {continue_polling:false, message}, no TTL loop.
 * AC-16: TTL expiry (no 402) → "session expired" + new start_claim.
 *
 * Consumes relayer-ui: GET /api/v1/claim/status?claim_id=...
 *   → {state:'STATE_1'|'STATE_2'|'STATE_3', detail, installation_id?, claimed_at?}
 *   → 402: payment method required
 *   → 404: claim not found (expired or invalid)
 */
module.exports = function registerCheckClaimStatus(server, options = {}) {
    const http = options.httpClient || createHttpClient(options);
    const relayerUiBase = options.relayerUiBase || RELAYER_UI_BASE;
    const pollInterval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    const sleep = options.sleep;

    server.tool(
        'check_claim_status',
        'Poll the status of a claim session. Checks every 10 seconds. States: STATE_1 (pending — user has not yet opened the claim URL), STATE_2 (in progress — user is completing the claim in browser), STATE_3 (completed — claim successful). Automatically proceeds when STATE_3 is reached.',
        {
            claim_id: z.string().describe('The claim_id returned by start_claim'),
            timeout_ms: z.number().optional().default(600000).describe('Maximum time to poll in milliseconds (default: 10 minutes)'),
        },
        async ({ claim_id, timeout_ms }) => {
            try {
                const checkOnce = async () => {
                    const { status, data } = await http.get(
                        `${relayerUiBase}/api/v1/claim/status?claim_id=${encodeURIComponent(claim_id)}`,
                    );

                    // AC-15a: 402 → stop, no loop
                    if (status === 402) {
                        return {
                            done: true,
                            stop: true,
                            result: {
                                success: false,
                                continue_polling: false,
                                message: 'A payment method is required before the claim can complete. Please add a payment method at console.xns.tech, then run start_claim again.',
                            },
                        };
                    }

                    // AC-16: 404 → expired
                    if (status === 404) {
                        return {
                            done: true,
                            result: {
                                success: false,
                                message: 'Claim session has expired or was not found. Run start_claim to create a new claim session.',
                                expired: true,
                            },
                        };
                    }

                    if (status >= 400) {
                        return {
                            done: true,
                            result: {
                                success: false,
                                error: data.error || `Claim status check failed (HTTP ${status}).`,
                            },
                        };
                    }

                    const state = data.state;

                    if (state === 'STATE_3') {
                        return {
                            done: true,
                            result: {
                                success: true,
                                message: 'Claim completed successfully. The Relayer is now linked to your account.',
                                state: 'STATE_3',
                                installation_id: data.installation_id,
                                claimed_at: data.claimed_at,
                            },
                        };
                    }

                    // STATE_1 or STATE_2 — still in progress
                    const stateMessages = {
                        STATE_1: 'Waiting for the user to open the claim URL in a browser.',
                        STATE_2: 'Claim is in progress — the user is completing the browser flow.',
                    };

                    return {
                        done: false,
                        result: {
                            success: false,
                            state,
                            message: stateMessages[state] || `Claim in state: ${state}`,
                            detail: data.detail,
                        },
                    };
                };

                const { result, timedOut } = await pollUntil({
                    fn: async () => {
                        const check = await checkOnce();
                        if (check.done) return check.result;
                        return null;
                    },
                    intervalMs: pollInterval,
                    timeoutMs: timeout_ms,
                    sleep,
                });

                if (timedOut) {
                    // AC-16: TTL expiry
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                message: 'Claim status polling timed out. The claim session may have expired. Run start_claim to create a new claim session.',
                                expired: true,
                            }, null, 2),
                        }],
                    };
                }

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(result, null, 2),
                    }],
                    isError: (result.success === false && result.continue_polling !== false) ? true : undefined,
                };
            } catch (err) {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            error: `Claim status check failed: ${err.message}`,
                        }),
                    }],
                    isError: true,
                };
            }
        },
    );
};
