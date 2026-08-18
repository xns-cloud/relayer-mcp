'use strict';

const { ALLOWED_SETTINGS } = require('../lib/allowedSettings');

function createIsolatedTokenState(initial = null) {
    let state = initial;
    return { get: () => state, set: (s) => { state = s; }, clear: () => { state = null; } };
}

const CONFIG_RESPONSE = {
    current: {
        CostCenter: 'cc-12345',
        HostIO: {
            HOSTIO_UPLOAD_WORKERS: 10,
            HOSTIO_SIMULTANEOUS_UPLOADS: 200,
        },
        Backup: {
            BACKUP_ENABLED: true,
            BACKUP_FREQUENCY: 60,
        },
        S3Gateway: {
            S3GW_CREDENTIAL_ENCRYPTION_KEY: 'super-secret-key-material',
        },
    },
    defaults: {
        HostIO: {
            HOSTIO_UPLOAD_WORKERS: { name: 'HOSTIO_UPLOAD_WORKERS', default: 10, type: 'Number' },
            HOSTIO_SIMULTANEOUS_UPLOADS: { name: 'HOSTIO_SIMULTANEOUS_UPLOADS', default: 571, type: 'Number' },
        },
        Backup: {
            BACKUP_ENABLED: { name: 'BACKUP_ENABLED', default: true, type: 'Boolean' },
        },
    },
    database: { host: 'localhost', password: '[REDACTED]' },
    uploadTuning: { status: 'tuned', ceiling: 571 },
};

describe('describe_settings', () => {
    let server;

    beforeEach(() => {
        server = { registerTool: jest.fn() };
    });

    function registerWithOptions(opts) {
        const register = require('../tools/describeSettings');
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

    test('returns the full whitelist with current values, defaults, and notes', async () => {
        registerWithOptions({
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 200, data: CONFIG_RESPONSE }),
                post: jest.fn(),
            },
        });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.settings).toHaveLength(Object.keys(ALLOWED_SETTINGS).length);

        const workers = parsed.settings.find((s) => s.name === 'HOSTIO_UPLOAD_WORKERS');
        expect(workers).toMatchObject({ group: 'HostIO', current: 10, default: 10, type: 'Number' });
        expect(workers.note).toMatch(/restart/i);

        const cc = parsed.settings.find((s) => s.name === 'CostCenter');
        expect(cc.current).toBe('cc-12345');
        expect(cc.note).toMatch(/billed/i);
    });

    test('never exposes non-whitelist settings or their values', async () => {
        registerWithOptions({
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 200, data: CONFIG_RESPONSE }),
                post: jest.fn(),
            },
        });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        const result = await handler({});

        expect(result.content[0].text).not.toContain('S3GW_CREDENTIAL_ENCRYPTION_KEY');
        expect(result.content[0].text).not.toContain('super-secret-key-material');
        expect(result.content[0].text).not.toContain('[REDACTED]');
    });

    test('passes uploadTuning through (the ceiling that caps SIMULTANEOUS_UPLOADS)', async () => {
        registerWithOptions({
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 200, data: CONFIG_RESPONSE }),
                post: jest.fn(),
            },
        });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        const parsed = JSON.parse((await handler({})).content[0].text);
        expect(parsed.uploadTuning).toEqual({ status: 'tuned', ceiling: 571 });
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
                        : { status: 200, data: CONFIG_RESPONSE };
                }),
                post: jest.fn(),
            },
        });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        const parsed = JSON.parse((await handler({})).content[0].text);

        expect(parsed.success).toBe(true);
        expect(acquireMock).toHaveBeenCalled();
    });

    test('config read failure → isError', async () => {
        registerWithOptions({
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 500, data: {} }),
                post: jest.fn(),
            },
        });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(result.isError).toBe(true);
    });
});
