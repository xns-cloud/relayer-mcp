'use strict';

const { z } = require('zod');

describe('install_relayer compose_url host limit', () => {
    function setup() {
        const { readRegistration } = require('./helpers/mockRegistration');
        const register = require('../tools/installRelayer');
        const server = { registerTool: jest.fn() };
        const execFile = jest.fn((cmd, args, opts, cb) => cb(null, '', ''));
        const composeUp = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
        const findContainer = jest.fn().mockResolvedValue(null);
        const fs = { mkdtemp: jest.fn(), writeFile: jest.fn(), chmod: jest.fn(), readFile: jest.fn(), rm: jest.fn() };
        register(server, { execFile, fs, dockerUtil: { composeUp, findContainer } });
        const { schema, handler } = readRegistration(server);
        return { run: async (args) => JSON.parse((await handler(z.object(schema).parse(args))).content[0].text), execFile, composeUp, findContainer, fs };
    }

    test.each([
        ['a public host', 'https://evil.example.org/c.yml', 'evil.example.org'],
        ['a public IP', 'http://8.8.8.8/c.yml', '8.8.8.8'],
        ['releases.xns.tech over plain http', 'http://releases.xns.tech/c.yml', 'releases.xns.tech'],
        ['a lookalike userinfo URL', 'https://releases.xns.tech@evil.example.org/c.yml', 'evil.example.org'],
        ['a lookalike subdomain', 'https://releases.xns.tech.evil.example.org/c.yml', 'releases.xns.tech.evil.example.org'],
        ['a file URL on a remote host', 'file://evil.example.org/share/c.yml', 'evil.example.org'],
        ['an ftp URL', 'ftp://192.168.1.5/c.yml', '192.168.1.5'],
    ])('%s is refused before anything is made, downloaded or composed', async (_label, url, host) => {
        const t = setup();
        const parsed = await t.run({ install_path: '/tmp/xns', compose_url: url });

        expect(parsed.success).toBe(false);
        expect(parsed.error).toContain(host);
        expect(parsed.error).toContain('file://');
        expect(t.execFile).not.toHaveBeenCalled();
        expect(t.composeUp).not.toHaveBeenCalled();
        expect(t.findContainer).not.toHaveBeenCalled();
        expect(t.fs.writeFile).not.toHaveBeenCalled();
    });

    test.each([
        ['releases.xns.tech over https', 'https://releases.xns.tech/custom/compose.yml', 'releases.xns.tech'],
        ['a file URL', 'file:///home/me/docker-compose.yml', 'this machine'],
        ['loopback', 'http://127.0.0.1:8000/c.yml', '127.0.0.1'],
        ['a private address', 'https://192.168.1.20/c.yml', '192.168.1.20'],
        ['a .local host', 'http://nas.local/c.yml', 'nas.local'],
    ])('%s is accepted and the reply names the compose host', async (_label, url, host) => {
        const t = setup();
        const parsed = await t.run({ install_path: '/tmp/xns', compose_url: url });

        expect(parsed.success).toBe(true);
        expect(parsed.compose_host).toBe(host);
        const curl = t.execFile.mock.calls.find((c) => c[0] === 'curl');
        expect(curl[1]).toContain(url);
        expect(t.composeUp).toHaveBeenCalledTimes(1);
    });

    test('a backslash before @ cannot make curl fetch from a host other than the checked one', async () => {
        const t = setup();
        const raw = 'http://127.0.0.1\\@evil.example/c.yml';
        const parsed = await t.run({ install_path: '/tmp/xns', compose_url: raw });

        const curl = t.execFile.mock.calls.find((c) => c[0] === 'curl');
        if (!curl) {
            expect(parsed.success).toBe(false);
            return;
        }
        const sent = curl[1][curl[1].length - 1];
        expect(sent).not.toBe(raw);
        expect(new URL(sent).hostname).toBe('127.0.0.1');
        expect(sent).not.toContain('\\');
    });

    test('the override download limits curl to http, https and file', async () => {
        const t = setup();
        await t.run({ install_path: '/tmp/xns', compose_url: 'https://releases.xns.tech/c.yml' });

        const curl = t.execFile.mock.calls.find((c) => c[0] === 'curl');
        const args = curl[1];
        expect(args[args.indexOf('--proto') + 1]).toBe('=http,https,file');
    });

    test('the override download does not follow redirects', async () => {
        const t = setup();
        await t.run({ install_path: '/tmp/xns', compose_url: 'https://releases.xns.tech/c.yml' });

        const curl = t.execFile.mock.calls.find((c) => c[0] === 'curl');
        expect(curl[1].join(' ')).not.toMatch(/-\w*L/);
    });
});
