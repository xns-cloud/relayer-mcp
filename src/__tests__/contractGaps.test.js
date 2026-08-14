'use strict';

/**
 * T1 Contract-Gap Tests
 *
 * Tests ONLY for gaps the build agent missed. Focused on data shapes
 * that can occur in production but have no existing test coverage.
 *
 * Gap sources:
 * - checkClaimStatus isError logic (operator-precedence bug on L138)
 * - getHostTags empty tags array (falsy [].length === 0 but array is truthy)
 * - configureVpd string response body from HostIO Go endpoint
 * - keycloaktoken header plumbing for tools 8/9
 * - checkRelayerHealth S3 4xx-as-healthy contract
 */

function createIsolatedTokenState(initial = null) {
    let state = initial;
    return { get: () => state, set: (s) => { state = s; }, clear: () => { state = null; } };
}

describe('T1 Contract-Gap: checkClaimStatus isError logic', () => {
    let server;

    beforeEach(() => {
        server = { tool: jest.fn() };
    });

    function registerWithOptions(opts) {
        const register = require('../tools/checkClaimStatus');
        register(server, {
            pollIntervalMs: 10,
            sleep: jest.fn().mockResolvedValue(undefined),
            ...opts,
        });
        return server.tool.mock.calls[0][3];
    }

    // The expression `!result.continue_polling === false` at checkClaimStatus.js:138
    // has operator precedence issues. `!` binds tighter than `===`.
    // When continue_polling is false: !false === false → true === false → false
    // When continue_polling is undefined: !undefined === false → true === false → false
    // So isError is ALWAYS undefined for non-error results. Verify the 402 path
    // does NOT set isError (it's guidance, not an error).
    test('402 path does not set isError (it is guidance, not an error)', async () => {
        const handler = registerWithOptions({
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 402, data: {} }),
                post: jest.fn(),
            },
        });

        const result = await handler({ claim_id: 'claim-abc', timeout_ms: 5000 });

        // 402 is "add payment method" guidance — should NOT be isError
        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.continue_polling).toBe(false);
    });

    // 404 expired path — isError=true (this is an error state, not guidance).
    // R3-PREC-1 fix corrected the precedence bug so 404 now correctly sets isError.
    test('404 expired path sets isError true', async () => {
        const handler = registerWithOptions({
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 404, data: {} }),
                post: jest.fn(),
            },
        });

        const result = await handler({ claim_id: 'claim-gone', timeout_ms: 5000 });
        const parsed = JSON.parse(result.content[0].text);

        // Verify expired is set
        expect(parsed.expired).toBe(true);
        // 404 is an error — isError should be true after the R3-PREC-1 fix
        expect(result.isError).toBe(true);
    });

    // STATE_3 success path — isError must not be set
    test('STATE_3 success does not set isError', async () => {
        const handler = registerWithOptions({
            httpClient: {
                get: jest.fn().mockResolvedValue({
                    status: 200,
                    data: {
                        state: 'STATE_3',
                        detail: 'Claimed',
                        installation_id: 'inst-456',
                        claimed_at: '2026-05-26T14:00:00Z',
                    },
                }),
                post: jest.fn(),
            },
        });

        const result = await handler({ claim_id: 'claim-ok', timeout_ms: 5000 });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(result.isError).toBeFalsy();
    });
});

describe('T1 Contract-Gap: getHostTags empty tags array', () => {
    let server;

    beforeEach(() => {
        server = { tool: jest.fn() };
    });

    // When HostIO returns { tags: [] } — empty array is truthy in JS,
    // so `data.tags || data || []` should return the empty array.
    // But if the code evaluates `data.tags` as the empty array (truthy),
    // it should be returned directly.
    test('empty tags array returns empty array, not the data object', async () => {
        const register = require('../tools/getHostTags');
        register(server, {
            _tokenStateModule: createIsolatedTokenState({
                access_token: 'valid-token',
                refresh_token: 'ref-token',
                expires_at: Date.now() + 300000,
            }),
            acquireToken: jest.fn(),
            refreshToken: jest.fn(),
            httpClient: {
                get: jest.fn().mockResolvedValue({
                    status: 200,
                    data: { tags: [] },
                }),
                post: jest.fn(),
            },
        });

        const handler = server.tool.mock.calls[0][3];
        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        // The key assertion: tags should be an empty array, not the whole data object
        expect(Array.isArray(parsed.tags)).toBe(true);
        expect(parsed.tags).toEqual([]);
    });
});

