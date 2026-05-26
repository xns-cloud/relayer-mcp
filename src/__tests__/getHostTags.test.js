'use strict';

function createIsolatedTokenState(initial = null) {
    let state = initial;
    return { get: () => state, set: (s) => { state = s; }, clear: () => { state = null; } };
}

describe('get_host_tags', () => {
    let server;

    beforeEach(() => {
        server = { tool: jest.fn() };
    });

    function registerWithOptions(opts) {
        const register = require('../tools/getHostTags');
        const tokenStateMod = createIsolatedTokenState(opts._tokenState ?? null);
        return register(server, {
            _tokenStateModule: tokenStateMod,
            ...opts,
        });
    }

    // TP-22: no token → triggers OIDC re-auth path (not silent failure)
    test('no token → triggers OIDC acquireToken', async () => {
        const acquireMock = jest.fn().mockResolvedValue({
            access_token: 'new-token',
            refresh_token: 'ref-token',
            expires_at: Date.now() + 300000,
        });

        registerWithOptions({
            acquireToken: acquireMock,
            refreshToken: jest.fn(),
            httpClient: {
                get: jest.fn().mockResolvedValue({
                    status: 200,
                    data: { tags: ['us-east', 'eu-west'] },
                }),
                post: jest.fn(),
            },
        });

        const handler = server.tool.mock.calls[0][3];
        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(acquireMock).toHaveBeenCalled();
        expect(parsed.success).toBe(true);
        expect(parsed.tags).toEqual(['us-east', 'eu-west']);
    });

    // TP-22: 401 → re-auth then retry (not silent failure)
    test('401 → re-auth and retry', async () => {
        let callCount = 0;
        const acquireMock = jest.fn().mockResolvedValue({
            access_token: 'fresh-token',
            refresh_token: 'ref-token',
            expires_at: Date.now() + 300000,
        });

        registerWithOptions({
            _tokenState: {
                access_token: 'expired-token',
                refresh_token: 'ref-token',
                expires_at: Date.now() + 300000,
            },
            acquireToken: acquireMock,
            refreshToken: jest.fn().mockRejectedValue(new Error('refresh failed')),
            httpClient: {
                get: jest.fn().mockImplementation(async () => {
                    callCount++;
                    if (callCount === 1) return { status: 401, data: {} };
                    return { status: 200, data: { tags: ['tag1'] } };
                }),
                post: jest.fn(),
            },
        });

        const handler = server.tool.mock.calls[0][3];
        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(acquireMock).toHaveBeenCalled();
    });

    // TP-24: with valid token → proxy call succeeds
    test('valid token → returns tags', async () => {
        registerWithOptions({
            _tokenState: {
                access_token: 'valid-token',
                refresh_token: 'ref-token',
                expires_at: Date.now() + 300000,
            },
            acquireToken: jest.fn(),
            refreshToken: jest.fn(),
            httpClient: {
                get: jest.fn().mockResolvedValue({
                    status: 200,
                    data: { tags: ['us-east', 'eu-west', 'asia'] },
                }),
                post: jest.fn(),
            },
        });

        const handler = server.tool.mock.calls[0][3];
        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.tags).toEqual(['us-east', 'eu-west', 'asia']);
        expect(parsed.message).toContain('plain-language');
    });

    // Double 401 → auth failed after re-auth
    test('double 401 → auth failure error', async () => {
        registerWithOptions({
            _tokenState: null,
            acquireToken: jest.fn().mockResolvedValue({
                access_token: 'bad-token',
                refresh_token: 'ref',
                expires_at: Date.now() + 300000,
            }),
            refreshToken: jest.fn(),
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 401, data: {} }),
                post: jest.fn(),
            },
        });

        const handler = server.tool.mock.calls[0][3];
        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.error).toContain('Authentication failed');
        expect(result.isError).toBe(true);
    });

    // Tool description check
    test('description mentions CEL and plain language', () => {
        registerWithOptions({
            acquireToken: jest.fn(),
            refreshToken: jest.fn(),
            httpClient: { get: jest.fn(), post: jest.fn() },
        });

        const description = server.tool.mock.calls[0][1];
        expect(description).toContain('CEL');
        expect(description).toContain('plain-language');
    });
});
