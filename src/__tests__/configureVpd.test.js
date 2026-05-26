'use strict';

function createIsolatedTokenState(initial = null) {
    let state = initial;
    return { get: () => state, set: (s) => { state = s; }, clear: () => { state = null; } };
}

describe('configure_vpd', () => {
    let server;

    beforeEach(() => {
        server = { tool: jest.fn() };
    });

    function registerWithOptions(opts) {
        const register = require('../tools/configureVpd');
        const defaultToken = opts._tokenState !== undefined ? opts._tokenState : {
            access_token: 'valid-token',
            refresh_token: 'ref-token',
            expires_at: Date.now() + 300000,
        };
        const tokenStateMod = createIsolatedTokenState(defaultToken);
        return register(server, {
            _tokenStateModule: tokenStateMod,
            acquireToken: jest.fn().mockResolvedValue({
                access_token: 'new-token',
                refresh_token: 'ref',
                expires_at: Date.now() + 300000,
            }),
            refreshToken: jest.fn(),
            ...opts,
        });
    }

    // AC-19: defaults → "true","true"
    test('defaults → success with data_expression and parity_expression', async () => {
        registerWithOptions({
            httpClient: {
                post: jest.fn().mockResolvedValue({ status: 200, data: {} }),
                get: jest.fn(),
            },
        });

        const handler = server.tool.mock.calls[0][3];
        const result = await handler({ data_expression: 'true', parity_expression: 'true' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.data_expression).toBe('true');
        expect(parsed.parity_expression).toBe('true');
    });

    // AC-18: 400 too-few-hosts → re-ask naming 10/20 threshold
    test('400 too-few-hosts → names 10/20 threshold', async () => {
        registerWithOptions({
            httpClient: {
                post: jest.fn().mockResolvedValue({
                    status: 400,
                    data: { message: 'too few hosts match the expression' },
                }),
                get: jest.fn(),
            },
        });

        const handler = server.tool.mock.calls[0][3];
        const result = await handler({
            data_expression: '"region" == "antarctica"',
            parity_expression: '"region" == "antarctica"',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.too_few_hosts).toBe(true);
        expect(parsed.min_data_hosts).toBe(10);
        expect(parsed.min_parity_hosts).toBe(20);
        expect(parsed.message).toContain('10 data hosts');
        expect(parsed.message).toContain('20 parity hosts');
    });

    // TP-25: invalid CEL → error
    test('400 invalid CEL → error mentioning syntax', async () => {
        registerWithOptions({
            httpClient: {
                post: jest.fn().mockResolvedValue({
                    status: 400,
                    data: { message: 'invalid CEL syntax' },
                }),
                get: jest.fn(),
            },
        });

        const handler = server.tool.mock.calls[0][3];
        const result = await handler({
            data_expression: 'bad syntax {{',
            parity_expression: 'true',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.error).toContain('CEL');
        expect(result.isError).toBe(true);
    });

    // TP-23: 401 → re-auth (not silent failure)
    test('401 → triggers re-auth', async () => {
        let callCount = 0;
        const acquireMock = jest.fn().mockResolvedValue({
            access_token: 'fresh-token',
            refresh_token: 'ref',
            expires_at: Date.now() + 300000,
        });

        registerWithOptions({
            _tokenState: {
                access_token: 'expired-token',
                refresh_token: 'ref',
                expires_at: Date.now() + 300000,
            },
            acquireToken: acquireMock,
            httpClient: {
                post: jest.fn().mockImplementation(async () => {
                    callCount++;
                    if (callCount === 1) return { status: 401, data: {} };
                    return { status: 200, data: {} };
                }),
                get: jest.fn(),
            },
        });

        const handler = server.tool.mock.calls[0][3];
        const result = await handler({ data_expression: 'true', parity_expression: 'true' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(acquireMock).toHaveBeenCalled();
    });

    // TP-26: CEL expression shapes
    test('passes CEL expressions to the proxy endpoint', async () => {
        const postMock = jest.fn().mockResolvedValue({ status: 200, data: {} });

        registerWithOptions({
            httpClient: { post: postMock, get: jest.fn() },
        });

        const handler = server.tool.mock.calls[0][3];
        await handler({
            data_expression: '"region" == "us-east"',
            parity_expression: '"region" == "eu-west"',
        });

        const [url, body] = postMock.mock.calls[0];
        expect(url).toContain('setexpressions');
        expect(body.data_expression).toBe('"region" == "us-east"');
        expect(body.parity_expression).toBe('"region" == "eu-west"');
    });
});
