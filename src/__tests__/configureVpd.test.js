'use strict';

function createIsolatedTokenState(initial = null) {
    let state = initial;
    return { get: () => state, set: (s) => { state = s; }, clear: () => { state = null; } };
}

describe('configure_vpd', () => {
    let server;

    beforeEach(() => {
        server = { registerTool: jest.fn() };
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

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
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

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
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

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
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

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        const result = await handler({ data_expression: 'true', parity_expression: 'true' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(acquireMock).toHaveBeenCalled();
    });

    // TP-26: CEL expression shapes — wire keys are HOSTIO's {data, parity}
    // (hostio/types.go SetExpressionsRequest). The <=0.5.2 payload
    // {data_expression, parity_expression} decoded as ""/"" and HOSTIO's fix()
    // silently applied the all-hosts default. This test would pass with that
    // regression reverted ONLY if the keys drift back — keep it pinned.
    test('passes CEL expressions to the proxy endpoint with {data, parity} wire keys', async () => {
        const postMock = jest.fn().mockResolvedValue({ status: 200, data: {} });

        registerWithOptions({
            httpClient: { post: postMock, get: jest.fn() },
        });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        await handler({
            data_expression: '"region" == "us-east"',
            parity_expression: '"region" == "eu-west"',
        });

        const [url, body] = postMock.mock.calls[0];
        expect(url).toContain('setexpressions');
        expect(body.data).toBe('"region" == "us-east"');
        expect(body.parity).toBe('"region" == "eu-west"');
        expect(body.data_expression).toBeUndefined();
        expect(body.parity_expression).toBeUndefined();
    });

    // Path contract: the proxy prepends /v1/hostio/ to the wildcard. The
    // <=0.5.2 URL carried the prefix itself → /v1/hostio/v1/hostio/... → 404.
    test('proxy URL carries no /v1/hostio/ double prefix', async () => {
        const postMock = jest.fn().mockResolvedValue({ status: 200, data: {} });

        registerWithOptions({
            httpClient: { post: postMock, get: jest.fn() },
        });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        await handler({ data_expression: 'true', parity_expression: 'true' });

        const [url] = postMock.mock.calls[0];
        expect(url).toContain('/api/v1/proxy/hostio/setexpressions');
        expect(url).not.toContain('/proxy/hostio/v1/hostio/');
    });

    // Proxy failure wrap: HTTP 200 {success:false, state} must not read as success.
    test('proxy-wrapped failure → isError with guidance, never success', async () => {
        registerWithOptions({
            httpClient: {
                post: jest.fn().mockResolvedValue({
                    status: 200,
                    data: { success: false, state: 'Request failed with status code 500' },
                }),
                get: jest.fn(),
            },
        });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        const result = await handler({ data_expression: 'true', parity_expression: 'true' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(result.isError).toBe(true);
        expect(parsed.message).toContain('10 data');
    });

    // dry_run on a Relayer with the evaluate endpoint → counts, nothing applied
    test('dry_run → evaluate endpoint, returns matched counts', async () => {
        const postMock = jest.fn().mockResolvedValue({
            status: 200,
            data: {
                data: { matched: ['pk1', 'pk2', 'pk3'], count: 3 },
                parity: { matched: ['pk1', 'pk2'], count: 2 },
            },
        });

        registerWithOptions({
            httpClient: { post: postMock, get: jest.fn() },
        });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        const result = await handler({
            data_expression: '"region" == "us-east"',
            parity_expression: 'true',
            dry_run: true,
        });
        const parsed = JSON.parse(result.content[0].text);

        const [url] = postMock.mock.calls[0];
        expect(url).toContain('/api/v1/proxy/hostio/evaluate');
        expect(parsed.success).toBe(true);
        expect(parsed.preview).toBe(true);
        expect(parsed.matched_data_hosts).toBe(3);
        expect(parsed.matched_parity_hosts).toBe(2);
        // Counts only — matched pubkey arrays must not flood the context.
        expect(result.content[0].text).not.toContain('pk1');
    });

    // dry_run against a pre-evaluate Relayer: proxy wraps HOSTIO 404 as
    // {success:false, state:'...404'} → graceful not-supported, NOT an error.
    test('dry_run on pre-evaluate Relayer → preview_supported false, no isError', async () => {
        registerWithOptions({
            httpClient: {
                post: jest.fn().mockResolvedValue({
                    status: 200,
                    data: { success: false, state: 'Request failed with status code 404' },
                }),
                get: jest.fn(),
            },
        });

        const { readRegistration } = require('./helpers/mockRegistration');
        const handler = readRegistration(server).handler;
        const result = await handler({
            data_expression: 'true',
            parity_expression: 'true',
            dry_run: true,
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.preview_supported).toBe(false);
        expect(parsed.message).toContain('does not support VPD preview');
        expect(result.isError).toBeUndefined();
    });
});
