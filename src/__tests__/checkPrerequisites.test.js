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

    // Every filesystem reports ample free space unless a test injects its own
    // statfs, so the disk check never reads the CI host's real disk.
    const AMPLE_STATFS = jest.fn(async () => ({ bavail: 500 * 10 ** 9, bsize: 1 }));

    function registerWithOptions(opts) {
        const { readRegistration } = require('./helpers/mockRegistration');
        const register = require('../tools/checkPrerequisites');
        register(server, { statfs: AMPLE_STATFS, ...opts });
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
                docker: jest.fn().mockRejectedValue(Object.assign(new Error('docker info failed: spawn docker ENOENT'), { code: 'ENOENT', stderr: '' })),
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
        expect(dockerCheck.remediation).toContain('curl -fsSL https://releases.scpri.me/relayer/install.sh | sh');
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

        expect(parsed.success).toBe(false); // install_file_location fails; ports are not the cause
        expect(parsed.checks.filter((c) => !c.passed).map((c) => c.name)).toEqual(['install_file_location']);
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

        expect(parsed.success).toBe(false); // remote daemon: install_file_location fails
        const ephCheck = parsed.checks.find((c) => c.name === 'ephemeral_environment');
        expect(ephCheck.passed).toBe(true);
        expect(ephCheck.warning).toBe(true);
        expect(ephCheck.detail).toContain('remote host');
        expect(ephCheck.detail).toContain('docker-box.lan');
        expect(ephCheck.detail).not.toContain('will be lost');
        expect(ephCheck.remediation).toContain('docker-box.lan');
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

    // BUG-229: install_relayer refuses when the daemon is on another machine,
    // so check_prerequisites must fail instead of passing and then being refused.
    describe('remote Docker host — install_relayer will refuse', () => {
        function remoteOpts(dockerHostResult) {
            return {
                dockerUtil: {
                    docker: jest.fn().mockResolvedValue({ stdout: '24.0.0', stderr: '' }),
                    getDockerHost: jest.fn().mockResolvedValue(dockerHostResult),
                    findContainer: jest.fn().mockResolvedValue(null),
                },
                httpClient: { get: jest.fn().mockResolvedValue({ status: 200, data: {} }), post: jest.fn() },
                checkPort: jest.fn().mockResolvedValue(true),
            };
        }

        test('remote host → install_file_location fails with a run-the-MCP-on-host remediation', async () => {
            const handler = registerWithOptions(remoteOpts({ remote: true, host: 'docker-box.lan', endpoint: 'ssh://admin@docker-box.lan' }));
            const parsed = JSON.parse((await handler({})).content[0].text);

            const check = parsed.checks.find((c) => c.name === 'install_file_location');
            expect(check).toBeDefined();
            expect(check.passed).toBe(false);
            expect(check.warning).toBeUndefined();
            expect(check.detail).toContain('docker-box.lan');
            expect(check.detail).toMatch(/install_relayer will refuse/);
            expect(check.remediation).toMatch(/run the MCP on docker-box\.lan/i);
        });

        test('remote endpoint with a password → the docker check never echoes it', async () => {
            const handler = registerWithOptions(remoteOpts({ remote: true, host: 'docker-box.lan', endpoint: 'ssh://admin:pa@ss@docker-box.lan' }));
            const result = await handler({});
            const parsed = JSON.parse(result.content[0].text);

            const check = parsed.checks.find((c) => c.name === 'docker');
            expect(check.detail).toContain('ssh://admin:***@docker-box.lan');
            expect(result.content[0].text).not.toContain('pa@ss');
        });

        test('remote host → overall result is not ready', async () => {
            const handler = registerWithOptions(remoteOpts({ remote: true, host: 'docker-box.lan', endpoint: 'ssh://admin@docker-box.lan' }));
            const parsed = JSON.parse((await handler({})).content[0].text);

            expect(parsed.success).toBe(false);
            expect(parsed.summary).toMatch(/1 prerequisite\(s\) failed/);
        });

        test('real dockerUtil with an ssh Docker context → failing check names the context host', async () => {
            const { createDockerUtil } = require('../lib/dockerUtil');
            const execFile = jest.fn((cmd, args, opts, cb) => {
                if (args[0] === 'context') return cb(null, 'ssh://user@box.example\n', '');
                return cb(null, '24.0.0', '');
            });
            const handler = registerWithOptions({
                dockerUtil: createDockerUtil({ execFile, env: {} }),
                httpClient: { get: jest.fn().mockResolvedValue({ status: 200, data: {} }), post: jest.fn() },
                checkPort: jest.fn().mockResolvedValue(true),
            });
            const parsed = JSON.parse((await handler({})).content[0].text);

            const check = parsed.checks.find((c) => c.name === 'install_file_location');
            expect(check.passed).toBe(false);
            expect(check.remediation).toMatch(/run the MCP on box\.example/i);
            expect(parsed.success).toBe(false);
        });

        test('ephemeral + remote → remediation says install_relayer will refuse and to run the MCP on the host', async () => {
            const handler = registerWithOptions({
                ...remoteOpts({ remote: true, host: 'docker-box.lan', endpoint: 'ssh://admin@docker-box.lan' }),
                environmentProbe: () => ({ ephemeral: true, signals: ['/.dockerenv present'] }),
            });
            const parsed = JSON.parse((await handler({})).content[0].text);

            const check = parsed.checks.find((c) => c.name === 'ephemeral_environment');
            expect(check.warning).toBe(true);
            expect(check.remediation).toContain('install_relayer will refuse');
            expect(check.remediation).toMatch(/Run the MCP on docker-box\.lan/);
            expect(check.remediation).not.toMatch(/docker context create/);
        });

        test('Docker missing → remediation does not recommend an SSH context', async () => {
            const handler = registerWithOptions({
                dockerUtil: {
                    docker: jest.fn().mockRejectedValue(Object.assign(new Error('docker info failed: spawn docker ENOENT'), { code: 'ENOENT', stderr: '' })),
                    getDockerHost: jest.fn(),
                    findContainer: jest.fn().mockResolvedValue(null),
                },
                httpClient: { get: jest.fn().mockResolvedValue({ status: 200, data: {} }), post: jest.fn() },
                checkPort: jest.fn().mockResolvedValue(true),
            });
            const parsed = JSON.parse((await handler({})).content[0].text);

            const check = parsed.checks.find((c) => c.name === 'docker');
            expect(check.passed).toBe(false);
            expect(check.remediation).not.toMatch(/docker context create/);
            expect(check.remediation).toMatch(/run this MCP on that machine/);
        });

        test('local host → no install_file_location check', async () => {
            const handler = registerWithOptions(remoteOpts({ remote: false, host: 'localhost', endpoint: 'unix:///var/run/docker.sock' }));
            const parsed = JSON.parse((await handler({})).content[0].text);

            expect(parsed.checks.find((c) => c.name === 'install_file_location')).toBeUndefined();
            expect(parsed.success).toBe(true);
        });
    });
    // --- E-A9: five distinct failures, own-container port pass, real disk check ---

    describe('E-A9 prerequisite failures (AC-19..AC-23, AC-27)', () => {
        const D5_COMMAND = 'curl -fsSL https://releases.scpri.me/relayer/install.sh | sh';
        const GB = 10 ** 9;
        const UNIT = 10 * GB;
        const DOCKER_ROOT = '/var/lib/docker';
        const INSTALL_DIR = '/opt/xns-relayer';
        const DENIED_STDERR = 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/info": dial unix /var/run/docker.sock: connect: permission denied';
        const STOPPED_STDERR = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';

        // A fresh mock server per handler: several cases build more than one
        // handler in one test, and readRegistration reads the first call.
        function registerFresh(opts) {
            const { readRegistration } = require('./helpers/mockRegistration');
            const register = require('../tools/checkPrerequisites');
            const fresh = { registerTool: jest.fn() };
            register(fresh, { statfs: AMPLE_STATFS, ...opts });
            return readRegistration(fresh).handler;
        }

        function rejection(stderr, code = 1) {
            return Object.assign(new Error(`docker info failed: Command failed: docker info\n${stderr}`), { stderr, code });
        }

        // A docker CLI fake that answers per command, the way the real one does.
        function fakeDocker({ info = 'ok', compose = 'ok', rootDir = DOCKER_ROOT } = {}) {
            return jest.fn(async (args) => {
                if (args[0] === 'compose' && args[1] === 'version') {
                    if (info === 'missing') throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT', stderr: '' });
                    if (compose === 'missing') throw rejection("docker: 'compose' is not a docker command.\nSee 'docker --help'");
                    return { stdout: 'Docker Compose version v2.29.7', stderr: '' };
                }
                if (args[0] === 'info') {
                    if (info === 'missing') throw Object.assign(new Error('docker info failed: spawn docker ENOENT'), { code: 'ENOENT', stderr: '' });
                    if (info === 'stopped') throw rejection(STOPPED_STDERR);
                    if (info === 'denied') throw rejection(DENIED_STDERR);
                    if (args.includes('{{.DockerRootDir}}')) return { stdout: `${rootDir}\n`, stderr: '' };
                    return { stdout: '27.3.1\n', stderr: '' };
                }
                return { stdout: '', stderr: '' };
            });
        }

        // statfs answering per path; a path missing from the map is ENOENT.
        function statfsFor(freeByPath) {
            return jest.fn(async (p) => {
                if (!(p in freeByPath)) throw Object.assign(new Error(`ENOENT: no such file or directory, statfs '${p}'`), { code: 'ENOENT' });
                return { bavail: freeByPath[p], bsize: 1 };
            });
        }

        function build({
            info, compose, rootDir,
            docker,
            dockerHost = { remote: false, host: 'localhost', endpoint: 'unix:///var/run/docker.sock' },
            container = null,
            hostPorts = [],
            portFree = () => true,
            statfs = statfsFor({ [DOCKER_ROOT]: 500 * GB, [INSTALL_DIR]: 500 * GB }),
            username = 'alice',
            groupFile = 'root:x:0:\ndocker:x:999:\n',
            dockerUtil,
        } = {}) {
            const util = dockerUtil || {
                docker: docker || fakeDocker({ info, compose, rootDir }),
                getDockerHost: jest.fn().mockResolvedValue(dockerHost),
                findContainer: jest.fn().mockResolvedValue(container),
                containerHostPorts: jest.fn().mockResolvedValue(hostPorts),
            };
            const handler = registerFresh({
                dockerUtil: util,
                httpClient: { get: jest.fn().mockResolvedValue({ status: 200, data: {} }), post: jest.fn() },
                checkPort: jest.fn(async (port) => portFree(port)),
                environmentProbe: () => ({ ephemeral: false, signals: [] }),
                statfs,
                userInfo: () => ({ username }),
                fs: { readFile: jest.fn(async (p) => { if (p !== '/etc/group') throw new Error(`unexpected read ${p}`); return groupFile; }) },
            });
            return { handler, util, statfs };
        }

        async function run(ctx) {
            const result = await ctx.handler({});
            return { result, parsed: JSON.parse(result.content[0].text), text: result.content[0].text };
        }

        const failed = (parsed) => parsed.checks.filter((c) => !c.passed);
        const check = (parsed, name) => parsed.checks.find((c) => c.name === name);
        const failureText = (c) => `${c.detail} ${c.remediation || ''}`;

        // TP-27 (AC-19..AC-21; M-L10, M-37, M-38, M-41)
        describe('Docker missing, daemon stopped, compose missing (TP-27)', () => {
            test('docker absent (ENOENT through the real dockerUtil) → only the Docker-missing failure, naming the install command', async () => {
                const { createDockerUtil } = require('../lib/dockerUtil');
                const execFile = jest.fn((cmd, args, opts, cb) => {
                    const err = new Error(`spawn ${cmd} ENOENT`);
                    err.code = 'ENOENT';
                    cb(err, '', '');
                });
                const statfs = statfsFor({ [DOCKER_ROOT]: 500 * GB, [INSTALL_DIR]: 500 * GB });
                const ctx = build({ dockerUtil: createDockerUtil({ execFile, env: {} }), statfs });
                const { parsed } = await run(ctx);

                expect(failed(parsed).map((c) => c.name)).toEqual(['docker']);
                expect(check(parsed, 'docker').remediation).toContain(D5_COMMAND);
                expect(failureText(check(parsed, 'docker'))).not.toMatch(/systemctl/);
                expect(check(parsed, 'docker_compose')).toMatchObject({ passed: true, skipped: true });
                expect(check(parsed, 'docker_group').passed).toBe(true);
                const rootLeg = check(parsed, 'disk').filesystems.find((f) => f.which === 'Docker root');
                expect(rootLeg.skipped).toBe(true);
                expect(statfs).not.toHaveBeenCalledWith(DOCKER_ROOT);
                expect(parsed.success).toBe(false);
            });

            // M-L10: a "no such file" in the daemon's stderr is not a missing CLI.
            test('daemon socket absent ("no such file or directory" text, exit 1) → daemon stopped, not Docker missing', async () => {
                const stderr = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running? dial unix /var/run/docker.sock: connect: no such file or directory (ENOENT)';
                const docker = jest.fn(async (args) => {
                    if (args[0] === 'info') throw rejection(stderr);
                    return { stdout: 'Docker Compose version v2.29.7', stderr: '' };
                });
                const { parsed } = await run(build({ docker }));

                expect(failed(parsed).map((c) => c.name)).toEqual(['docker']);
                expect(check(parsed, 'docker').remediation).toContain('sudo systemctl start docker');
                expect(check(parsed, 'docker').remediation).not.toContain(D5_COMMAND);
            });

            test('daemon down, compose present → only the daemon-stopped failure, naming the start command', async () => {
                const { parsed } = await run(build({ info: 'stopped' }));

                expect(failed(parsed).map((c) => c.name)).toEqual(['docker']);
                expect(check(parsed, 'docker').remediation).toContain('sudo systemctl start docker');
                expect(check(parsed, 'docker_compose')).toMatchObject({ passed: true });
                expect(check(parsed, 'docker_compose').skipped).toBeUndefined();
            });

            test('daemon up, compose missing → only the compose-missing failure, naming the fix command', async () => {
                const { parsed } = await run(build({ compose: 'missing' }));

                expect(failed(parsed).map((c) => c.name)).toEqual(['docker_compose']);
                expect(check(parsed, 'docker_compose').remediation).toContain('sudo apt-get install docker-compose-plugin');
                expect(check(parsed, 'docker').passed).toBe(true);
            });

            test('daemon down and compose missing → exactly the two failures', async () => {
                const { parsed } = await run(build({ info: 'stopped', compose: 'missing' }));

                expect(failed(parsed).map((c) => c.name).sort()).toEqual(['docker', 'docker_compose']);
            });
        });

        // TP-28 / CR-7 (AC-22; M-71, M-V8, M-39, M-63, M-64)
        describe('permission denied and the docker group (TP-28, CR-7)', () => {
            test('(a) denied, user in the docker line → only the group failure, "log out and back in", never daemon-stopped', async () => {
                const ctx = build({ info: 'denied', groupFile: 'root:x:0:\ndocker:x:999:bob,alice\n' });
                const { parsed, text } = await run(ctx);

                expect(failed(parsed).map((c) => c.name)).toEqual(['docker_group']);
                const group = check(parsed, 'docker_group');
                expect(failureText(group)).toContain('log out and back in');
                expect(failureText(group)).not.toContain('usermod');
                expect(text).not.toContain('systemctl start docker');
                expect(check(parsed, 'docker')).toMatchObject({ passed: true });
                expect(check(parsed, 'docker').detail).toMatch(/socket/i);
                const rootLeg = check(parsed, 'disk').filesystems.find((f) => f.which === 'Docker root');
                expect(rootLeg.skipped).toBe(true);
                expect(ctx.util.docker).toHaveBeenCalledWith(['compose', 'version']);
                expect(check(parsed, 'docker_compose').passed).toBe(true);
            });

            test('(b) denied, user not in the docker line → only the failure naming the add-group command', async () => {
                const { parsed } = await run(build({ info: 'denied', groupFile: 'docker:x:999:bob\nalice:x:1000:\n' }));

                expect(failed(parsed).map((c) => c.name)).toEqual(['docker_group']);
                expect(check(parsed, 'docker_group').remediation).toContain('sudo usermod -aG docker alice');
            });

            test('(b2) denied and /etc/group unreadable → add-group command, still the only failure', async () => {
                const ctx = build({ info: 'denied' });
                const handler = registerFresh({
                    dockerUtil: ctx.util,
                    httpClient: { get: jest.fn().mockResolvedValue({ status: 200, data: {} }), post: jest.fn() },
                    checkPort: jest.fn().mockResolvedValue(true),
                    environmentProbe: () => ({ ephemeral: false, signals: [] }),
                    userInfo: () => ({ username: 'alice' }),
                    fs: { readFile: jest.fn().mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' })) },
                });
                const parsed = JSON.parse((await handler({})).content[0].text);

                expect(failed(parsed).map((c) => c.name)).toEqual(['docker_group']);
                expect(check(parsed, 'docker_group').remediation).toContain('sudo usermod -aG docker alice');
            });

            test('(c) docker info succeeds as root → no group failure', async () => {
                const { parsed } = await run(build({ username: 'root', groupFile: 'root:x:0:\ndocker:x:999:\n' }));

                expect(check(parsed, 'docker_group').passed).toBe(true);
                expect(failed(parsed)).toEqual([]);
                expect(parsed.success).toBe(true);
            });

            test('(d) docker info succeeds rootless, user not in the docker line → no group failure', async () => {
                const { parsed } = await run(build({ username: 'alice', groupFile: 'docker:x:999:bob\n' }));

                expect(check(parsed, 'docker_group').passed).toBe(true);
                expect(failed(parsed)).toEqual([]);
            });

            test('(e) denied while xns-relayer holds 8888 and 9000 → ports skipped with the group note, findContainer never consulted', async () => {
                const ctx = build({
                    info: 'denied',
                    groupFile: 'docker:x:999:alice\n',
                    portFree: () => false,
                    container: { name: 'xns-relayer', status: 'Up 2 minutes', image: 'releases.scpri.me/xns-relayer:release-latest', running: true },
                    hostPorts: [8888, 9000],
                });
                const { parsed, text } = await run(ctx);

                expect(failed(parsed).map((c) => c.name)).toEqual(['docker_group']);
                for (const name of ['port_8888', 'port_9000']) {
                    expect(check(parsed, name)).toMatchObject({ passed: true, skipped: true });
                    expect(check(parsed, name).detail).toMatch(/docker group/i);
                }
                expect(ctx.util.findContainer).not.toHaveBeenCalled();
                expect(ctx.util.containerHostPorts).not.toHaveBeenCalled();
                expect(text).not.toContain('Stop the service using this port');
            });
        });

        // TP-29, TP-52, CR-10 (AC-23; M-V4, M-L11, M-40, M-69, M-V6)
        describe('disk free space on the Docker root and the install dir (TP-29, TP-52, CR-10)', () => {
            async function disk(freeByPath, extra = {}) {
                const statfs = statfsFor(freeByPath);
                const { parsed } = await run(build({ statfs, ...extra }));
                return { parsed, disk: check(parsed, 'disk'), statfs };
            }

            test('(a) both at exactly 10×10^9 bytes → passes', async () => {
                const { disk: d, parsed } = await disk({ [DOCKER_ROOT]: UNIT, [INSTALL_DIR]: UNIT });
                expect(d.passed).toBe(true);
                expect(parsed.success).toBe(true);
            });

            test('(b) install dir one byte short → fails naming the install dir and its free space', async () => {
                const { disk: d } = await disk({ [DOCKER_ROOT]: UNIT, [INSTALL_DIR]: UNIT - 1 });
                expect(d.passed).toBe(false);
                expect(d.detail).toMatch(/install dir/i);
                expect(d.detail).toContain(INSTALL_DIR);
                expect(d.detail).toContain('9.99 GB free');
                expect(d.detail).not.toMatch(/Docker root/);
                expect(d.remediation).toBeDefined();
            });

            test('(c) Docker root one byte short → fails naming the Docker root', async () => {
                const { disk: d } = await disk({ [DOCKER_ROOT]: UNIT - 1, [INSTALL_DIR]: UNIT });
                expect(d.passed).toBe(false);
                expect(d.detail).toMatch(/Docker root/);
                expect(d.detail).toContain(DOCKER_ROOT);
                expect(d.detail).not.toMatch(/install dir/i);
            });

            test('(d) both under → one failure naming both filesystems', async () => {
                const { disk: d, parsed } = await disk({ [DOCKER_ROOT]: 3 * GB, [INSTALL_DIR]: 4 * GB });
                expect(failed(parsed).map((c) => c.name)).toEqual(['disk']);
                expect(d.detail).toMatch(/Docker root/);
                expect(d.detail).toMatch(/install dir/i);
                expect(d.detail).toContain('3.00 GB free');
                expect(d.detail).toContain('4.00 GB free');
            });

            test.each([['(e) 1 GB', GB], ['(f) 0 bytes', 0]])('%s free → fails', async (_label, free) => {
                const { disk: d } = await disk({ [DOCKER_ROOT]: free, [INSTALL_DIR]: free });
                expect(d.passed).toBe(false);
            });

            test('(g) install dir absent → nearest existing ancestor decides (fails when it is short)', async () => {
                const { disk: d, statfs } = await disk({ [DOCKER_ROOT]: 500 * GB, '/opt': 5 * GB });
                expect(statfs).toHaveBeenCalledWith(INSTALL_DIR);
                expect(statfs).toHaveBeenCalledWith('/opt');
                expect(d.passed).toBe(false);
                expect(d.detail).toMatch(/install dir/i);
                expect(d.detail).toContain('/opt');
            });

            test('(g2) install dir and /opt absent → / decides (passes when ample)', async () => {
                const { disk: d, statfs } = await disk({ [DOCKER_ROOT]: 500 * GB, '/': 50 * GB });
                expect(statfs).toHaveBeenCalledWith('/');
                expect(d.passed).toBe(true);
                const leg = d.filesystems.find((f) => f.which === 'install dir');
                expect(leg).toMatchObject({ path: '/', free_bytes: 50 * GB, passed: true });
            });

            test('(h) 10.5×10^9 free on both → passes (a GiB threshold would fail it)', async () => {
                const { disk: d } = await disk({ [DOCKER_ROOT]: 10.5 * GB, [INSTALL_DIR]: 10.5 * GB });
                expect(d.passed).toBe(true);
            });

            test('free bytes are available blocks × block size', async () => {
                const statfs = jest.fn(async () => ({ bavail: 2441407, bsize: 4096 })); // 10,000,003,072 bytes
                const { parsed } = await run(build({ statfs }));
                expect(check(parsed, 'disk').passed).toBe(true);
                const statfsShort = jest.fn(async () => ({ bavail: 2441406, bsize: 4096 })); // 9,999,998,976 bytes
                const short = await run(build({ statfs: statfsShort }));
                expect(check(short.parsed, 'disk').passed).toBe(false);
            });

            test('CR-10: Docker root under 10 GB on its own volume while /opt has 30 GB → fails naming the Docker root', async () => {
                const { disk: d, parsed } = await disk({ [DOCKER_ROOT]: 5 * GB, [INSTALL_DIR]: 30 * GB });
                expect(parsed.success).toBe(false);
                expect(d.detail).toMatch(/Docker root/);
                expect(d.detail).toContain('5.00 GB free');
                expect(d.detail).not.toMatch(/install dir/i);
            });

            test('TP-52: remote DOCKER_HOST → Docker-root leg skipped, no local statfs of it; install-dir leg still runs', async () => {
                const statfs = statfsFor({ [DOCKER_ROOT]: 1, [INSTALL_DIR]: 500 * GB });
                const ctx = build({ statfs, dockerHost: { remote: true, host: 'docker-box.lan', endpoint: 'ssh://admin@docker-box.lan' } });
                const { parsed } = await run(ctx);

                const d = check(parsed, 'disk');
                expect(d.passed).toBe(true);
                expect(statfs).not.toHaveBeenCalledWith(DOCKER_ROOT);
                expect(statfs).toHaveBeenCalledWith(INSTALL_DIR);
                const rootLeg = d.filesystems.find((f) => f.which === 'Docker root');
                expect(rootLeg.skipped).toBe(true);
                expect(rootLeg.detail).toContain('docker-box.lan');
                expect(ctx.util.docker).not.toHaveBeenCalledWith(['info', '--format', '{{.DockerRootDir}}']);
            });

            test('an unreadable Docker root answer (not an absolute path) skips that leg', async () => {
                const statfs = statfsFor({ [INSTALL_DIR]: 500 * GB });
                const { parsed } = await run(build({ statfs, rootDir: '' }));
                const rootLeg = check(parsed, 'disk').filesystems.find((f) => f.which === 'Docker root');
                expect(rootLeg.skipped).toBe(true);
                expect(check(parsed, 'disk').passed).toBe(true);
            });
        });

        // AC-23 last clause: the five failure messages differ pairwise.
        test('the five failure details differ pairwise and from the retired shared text', async () => {
            const { createDockerUtil } = require('../lib/dockerUtil');
            const enoent = jest.fn((cmd, args, opts, cb) => cb(Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }), '', ''));
            const missing = (await run(build({ dockerUtil: createDockerUtil({ execFile: enoent, env: {} }) }))).parsed;
            const stopped = (await run(build({ info: 'stopped' }))).parsed;
            const compose = (await run(build({ compose: 'missing' }))).parsed;
            const group = (await run(build({ info: 'denied' }))).parsed;
            const diskShort = (await run(build({ statfs: statfsFor({ [DOCKER_ROOT]: GB, [INSTALL_DIR]: GB }) }))).parsed;

            const details = [
                check(missing, 'docker').detail,
                check(stopped, 'docker').detail,
                check(compose, 'docker_compose').detail,
                check(group, 'docker_group').detail,
                check(diskShort, 'disk').detail,
            ];
            expect(new Set(details).size).toBe(5);
            expect(details).not.toContain('Docker is not available or not running');
            // M-41: each failure names a command that fixes it.
            const remediations = [
                check(missing, 'docker').remediation,
                check(stopped, 'docker').remediation,
                check(compose, 'docker_compose').remediation,
                check(group, 'docker_group').remediation,
                check(diskShort, 'disk').remediation,
            ];
            expect(new Set(remediations).size).toBe(5);
            for (const r of remediations) expect(typeof r).toBe('string');
        });

        // CR-1, AC-27, TP-51 (M-48, M-L12)
        describe('ports held by the Relayer the install script started (CR-1, AC-27, TP-51)', () => {
            const RUNNING = { name: 'xns-relayer', status: 'Up 4 minutes', image: 'releases.scpri.me/xns-relayer:release-latest', running: true };

            test('CR-1: xns-relayer running and publishing 8888/9000 → both port checks pass with a note naming it, success:true', async () => {
                const ctx = build({ portFree: () => false, container: RUNNING, hostPorts: [8888, 9000, 9443] });
                const { parsed, text } = await run(ctx);

                for (const [name, port] of [['port_8888', 8888], ['port_9000', 9000]]) {
                    const c = check(parsed, name);
                    expect(c.passed).toBe(true);
                    expect(c.detail).toContain('xns-relayer');
                    expect(c.detail).toContain(String(port));
                }
                expect(parsed.success).toBe(true);
                expect(text).not.toContain('Stop the service using this port');
                const existing = check(parsed, 'existing_install');
                expect(existing.warning).toBe(true);
                expect(existing.remediation).toContain('check_relayer_health');
                expect(existing.remediation).not.toMatch(/docker stop|docker rm/);
            });

            test('TP-51: xns-relayer running but published on 18888/19000 while another process holds 8888/9000 → both still fail, no container note', async () => {
                const ctx = build({ portFree: () => false, container: RUNNING, hostPorts: [18888, 19000] });
                const { parsed } = await run(ctx);

                for (const name of ['port_8888', 'port_9000']) {
                    const c = check(parsed, name);
                    expect(c.passed).toBe(false);
                    expect(c.detail).not.toContain('xns-relayer');
                    expect(c.remediation).toContain('Stop the service using this port');
                }
                expect(parsed.success).toBe(false);
            });

            test('stopped xns-relayer → a held port still fails', async () => {
                const ctx = build({ portFree: (p) => p !== 8888, container: { ...RUNNING, status: 'Exited (0) 1 hour ago', running: false }, hostPorts: [] });
                const { parsed } = await run(ctx);

                expect(check(parsed, 'port_8888').passed).toBe(false);
                expect(check(parsed, 'port_9000').passed).toBe(true);
            });

            test('no xns-relayer container → a held port fails as before', async () => {
                const ctx = build({ portFree: (p) => p !== 9000 });
                const { parsed } = await run(ctx);

                expect(check(parsed, 'port_9000').passed).toBe(false);
                expect(check(parsed, 'port_9000').remediation).toContain('Port 9000');
                expect(ctx.util.containerHostPorts).not.toHaveBeenCalled();
            });
        });
    });
});
