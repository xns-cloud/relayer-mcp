'use strict';

/**
 * installRelayer.stops.test.js — the default install stops, says why and what
 * to do, and leaves the install folder exactly as it was, when the release
 * files cannot be downloaded or used.
 *
 * The four stops: a download fails, the release .env has no COMPOSE_PROFILES
 * line, a bind_address the release compose ignores, and a temporary folder
 * that cannot be created or read.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { z } = require('zod');
const { readRegistration } = require('./helpers/mockRegistration');
const pkg = require('../../package.json');

const repoRoot = path.resolve(__dirname, '..', '..');

const CHANNEL_COMPOSE_URL = 'https://releases.xns.tech/relayer/release/docker-compose.yml';
const CHANNEL_ENV_URL = 'https://releases.xns.tech/relayer/release/.env';
const STAGE = path.join(os.tmpdir(), 'xns-relayer-install-TEST');
const INSTALL = '/tmp/xns';
const PREFIX = 'Relayer installation failed: ';

const GOOD_COMPOSE = 'services:\n  xns:\n    ports:\n      - "${BIND_ADDRESS:-}${UI_PORT:-8888}:8888"\n';
const GOOD_ENV = 'COMPOSE_PROFILES=loki\n';

// The four stop messages, word for word, with their filled-in values.
const downloadFailed = (host, file) => `${PREFIX}The Relayer release files could not be downloaded from ${host} (the ${file} download failed), so nothing was installed. Check that this machine reaches https://${host}, then run install_relayer again.`;
const incompleteEnv = (host, bugsUrl) => `${PREFIX}The release .env downloaded from ${host} has no COMPOSE_PROFILES line, so the download was cut short or the published release is incomplete, and nothing was installed. Run install_relayer again; if it stops here again, report it at ${bugsUrl}.`;
const bindUnsupported = (value) => `${PREFIX}bind_address ${value} was requested, but the release compose file does not use BIND_ADDRESS on every published port, so the ports would be published on all interfaces. Nothing was installed. Run install_relayer again without bind_address, or pass compose_url pointing at a compose file whose ports use \${BIND_ADDRESS}.`;
const tempFolder = (tmpDir) => `${PREFIX}The release files could not be prepared on this machine: the temporary folder under ${tmpDir} could not be created or read. Nothing was installed. Check that the folder is writable and the disk is not full, then run install_relayer again.`;

const rawError = (text, code) => Object.assign(new Error(text), { code });

/**
 * A fake fs holding `files`, and a curl that writes each URL's body into the
 * path after `-o`, as `curl -fsSL -o <path> <url>` does. A URL in `failing`
 * errors like a 404 and writes nothing. `readFileFails` maps a path to the
 * error its read rejects with.
 */
function build({
    bodies = { [CHANNEL_COMPOSE_URL]: GOOD_COMPOSE, [CHANNEL_ENV_URL]: GOOD_ENV },
    failing = [],
    files = {},
    readFileFails = {},
    mkdtempFails = null,
    rmFails = null,
    channelComposeUrl,
} = {}) {
    const fakeFs = {
        files,
        readFile: jest.fn(async (p) => {
            if (p in readFileFails) throw readFileFails[p];
            if (p in files) return files[p];
            throw rawError(`ENOENT: no such file or directory, open '${p}'`, 'ENOENT');
        }),
        writeFile: jest.fn(async (p, data) => { files[p] = data; }),
        chmod: jest.fn(async () => {}),
        mkdtemp: jest.fn(async (prefix) => {
            if (mkdtempFails) throw mkdtempFails;
            return `${prefix}TEST`;
        }),
        rm: jest.fn(async (dir) => {
            if (rmFails) throw rmFails;
            for (const p of Object.keys(files)) if (p.startsWith(`${dir}/`)) delete files[p];
        }),
    };
    const curlCalls = [];
    const execFile = jest.fn((cmd, args, opts, cb) => {
        if (cmd !== 'curl') return cb(null, '', '');
        const url = args[args.length - 1];
        const out = args[args.indexOf('-o') + 1];
        curlCalls.push({ url, out, timeout: opts && opts.timeout });
        if (failing.includes(url)) return cb(new Error(`curl: (22) The requested URL returned error: 404 ${url}`));
        files[out] = bodies[url] ?? '';
        return cb(null, '', '');
    });
    const composeUp = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const server = { registerTool: jest.fn() };
    const options = { execFile, fs: fakeFs, dockerUtil: { composeUp, findContainer: jest.fn().mockResolvedValue(null) } };
    if (channelComposeUrl) options.channelComposeUrl = channelComposeUrl;
    require('../tools/installRelayer')(server, options);
    const { schema, handler } = readRegistration(server);
    const run = (args = {}) => handler(z.object(schema).parse({ install_path: INSTALL, ...args }));
    return { run, fs: fakeFs, execFile, composeUp, curlCalls };
}

async function stop(ctx, args) {
    const result = await ctx.run(args);
    return { result, parsed: JSON.parse(result.content[0].text) };
}

