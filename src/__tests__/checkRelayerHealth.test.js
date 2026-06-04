'use strict';

describe('check_relayer_health', () => {
    let server;

    beforeEach(() => {
        server = { tool: jest.fn() };
    });

    // Default dockerUtil fake: local daemon. Tests never exec the real docker CLI.
    function localDockerUtil() {
        return {
            getDockerHost: jest.fn().mockResolvedValue({ remote: false, host: 'localhost', endpoint: 'unix:///var/run/docker.sock' }),
        };
    }

    function registerWithOptions(opts) {
        const register = require('../tools/checkRelayerHealth');
        register(server, {
            pollIntervalMs: 10,
            pollTimeoutMs: 100,
            sleep: jest.fn().mockResolvedValue(undefined),
            dockerUtil: localDockerUtil(),
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
        expect(parsed.unhealthy).toContain('UI (localhost:8888)');
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

    // --- Remote Docker host (homelab feedback: Claude Code on a jump host) ---

    // Probes must target the machine the Docker daemon runs on, not localhost.
    test('remote ssh:// docker context → probes the remote host', async () => {
        const urls = [];
        const handler = registerWithOptions({
            dockerUtil: {
                getDockerHost: jest.fn().mockResolvedValue({ remote: true, host: 'docker-box.lan', endpoint: 'ssh://user@docker-box.lan' }),
            },
            httpClient: {
                get: jest.fn().mockImplementation(async (url) => { urls.push(url); return { status: 200 }; }),
                post: jest.fn(),
            },
        });

        const result = await handler({ poll: false });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.target_host).toBe('docker-box.lan');
        expect(parsed.remote_docker).toBe(true);
        expect(urls).toContain('http://docker-box.lan:8888/health');
        expect(urls).toContain('http://docker-box.lan:9000/');
        expect(urls.some((u) => u.includes('localhost'))).toBe(false);
    });

    // Explicit host param overrides auto-detection entirely.
    test('host param overrides docker context detection', async () => {
        const urls = [];
        const getDockerHost = jest.fn();
        const handler = registerWithOptions({
            dockerUtil: { getDockerHost },
            httpClient: {
                get: jest.fn().mockImplementation(async (url) => { urls.push(url); return { status: 200 }; }),
                post: jest.fn(),
            },
        });

        const result = await handler({ poll: false, host: '192.168.1.50' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.target_host).toBe('192.168.1.50');
        expect(getDockerHost).not.toHaveBeenCalled();
        expect(urls).toContain('http://192.168.1.50:8888/health');
    });

    // Host inputs arrive messy — an accidental scheme prefix or bare IPv6 must
    // still produce valid probe URLs, not false unhealthy reports.
    test('host with scheme prefix or bare IPv6 → normalized probe URLs', async () => {
        const urls = [];
        const handler = registerWithOptions({
            httpClient: {
                get: jest.fn().mockImplementation(async (url) => { urls.push(url); return { status: 200 }; }),
                post: jest.fn(),
            },
        });

        await handler({ poll: false, host: 'http://docker-box.lan' });
        expect(urls).toContain('http://docker-box.lan:8888/health');

        urls.length = 0;
        await handler({ poll: false, host: 'fd00::7' });
        expect(urls).toContain('http://[fd00::7]:8888/health');
    });

    // Custom ports flow into the probe URLs (matches install_relayer ports).
    test('custom ui_port/s3_port → probe URLs carry them', async () => {
        const urls = [];
        const handler = registerWithOptions({
            httpClient: {
                get: jest.fn().mockImplementation(async (url) => { urls.push(url); return { status: 200 }; }),
                post: jest.fn(),
            },
        });

        await handler({ poll: false, ui_port: 18888, s3_port: 19000 });

        expect(urls).toContain('http://localhost:18888/health');
        expect(urls).toContain('http://localhost:19000/');
    });
});
