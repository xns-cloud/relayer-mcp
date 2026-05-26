'use strict';

const { z } = require('zod');
const { createHttpClient } = require('../lib/httpClient');
const { pollUntil } = require('../lib/pollUntil');

const CONSOLE_BASE_URL = 'https://console.xns.tech';
const POLL_INTERVAL_MS = 15000;   // 15s (AC-9)
const POLL_TIMEOUT_MS = 1800000;  // 30 min (AC-11)

/**
 * Tool 3: check_email_verified
 * AC-9: poll every 15s; auto-proceed on verified.
 * AC-10: three-state {verified:true} / {verified:false, exists:true} / {verified:false, exists:false}.
 * AC-11: 30-min timeout → expiry msg + resend (resend=true), no re-register.
 *
 * Consumes E2: GET /api/auth/email-verified?email=&resend=
 *   → {verified:true}
 *   → {verified:false, exists:true}
 *   → {verified:false, exists:false}
 *   resend-unknown → 404; >180/email/hr → 429
 */
module.exports = function registerCheckEmailVerified(server, options = {}) {
    const http = options.httpClient || createHttpClient(options);
    const consoleBaseUrl = options.consoleBaseUrl || CONSOLE_BASE_URL;
    const pollInterval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    const pollTimeout = options.pollTimeoutMs ?? POLL_TIMEOUT_MS;
    const sleep = options.sleep;

    server.tool(
        'check_email_verified',
        'Poll to check if the user has verified their email address. Automatically polls every 15 seconds for up to 30 minutes. Returns immediately if already verified. If the email has no account, indicates registration is needed.',
        {
            email: z.string().email().describe('Email address to check verification status'),
            poll: z.boolean().optional().default(true).describe('If true (default), poll until verified or timeout. If false, check once.'),
        },
        async ({ email, poll }) => {
            try {
                const checkOnce = async () => {
                    const { status, data } = await http.get(
                        `${consoleBaseUrl}/api/auth/email-verified?email=${encodeURIComponent(email)}`,
                    );

                    if (status === 429) {
                        return {
                            done: true,
                            result: {
                                success: false,
                                message: 'Rate limited. Waiting before retrying.',
                                rate_limited: true,
                            },
                        };
                    }

                    if (status === 404) {
                        return {
                            done: true,
                            result: {
                                success: false,
                                message: `No account found for ${email}. Use register_account first.`,
                                exists: false,
                                verified: false,
                            },
                        };
                    }

                    // Three-state response (AC-10)
                    if (data.verified === true) {
                        return {
                            done: true,
                            result: {
                                success: true,
                                message: `Email ${email} is verified. Proceeding to installation.`,
                                verified: true,
                                exists: true,
                            },
                        };
                    }

                    if (data.verified === false && data.exists === false) {
                        return {
                            done: true,
                            result: {
                                success: false,
                                message: `No account found for ${email}. Use register_account to create an account first.`,
                                verified: false,
                                exists: false,
                            },
                        };
                    }

                    // verified:false, exists:true — not yet verified, keep polling
                    return {
                        done: false,
                        result: {
                            success: false,
                            verified: false,
                            exists: true,
                            message: `Email ${email} is registered but not yet verified. Waiting for the user to click the verification link.`,
                        },
                    };
                };

                // Single check mode
                if (!poll) {
                    const { result } = await checkOnce();
                    return {
                        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                    };
                }

                // Poll mode (AC-9)
                const { result, timedOut } = await pollUntil({
                    fn: async () => {
                        const check = await checkOnce();
                        if (check.done) return check.result;
                        return null; // not done, keep polling
                    },
                    intervalMs: pollInterval,
                    timeoutMs: pollTimeout,
                    sleep,
                });

                if (timedOut) {
                    // AC-11: timeout → resend, no re-register
                    try {
                        await http.get(
                            `${consoleBaseUrl}/api/auth/email-verified?email=${encodeURIComponent(email)}&resend=true`,
                        );
                    } catch {
                        // Best-effort resend
                    }

                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                message: `Verification timed out after 30 minutes. A new verification email has been sent to ${email}. Ask the user to check their inbox (including spam folder) and click the link, then run check_email_verified again.`,
                                verified: false,
                                exists: true,
                                resent: true,
                            }, null, 2),
                        }],
                    };
                }

                return {
                    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                };
            } catch (err) {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            error: `Email verification check failed: ${err.message}`,
                        }),
                    }],
                    isError: true,
                };
            }
        },
    );
};
