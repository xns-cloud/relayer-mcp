'use strict';

describe('check_relayer_health', () => {
    let server;

    beforeEach(() => {
        server = { tool: jest.fn() };
    });

    function registerWithOptions(opts) {
        const register = require('../tools/checkRelayerHealth');
        register(server, {
            pollIntervalMs: 10,
            pollTimeoutMs: 100,
            sleep: jest.fn().mockResolvedValue(undefined),
            ...opts,
        });
        return server.tool.mock.calls[0][3];
    }

    // AC-13: healthy when ui+s3 healthy
    test('ui+s3 healthy → success', async () => {
        const handler = registerWithOptions({
            httpClient: {
                get: jest.fn().mockImplementation(async (url) => {
                    if (url.includes(':8888/health')) return { status: 200 };
                    if (url.includes(':9000')) return { status: 200 };
                    if (url.includes('hostio')) return { status: 401 }; // auth required
                    return { status: 200 };
                }),
                post: jest.fn(),
            },
        });

        const result = await handler({ poll: false });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.components.ui.healthy).toBe(true);
        expect(parsed.components.s3.healthy).toBe(true);
    });

    // TP-31: hostio = null (not false) before auth
    test('hostio health is null (not false) when auth required', async () => {
        const handler = registerWithOptions({
            httpClient: {
                get: jest.fn().mockImplementation(async (url) => {
                    if (url.includes(':8888/health')) return { status: 200 };
                    if (url.includes(':9000')) return { status: 200 };
                    if (url.includes('hostio')) return { status: 401 };
                    return { status: 200 };
                }),
                post: jest.fn(),
            },
        });

        const result = await handler({ poll: false });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.components.hostio.healthy).toBeNull();
        expect(parsed.components.hostio.note).toContain('Authentication required');
    });

    // AC-13: names unhealthy component
    test('UI down → names UI as unhealthy', async () => {
        const handler = registerWithOptions({
            httpClient: {
                get: jest.fn().mockImplementation(async (url) => {
                    if (url.includes(':8888/health')) throw new Error('ECONNREFUSED');
                    if (url.includes(':9000')) return { status: 200 };
                    if (url.includes('hostio')) return { status: 401 };
                    return { status: 200 };
                }),
                post: jest.fn(),
            },
        });

        const result = await handler({ poll: false });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.unhealthy).toContain('UI (port 8888)');
    });

    // AC-13: 300s timeout
    test('timeout → reports unhealthy components', async () => {
        const handler = registerWithOptions({
            pollTimeoutMs: 50,
            pollIntervalMs: 10,
            httpClient: {
                get: jest.fn().mockImplementation(async (url) => {
                    if (url.includes(':8888/health')) throw new Error('ECONNREFUSED');
                    if (url.includes(':9000')) return { status: 200 };
                    if (url.includes('hostio')) return { status: 401 };
                    return { status: 200 };
                }),
                post: jest.fn(),
            },
        });

        const result = await handler({ poll: true });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.message).toContain('timed out');
    });

    // All healthy including hostio
    test('all three healthy → all_healthy true', async () => {
        const handler = registerWithOptions({
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 200 }),
                post: jest.fn(),
            },
        });

        const result = await handler({ poll: false });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.all_healthy).toBe(true);
    });
});
