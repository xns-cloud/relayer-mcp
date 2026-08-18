'use strict';

function createIsolatedTokenState(initial = null) {
    let state = initial;
    return { get: () => state, set: (s) => { state = s; }, clear: () => { state = null; } };
}

const CONFIG_RESPONSE = {
    current: {
        CostCenter: 'cc-old',
        General: { GENERAL_AUTOSTART: true },
        HostIO: { HOSTIO_UPLOAD_WORKERS: 10, HOSTIO_SIMULTANEOUS_UPLOADS: 200 },
        Backup: { BACKUP_ENABLED: true, BACKUP_FREQUENCY: 60 },
    },
    defaults: {},
    database: { host: 'localhost', port: 5432, user: 'xns', password: '[REDACTED]', dbname: 'relayer' },
};

describe('update_settings', () => {
    let server;

    beforeEach(() => {
        server = { registerTool: jest.fn() };
    });

    function registerWithOptions(opts) {
        const register = require('../tools/updateSettings');
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

    function happyClient(putResponse = { status: 200, data: { success: true, requireRestart: true } }) {
        return {
            get: jest.fn().mockResolvedValue({ status: 200, data: CONFIG_RESPONSE }),
            put: jest.fn().mockResolvedValue(putResponse),
            post: jest.fn(),
        };
    }

    test('merges accepted keys into the right config groups and PUTs the full config', async () => {
        const http = happyClient();
        registerWithOptions({ httpClient: http });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        const result = await handler({
            settings: { HOSTIO_UPLOAD_WORKERS: 12, BACKUP_FREQUENCY: 30, CostCenter: 'cc-new' },
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.require_restart).toBe(true);
        expect(parsed.applied).toEqual({
            HOSTIO_UPLOAD_WORKERS: 12, BACKUP_FREQUENCY: 30, CostCenter: 'cc-new',
        });

        const [url, body] = http.put.mock.calls[0];
        expect(url).toContain('/api/v1/config');
        expect(body.config.HostIO.HOSTIO_UPLOAD_WORKERS).toBe(12);
        expect(body.config.Backup.BACKUP_FREQUENCY).toBe(30);
        expect(body.config.CostCenter).toBe('cc-new'); // top-level key
        // Untouched groups/values round-trip intact (full-file PUT contract)
        expect(body.config.General.GENERAL_AUTOSTART).toBe(true);
        expect(body.config.HostIO.HOSTIO_SIMULTANEOUS_UPLOADS).toBe(200);
    });

    test('database round-trips as received — server-side guard owns the [REDACTED] sentinel', async () => {
        const http = happyClient();
        registerWithOptions({ httpClient: http });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        await handler({ settings: { HOSTIO_UPLOAD_WORKERS: 12 } });

        const [, body] = http.put.mock.calls[0];
        expect(body.database).toEqual(CONFIG_RESPONSE.database);
    });

    test('unknown key → rejected with nearest-name suggestion, no PUT when nothing accepted', async () => {
        const http = happyClient();
        registerWithOptions({ httpClient: http });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        const result = await handler({ settings: { HOSTIO_UPLOD_WORKERS: 5 } });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(result.isError).toBe(true);
        expect(parsed.rejected[0].key).toBe('HOSTIO_UPLOD_WORKERS');
        expect(parsed.rejected[0].reason).toContain('HOSTIO_UPLOAD_WORKERS');
        expect(parsed.allowed_settings).toContain('BACKUP_ENABLED');
        expect(http.put).not.toHaveBeenCalled();
        expect(http.get).not.toHaveBeenCalled();
    });

    test('non-whitelist (protected) key → rejected, never written', async () => {
        const http = happyClient();
        registerWithOptions({ httpClient: http });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        const result = await handler({ settings: { S3GW_CREDENTIAL_ENCRYPTION_KEY: 'x' } });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(http.put).not.toHaveBeenCalled();
    });

    test('type mismatch → rejected with expected type', async () => {
        const http = happyClient();
        registerWithOptions({ httpClient: http });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        const result = await handler({
            settings: { HOSTIO_UPLOAD_WORKERS: 'ten', BACKUP_ENABLED: false },
        });
        const parsed = JSON.parse(result.content[0].text);

        // The valid key still applies; the bad one is rejected with the reason.
        expect(parsed.success).toBe(true);
        expect(parsed.applied).toEqual({ BACKUP_ENABLED: false });
        expect(parsed.rejected[0]).toMatchObject({ key: 'HOSTIO_UPLOAD_WORKERS' });
        expect(parsed.rejected[0].reason).toContain('number');
    });

    test('server-side rejection (upload ceiling) passes the message through', async () => {
        const http = happyClient({
            status: 200,
            data: { success: false, message: 'HOSTIO_SIMULTANEOUS_UPLOADS exceeds the resource-aware ceiling of 571' },
        });
        registerWithOptions({ httpClient: http });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        const result = await handler({ settings: { HOSTIO_SIMULTANEOUS_UPLOADS: 99999 } });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(result.isError).toBe(true);
        expect(parsed.error).toContain('ceiling of 571');
    });

    test('401 on read → re-auth and retry', async () => {
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
                        : { status: 200, data: CONFIG_RESPONSE };
                }),
                put: jest.fn().mockResolvedValue({ status: 200, data: { success: true, requireRestart: true } }),
                post: jest.fn(),
            },
        });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        const parsed = JSON.parse((await handler({ settings: { BACKUP_ENABLED: false } })).content[0].text);

        expect(parsed.success).toBe(true);
        expect(acquireMock).toHaveBeenCalled();
    });

    test('malformed read (missing database section) → abort, no PUT', async () => {
        const http = {
            get: jest.fn().mockResolvedValue({ status: 200, data: { current: { HostIO: {} } } }),
            put: jest.fn(),
            post: jest.fn(),
        };
        registerWithOptions({ httpClient: http });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        const result = await handler({ settings: { BACKUP_ENABLED: false } });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.error).toContain('Nothing was changed');
        expect(http.put).not.toHaveBeenCalled();
    });

    test('read failure → nothing written', async () => {
        const http = {
            get: jest.fn().mockResolvedValue({ status: 500, data: {} }),
            put: jest.fn(),
            post: jest.fn(),
        };
        registerWithOptions({ httpClient: http });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        const result = await handler({ settings: { BACKUP_ENABLED: false } });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.error).toContain('Nothing was changed');
        expect(http.put).not.toHaveBeenCalled();
    });
});