describe('install_relayer stops', () => {
    let errSpy;
    beforeEach(() => { errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
    afterEach(() => errSpy.mockRestore());
    const logged = () => errSpy.mock.calls.flat().join(' ');

    test('the tool description, the bind_address text and the README promise no bundled copy', () => {
        const server = { registerTool: jest.fn() };
        require('../tools/installRelayer')(server);
        const { description, schema } = readRegistration(server);
        const bindText = schema.bind_address.description;
        const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

        for (const text of [description, bindText]) {
            expect(text).not.toMatch(/bundled/i);
            expect(text).not.toMatch(/fallback/i);
        }
        expect(description).toContain('If the release files cannot be downloaded or used, it stops, says why and what to do, and installs nothing.');
        expect(description).toContain('When bind_address is set and the release compose does not use BIND_ADDRESS on every published port, the tool stops before installing anything and says so.');
        expect(readme).not.toMatch(/bundled/i);
    });

    test('the compose download fails → stops naming docker-compose.yml and the host, after one curl call', async () => {
        const ctx = build({ failing: [CHANNEL_COMPOSE_URL] });
        const { result, parsed } = await stop(ctx);

        expect(result.isError).toBe(true);
        expect(parsed).toEqual({ success: false, error: downloadFailed('releases.xns.tech', 'docker-compose.yml') });
        expect(ctx.curlCalls).toHaveLength(1);
    });

    test('each release download has a 60 s limit, so a stalled download stops instead of hanging', async () => {
        const ctx = build({ failing: [CHANNEL_ENV_URL] });
        await stop(ctx);

        expect(ctx.curlCalls.map((c) => c.timeout)).toEqual([60000, 60000]);
    });

    test('the .env download fails → stops naming .env and the host', async () => {
        const ctx = build({ failing: [CHANNEL_ENV_URL] });
        const { result, parsed } = await stop(ctx);

        expect(result.isError).toBe(true);
        expect(parsed).toEqual({ success: false, error: downloadFailed('releases.xns.tech', '.env') });
    });

    test('a channelComposeUrl on another host → the stop names that host, never releases.xns.tech', async () => {
        const mirror = 'https://mirror.example/x/docker-compose.yml';
        const ctx = build({ channelComposeUrl: mirror, failing: [mirror] });
        const { parsed } = await stop(ctx);

        expect(parsed.error.split('mirror.example')).toHaveLength(3);
        expect(parsed.error).not.toContain('releases.xns.tech');
    });

    test('a release .env with no COMPOSE_PROFILES line → stops, says it is incomplete and where to report it', async () => {
        const ctx = build({ bodies: { [CHANNEL_COMPOSE_URL]: GOOD_COMPOSE, [CHANNEL_ENV_URL]: 'FOO=1\n' } });
        const { result, parsed } = await stop(ctx);

        expect(result.isError).toBe(true);
        expect(parsed.error).toBe(incompleteEnv('releases.xns.tech', pkg.bugs.url));
    });

    test('bind_address set and the release compose names BIND_ADDRESS only in a comment → stops before the .env download', async () => {
        const commentOnly = '# set BIND_ADDRESS to narrow this: ${BIND_ADDRESS}\nports:\n  - "${UI_PORT:-8888}:8888"\n';
        const ctx = build({ bodies: { [CHANNEL_COMPOSE_URL]: commentOnly, [CHANNEL_ENV_URL]: GOOD_ENV } });
        const { result, parsed } = await stop(ctx, { bind_address: '127.0.0.1' });

        expect(result.isError).toBe(true);
        expect(parsed.error).toBe(bindUnsupported('127.0.0.1'));
        expect(ctx.curlCalls).toHaveLength(1);
    });

    test.each([
        ['only in an environment entry', 'services:\n  xns:\n    ports:\n      - "8888:8888"\n    environment:\n      - BIND_ADDRESS=${BIND_ADDRESS}\n'],
        ['on one port of two', 'services:\n  xns:\n    ports:\n      - "${BIND_ADDRESS:-}8888:8888"\n      - "9000:9000"\n'],
        ['on one service of two', 'services:\n  xns:\n    ports:\n      - "${BIND_ADDRESS:-}8888:8888"\n  grafana:\n    ports:\n      - "3000:3000"\n'],
        ['on one flow-list port of two', 'services:\n  xns:\n    ports: ["${BIND_ADDRESS:-}8888:8888", "9000:9000"]\n'],
        ['long syntax with no host_ip', 'services:\n  xns:\n    ports:\n      - target: 8888\n        published: 8888\n    environment:\n      - X=${BIND_ADDRESS}\n'],
        ['nowhere, no ports at all', 'services:\n  xns:\n    image: x\n'],
        ['on one service while another takes its ports from a YAML alias', 'x-ports: &open\n  - "3000:3000"\nservices:\n  xns:\n    ports:\n      - "${BIND_ADDRESS:-}8888:8888"\n  grafana:\n    ports: *open\n'],
    ])('bind_address set and the release compose uses BIND_ADDRESS %s → stops before the .env download', async (_label, compose) => {
        const ctx = build({ bodies: { [CHANNEL_COMPOSE_URL]: compose, [CHANNEL_ENV_URL]: GOOD_ENV } });
        const { result, parsed } = await stop(ctx, { bind_address: '127.0.0.1' });

        expect(result.isError).toBe(true);
        expect(parsed.error).toBe(bindUnsupported('127.0.0.1'));
        expect(ctx.curlCalls).toHaveLength(1);
    });

    describe('a local step on the downloads fails → the temporary-folder stop, no raw OS text', () => {
        test.each([
            ['mkdtemp rejects', () => ({ mkdtempFails: rawError('EACCES: permission denied, mkdtemp', 'EACCES') }), 'EACCES: permission denied, mkdtemp'],
            ['the staged compose read rejects', () => ({ readFileFails: { [`${STAGE}/docker-compose.yml`]: rawError('EIO: i/o error, read', 'EIO') } }), 'EIO: i/o error, read'],
            ['the staged .env read rejects', () => ({ readFileFails: { [`${STAGE}/.env`]: rawError('EACCES: permission denied, open', 'EACCES') } }), 'EACCES: permission denied, open'],
        ])('%s', async (_label, opts, raw) => {
            const ctx = build(opts());
            const { result, parsed } = await stop(ctx);

            expect(result.isError).toBe(true);
            expect(parsed.error).toBe(tempFolder(os.tmpdir()));
            expect(result.content[0].text).not.toContain('EACCES');
            expect(result.content[0].text).not.toContain('EIO');
            expect(logged()).toContain(raw);
        });
    });

    describe('after a stop the install folder is as it was', () => {
        const commentOnly = '# ${BIND_ADDRESS}\nports:\n  - "8888:8888"\n';
        test.each([
            ['the compose download fails', () => ({ failing: [CHANNEL_COMPOSE_URL] }), {}, true],
            ['the .env download fails', () => ({ failing: [CHANNEL_ENV_URL] }), {}, true],
            ['the .env has no COMPOSE_PROFILES', () => ({ bodies: { [CHANNEL_COMPOSE_URL]: GOOD_COMPOSE, [CHANNEL_ENV_URL]: 'FOO=1\n' } }), {}, true],
            ['bind_address the compose ignores', () => ({ bodies: { [CHANNEL_COMPOSE_URL]: commentOnly, [CHANNEL_ENV_URL]: GOOD_ENV } }), { bind_address: '127.0.0.1' }, true],
            ['mkdtemp rejects', () => ({ mkdtempFails: rawError('EACCES: permission denied, mkdtemp', 'EACCES') }), {}, false],
            ['the staged compose read rejects', () => ({ readFileFails: { [`${STAGE}/docker-compose.yml`]: rawError('EIO: i/o error, read', 'EIO') } }), {}, true],
            ['the staged .env read rejects', () => ({ readFileFails: { [`${STAGE}/.env`]: rawError('EACCES: permission denied, open', 'EACCES') } }), {}, true],
        ])('%s → no mkdir, no write, no compose up; the temporary folder is removed', async (_label, opts, args, staged) => {
            const ctx = build(opts());
            const { result } = await stop(ctx, args);

            expect(result.isError).toBe(true);
            expect(ctx.execFile.mock.calls.filter((c) => c[0] === 'mkdir')).toEqual([]);
            expect(ctx.fs.writeFile).not.toHaveBeenCalled();
            expect(ctx.fs.chmod).not.toHaveBeenCalled();
            expect(ctx.composeUp).not.toHaveBeenCalled();
            if (staged) {
                expect(ctx.fs.rm.mock.calls).toEqual([[STAGE, { recursive: true, force: true }]]);
            } else {
                expect(ctx.fs.rm).not.toHaveBeenCalled();
            }
        });

        test('an earlier install’s docker-compose.yml and .env are untouched when the .env download fails', async () => {
            const files = { [`${INSTALL}/docker-compose.yml`]: 'old-compose', [`${INSTALL}/.env`]: 'OLD=1' };
            const ctx = build({ files, failing: [CHANNEL_ENV_URL] });
            await stop(ctx);

            expect(ctx.fs.files[`${INSTALL}/docker-compose.yml`]).toBe('old-compose');
            expect(ctx.fs.files[`${INSTALL}/.env`]).toBe('OLD=1');
        });

        test('a temporary folder that cannot be removed does not replace the stop message', async () => {
            const ctx = build({ failing: [CHANNEL_COMPOSE_URL], rmFails: rawError('EBUSY: resource busy or locked, rmdir', 'EBUSY') });
            const { result, parsed } = await stop(ctx);

            expect(parsed.error).toBe(downloadFailed('releases.xns.tech', 'docker-compose.yml'));
            expect(result.content[0].text).not.toContain('EBUSY');
            expect(logged()).toContain('EBUSY: resource busy or locked, rmdir');
        });
    });
});
