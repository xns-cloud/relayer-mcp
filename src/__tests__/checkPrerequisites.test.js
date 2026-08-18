'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');

describe('check_prerequisites', () => {
    let server;
    let registeredTools;

    beforeEach(() => {
        server = {
            registerTool: jest.fn(),
        };
        registeredTools = {};
    });

    function registerWithOptions(opts) {
        const { readRegistration } = require('./helpers/mockRegistration');
        const register = require('../tools/checkPrerequisites');
        register(server, opts);
        const reg = readRegistration(server);
        registeredTools[reg.name] = reg.handler;
        return reg.handler;
    }

    // TP-4: check_prerequisites registered with correct name
    test('registers tool with name check_prerequisites', () => {
        const { readRegistration } = require('./helpers/mockRegistration');
        const register = require('../tools/checkPrerequisites');
        register(server);
        expect(server.registerTool).toHaveBeenCalledTimes(1);
        expect(readRegistration(server).name).toBe('check_prerequisites');
    });

    // TP-5: all checks pass → success: true
    test('returns success when all prerequisites pass', async () => {
        const handler = registerWithOptions({
            dockerUtil: {
                docker: jest.fn().mockResolvedValue({ stdout: '24.0.0', stderr: '' }),
                getDockerHost: jest.fn().mockResolvedValue({ remote: false, host: 'localhost', endpoint: 'unix:///var/run/docker.sock' }),
                findContainer: jest.fn().mockResolvedValue(null),
            },
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 200, data: {} }),
                post: jest.fn(),
            },
            checkPort: jest.fn().mockResolvedValue(true),
        });

        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.checks).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: 'docker', passed: true }),
                expect.objectContaining({ name: 'port_8888', passed: true }),
                expect.objectContaining({ name: 'port_9000', passed: true }),
            ]),
        );
    });

    // TP-6: Docker missing → failure + remediation (AC-4)
    test('reports Docker failure with remediation hint', async () => {
        const handler = registerWithOptions({
            dockerUtil: {
                docker: jest.fn().mockRejectedValue(new Error('not found')),
                getDockerHost: jest.fn().mockResolvedValue({ remote: false, host: 'localhost', endpoint: null }),
                findContainer: jest.fn().mockRejectedValue(new Error('not found')),
            },
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 200, data: {} }),
                post: jest.fn(),
            },
            checkPort: jest.fn().mockResolvedValue(true),
        });

        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        const dockerCheck = parsed.checks.find((c) => c.name === 'docker');
        expect(dockerCheck.passed).toBe(false);
        expect(dockerCheck.remediation).toBeDefined();
        expect(dockerCheck.remediation).toContain('Install Docker');
    });

    // TP-7: port in use → failure + remediation (AC-4)
    test('reports port 8888 in use with remediation hint', async () => {
        const handler = registerWithOptions({
            dockerUtil: {
                docker: jest.fn().mockResolvedValue({ stdout: '24.0.0', stderr: '' }),
                getDockerHost: jest.fn().mockResolvedValue({ remote: false, host: 'localhost', endpoint: 'unix:///var/run/docker.sock' }),
                findContainer: jest.fn().mockResolvedValue(null),
            },
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 200, data: {} }),
                post: jest.fn(),
            },
            checkPort: jest.fn().mockImplementation(async (port) => {
                return port !== 8888;
            }),
        });

        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        const portCheck = parsed.checks.find((c) => c.name === 'port_8888');
        expect(portCheck.passed).toBe(false);
        expect(portCheck.remediation).toContain('Port 8888');
    });

    // TP-8: connectivity failure → remediation (AC-4)
    test('reports connectivity failure with remediation hint', async () => {
        const handler = registerWithOptions({
            dockerUtil: {
                docker: jest.fn().mockResolvedValue({ stdout: '24.0.0', stderr: '' }),
                getDockerHost: jest.fn().mockResolvedValue({ remote: false, host: 'localhost', endpoint: 'unix:///var/run/docker.sock' }),
                findContainer: jest.fn().mockResolvedValue(null),
            },
            httpClient: {
                get: jest.fn().mockRejectedValue(new Error('ENOTFOUND')),
                post: jest.fn(),
            },
            checkPort: jest.fn().mockResolvedValue(true),
        });

        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        const consoleCheck = parsed.checks.find((c) => c.name === 'connectivity_console');
        expect(consoleCheck.passed).toBe(false);
        expect(consoleCheck.remediation).toContain('HTTPS');
    });

    // The registry install_relayer pulls from is part of connectivity: a host
    // that can reach console/auth but not releases.scpri.me would pass checks
    // and then fail mid-install on the image pull.
    test('probes the releases registry the install pulls from', async () => {
        const handler = registerWithOptions({
            dockerUtil: {
                docker: jest.fn().mockResolvedValue({ stdout: '24.0.0', stderr: '' }),
                getDockerHost: jest.fn().mockResolvedValue({ remote: false, host: 'localhost', endpoint: 'unix:///var/run/docker.sock' }),
                findContainer: jest.fn().mockResolvedValue(null),
            },
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 200, data: '{}' }),
                post: jest.fn(),
            },
            checkPort: jest.fn().mockResolvedValue(true),
        });

        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        const registryCheck = parsed.checks.find((c) => c.name === 'connectivity_registry');
        expect(registryCheck).toBeDefined();
        expect(registryCheck.passed).toBe(true);
        expect(registryCheck.detail).toContain('releases.scpri.me');
    });

    // AC-3: plain English descriptions
    test('all checks have human-readable detail strings', async () => {
        const handler = registerWithOptions({
            dockerUtil: {
                docker: jest.fn().mockResolvedValue({ stdout: '24.0.0', stderr: '' }),
                getDockerHost: jest.fn().mockResolvedValue({ remote: false, host: 'localhost', endpoint: 'unix:///var/run/docker.sock' }),
                findContainer: jest.fn().mockResolvedValue(null),
            },
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 200, data: {} }),
                post: jest.fn(),
            },
            checkPort: jest.fn().mockResolvedValue(true),
        });

        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        for (const check of parsed.checks) {
            expect(typeof check.detail).toBe('string');
            expect(check.detail.length).toBeGreaterThan(0);
        }
    });

    // --- Remote Docker host (homelab feedback: Claude Code on a jump host) ---

    // The local bind-probe tests THIS machine; with a remote daemon the
    // containers bind ports on the REMOTE host — probing here is the wrong
    // machine. Skip with an explanation instead of reporting a false answer.
    test('remote docker host → port checks skipped, not falsely reported', async () => {
        const checkPort = jest.fn();
        const handler = registerWithOptions({
            dockerUtil: {
                docker: jest.fn().mockResolvedValue({ stdout: '24.0.0', stderr: '' }),
                getDockerHost: jest.fn().mockResolvedValue({ remote: true, host: 'docker-box.lan', endpoint: 'ssh://user@docker-box.lan' }),
                findContainer: jest.fn().mockResolvedValue(null),
            },
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 200, data: {} }),
                post: jest.fn(),
            },
            checkPort,
        });

        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(checkPort).not.toHaveBeenCalled();
        const dockerCheck = parsed.checks.find((c) => c.name === 'docker');
        expect(dockerCheck.detail).toContain('docker-box.lan');
        for (const name of ['port_8888', 'port_9000']) {
            const portCheck = parsed.checks.find((c) => c.name === name);
            expect(portCheck.skipped).toBe(true);
            expect(portCheck.detail).toContain('docker-box.lan');
        }
    });

    // An existing xns-relayer container (any channel, running or stopped) will
    // fail install_relayer with a name conflict — warn here, before install.
    test('existing xns-relayer container → warning with migration remediation', async () => {
        const handler = registerWithOptions({
            dockerUtil: {
                docker: jest.fn().mockResolvedValue({ stdout: '24.0.0', stderr: '' }),
                getDockerHost: jest.fn().mockResolvedValue({ remote: false, host: 'localhost', endpoint: 'unix:///var/run/docker.sock' }),
                findContainer: jest.fn().mockResolvedValue({
                    name: 'xns-relayer',
                    status: 'Up 5 days',
                    image: 'releases.scpri.me/xns-relayer:alpha-latest',
                    running: true,
                }),
            },
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 200, data: {} }),
                post: jest.fn(),
            },
            checkPort: jest.fn().mockResolvedValue(true),
        });

        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        const existing = parsed.checks.find((c) => c.name === 'existing_install');
        expect(existing.warning).toBe(true);
        expect(existing.detail).toContain('alpha-latest');
        expect(existing.remediation).toContain('fresh installs only');
    });

    // --- Ephemeral environment (TP-6) ---

    test('ephemeral environment: warning with remediation, success stays true', async () => {
        const handler = registerWithOptions({
            dockerUtil: {
                docker: jest.fn().mockResolvedValue({ stdout: '24.0.0', stderr: '' }),
                getDockerHost: jest.fn().mockResolvedValue({ remote: false, host: 'localhost', endpoint: 'unix:///var/run/docker.sock' }),
                findContainer: jest.fn().mockResolvedValue(null),
            },
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 200, data: {} }),
                post: jest.fn(),
            },
            checkPort: jest.fn().mockResolvedValue(true),
            environmentProbe: () => ({
                ephemeral: true,
                signals: ['/.dockerenv exists', 'systemd is absent'],
            }),
        });

        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        const ephCheck = parsed.checks.find((c) => c.name === 'ephemeral_environment');
        expect(ephCheck.passed).toBe(true);
        expect(ephCheck.warning).toBe(true);
        expect(ephCheck.detail).toContain('ephemeral');
        expect(ephCheck.remediation).toBeDefined();
        expect(ephCheck.remediation).toContain('persistent');
    });

    test('remote docker + ephemeral environment: message names remote host, not local install', async () => {
        const handler = registerWithOptions({
            dockerUtil: {
                docker: jest.fn().mockResolvedValue({ stdout: '24.0.0', stderr: '' }),
                getDockerHost: jest.fn().mockResolvedValue({ remote: true, host: 'docker-box.lan', endpoint: 'ssh://user@docker-box.lan' }),
                findContainer: jest.fn().mockResolvedValue(null),
            },
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 200, data: {} }),
                post: jest.fn(),
            },
            checkPort: jest.fn().mockResolvedValue(true),
            environmentProbe: () => ({
                ephemeral: true,
                signals: ['/.dockerenv exists', 'systemd is absent'],
            }),
        });

        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        const ephCheck = parsed.checks.find((c) => c.name === 'ephemeral_environment');
        expect(ephCheck.passed).toBe(true);
        expect(ephCheck.warning).toBe(true);
        expect(ephCheck.detail).toContain('remote host');
        expect(ephCheck.detail).toContain('docker-box.lan');
        expect(ephCheck.detail).not.toContain('will be lost');
        expect(ephCheck.remediation).toContain('remote Docker host');
    });

    test('non-ephemeral environment: no warning', async () => {
        const handler = registerWithOptions({
            dockerUtil: {
                docker: jest.fn().mockResolvedValue({ stdout: '24.0.0', stderr: '' }),
                getDockerHost: jest.fn().mockResolvedValue({ remote: false, host: 'localhost', endpoint: 'unix:///var/run/docker.sock' }),
                findContainer: jest.fn().mockResolvedValue(null),
            },
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 200, data: {} }),
                post: jest.fn(),
            },
            checkPort: jest.fn().mockResolvedValue(true),
            environmentProbe: () => ({ ephemeral: false, signals: [] }),
        });

        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        const ephCheck = parsed.checks.find((c) => c.name === 'ephemeral_environment');
        expect(ephCheck.passed).toBe(true);
        expect(ephCheck.warning).toBeUndefined();
    });

    // No existing container → explicit all-clear entry.
    test('no existing container → existing_install reports ready', async () => {
        const handler = registerWithOptions({
            dockerUtil: {
                docker: jest.fn().mockResolvedValue({ stdout: '24.0.0', stderr: '' }),
                getDockerHost: jest.fn().mockResolvedValue({ remote: false, host: 'localhost', endpoint: 'unix:///var/run/docker.sock' }),
                findContainer: jest.fn().mockResolvedValue(null),
            },
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 200, data: {} }),
                post: jest.fn(),
            },
            checkPort: jest.fn().mockResolvedValue(true),
        });

        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        const existing = parsed.checks.find((c) => c.name === 'existing_install');
        expect(existing.passed).toBe(true);
        expect(existing.warning).toBeUndefined();
        expect(existing.detail).toContain('fresh install');
    });

    // --- Docker host metadata guard ---

    test('getDockerHost returns null → treated as local, no crash', async () => {
        const handler = registerWithOptions({
            dockerUtil: {
                docker: jest.fn().mockResolvedValue({ stdout: '24.0.0', stderr: '' }),
                getDockerHost: jest.fn().mockResolvedValue(null),
                findContainer: jest.fn().mockResolvedValue(null),
            },
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 200, data: {} }),
                post: jest.fn(),
            },
            checkPort: jest.fn().mockResolvedValue(true),
        });

        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        const dockerCheck = parsed.checks.find((c) => c.name === 'docker');
        expect(dockerCheck.passed).toBe(true);
    });

    test('getDockerHost returns undefined → treated as local, no crash', async () => {
        const handler = registerWithOptions({
            dockerUtil: {
                docker: jest.fn().mockResolvedValue({ stdout: '24.0.0', stderr: '' }),
                getDockerHost: jest.fn().mockResolvedValue(undefined),
                findContainer: jest.fn().mockResolvedValue(null),
            },
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 200, data: {} }),
                post: jest.fn(),
            },
            checkPort: jest.fn().mockResolvedValue(true),
        });

        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
    });

    test('getDockerHost returns partial metadata (missing host) → defaults applied', async () => {
        const handler = registerWithOptions({
            dockerUtil: {
                docker: jest.fn().mockResolvedValue({ stdout: '24.0.0', stderr: '' }),
                getDockerHost: jest.fn().mockResolvedValue({ remote: true }),
                findContainer: jest.fn().mockResolvedValue(null),
            },
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 200, data: {} }),
                post: jest.fn(),
            },
            checkPort: jest.fn().mockResolvedValue(true),
        });

        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        const dockerCheck = parsed.checks.find((c) => c.name === 'docker');
        expect(dockerCheck.passed).toBe(true);
        // incomplete remote metadata (no usable host) is classified LOCAL:
        // the local-Docker detail is reported and both port checks run
        // instead of skipping against a host we cannot name.
        expect(dockerCheck.detail).toBe('Docker is running');
        for (const name of ['port_8888', 'port_9000']) {
            const portCheck = parsed.checks.find((c) => c.name === name);
            expect(portCheck.skipped).toBeUndefined();
            expect(portCheck.passed).toBe(true);
        }
    });
});
