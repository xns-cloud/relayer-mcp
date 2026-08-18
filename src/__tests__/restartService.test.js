'use strict';

function createIsolatedTokenState(initial = null) {
    let state = initial;
    return { get: () => state, set: (s) => { state = s; }, clear: () => { state = null; } };
}

describe('restart_service', () => {
    let server;

    beforeEach(() => {
        server = { registerTool: jest.fn() };
    });

    function registerWithOptions(opts) {
        const register = require('../tools/restartService');
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

    test('named service → GET /api/v1/system/restart/:service', async () => {
        const getMock = jest.fn().mockResolvedValue({
            status: 200, data: { success: 'serviceRestart', service: 'hostio' },
        });
        registerWithOptions({ httpClient: { get: getMock, post: jest.fn() } });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        const result = await handler({ service: 'hostio' });
        const parsed = JSON.parse(result.content[0].text);

        expect(getMock.mock.calls[0][0]).toContain('/api/v1/system/restart/hostio');
        expect(parsed.success).toBe(true);
        expect(parsed.service).toBe('hostio');
        expect(parsed.message).toContain('check_relayer_health');
    });

    test('omitted/all service → GET /api/v1/system/restart with no suffix', async () => {
        const getMock = jest.fn().mockResolvedValue({
            status: 200, data: { success: 'serviceRestart', service: 'all' },
        });
        registerWithOptions({ httpClient: { get: getMock, post: jest.fn() } });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        await handler({});
        await handler({ service: 'all' });

        for (const [url] of getMock.mock.calls) {
            expect(url).toMatch(/\/api\/v1\/system\/restart$/);
        }
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
                        : { status: 200, data: { success: 'serviceRestart', service: 'gateway' } };
                }),
                post: jest.fn(),
            },
        });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        const parsed = JSON.parse((await handler({ service: 'gateway' })).content[0].text);

        expect(parsed.success).toBe(true);
        expect(acquireMock).toHaveBeenCalled();
    });

    test('HTTP failure → isError', async () => {
        registerWithOptions({
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 500, data: { message: 'boom' } }),
                post: jest.fn(),
            },
        });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        const result = await handler({ service: 's3gateway' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(result.isError).toBe(true);
    });

    test('description warns the operation is disruptive', () => {
        registerWithOptions({ httpClient: { get: jest.fn(), post: jest.fn() } });
        const { readRegistration } = require('./helpers/mockRegistration');
        const { description } = readRegistration(server);
        expect(description).toMatch(/disruptive/i);
        expect(description).toContain('confirm');
    });
});
