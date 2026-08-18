'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { z } = require('zod');
const { createHttpClient } = require('../lib/httpClient');
const { validateHostAllowlist, NO_REDIRECT_TOKEN_CONFIG } = require('../lib/hostAllowlist');

/**
 * Tool 11: setup_cli_credentials
 *
 * After check_claim_status reaches STATE_3, the user has a provisioned Relayer
 * but no CLI credentials. This tool:
 *   1. Creates an IAM user "xns-cli" via the Relayer UI MC proxy
 *   2. Receives the one-time {access_key, secret_key} response
 *   3. Writes ~/.xns/credentials (AC-11 JSON schema, mode 0600)
 *
 * The muse_token is the Keycloak JWT already held by the agent from the
 * configure_vpd / get_host_tags calls — no new auth step required.
 */
module.exports = function registerSetupCliCredentials(server, options = {}) {
    const http = options.httpClient || createHttpClient(options);

    server.registerTool(
        'setup_cli_credentials',
        {
            title: 'setup_cli_credentials',
            description: 'Provision S3 IAM credentials for the XNS CLI. Creates an IAM user in the Relayer and writes ~/.xns/credentials so that `xns ls` and other S3 verbs work without further configuration. Call once after check_claim_status reaches STATE_3.',
            inputSchema: {
                muse_token: z.string().describe('Keycloak/Muse token — the same token used for get_host_tags and configure_vpd'),
                installation_id: z.string().optional().default('').describe('Installation ID from check_claim_status STATE_3 result — used as cost_center_id in credentials'),
                relayer_ui_url: z.string().url().optional().default('http://localhost:8888').describe('Relayer UI base URL (default: http://localhost:8888). Must be a loopback, private-network, or .local address — this tool sends your Muse token to it.'),
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                openWorldHint: true,
            },
        },
        async ({ muse_token, installation_id, relayer_ui_url }) => {
            // This request carries the caller's Muse token. Check the destination BEFORE
            // sending anything, or a caller can name any host and collect the token
            // (MR !33). Same allowlist verify_storage has always applied.
            const allow = validateHostAllowlist(relayer_ui_url);
            if (!allow.allowed) {
                console.error(`[setup_cli_credentials] relayer_ui_url rejected: ${allow.reason}`);
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            error: `relayer_ui_url rejected: ${allow.reason}`,
                        }),
                    }],
                };
            }

            try {
                // Step 1: create IAM user "xns-cli" via MC proxy
                const { status, data } = await http.post(
                    `${relayer_ui_url}/api/v1/mc/user`,
                    { user: 'xns-cli' },
                    { headers: { keycloaktoken: muse_token }, ...NO_REDIRECT_TOKEN_CONFIG }
                );

                if (status !== 200) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: `Relayer returned HTTP ${status}`,
                                detail: data,
                            }),
                        }],
                    };
                }

                const ak = data.access_key || data.AccessKey || '';
                const sk = data.secret_key || data.SecretKey || '';

                if (!ak || !sk) {
                    const msg = data.message || data.Message || data.error || data.Error || 'no credentials in response';
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: `Relayer: ${msg}`,
                                hint: 'CLI credentials may already exist. Run `xns ls` — if it works, credentials are valid.',
                            }),
                        }],
                    };
                }

                // Step 2: derive S3 endpoint (same host, port 9000)
                const s3Endpoint = relayer_ui_url.replace(/:(\d+)(\/|$)/, ':9000$2');

                // Step 3: write ~/.xns/credentials (AC-11 JSON schema, mode 0600)
                const credsPath = path.join(os.homedir(), '.xns', 'credentials');
                fs.mkdirSync(path.dirname(credsPath), { recursive: true });

                const creds = {
                    version: 1,
                    profiles: {
                        default: {
                            endpoint: s3Endpoint,
                            access_key_id: ak,
                            secret_access_key: sk,
                            cost_center_id: installation_id,
                            muse_token: muse_token,
                        },
                    },
                    active_profile: 'default',
                };

                fs.writeFileSync(credsPath, JSON.stringify(creds, null, 2), { mode: 0o600 });

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: true,
                            message: 'CLI credentials written to ~/.xns/credentials. The user can now run `xns ls` to list their storage.',
                            s3_endpoint: s3Endpoint,
                        }),
                    }],
                };
            } catch (err) {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            error: err.message,
                        }),
                    }],
                };
            }
        }
    );
};
