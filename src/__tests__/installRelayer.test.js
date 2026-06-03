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
            dockerUtil: { composeUp },
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
        expect(fs.writes['/tmp/xns/.env']).toBe('UI_PORT=8888\nMINIO_PORT=9000\n');
    });

    // Custom ports flow into .env AND into the compose env (interpolation).
    test('custom ports → .env + composeUp env carry them', async () => {
        const fs = fakeFs();
        const composeUp = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
        const handler = registerWithOptions({
            execFile: jest.fn((cmd, args, opts, cb) => cb(null, '', '')),
            fs,
            dockerUtil: { composeUp },
        });

        await handler({ install_path: '/tmp/xns', ui_port: 18888, minio_port: 19000 });

        expect(fs.writes['/tmp/xns/.env']).toBe('UI_PORT=18888\nMINIO_PORT=19000\n');
        // composeUp runs in the install dir with the ports in env.
        const [composePath, execOpts] = composeUp.mock.calls[0];
        expect(composePath).toBe('/tmp/xns/docker-compose.yml');
        expect(execOpts.cwd).toBe('/tmp/xns');
        expect(execOpts.env.UI_PORT).toBe('18888');
        expect(execOpts.env.MINIO_PORT).toBe('19000');
    });

    // Pre-release channel lock: the bundled template ships pinned to :beta so
    // alpha/beta testers exercise the current Relayer. Flips to :stable at GA.
    // Reads the real file on disk (not the mock) so a stray retag is caught.
    test('bundled template pins the :beta channel, not :stable', () => {
        const path = require('path');
        const realFs = require('fs');
        const templatePath = path.join(__dirname, '..', 'templates', 'docker-compose.yml');
        const template = realFs.readFileSync(templatePath, 'utf8');

        expect(template).toMatch(/^\s*image:\s*scprime\/xns-relayer:beta\s*$/m);
        expect(template).not.toMatch(/image:\s*scprime\/xns-relayer:stable/);
    });
});
