'use strict';

const { createHttpClient } = require('../lib/httpClient');
const { createTokenManager } = require('../lib/ensureToken');
const { ALLOWED_SETTINGS } = require('../lib/allowedSettings');

const RELAYER_UI_BASE = 'http://localhost:8888';

/**
 * Tool 12: describe_settings
 * Curated runtime catalog — the MCP exposes only the whitelist in
 * allowedSettings.js, never the full ~74-key advanced catalog (Ken,
 * 2026-06-11). Current values + defaults come from GET /api/v1/config
 * (relayer-ui Config.readConfig: { current, defaults, uploadTuning, ... }).
 */
module.exports = function registerDescribeSettings(server, options = {}) {
    const http = options.httpClient || createHttpClient(options);
    const relayerUiBase = options.relayerUiBase || RELAYER_UI_BASE;

    const tokenMgr = createTokenManager(options);
    const { ensureToken } = tokenMgr;

    server.registerTool(
        'describe_settings',
        {
            title: 'describe_settings',
            description: 'List the adjustable Relayer settings: worker/concurrency tuning, backup schedule, and cost center (CCID). Returns current value, default, type, and guidance per setting. Use before update_settings. Requires OIDC sign-in (same session as the other tools).',
            inputSchema: {
                /* no parameters — the whitelist is small by design */
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
                    `${relayerUiBase}/api/v1/config`,
                    { headers: { keycloaktoken: token } },
                );

                if (status === 401) {
                    token = await tokenMgr.reauth();
                    const retry = await http.get(
                        `${relayerUiBase}/api/v1/config`,
                        { headers: { keycloaktoken: token } },
                    );
                    status = retry.status;
                    data = retry.data;
                }

                if (status >= 400) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: `Failed to read Relayer configuration (HTTP ${status}).`,
                            }),
                        }],
                        isError: true,
                    };
                }

                const current = data?.current || {};
                const defaults = data?.defaults || {};

                const settings = Object.entries(ALLOWED_SETTINGS).map(([name, meta]) => {
                    const currentValue = meta.group
                        ? current[meta.group]?.[name]
                        : current[name];
                    const catalogEntry = meta.group ? defaults[meta.group]?.[name] : null;
                    return {
                        name,
                        group: meta.group || 'General',
                        current: currentValue,
                        default: catalogEntry ? catalogEntry.default : null,
                        type: meta.type,
                        note: meta.note,
                    };
                });

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: true,
                            settings,
                            // uploadTuning: 'calculating' until a speedtest lands;
                            // 'tuned' carries the resource-aware concurrency ceiling
                            // that caps HOSTIO_SIMULTANEOUS_UPLOADS.
                            uploadTuning: data.uploadTuning ?? null,
                            message: 'These are the only settings adjustable through this MCP. Apply changes with update_settings; most need restart_service afterwards. Changing CostCenter changes who is billed — always confirm with the operator first.',
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            error: `Failed to describe settings: ${err.message}`,
                        }),
                    }],
                    isError: true,
                };
            }
        },
    );

    return { ensureToken, getTokenState: tokenMgr.getTokenState, setTokenState: tokenMgr.setTokenState };
};