describe('T1 Contract-Gap: configureVpd string response body', () => {
    let server;

    beforeEach(() => {
        server = { tool: jest.fn() };
    });

    function registerWithOptions(opts) {
        const register = require('../tools/configureVpd');
        register(server, {
            _tokenStateModule: createIsolatedTokenState({
                access_token: 'valid-token',
                refresh_token: 'ref-token',
                expires_at: Date.now() + 300000,
            }),
            acquireToken: jest.fn().mockResolvedValue({
                access_token: 'new-token',
                refresh_token: 'ref',
                expires_at: Date.now() + 300000,
            }),
            refreshToken: jest.fn(),
            ...opts,
        });
        return server.tool.mock.calls[0][3];
    }

    // HostIO is a Go endpoint that may return a plain string body on 400,
    // not a JSON object. The code has a `typeof data === 'string'` branch.
    test('400 with string body containing "too few" triggers threshold message', async () => {
        registerWithOptions({
            httpClient: {
                post: jest.fn().mockResolvedValue({
                    status: 400,
                    data: 'too few hosts match the expression',
                }),
                get: jest.fn(),
            },
        });

        const handler = server.tool.mock.calls[0][3];
        const result = await handler({
            data_expression: '"region" == "nowhere"',
            parity_expression: '"region" == "nowhere"',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.too_few_hosts).toBe(true);
        expect(parsed.min_data_hosts).toBe(10);
        expect(parsed.min_parity_hosts).toBe(20);
    });

    // 400 with a string body that is NOT too-few-hosts (e.g. bad CEL syntax)
    test('400 with string body for invalid CEL returns error with CEL mention', async () => {
        registerWithOptions({
            httpClient: {
                post: jest.fn().mockResolvedValue({
                    status: 400,
                    data: 'parse error in CEL expression at position 5',
                }),
                get: jest.fn(),
            },
        });

        const handler = server.tool.mock.calls[0][3];
        const result = await handler({
            data_expression: '{{bad',
            parity_expression: 'true',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        // The error message should contain the raw string from the server
        expect(parsed.error).toContain('parse error in CEL');
        expect(result.isError).toBe(true);
    });
});

describe('T1 Contract-Gap: keycloaktoken header plumbing', () => {
    let server;

    beforeEach(() => {
        server = { tool: jest.fn() };
    });

    // Verify getHostTags actually sends the keycloaktoken header
    test('getHostTags sends keycloaktoken header on proxy request', async () => {
        const getMock = jest.fn().mockResolvedValue({
            status: 200,
            data: { tags: ['us-east'] },
        });

        const register = require('../tools/getHostTags');
        register(server, {
            _tokenStateModule: createIsolatedTokenState({
                access_token: 'my-jwt-token',
                refresh_token: 'ref',
                expires_at: Date.now() + 300000,
            }),
            acquireToken: jest.fn(),
            refreshToken: jest.fn(),
            httpClient: { get: getMock, post: jest.fn() },
        });

        const handler = server.tool.mock.calls[0][3];
        await handler({});

        // Verify the header was passed
        const [url, config] = getMock.mock.calls[0];
        expect(url).toContain('/api/v1/proxy/hostio');
        expect(config.headers).toBeDefined();
        expect(config.headers.keycloaktoken).toBe('my-jwt-token');
    });

    // Verify configureVpd sends the keycloaktoken header on the POST
    test('configureVpd sends keycloaktoken header on proxy request', async () => {
        const postMock = jest.fn().mockResolvedValue({ status: 200, data: {} });

        const register = require('../tools/configureVpd');
        register(server, {
            _tokenStateModule: createIsolatedTokenState({
                access_token: 'vpd-jwt-token',
                refresh_token: 'ref',
                expires_at: Date.now() + 300000,
            }),
            acquireToken: jest.fn().mockResolvedValue({
                access_token: 'new',
                refresh_token: 'ref',
                expires_at: Date.now() + 300000,
            }),
            refreshToken: jest.fn(),
            httpClient: { post: postMock, get: jest.fn() },
        });

        const handler = server.tool.mock.calls[0][3];
        await handler({ data_expression: 'true', parity_expression: 'true' });

        // Verify the header was passed as third argument (config) to post()
        const [url, body, config] = postMock.mock.calls[0];
        expect(url).toContain('/api/v1/proxy/hostio');
        expect(config.headers).toBeDefined();
        expect(config.headers.keycloaktoken).toBe('vpd-jwt-token');
    });
});

describe('T1 Contract-Gap: cross-tool invariants', () => {
    const ALL_TOOL_MODULES = [
        '../tools/checkPrerequisites',
        '../tools/startRegistration',
        '../tools/checkEmailVerified',
        '../tools/installRelayer',
        '../tools/checkRelayerHealth',
        '../tools/startClaim',
        '../tools/checkClaimStatus',
        '../tools/getHostTags',
        '../tools/configureVpd',
        '../tools/verifyStorage',
        '../tools/setupCliCredentials',
        '../tools/describeSettings',
        '../tools/updateSettings',
        '../tools/restartService',
        '../tools/manageBackups',
    ];

    function registerAllTools() {
        const srv = { tool: jest.fn() };
        for (const mod of ALL_TOOL_MODULES) {
            require(mod)(srv);
        }
        return srv;
    }

    test('TP-5: no tool description matches /fullaccess/i', () => {
        const srv = registerAllTools();
        for (const [name, description] of srv.tool.mock.calls) {
            expect(description.toLowerCase()).not.toContain('fullaccess');
        }
    });

    test('TP-4: no tool schema accepts a password key', () => {
        const srv = registerAllTools();
        for (const [name, , schema] of srv.tool.mock.calls) {
            const keys = Object.keys(schema || {});
            expect(keys).not.toContain('password');
        }
    });
});

describe('T1 Contract-Gap: checkRelayerHealth S3 4xx response', () => {
    let server;

    beforeEach(() => {
        server = { tool: jest.fn() };
    });

    // The code considers S3 healthy when status >= 200 && status < 500.
    // A 403 Forbidden means the service is running but rejecting requests.
    // Verify the code considers 403 as "healthy" (service is up).
    test('S3 returning 403 is treated as healthy (service reachable)', async () => {
        const register = require('../tools/checkRelayerHealth');
        register(server, {
            pollIntervalMs: 10,
            pollTimeoutMs: 100,
            sleep: jest.fn().mockResolvedValue(undefined),
            dockerUtil: {
                getDockerHost: jest.fn().mockResolvedValue({ remote: false, host: 'localhost', endpoint: 'unix:///var/run/docker.sock' }),
                isContainerRunning: jest.fn().mockResolvedValue(true),
            },
            httpClient: {
                get: jest.fn().mockImplementation(async (url) => {
                    if (url.includes(':8888/health')) return { status: 200 };
                    if (url.includes(':9000')) return { status: 403 };
                    if (url.includes('hostio')) return { status: 401 };
                    return { status: 200 };
                }),
                post: jest.fn(),
            },
        });

        const handler = server.tool.mock.calls[0][3];
        const result = await handler({ poll: false });
        const parsed = JSON.parse(result.content[0].text);

        // S3 should be considered healthy (403 means service is running)
        expect(parsed.success).toBe(true);
        expect(parsed.components.s3.healthy).toBe(true);
        expect(parsed.components.s3.status).toBe(403);
    });

    // S3 returning 500 → NOT healthy
    test('S3 returning 500 is treated as unhealthy', async () => {
        const register = require('../tools/checkRelayerHealth');
        register(server, {
            pollIntervalMs: 10,
            pollTimeoutMs: 100,
            sleep: jest.fn().mockResolvedValue(undefined),
            dockerUtil: {
                getDockerHost: jest.fn().mockResolvedValue({ remote: false, host: 'localhost', endpoint: 'unix:///var/run/docker.sock' }),
                isContainerRunning: jest.fn().mockResolvedValue(true),
            },
            httpClient: {
                get: jest.fn().mockImplementation(async (url) => {
                    if (url.includes(':8888/health')) return { status: 200 };
                    if (url.includes(':9000')) return { status: 500 };
                    if (url.includes('hostio')) return { status: 401 };
                    return { status: 200 };
                }),
                post: jest.fn(),
            },
        });

        const handler = server.tool.mock.calls[0][3];
        const result = await handler({ poll: false });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.components.s3.healthy).toBe(false);
        expect(parsed.unhealthy).toContain('S3 gateway (localhost:9000)');
    });
});
