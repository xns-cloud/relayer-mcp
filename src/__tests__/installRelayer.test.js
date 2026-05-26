'use strict';

describe('install_relayer', () => {
    let server;

    beforeEach(() => {
        server = { tool: jest.fn() };
    });

    function registerWithOptions(opts) {
        const register = require('../tools/installRelayer');
        register(server, opts);
        return server.tool.mock.calls[0][3];
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
});
