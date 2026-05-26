'use strict';

const { z } = require('zod');
const { createHttpClient } = require('../lib/httpClient');

const CONSOLE_BASE_URL = 'https://console.xns.tech';

/**
 * Tool 2: register_account
 * AC-5: silent register, confirms account at {email}.
 * AC-6: 409 → "email already has account" + next_action skip hint.
 * AC-7: 422 → names the specific password rule.
 * AC-8: Gate 1 dialogue names email + auth.xns.tech + auto-check.
 *
 * Consumes E2: POST /api/auth/register
 *   → 201 {success:true, userId, message:"Verification email sent"}
 *   → 409 {success:false, message} (already registered)
 *   → 422 {success:false, message} (validation error — password rules)
 *   → 429 {success:false, message} (rate limited)
 */
module.exports = function registerRegisterAccount(server, options = {}) {
    const http = options.httpClient || createHttpClient(options);
    const consoleBaseUrl = options.consoleBaseUrl || CONSOLE_BASE_URL;

    server.tool(
        'register_account',
        'Register a new XNS account with an email and password. After registration, the user must verify their email at auth.xns.tech by clicking the link sent to their inbox. Use check_email_verified to poll for verification status. If the email already has an account, you can skip to install_relayer.',
        {
            email: z.string().email().describe('User email address'),
            password: z.string().min(8).describe('Password (minimum 8 characters)'),
        },
        async ({ email, password }) => {
            try {
                const { status, data } = await http.post(
                    `${consoleBaseUrl}/api/auth/register`,
                    { email, password },
                );

                if (status === 201) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: true,
                                message: `Account registered for ${email}. A verification email has been sent. The user must click the verification link at auth.xns.tech before proceeding. Use check_email_verified to poll for verification.`,
                                email,
                                userId: data.userId,
                            }),
                        }],
                    };
                }

                if (status === 409) {
                    // AC-6: carry next_action skip hint
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                message: `Email ${email} already has an account. You can skip registration and proceed directly to install_relayer.`,
                                next_action: 'skip_to_install',
                                email,
                            }),
                        }],
                    };
                }

                if (status === 422) {
                    // AC-7: name the specific password rule
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                message: data.message || 'Validation error — check password requirements (minimum 8 characters, at least one uppercase, one lowercase, one number).',
                                email,
                            }),
                        }],
                        isError: true,
                    };
                }

                if (status === 429) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                message: data.message || 'Rate limited. Please wait before retrying registration.',
                                email,
                            }),
                        }],
                        isError: true,
                    };
                }

                // Unexpected status
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            error: `Unexpected response (HTTP ${status}): ${data.message || JSON.stringify(data)}`,
                            email,
                        }),
                    }],
                    isError: true,
                };
            } catch (err) {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            error: `Registration request failed: ${err.message}`,
                        }),
                    }],
                    isError: true,
                };
            }
        },
    );
};
