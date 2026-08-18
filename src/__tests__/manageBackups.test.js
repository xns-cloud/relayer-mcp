'use strict';

function createIsolatedTokenState(initial = null) {
    let state = initial;
    return { get: () => state, set: (s) => { state = s; }, clear: () => { state = null; } };
}

describe('manage_backups', () => {
    let server;

    beforeEach(() => {
        server = { registerTool: jest.fn() };
    });

    function registerWithOptions(opts) {
        const register = require('../tools/manageBackups');
        const tokenStateMod = createIsolatedTokenState({
            access_token: 'valid-token',
            refresh_token: 'ref',
            expires_at: Date.now() + 300000,
        });
        return register(server, {
            _tokenStateModule: tokenStateMod,
            acquireToken: jest.fn().mockResolvedValue({
                access_token: 'new-token', refresh_token: 'ref', expires_at: Date.now() + 300000,
            }),
            refreshToken: jest.fn(),
            ...opts,
        });
    }

    test('list → GET /api/v1/backup/list, maps name/size/created', async () => {
        const getMock = jest.fn().mockResolvedValue({
            status: 200,
            data: {
                success: true,
                files: [{ name: '1718000000000.zip', stats: { size: 2048, mtime: '2026-06-11T00:00:00Z' } }],
            },
        });
        registerWithOptions({ httpClient: { get: getMock, put: jest.fn(), del: jest.fn(), post: jest.fn() } });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        const parsed = JSON.parse((await handler({ action: 'list' })).content[0].text);

        expect(getMock.mock.calls[0][0]).toContain('/api/v1/backup/list');
        expect(parsed.success).toBe(true);
        expect(parsed.files).toEqual([
            { name: '1718000000000.zip', size: 2048, created: '2026-06-11T00:00:00Z' },
        ]);
    });

    test('backups disabled → routes the agent to update_settings, isError', async () => {
        registerWithOptions({
            httpClient: {
                get: jest.fn().mockResolvedValue({
                    status: 200,
                    data: { success: false, disabled: true, message: 'Backups currently disabled' },
                }),
                put: jest.fn(), del: jest.fn(), post: jest.fn(),
            },
        });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        const result = await handler({ action: 'list' });
        const parsed = JSON.parse(result.content[0].text);

        expect(result.isError).toBe(true);
        expect(parsed.error).toContain('BACKUP_ENABLED');
    });

    test('start → PUT /api/v1/backup/start', async () => {
        const putMock = jest.fn().mockResolvedValue({ status: 200, data: { success: true } });
        registerWithOptions({ httpClient: { get: jest.fn(), put: putMock, del: jest.fn(), post: jest.fn() } });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        const parsed = JSON.parse((await handler({ action: 'start' })).content[0].text);

        expect(putMock.mock.calls[0][0]).toContain('/api/v1/backup/start');
        expect(parsed.success).toBe(true);
    });

    test('restore without file → isError, no HTTP call', async () => {
        const http = { get: jest.fn(), put: jest.fn(), del: jest.fn(), post: jest.fn() };
        registerWithOptions({ httpClient: http });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        const result = await handler({ action: 'restore' });
        const parsed = JSON.parse(result.content[0].text);

        expect(result.isError).toBe(true);
        expect(parsed.error).toContain('requires a file name');
        expect(http.put).not.toHaveBeenCalled();
    });

    test('restore with components → PUT body {file, components}', async () => {
        const putMock = jest.fn().mockResolvedValue({ status: 200, data: { success: true } });
        registerWithOptions({ httpClient: { get: jest.fn(), put: putMock, del: jest.fn(), post: jest.fn() } });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        const parsed = JSON.parse((await handler({
            action: 'restore', file: 'b.zip', components: ['conf', 'samba'],
        })).content[0].text);

        const [url, body] = putMock.mock.calls[0];
        expect(url).toContain('/api/v1/backup/restore');
        expect(body).toEqual({ file: 'b.zip', components: ['conf', 'samba'] });
        expect(parsed.message).toContain('check_relayer_health');
    });

    test('restore without components → body {file} only (full restore)', async () => {
        const putMock = jest.fn().mockResolvedValue({ status: 200, data: { success: true } });
        registerWithOptions({ httpClient: { get: jest.fn(), put: putMock, del: jest.fn(), post: jest.fn() } });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        await handler({ action: 'restore', file: 'b.zip' });

        expect(putMock.mock.calls[0][1]).toEqual({ file: 'b.zip' });
    });

    test('delete → DELETE /api/v1/backup/remove with {file} body', async () => {
        const delMock = jest.fn().mockResolvedValue({ status: 200, data: { success: true } });
        registerWithOptions({ httpClient: { get: jest.fn(), put: jest.fn(), del: delMock, post: jest.fn() } });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        const parsed = JSON.parse((await handler({ action: 'delete', file: 'old.zip' })).content[0].text);

        const [url, config] = delMock.mock.calls[0];
        expect(url).toContain('/api/v1/backup/remove');
        expect(config.data).toEqual({ file: 'old.zip' });
        expect(parsed.success).toBe(true);
        expect(parsed.file).toBe('old.zip');
    });

    test('401 → re-auth and retry', async () => {
        let calls = 0;
        const acquireMock = jest.fn().mockResolvedValue({
            access_token: 'fresh', refresh_token: 'ref', expires_at: Date.now() + 300000,
        });
        registerWithOptions({
            acquireToken: acquireMock,
            httpClient: {
                get: jest.fn().mockImplementation(async () => {
                    calls++;
                    return calls === 1
                        ? { status: 401, data: {} }
                        : { status: 200, data: { success: true, files: [] } };
                }),
                put: jest.fn(), del: jest.fn(), post: jest.fn(),
            },
        });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        const parsed = JSON.parse((await handler({ action: 'list' })).content[0].text);

        expect(parsed.success).toBe(true);
        expect(acquireMock).toHaveBeenCalled();
    });

    test('description warns restore is destructive', () => {
        registerWithOptions({ httpClient: { get: jest.fn(), put: jest.fn(), del: jest.fn(), post: jest.fn() } });
        const { readRegistration } = require('./helpers/mockRegistration');
        const { description } = readRegistration(server);
        expect(description).toMatch(/OVERWRITES/);
        expect(description).toContain('confirm');
    });
});
