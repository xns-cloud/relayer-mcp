'use strict';

describe('check_relayer_health', () => {
    let server;

    beforeEach(() => {
        server = { registerTool: jest.fn() };
    });

    // Default dockerUtil fake: local daemon, monitoring sidecars running.
    // Tests never exec the real docker CLI.
    function localDockerUtil() {
        return {
            getDockerHost: jest.fn().mockResolvedValue({ remote: false, host: 'localhost', endpoint: 'unix:///var/run/docker.sock' }),
            isContainerRunning: jest.fn().mockResolvedValue(true),
            hasMuseToken: jest.fn().mockResolvedValue(true),
        };
    }

    // UI answers, S3 gateway refuses — a fresh install before the claim.
    function uiUpS3Down() {
        return {
            get: jest.fn().mockImplementation(async (url) => {
                if (url.includes(':8888/health')) return { status: 200 };
                if (url.includes(':9000')) throw new Error('ECONNRESET');
                if (url.includes('hostio')) return { status: 401 };
                return { status: 200 };
            }),
            post: jest.fn(),
        };
    }

    function registerWithOptions(opts) {
        const { readRegistration } = require('./helpers/mockRegistration');
        const register = require('../tools/checkRelayerHealth');
        register(server, {
            pollIntervalMs: 10,
            pollTimeoutMs: 100,
            sleep: jest.fn().mockResolvedValue(undefined),
            dockerUtil: localDockerUtil(),
            ...opts,
        });
        return readRegistration(server).handler;
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

    // --- Before the claim, the image keeps the S3 gateway stopped ---
    test('unclaimed Relayer, S3 down → ready for claim, not unhealthy', async () => {
        const docker = localDockerUtil();
        docker.hasMuseToken.mockResolvedValue(false);
        const handler = registerWithOptions({ httpClient: uiUpS3Down(), dockerUtil: docker });

        const parsed = JSON.parse((await handler({ poll: false })).content[0].text);

        expect(docker.hasMuseToken).toHaveBeenCalledWith('xns-relayer');
        expect(parsed.success).toBe(true);
        expect(parsed.healthy).toBe(true);
        expect(parsed.awaiting_claim).toBe(true);
        expect(parsed.components.s3.healthy).toBeNull();
        expect(parsed.components.s3.note).toContain('signs in');
        expect(parsed.unhealthy).toBeUndefined();
        expect(parsed.message).toContain('start_claim');
        expect(parsed.message).toContain('sign in at http://localhost:8888');
    });

    test('unclaimed Relayer in poll mode → returns at once, no timeout', async () => {
        const docker = localDockerUtil();
        docker.hasMuseToken.mockResolvedValue(false);
        const sleep = jest.fn().mockResolvedValue(undefined);
        const handler = registerWithOptions({ httpClient: uiUpS3Down(), dockerUtil: docker, sleep });

        const parsed = JSON.parse((await handler({ poll: true })).content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.awaiting_claim).toBe(true);
        expect(parsed.message).not.toContain('timed out');
        expect(sleep).not.toHaveBeenCalled();
    });

    test.each([
        ['claimed', true],
        ['claim state unknown', null],
    ])('%s Relayer, S3 down → unhealthy, names the S3 gateway', async (_label, claimed) => {
        const docker = localDockerUtil();
        docker.hasMuseToken.mockResolvedValue(claimed);
        const handler = registerWithOptions({ httpClient: uiUpS3Down(), dockerUtil: docker });

        const parsed = JSON.parse((await handler({ poll: false })).content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.awaiting_claim).toBeUndefined();
        expect(parsed.components.s3.healthy).toBe(false);
        expect(parsed.unhealthy).toEqual(['S3 gateway (localhost:9000)']);
    });

    test('UI down → claim state not consulted, UI and S3 named', async () => {
        const docker = localDockerUtil();
        docker.hasMuseToken.mockResolvedValue(false);
        const handler = registerWithOptions({
            dockerUtil: docker,
            httpClient: { get: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')), post: jest.fn() },
        });

        const parsed = JSON.parse((await handler({ poll: false })).content[0].text);

        expect(docker.hasMuseToken).not.toHaveBeenCalled();
        expect(parsed.success).toBe(false);
        expect(parsed.unhealthy).toEqual(['UI (localhost:8888)', 'S3 gateway (localhost:9000)']);
    });

    test('S3 up → no claim prompt in either mode', async () => {
        for (const poll of [false, true]) {
            const handler = registerWithOptions({
                httpClient: { get: jest.fn().mockResolvedValue({ status: 200 }), post: jest.fn() },
            });
            const parsed = JSON.parse((await handler({ poll })).content[0].text);
            expect(parsed.success).toBe(true);
            expect(parsed.message).not.toMatch(/start_claim|Ready for claim/);
        }
    });

    test('host override names another machine → token not consulted, S3 named', async () => {
        const docker = localDockerUtil();
        docker.hasMuseToken.mockResolvedValue(false);
        const handler = registerWithOptions({ httpClient: uiUpS3Down(), dockerUtil: docker });

        const parsed = JSON.parse((await handler({ poll: false, host: 'other-box.lan' })).content[0].text);

        expect(docker.hasMuseToken).not.toHaveBeenCalled();
        expect(parsed.success).toBe(false);
        expect(parsed.unhealthy).toEqual(['S3 gateway (other-box.lan:9000)']);
    });

    test.each([
        ['loopback alias of the local daemon', '127.0.0.1', { remote: false, host: 'localhost', endpoint: 'unix:///var/run/docker.sock' }],
        ['the remote daemon host itself', 'docker-box.lan', { remote: true, host: 'docker-box.lan', endpoint: 'ssh://u@docker-box.lan' }],
    ])('host override is %s → token consulted', async (_label, host, daemon) => {
        const docker = localDockerUtil();
        docker.getDockerHost.mockResolvedValue(daemon);
        docker.hasMuseToken.mockResolvedValue(false);
        const handler = registerWithOptions({ httpClient: uiUpS3Down(), dockerUtil: docker });

        const parsed = JSON.parse((await handler({ poll: false, host })).content[0].text);

        expect(docker.hasMuseToken).toHaveBeenCalledWith('xns-relayer');
        expect(parsed.awaiting_claim).toBe(true);
    });

    test('S3 up → claim state not consulted', async () => {
        const docker = localDockerUtil();
        const handler = registerWithOptions({
            dockerUtil: docker,
            httpClient: { get: jest.fn().mockResolvedValue({ status: 200 }), post: jest.fn() },
        });

        await handler({ poll: false });

        expect(docker.hasMuseToken).not.toHaveBeenCalled();
    });

    // --- Remote Docker host (homelab feedback: Claude Code on a jump host) ---

    // Probes must target the machine the Docker daemon runs on, not localhost.
    test('remote ssh:// docker context → probes the remote host', async () => {
        const urls = [];
        const handler = registerWithOptions({
            dockerUtil: {
                getDockerHost: jest.fn().mockResolvedValue({ remote: true, host: 'docker-box.lan', endpoint: 'ssh://user@docker-box.lan' }),
                isContainerRunning: jest.fn().mockResolvedValue(true),
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
            dockerUtil: { getDockerHost, isContainerRunning: jest.fn().mockResolvedValue(true) },
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

    // A pasted Docker endpoint (tcp://) must normalize too, and loopback
    // aliases must classify as local — not as a remote Docker host.
    test('tcp:// endpoint paste normalizes; 127.0.0.1 classifies local', async () => {
        const urls = [];
        const handler = registerWithOptions({
            httpClient: {
                get: jest.fn().mockImplementation(async (url) => { urls.push(url); return { status: 200 }; }),
                post: jest.fn(),
            },
        });

        let result = await handler({ poll: false, host: 'tcp://10.0.0.5:2376' });
        let parsed = JSON.parse(result.content[0].text);
        expect(urls).toContain('http://10.0.0.5:8888/health');
        expect(parsed.remote_docker).toBe(true);

        urls.length = 0;
        result = await handler({ poll: false, host: '127.0.0.1' });
        parsed = JSON.parse(result.content[0].text);
        expect(urls).toContain('http://127.0.0.1:8888/health');
        expect(parsed.remote_docker).toBeUndefined();
    });

    // --- Monitoring sidecars (channel bundle: prometheus + grafana) ----------

    // The channel bundle ships prometheus + grafana — without them the UI's
    // Monitoring section is dead. Their absence must be SURFACED as degraded,
    // not silently reported healthy (the gap that let relayer-only MCP installs
    // pass health checks).
    test('monitoring containers absent → degraded, named in note, core still healthy', async () => {
        const docker = localDockerUtil();
        docker.isContainerRunning = jest.fn().mockResolvedValue(false);
        const handler = registerWithOptions({
            dockerUtil: docker,
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 200 }),
                post: jest.fn(),
            },
        });

        const result = await handler({ poll: false });
        const parsed = JSON.parse(result.content[0].text);

        // Core flow is NOT blocked — monitoring absence degrades, never fails.
        expect(parsed.success).toBe(true);
        expect(parsed.degraded).toBe(true);
        expect(parsed.components.monitoring.healthy).toBe(false);
        expect(parsed.components.monitoring.prometheus).toBe(false);
        expect(parsed.components.monitoring.grafana).toBe(false);
        expect(parsed.components.monitoring.note).toMatch(/Monitoring/);
        expect(parsed.message).toMatch(/monitoring/i);
    });

    test('monitoring containers running → monitoring healthy, not degraded', async () => {
        const docker = localDockerUtil();
        const handler = registerWithOptions({
            dockerUtil: docker,
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 200 }),
                post: jest.fn(),
            },
        });

        const result = await handler({ poll: false });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.degraded).toBeUndefined();
        expect(parsed.components.monitoring.healthy).toBe(true);
        // Probed both sidecars by container name.
        const probed = docker.isContainerRunning.mock.calls.map((c) => c[0]);
        expect(probed).toContain('prometheus');
        expect(probed).toContain('grafana');
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
