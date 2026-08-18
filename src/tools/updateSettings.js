'use strict';

const { z } = require('zod');
const { createHttpClient } = require('../lib/httpClient');
const { createTokenManager } = require('../lib/ensureToken');
const { ALLOWED_SETTINGS, isAllowed, typeError, suggestKey } = require('../lib/allowedSettings');

const RELAYER_UI_BASE = 'http://localhost:8888';

/**
 * Tool 13: update_settings
 * Whitelist-enforced read-merge-write against relayer-ui's config API:
 * GET /api/v1/config -> merge accepted keys into `current` -> PUT { config, database }.
 *
 * CROSS-BOUNDARY CONTRACT — the PUT persists the FULL config file (there is no
 * server-side patch), and `database` must round-trip from the GET. The GET
 * redacts database.password to '[REDACTED]'; relayer-ui >= 3.43.3 restores the
 * real password server-side (dbPasswordGuard.js). Against older relayer-ui
 * versions this tool could clobber the DB password — the README pins the
 * minimum version.
 *
 * Semantic validation stays server-side (e.g. the resource-aware upload
 * ceiling rejects oversized HOSTIO_SIMULTANEOUS_UPLOADS); those rejection
 * messages pass through verbatim.
 */
module.exports = function registerUpdateSettings(server, options = {}) {
    const http = options.httpClient || createHttpClient(options);
    const relayerUiBase = options.relayerUiBase || RELAYER_UI_BASE;

    const tokenMgr = createTokenManager(options);
    const { ensureToken } = tokenMgr;

    server.registerTool(
        'update_settings',
        {
            title: 'update_settings',
            description: 'Update adjustable Relayer settings (see describe_settings for the allowed set). Pass a map of setting name to new value, e.g. {"HOSTIO_UPLOAD_WORKERS": 20}. Returns require_restart — if true, follow up with restart_service after confirming with the operator. Changing CostCenter re-bills to a different cost center; always confirm first.',
            inputSchema: {
                settings: z.record(z.union([z.string(), z.number(), z.boolean()]))
                    .describe('Map of setting name to new value. Only whitelisted settings are accepted; unknown or protected keys are rejected with the allowed list.'),
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                openWorldHint: true,
            },
        },
        async ({ settings }) => {
            try {
                const accepted = {};
                const rejected = [];
                for (const [key, value] of Object.entries(settings || {})) {
                    if (!isAllowed(key)) {
                        const suggestion = suggestKey(key);
                        rejected.push({
                            key,
                            reason: `not an adjustable setting${suggestion ? ` — did you mean ${suggestion}?` : ''}`,
                        });
                        continue;
                    }
                    const typeProblem = typeError(key, value);
                    if (typeProblem) {
                        rejected.push({ key, reason: typeProblem });
                        continue;
                    }
                    accepted[key] = value;
                }

                if (Object.keys(accepted).length === 0) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                rejected,
                                allowed_settings: Object.keys(ALLOWED_SETTINGS),
                                message: 'No valid settings to apply. Only the listed settings are adjustable through this MCP.',
                            }, null, 2),
                        }],
                        isError: true,
                    };
                }

                let token = await ensureToken();

                const readOnce = (tok) => http.get(
                    `${relayerUiBase}/api/v1/config`,
                    { headers: { keycloaktoken: tok } },
                );

                let { status, data } = await readOnce(token);
                if (status === 401) {
                    token = await tokenMgr.reauth();
                    ({ status, data } = await readOnce(token));
                }
                if (status >= 400) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: `Failed to read current configuration before update (HTTP ${status}). Nothing was changed.`,
                            }),
                        }],
                        isError: true,
                    };
                }

                // The PUT persists the full config file AND requires the
                // database section — refuse to write from a malformed read
                // rather than risk persisting a gutted config.
                if (!data || typeof data !== 'object' || !data.current || !data.database) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: 'Unexpected configuration response from the Relayer (missing current config or database section). Nothing was changed.',
                            }),
                        }],
                        isError: true,
                    };
                }

                // Merge accepted keys into a copy of the live config. Group
                // placement comes from the whitelist (matches the sections of
                // relayer_configuration.json); CostCenter is top-level.
                const config = JSON.parse(JSON.stringify(data.current));
                for (const [key, value] of Object.entries(accepted)) {
                    const group = ALLOWED_SETTINGS[key].group;
                    if (group) {
                        config[group] = config[group] || {};
                        config[group][key] = value;
                    } else {
                        config[key] = value;
                    }
                }

                const putResp = await http.put(
                    `${relayerUiBase}/api/v1/config`,
                    { config, database: data.database },
                    { headers: { keycloaktoken: token } },
                );

                if (putResp.status >= 400 || putResp.data?.success === false) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                rejected,
                                // Server-side rejections (e.g. the upload-concurrency
                                // ceiling) carry an actionable message — surface it.
                                error: putResp.data?.message || `Configuration update failed (HTTP ${putResp.status}).`,
                            }, null, 2),
                        }],
                        isError: true,
                    };
                }

                const requireRestart = putResp.data?.requireRestart === true
                    || Object.keys(accepted).some((k) => /restart/i.test(ALLOWED_SETTINGS[k].note));

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: true,
                            applied: accepted,
                            rejected,
                            require_restart: requireRestart,
                            message: requireRestart
                                ? 'Settings saved. They take effect after a service restart — confirm with the operator, then call restart_service.'
                                : 'Settings saved.',
                        }, null, 2),
                    }],
                };
            } catch (err) {
                // err.message is surfaced DELIBERATELY (looks like R3 leakage,
                // isn't): this is a stdio MCP in the operator's local trust
                // domain, there is no server-side log a user would read, and
                // the raw signal (ECONNREFUSED, timeout) is what lets the
                // agent self-correct. Same contract as the 11 original tools.
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            error: `Failed to update settings: ${err.message}`,
                        }),
                    }],
                    isError: true,
                };
            }
        },
    );

    return { ensureToken, getTokenState: tokenMgr.getTokenState, setTokenState: tokenMgr.setTokenState };
};
