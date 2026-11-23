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

    // Only the default release fetch carries a source tag; a user's own
    // compose file is fetched exactly as given.
    test.each([
        'https://releases.xns.tech/custom/compose.yml',
        'file:///home/me/docker-compose.yml',
        'http://192.168.1.20/c.yml',
    ])('%s is fetched exactly as given, with no src tag', async (url) => {
        const t = setup();
        const parsed = await t.run({ install_path: '/tmp/xns', compose_url: url });

        expect(parsed.success).toBe(true);
        const curls = t.execFile.mock.calls.filter((c) => c[0] === 'curl');
        expect(curls).toHaveLength(1);
        const sent = curls[0][1][curls[0][1].length - 1];
        expect(sent).toBe(url);
        expect(sent).not.toContain('src=');
    });

    test.each([
        'file:///etc/passwd',
        'file:///dev/zero',
        'file:///proc/self/environ',
        'file:///home/me/.xns/credentials',
        'file:///home/me/compose.yml.bak',
        'file:///home/me/compose%2Ftxt',
    ])('%s is refused as a compose file before anything is written or downloaded', async (url) => {
        const t = setup();
        const parsed = await t.run({ install_path: '/tmp/xns', compose_url: url });

        expect(parsed.success).toBe(false);
        expect(parsed.error).toContain('.yml or .yaml');
        expect(t.execFile).not.toHaveBeenCalled();
        expect(t.composeUp).not.toHaveBeenCalled();
        expect(t.fs.writeFile).not.toHaveBeenCalled();
    });

    test.each([
        'file:///home/me/docker-compose.yml',
        'file:///home/me/stack.YAML',
        'file://localhost/home/me/my%20compose.Yml',
    ])('%s is accepted as a compose file', async (url) => {
        const t = setup();
        const parsed = await t.run({ install_path: '/tmp/xns', compose_url: url });

        expect(parsed.success).toBe(true);
        expect(parsed.compose_host).toBe('this machine');
    });

    test('every curl call starts with -q so ~/.curlrc is not read', async () => {
        const t = setup();
        await t.run({ install_path: '/tmp/xns', compose_url: 'https://releases.xns.tech/c.yml' });

        const curls = t.execFile.mock.calls.filter((c) => c[0] === 'curl');
        expect(curls.length).toBeGreaterThan(0);
        for (const call of curls) expect(call[1][0]).toBe('-q');
    });

    test('the override download is capped at 1 MiB', async () => {
        const t = setup();
        await t.run({ install_path: '/tmp/xns', compose_url: 'file:///home/me/docker-compose.yml' });

        const args = t.execFile.mock.calls.find((c) => c[0] === 'curl')[1];
        expect(args[args.indexOf('--max-filesize') + 1]).toBe('1048576');
    });

    test('the override download holds at most 1 MiB in memory, whatever the curl version', async () => {
        const t2 = setup();
        await t2.run({ install_path: '/tmp/xns', compose_url: 'file:///home/me/docker-compose.yml' });

        const curl = t2.execFile.mock.calls.find((c) => c[0] === 'curl');
        expect(curl[2].maxBuffer).toBe(1048576);
        expect(curl[1]).not.toContain('-o');
    });

    test('an override larger than 1 MiB is refused and nothing is written', async () => {
        const t2 = setup();
        t2.execFile.mockImplementation((cmd, args, opts, cb) => {
            if (cmd === 'curl') return cb(Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), Buffer.alloc(0), '');
            return cb(null, '', '');
        });
        const parsed = await t2.run({ install_path: '/tmp/xns', compose_url: 'http://192.168.1.10/compose.yml' });

        expect(parsed.success).toBe(false);
        expect(parsed.error).toContain('larger than 1048576 bytes');
        expect(t2.fs.writeFile).not.toHaveBeenCalled();
        expect(t2.composeUp).not.toHaveBeenCalled();
    });

    test('a backslash before @ cannot make curl fetch from a host other than the checked one', async () => {
        const t = setup();
        const raw = 'http://127.0.0.1\\@evil.example/c.yml';
        const parsed = await t.run({ install_path: '/tmp/xns', compose_url: raw });

        expect(parsed.success).toBe(true);
        const curl = t.execFile.mock.calls.find((c) => c[0] === 'curl');
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

    test('a hostname curl would read as a {a,b} pattern is refused before anything is downloaded', async () => {
        const t = setup();
        const parsed = await t.run({ install_path: '/tmp/xns', compose_url: 'http://{a.local/c.yml?,evil.example/c.yml?}' });

        expect(parsed.success).toBe(false);
        expect(t.execFile.mock.calls.find((c) => c[0] === 'curl')).toBeUndefined();
        expect(t.composeUp).not.toHaveBeenCalled();
    });

    test('curl is told not to expand URL patterns on the override path', async () => {
        const t = setup();
        await t.run({ install_path: '/tmp/xns', compose_url: 'http://192.168.1.20/c.yml' });

        const curl = t.execFile.mock.calls.find((c) => c[0] === 'curl');
        expect(curl[1]).toContain('-g');
    });
});
