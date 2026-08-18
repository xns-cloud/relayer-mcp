'use strict';

const { z } = require('zod');
const { createHttpClient } = require('../lib/httpClient');
const { createTokenManager } = require('../lib/ensureToken');

const RELAYER_UI_BASE = 'http://localhost:8888';

// Selective-restore component keys accepted by relayer-ui Backup.restore
// (server/api/v1/Backup.js shouldRestore switch). Omitting components
// restores everything in the archive.
const COMPONENTS = ['db', 'conf', 'hostio', 'samba'];

/**
 * Tool 15: manage_backups
 * One verb, four actions over relayer-ui's backup API:
 *   list    -> GET    /api/v1/backup/list
 *   start   -> PUT    /api/v1/backup/start   (server runs a disk preflight)
 *   restore -> PUT    /api/v1/backup/restore { file, components? }
 *   delete  -> DELETE /api/v1/backup/remove  { file }
 * Single tool by design — backups are a small closed verb set and each extra
 * tool definition is per-turn context weight for every agent session.
 */
module.exports = function registerManageBackups(server, options = {}) {
    const http = options.httpClient || createHttpClient(options);
    const relayerUiBase = options.relayerUiBase || RELAYER_UI_BASE;

    const tokenMgr = createTokenManager(options);
    const { ensureToken } = tokenMgr;

    server.registerTool(
        'manage_backups',
        {
            title: 'manage_backups',
            description: 'Manage Relayer configuration backups: list archives, start a backup, restore from an archive, or delete one. Restore OVERWRITES current state and restarts services — always confirm with the operator and state which archive and components first. Backups must be enabled (BACKUP_ENABLED) for list/start.',
            inputSchema: {
                action: z.enum(['list', 'start', 'restore', 'delete'])
                    .describe('Backup operation to perform.'),
                file: z.string().optional()
                    .describe('Archive file name from list (e.g. "1718000000000.zip"). Required for restore and delete.'),
                components: z.array(z.enum(COMPONENTS)).optional()
                    .describe('Restore only these components (db, conf, hostio, samba). Omit to restore everything.'),
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                openWorldHint: true,
            },
        },
        async ({ action, file, components }) => {
            try {
                if ((action === 'restore' || action === 'delete') && !file) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: `Action "${action}" requires a file name. Call manage_backups with action "list" to see available archives.`,
                            }),
                        }],
                        isError: true,
                    };
                }

                let token = await ensureToken();

                const send = async (tok) => {
                    const headers = { keycloaktoken: tok };
                    switch (action) {
                        case 'list':
                            return http.get(`${relayerUiBase}/api/v1/backup/list`, { headers });
                        case 'start':
                            return http.put(`${relayerUiBase}/api/v1/backup/start`, {}, { headers });
                        case 'restore':
                            return http.put(
                                `${relayerUiBase}/api/v1/backup/restore`,
                                components && components.length > 0 ? { file, components } : { file },
                                { headers },
                            );
                        case 'delete':
                        default:
                            return http.del(`${relayerUiBase}/api/v1/backup/remove`, { headers, data: { file } });
                    }
                };

                let { status, data } = await send(token);
                if (status === 401) {
                    token = await tokenMgr.reauth();
                    ({ status, data } = await send(token));
                }

                if (status >= 400 || data?.success === false) {
                    const detail = data?.message || data?.error || `HTTP ${status}`;
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                action,
                                // Backups-disabled is a state, not a fault — route the
                                // agent to the fix instead of a dead end.
                                error: data?.disabled
                                    ? 'Backups are disabled. Enable them with update_settings {"BACKUP_ENABLED": true} first.'
                                    : `Backup ${action} failed: ${detail}`,
                            }, null, 2),
                        }],
                        isError: true,
                    };
                }

                const result = { success: true, action };
                if (action === 'list') {
                    result.files = (data?.files || []).map((f) => ({
                        name: f.name,
                        size: f.stats?.size,
                        created: f.stats?.mtime || f.stats?.ctime,
                    }));
                    result.message = result.files.length
                        ? 'Backup archives listed. Use the name field for restore/delete.'
                        : 'No backup archives found yet. Use action "start" to create one.';
                } else if (action === 'start') {
                    result.message = 'Backup started. It appears in the list when finished.';
                } else if (action === 'restore') {
                    result.message = 'Restore initiated — services restart as part of the restore. Verify recovery with check_relayer_health.';
                } else {
                    result.file = file;
                    result.message = 'Backup archive deleted.';
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
                            error: `Backup ${action} failed: ${err.message}`,
                        }),
                    }],
                    isError: true,
                };
            }
        },
    );

    return { ensureToken, getTokenState: tokenMgr.getTokenState, setTokenState: tokenMgr.setTokenState };
};
