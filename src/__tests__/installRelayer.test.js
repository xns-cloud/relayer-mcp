'use strict';

const { z } = require('zod');

describe('install_relayer', () => {
    let server;

    beforeEach(() => {
        server = { tool: jest.fn() };
    });

    // Wrap the handler so the registered Zod shape is applied first — mirrors how
    // the MCP SDK validates + fills defaults before the handler ever runs.
    function registerWithOptions(opts) {
        const register = require('../tools/installRelayer');
        register(server, opts);
        const [, , shape, handler] = server.tool.mock.calls[0];
        return (args) => handler(z.object(shape).parse(args));
    }

    // TP-30: uses execFile, no shell (security non-negotiable)
    test('uses execFile for mkdir and curl, not exec/spawn', async () => {
        const execFileCalls = [];
        const fakeExecFile = jest.fn((cmd, args, opts, cb) => {
            execFileCalls.push({ cmd, args });
            cb(null, '', '');
        });

        const handler = registerWithOptions({
            execFile: fakeExecFile,
            dockerUtil: {
                composeUp: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
                findContainer: jest.fn().mockResolvedValue(null),
            },
        });

        await handler({
            compose_url: 'https://example.com/docker-compose.yml',
            install_path: '/tmp/test-install',
        });

        // Verify mkdir was called via execFile
        expect(execFileCalls[0].cmd).toBe('mkdir');
        expect(execFileCalls[0].args).toContain('-p');

        // Verify curl was called via execFile
        expect(execFileCalls[1].cmd).toBe('curl');
        expect(execFileCalls[1].args).toContain('-fsSL');
    });

    // AC-12: confirms "containers starting"
    test('success → message says containers starting', async () => {
        const handler = registerWithOptions({
            execFile: jest.fn((cmd, args, opts, cb) => cb(null, '', '')),
            dockerUtil: {
                composeUp: jest.fn().mockResolvedValue({ stdout: 'ok', stderr: '' }),
                findContainer: jest.fn().mockResolvedValue(null),
            },
        });

        const result = await handler({
            compose_url: 'https://example.com/docker-compose.yml',
            install_path: '/tmp/test',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.message).toContain('containers are starting');
    });

    // Download failure
    test('curl failure → error with message', async () => {
        const handler = registerWithOptions({
            execFile: jest.fn((cmd, args, opts, cb) => {
                if (cmd === 'curl') return cb(new Error('download failed'));
                cb(null, '', '');
            }),
            dockerUtil: {
                composeUp: jest.fn(),
                findContainer: jest.fn().mockResolvedValue(null),
            },
        });

        const result = await handler({
            compose_url: 'https://example.com/bad.yml',
            install_path: '/tmp/test',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.error).toContain('download');
        expect(result.isError).toBe(true);
    });

    // Docker compose failure
    test('docker compose failure → error', async () => {
        const handler = registerWithOptions({
            execFile: jest.fn((cmd, args, opts, cb) => cb(null, '', '')),
            dockerUtil: {
                composeUp: jest.fn().mockRejectedValue(new Error('compose failed')),
                findContainer: jest.fn().mockResolvedValue(null),
            },
        });

        const result = await handler({
            compose_url: 'https://example.com/compose.yml',
            install_path: '/tmp/test',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(result.isError).toBe(true);
    });

    // --- Default path: bundled released compose, user authors nothing ---------

    function fakeFs() {
        const writes = {};
        return {
            writes,
            readFile: jest.fn().mockResolvedValue('BUNDLED_COMPOSE_TEMPLATE\n'),
            writeFile: jest.fn(async (p, data) => { writes[p] = data; }),
        };
    }

    // The whole point: a first-time user supplies no compose_url, and the tool
    // writes BOTH docker-compose.yml and .env for them — no curl.
    test('no compose_url → writes bundled compose + .env, never curls', async () => {
        const execFileCalls = [];
        const fs = fakeFs();
        const composeUp = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
        const handler = registerWithOptions({
            execFile: jest.fn((cmd, args, opts, cb) => { execFileCalls.push(cmd); cb(null, '', ''); }),
            fs,
            dockerUtil: { composeUp, findContainer: jest.fn().mockResolvedValue(null) },
        });

        const result = await handler({ install_path: '/tmp/xns' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.source).toBe('bundled');
        // No curl in the default path — only mkdir.
        expect(execFileCalls).toContain('mkdir');
        expect(execFileCalls).not.toContain('curl');
        // Bundled template written to docker-compose.yml.
        expect(fs.readFile).toHaveBeenCalled();
        expect(fs.writes['/tmp/xns/docker-compose.yml']).toBe('BUNDLED_COMPOSE_TEMPLATE\n');
        // .env written with default ports.
        expect(fs.writes['/tmp/xns/.env']).toBe('UI_PORT=8888\nS3_PORT=9000\n');
    });

    // Custom ports flow into .env AND into the compose env (interpolation).
    test('custom ports → .env + composeUp env carry them', async () => {
        const fs = fakeFs();
        const composeUp = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
        const handler = registerWithOptions({
            execFile: jest.fn((cmd, args, opts, cb) => cb(null, '', '')),
            fs,
            dockerUtil: { composeUp, findContainer: jest.fn().mockResolvedValue(null) },
        });

        await handler({ install_path: '/tmp/xns', ui_port: 18888, s3_port: 19000 });

        expect(fs.writes['/tmp/xns/.env']).toBe('UI_PORT=18888\nS3_PORT=19000\n');
        // composeUp runs in the install dir with the ports in env.
        const [composePath, execOpts] = composeUp.mock.calls[0];
        expect(composePath).toBe('/tmp/xns/docker-compose.yml');
        expect(execOpts.cwd).toBe('/tmp/xns');
        expect(execOpts.env.UI_PORT).toBe('18888');
        expect(execOpts.env.S3_PORT).toBe('19000');
    });

    // --- Preflight: fresh installs only (homelab feedback: alpha-channel name conflict) ---

    // A RUNNING xns-relayer (e.g. an existing alpha-channel deployment) must
    // stop the install with an actionable message — not a docker name-conflict.
    test('existing running container → friendly error, nothing installed', async () => {
        const fs = fakeFs();
        const composeUp = jest.fn();
        const execFile = jest.fn((cmd, args, opts, cb) => cb(null, '', ''));
        const handler = registerWithOptions({
            execFile,
            fs,
            dockerUtil: {
                composeUp,
                findContainer: jest.fn().mockResolvedValue({
                    name: 'xns-relayer',
                    status: 'Up 3 days',
                    image: 'releases.scpri.me/xns-relayer:alpha-latest',
                    running: true,
                }),
            },
        });

        const result = await handler({ install_path: '/tmp/xns' });
        const parsed = JSON.parse(result.content[0].text);

        expect(result.isError).toBe(true);
        expect(parsed.success).toBe(false);
        expect(parsed.error).toContain('fresh installs only');
        expect(parsed.error).toContain('alpha-latest');
        expect(parsed.remediation).toContain('docker stop xns-relayer && docker rm xns-relayer');
        // Nothing was installed or started.
        expect(composeUp).not.toHaveBeenCalled();
        expect(fs.writeFile).not.toHaveBeenCalled();
        expect(execFile).not.toHaveBeenCalled();
    });

    // A STOPPED container still owns the name and still breaks compose up —
    // the preflight must catch it too (docker ps -a, not docker ps).
    test('existing stopped container → still blocks the install', async () => {
        const composeUp = jest.fn();
        const handler = registerWithOptions({
            execFile: jest.fn((cmd, args, opts, cb) => cb(null, '', '')),
            fs: fakeFs(),
            dockerUtil: {
                composeUp,
                findContainer: jest.fn().mockResolvedValue({
                    name: 'xns-relayer',
                    status: 'Exited (0) 2 weeks ago',
                    image: 'scprime/xns-relayer:beta',
                    running: false,
                }),
            },
        });

        const result = await handler({ install_path: '/tmp/xns' });
        const parsed = JSON.parse(result.content[0].text);

        expect(result.isError).toBe(true);
        expect(parsed.existing_container.status).toContain('Exited');
        expect(composeUp).not.toHaveBeenCalled();
    });

    // Release-channel lock: the bundled template ships pinned to the canonical
    // beta channel on the XNS releases registry (anonymous pull). Flips to
    // :stable-latest at GA. Reads the real file on disk (not the mock) so a
    // stray retag is caught.
    test('bundled template pins the releases-registry beta channel', () => {
        const path = require('path');
        const realFs = require('fs');
        const templatePath = path.join(__dirname, '..', 'templates', 'docker-compose.yml');
        const template = realFs.readFileSync(templatePath, 'utf8');

        expect(template).toMatch(/^\s*image:\s*releases\.scpri\.me\/xns-relayer:beta-latest\s*$/m);
        expect(template).not.toMatch(/^\s*image:.*:stable/m);
    });

    // Fleet-safety regression: Docker Hub scprime/* tags are production FLEET
    // artifacts, not a release channel — the 0.3.0 template pointed there and
    // installed a 10-month-stale image. A Hub (or any non-releases-registry)
    // image reference must never return to the bundled install.
    test('bundled template never references Docker Hub or fleet images', () => {
        const path = require('path');
        const realFs = require('fs');
        const templatePath = path.join(__dirname, '..', 'templates', 'docker-compose.yml');
        const template = realFs.readFileSync(templatePath, 'utf8');

        const imageLines = template.split('\n').filter((l) => /^\s*image:/.test(l));
        expect(imageLines).toHaveLength(1);
        expect(imageLines[0]).toContain('releases.scpri.me/');
        expect(imageLines[0]).not.toContain('scprime/');
        expect(template).not.toMatch(/image:.*docker\.io/);
    });
});
