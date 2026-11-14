'use strict';

const { z } = require('zod');

describe('install_relayer', () => {
    let server;

    beforeEach(() => {
        server = { registerTool: jest.fn() };
    });

    // Wrap the handler so the registered Zod shape is applied first — mirrors how
    // the MCP SDK validates + fills defaults before the handler ever runs.
    function registerWithOptions(opts) {
        const { readRegistration } = require('./helpers/mockRegistration');
        const register = require('../tools/installRelayer');
        register(server, opts);
        const { schema, handler } = readRegistration(server);
        return (args) => handler(z.object(schema).parse(args));
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
            compose_url: 'https://releases.xns.tech/docker-compose.yml',
            install_path: '/tmp/test-install',
        });

        // Verify mkdir was called via execFile
        expect(execFileCalls[0].cmd).toBe('mkdir');
        expect(execFileCalls[0].args).toContain('-p');

        // Verify curl was called via execFile
        expect(execFileCalls[1].cmd).toBe('curl');
        expect(execFileCalls[1].args).toContain('-fsS');
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
            compose_url: 'https://releases.xns.tech/docker-compose.yml',
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
            compose_url: 'https://releases.xns.tech/bad.yml',
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
            compose_url: 'https://releases.xns.tech/compose.yml',
            install_path: '/tmp/test',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(result.isError).toBe(true);
    });

    // --- Default path: fetch the channel bundle, user authors nothing ---------

    const CHANNEL_COMPOSE_URL = 'https://releases.xns.tech/relayer/release/docker-compose.yml';
    const CHANNEL_ENV_URL = 'https://releases.xns.tech/relayer/release/.env';
    // The temporary folder every fake mkdtemp below hands back.
    const STAGE = require('path').join(require('os').tmpdir(), 'xns-relayer-install-TEST');

    // Per-path fake fs. A path reads what curl wrote there (see curlWritingInto)
    // or, when nothing was written, `fetchedEnv` for a .env and DEFAULT_COMPOSE
    // for a docker-compose.yml — the release files curl "downloaded".
    // Any other path is ENOENT.
    // The publisher refuses to ship a release .env without this line.
    const RELEASE_PROFILE_LINE = 'COMPOSE_PROFILES=${RELAYER_AUDIT_MODE:-loki}\n';
    const DEFAULT_COMPOSE = 'services:\n  xns:\n    ports:\n      - "${BIND_ADDRESS:-}${UI_PORT:-8888}:8888"\n';

    function fakeFs({ fetchedEnv = RELEASE_PROFILE_LINE } = {}) {
        const writes = {};
        return {
            writes,
            readFile: jest.fn(async (p) => {
                if (p in writes) return writes[p];
                if (p.endsWith('/.env')) return fetchedEnv;
                if (p.endsWith('/docker-compose.yml')) return DEFAULT_COMPOSE;
                throw Object.assign(new Error(`ENOENT: no such file, open '${p}'`), { code: 'ENOENT' });
            }),
            writeFile: jest.fn(async (p, data) => { writes[p] = data; }),
            chmod: jest.fn(async () => {}),
            mkdtemp: jest.fn(async (prefix) => `${prefix}TEST`),
            rm: jest.fn(async (dir) => {
                for (const p of Object.keys(writes)) if (p.startsWith(`${dir}/`)) delete writes[p];
            }),
        };
    }

    // A curl that writes the body it "downloads" into the fake fs, as the
    // real `curl -fsSL -o <path> <url>` does, so a second run sees the fresh
    // download rather than the previous run's file. `bodies` maps URL → body;
    // a URL in `failing` errors like a 404.
    function curlWritingInto(fs, bodies, failing = []) {
        const calls = [];
        const execFile = jest.fn((cmd, args, opts, cb) => {
            if (cmd !== 'curl') return cb(null, '', '');
            const url = args[args.length - 1];
            const out = args[args.indexOf('-o') + 1];
            calls.push({ url, out });
            if (failing.includes(url)) return cb(new Error(`curl: (22) The requested URL returned error: 404 ${url}`));
            fs.writes[out] = bodies[url] ?? '';
            return cb(null, '', '');
        });
        return { execFile, calls };
    }

    // The released install IS the channel bundle (relayer + monitoring stack).
    // A first-time user supplies no compose_url; the tool fetches the canonical
    // beta channel compose and writes the .env for them. Guards the live gap
    // where an install without the monitoring stack left the UI's Monitoring
    // section dead.
    test('no compose_url → fetches the channel bundle + writes .env', async () => {
        const execFileCalls = [];
        const fs = fakeFs();
        const composeUp = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
        const handler = registerWithOptions({
            execFile: jest.fn((cmd, args, opts, cb) => { execFileCalls.push({ cmd, args }); cb(null, '', ''); }),
            fs,
            dockerUtil: { composeUp, findContainer: jest.fn().mockResolvedValue(null) },
        });

        const result = await handler({ install_path: '/tmp/xns' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.source).toBe('channel');
        // curl fetched the canonical channel compose into the temporary folder.
        const curl = execFileCalls.find((c) => c.cmd === 'curl');
        expect(curl.args).toContain(CHANNEL_COMPOSE_URL);
        expect(curl.args).toContain(`${STAGE}/docker-compose.yml`);
        // The downloaded compose and the .env with default ports land in the install folder.
        expect(fs.writes['/tmp/xns/docker-compose.yml']).toBe(DEFAULT_COMPOSE);
        expect(fs.writes['/tmp/xns/.env']).toBe(`${RELEASE_PROFILE_LINE}UI_PORT=8888\nS3_PORT=9000\nBIND_ADDRESS=\n`);
    });

    // The release files are downloaded into a temporary folder, checked there,
    // and only then copied into the install folder.
    test('bind_address set and good release files → downloads staged, then copied into the install folder', async () => {
        const fs = fakeFs();
        const releaseCompose = 'services:\n  xns:\n    ports:\n      - "${BIND_ADDRESS}8888:8888"\n';
        const { execFile, calls } = curlWritingInto(fs, {
            [CHANNEL_COMPOSE_URL]: releaseCompose,
            [CHANNEL_ENV_URL]: 'COMPOSE_PROFILES=loki\n',
        });
        const handler = registerWithOptions({
            execFile,
            fs,
            dockerUtil: { composeUp: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }), findContainer: jest.fn().mockResolvedValue(null) },
        });

        const parsed = JSON.parse((await handler({ install_path: '/tmp/xns', bind_address: '127.0.0.1' })).content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.source).toBe('channel');
        expect(parsed).not.toHaveProperty('reason');
        expect(parsed).not.toHaveProperty('note');
        expect(calls.map((c) => c.out)).toEqual([`${STAGE}/docker-compose.yml`, `${STAGE}/.env`]);
        expect(fs.writes['/tmp/xns/docker-compose.yml']).toBe(releaseCompose);
        expect(fs.writes['/tmp/xns/.env']).toBe('COMPOSE_PROFILES=loki\nUI_PORT=8888\nS3_PORT=9000\nBIND_ADDRESS=127.0.0.1:\n');
        expect(fs.writeFile).toHaveBeenCalledWith('/tmp/xns/.env', expect.any(String), { mode: 0o600 });
        expect(fs.rm).toHaveBeenCalledWith(STAGE, { recursive: true, force: true });
    });

    // --- E-A9 AC-25 (TP-31): release compose + release .env, fetched each run ---

    describe('release channel .env (AC-25)', () => {
        const RELEASE_ENV = [
            '# XNS Relayer release channel',
            '# Audit mode: loki (default) or off',
            'COMPOSE_PROFILES=${RELAYER_AUDIT_MODE:-loki}',
            '',
            '# RELAYER_LOG_LEVEL=info',
            '',
        ].join('\n');
        const PORT_LINES = 'UI_PORT=8888\nS3_PORT=9000\nBIND_ADDRESS=\n';

        function build({ bodies } = {}) {
            const fs = fakeFs();
            const curl = curlWritingInto(fs, bodies || {
                [CHANNEL_COMPOSE_URL]: 'RELEASE_COMPOSE\n',
                [CHANNEL_ENV_URL]: RELEASE_ENV,
            });
            const composeUp = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
            const handler = registerWithOptions({
                execFile: curl.execFile,
                fs,
                dockerUtil: { composeUp, findContainer: jest.fn().mockResolvedValue(null) },
            });
            return { handler, fs, curl, composeUp };
        }

        test('fetches the release compose and the release .env, never the beta channel', async () => {
            const { handler, curl } = build();

            const parsed = JSON.parse((await handler({ install_path: '/tmp/xns' })).content[0].text);

            expect(parsed.success).toBe(true);
            expect(parsed.source).toBe('channel');
            expect(curl.calls).toEqual([
                { url: CHANNEL_COMPOSE_URL, out: `${STAGE}/docker-compose.yml` },
                { url: CHANNEL_ENV_URL, out: `${STAGE}/.env` },
            ]);
            for (const { url } of curl.calls) {
                expect(url).toContain('/relayer/release/');
                expect(url).not.toContain('/beta/');
            }
        });

        // M-L15: every fetched line is kept (COMPOSE_PROFILES, comments, blank
        // lines) and the port lines are appended once — not once per run.
        test('keeps every fetched line and appends the port lines once, across two runs', async () => {
            const { handler, fs, curl } = build();

            await handler({ install_path: '/tmp/xns' });
            await handler({ install_path: '/tmp/xns' });

            expect(fs.writes['/tmp/xns/.env']).toBe(`${RELEASE_ENV}${PORT_LINES}`);
            expect(fs.writes['/tmp/xns/.env']).toContain('COMPOSE_PROFILES=${RELAYER_AUDIT_MODE:-loki}');
            expect(fs.writes['/tmp/xns/.env'].match(/^UI_PORT=/gm)).toHaveLength(1);
            // A fresh .env download on each run.
            expect(curl.calls.filter((c) => c.url === CHANNEL_ENV_URL)).toHaveLength(2);
            // The compose on disk is the release one, untouched by the .env step.
            expect(fs.writes['/tmp/xns/docker-compose.yml']).toBe('RELEASE_COMPOSE\n');
        });

        // M-L13: a fetched .env with no final newline must not glue UI_PORT
        // onto its last line.
        test('a fetched .env without a final newline still gets UI_PORT on its own line', async () => {
            const { handler, fs } = build({
                bodies: { [CHANNEL_COMPOSE_URL]: 'RELEASE_COMPOSE\n', [CHANNEL_ENV_URL]: 'COMPOSE_PROFILES=loki' },
            });

            await handler({ install_path: '/tmp/xns', ui_port: 18888 });

            expect(fs.writes['/tmp/xns/.env']).toBe('COMPOSE_PROFILES=loki\nUI_PORT=18888\nS3_PORT=9000\nBIND_ADDRESS=\n');
        });

        // Compose lets the process environment beat .env, so an inherited value would
        // leave the audit sink on with no sidecars to tail and rotate it.
        test.each([
            ['the channel path', {}, undefined],
            ['the compose_url path, which writes no .env', { compose_url: 'https://releases.xns.tech/c.yml' }, 'other'],
        ])('inherited COMPOSE_PROFILES on %s', async (_label, { compose_url }, expected) => {
            const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
            const inherited = process.env.COMPOSE_PROFILES;
            process.env.COMPOSE_PROFILES = 'other';
            try {
                const { handler, composeUp } = build();
                await handler({ install_path: '/tmp/xns', compose_url });
                expect(composeUp.mock.calls[0][1].env.COMPOSE_PROFILES).toBe(expected);
            } finally {
                if (inherited === undefined) delete process.env.COMPOSE_PROFILES;
                else process.env.COMPOSE_PROFILES = inherited;
                errSpy.mockRestore();
            }
        });

    });

    // --- E-A2 / D5 / AC-8: the installer states the binding at install time ---

    // The installer is one of D5's three out-of-band channels. It must print the
    // binding it actually composed, so a refused connection is explainable later.
    test('success JSON states the binding it composed (non-default ports)', async () => {
        const fs = fakeFs();
        const handler = registerWithOptions({
            execFile: jest.fn((cmd, args, opts, cb) => cb(null, '', '')),
            fs,
            dockerUtil: {
                composeUp: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
                findContainer: jest.fn().mockResolvedValue(null),
            },
        });

        const result = await handler({ install_path: '/tmp/xns', ui_port: 9999, s3_port: 9100 });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.binding.ui).toEqual({ host_port: 9999, container_port: 8888 });
        expect(parsed.binding.s3).toEqual({ host_port: 9100, container_port: 9000 });
        expect(parsed.binding.composed_from).toContain('/tmp/xns/.env');
        expect(parsed.binding.composed_from).toContain('UI_PORT=9999');
    });

    // PRD §7 two-statement rule (AC-12): what the process asserts is kept apart
    // from what is only CONFIGURED. This process cannot see the host's actual
    // Docker publication, so it must say so and point at the host-side check rather
    // than asserting reachability it cannot verify.
    test('binding labels reachability as configured-not-verified and points at docker port', async () => {
        const fs = fakeFs();
        const handler = registerWithOptions({
            execFile: jest.fn((cmd, args, opts, cb) => cb(null, '', '')),
            fs,
            dockerUtil: {
                composeUp: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
                findContainer: jest.fn().mockResolvedValue(null),
            },
        });

        const parsed = JSON.parse((await handler({ install_path: '/tmp/xns' })).content[0].text);

        expect(parsed.binding.reachability).toMatch(/configured/i);
        expect(parsed.binding.reachability).toMatch(/not verified/i);
        expect(parsed.binding.reachability).toContain('docker port');
        // No merged claim: the asserted half never says "reachable".
        expect(parsed.binding.composed_from).not.toMatch(/reachable/i);
    });

    // The compose_url override writes no .env — the readout must not claim it did.
    test('compose_url override → binding does not claim an .env was written', async () => {
        const fs = fakeFs();
        const handler = registerWithOptions({
            execFile: jest.fn((cmd, args, opts, cb) => cb(null, '', '')),
            fs,
            dockerUtil: {
                composeUp: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
                findContainer: jest.fn().mockResolvedValue(null),
            },
        });

        const result = await handler({
            install_path: '/tmp/xns',
            compose_url: 'https://releases.xns.tech/docker-compose.yml',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.binding.composed_from).not.toContain('/tmp/xns/.env');
        expect(parsed.binding.composed_from).toContain('no .env written');
        expect(parsed.binding.composed_from).toContain('docker compose');
        expect(fs.writeFile).not.toHaveBeenCalled();
    });

    // A compose_url override downloads straight into the install folder, with no
    // temporary folder.
    test('compose_url override → mkdir, then curl into the install folder, no temporary folder', async () => {
        const fs = fakeFs();
        const execFile = jest.fn((cmd, args, opts, cb) => cb(null, '', ''));
        const handler = registerWithOptions({
            execFile,
            fs,
            dockerUtil: { composeUp: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }), findContainer: jest.fn().mockResolvedValue(null) },
        });

        const parsed = JSON.parse((await handler({ install_path: '/tmp/xns', compose_url: 'https://releases.xns.tech/c.yml' })).content[0].text);

        expect(execFile.mock.calls.map((c) => c[0])).toEqual(['mkdir', 'curl']);
        const curlArgs = execFile.mock.calls[1][1];
        expect(curlArgs[curlArgs.indexOf('-o') + 1]).toBe('/tmp/xns/docker-compose.yml');
        expect(fs.mkdtemp).not.toHaveBeenCalled();
        expect(parsed.source).toBe('compose_url');
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

        expect(fs.writes['/tmp/xns/.env']).toBe(`${RELEASE_PROFILE_LINE}UI_PORT=18888\nS3_PORT=19000\nBIND_ADDRESS=\n`);
        // composeUp runs in the install dir with the ports in env.
        const [composePath, execOpts] = composeUp.mock.calls[0];
        expect(composePath).toBe('/tmp/xns/docker-compose.yml');
        expect(execOpts.cwd).toBe('/tmp/xns');
        expect(execOpts.env.UI_PORT).toBe('18888');
        expect(execOpts.env.S3_PORT).toBe('19000');
    });

    // --- E-A3 / W12: bind_address flows into .env + composeUp env + success JSON ---

    test('bind_address=127.0.0.1 → .env + composeUp env carry the prefix', async () => {
        const fs = fakeFs();
        const composeUp = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
        const handler = registerWithOptions({
            execFile: jest.fn((cmd, args, opts, cb) => cb(null, '', '')),
            fs,
            dockerUtil: { composeUp, findContainer: jest.fn().mockResolvedValue(null) },
        });

        const result = await handler({ install_path: '/tmp/xns', bind_address: '127.0.0.1' });
        const parsed = JSON.parse(result.content[0].text);

        expect(fs.writes['/tmp/xns/.env']).toBe(`${RELEASE_PROFILE_LINE}UI_PORT=8888\nS3_PORT=9000\nBIND_ADDRESS=127.0.0.1:\n`);
        const [, execOpts] = composeUp.mock.calls[0];
        expect(execOpts.env.BIND_ADDRESS).toBe('127.0.0.1:');
        expect(parsed.binding.bind_address).toBe('127.0.0.1');
    });

    // Pre-push R5 (input boundaries): the .env this installer authors is auto-loaded
    // by Compose, so a newline in bind_address injects further KEY=VALUE lines. The
    // dangerous one is a second UI_PORT — last value wins, so the box republishes on
    // a port the success JSON still reports as 8888.
    test('bind_address containing a newline is rejected before it reaches the .env', async () => {
        const fs = fakeFs();
        const composeUp = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
        const handler = registerWithOptions({
            execFile: jest.fn((cmd, args, opts, cb) => cb(null, '', '')),
            fs,
            dockerUtil: { composeUp, findContainer: jest.fn().mockResolvedValue(null) },
        });

        // The schema rejects at parse time, which the harness runs synchronously
        // before the handler is ever entered — so this throws rather than rejecting.
        expect(() =>
            handler({ install_path: '/tmp/xns', bind_address: '127.0.0.1\nUI_PORT=1\nEXTRA=malicious' }),
        ).toThrow(/bind_address must be empty \(all interfaces\)/);

        // Nothing was written and nothing was started.
        expect(fs.writes['/tmp/xns/.env']).toBeUndefined();
        expect(composeUp).not.toHaveBeenCalled();
    });

    test('bind_address accepts ordinary IPv4 and bracketed IPv6', async () => {
        const handler = registerWithOptions({
            execFile: jest.fn((cmd, args, opts, cb) => cb(null, '', '')),
            fs: fakeFs(),
            dockerUtil: {
                composeUp: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
                findContainer: jest.fn().mockResolvedValue(null),
            },
        });

        for (const addr of ['127.0.0.1', '192.168.1.221', '0.0.0.0', '[::1]', '[2001:db8::1]', '']) {
            const res = await handler({ install_path: '/tmp/xns', bind_address: addr });
            expect(res.isError).not.toBe(true);
            expect(JSON.parse(res.content[0].text).success).toBe(true);
        }
    });

    // A charset-only guard let these through: each is an address form Docker
    // cannot bind, so it would surface as an invalid port mapping at `compose up`
    // rather than as a clear rejection here.
    test('bind_address rejects malformed address forms', async () => {
        const fs = fakeFs();
        const composeUp = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
        const handler = registerWithOptions({
            execFile: jest.fn((cmd, args, opts, cb) => cb(null, '', '')),
            fs,
            dockerUtil: { composeUp, findContainer: jest.fn().mockResolvedValue(null) },
        });

        const malformed = [
            '[',                   // unterminated bracket
            '[::1',                // unclosed bracketed IPv6
            '[not:an:ipv6]',       // bracketed but not a valid IPv6 body
            '::1',                 // raw IPv6 — Docker requires brackets
            '999.999.999.999',     // out-of-range IPv4 octets
            '127.0.0.1:',          // trailing port separator
            '127.0.0.1:8888',      // address:port, not an address
            '1.2.3',               // truncated IPv4
            // Hostnames: the Compose ports host component is an IP address, so
            // "localhost:8888:8888" is a malformed mapping, not a resolved one.
            'localhost',
            'relayer.example.com',
        ];

        for (const addr of malformed) {
            expect(() => handler({ install_path: '/tmp/xns', bind_address: addr }))
                .toThrow(/bind_address must be empty \(all interfaces\)/);
        }

        expect(fs.writes['/tmp/xns/.env']).toBeUndefined();
        expect(composeUp).not.toHaveBeenCalled();
    });

    test('bind_address default (empty) → success JSON says all interfaces', async () => {
        const fs = fakeFs();
        const composeUp = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
        const handler = registerWithOptions({
            execFile: jest.fn((cmd, args, opts, cb) => cb(null, '', '')),
            fs,
            dockerUtil: { composeUp, findContainer: jest.fn().mockResolvedValue(null) },
        });

        const parsed = JSON.parse((await handler({ install_path: '/tmp/xns' })).content[0].text);

        expect(parsed.binding.bind_address).toBe('0.0.0.0 (all interfaces)');
        expect(parsed.binding.composed_from).toContain('BIND_ADDRESS=');
    });

    // --- E-A3 / W12: bind_address_applied honesty per source path ---

    test('channel path whose compose references BIND_ADDRESS → source channel, bind_address_applied says yes', async () => {
        const fs = fakeFs();
        const { execFile } = curlWritingInto(fs, { [CHANNEL_COMPOSE_URL]: 'ports:\n  - ${BIND_ADDRESS:-}${UI_PORT:-8888}:8888\n', [CHANNEL_ENV_URL]: RELEASE_PROFILE_LINE });
        const handler = registerWithOptions({
            execFile,
            fs,
            dockerUtil: {
                composeUp: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
                findContainer: jest.fn().mockResolvedValue(null),
            },
        });

        const parsed = JSON.parse((await handler({ install_path: '/tmp/xns', bind_address: '127.0.0.1' })).content[0].text);

        expect(parsed.source).toBe('channel');
        expect(parsed.reason).toBeUndefined();
        expect(parsed.binding.bind_address_applied).toMatch(/^yes — the channel compose/);
    });

    test('no bind_address and the channel compose lacks BIND_ADDRESS → the channel compose stays', async () => {
        const fs = fakeFs();
        const { execFile } = curlWritingInto(fs, { [CHANNEL_COMPOSE_URL]: 'ports:\n  - "8888:8888"\n', [CHANNEL_ENV_URL]: RELEASE_PROFILE_LINE });
        const handler = registerWithOptions({
            execFile,
            fs,
            dockerUtil: { composeUp: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }), findContainer: jest.fn().mockResolvedValue(null) },
        });

        const parsed = JSON.parse((await handler({ install_path: '/tmp/xns' })).content[0].text);

        expect(parsed.source).toBe('channel');
        expect(fs.writes['/tmp/xns/docker-compose.yml']).toBe('ports:\n  - "8888:8888"\n');
    });

    // SEC-1: the .env carries webhook/SMTP secrets.
    test('the .env is written owner-only (0600) on the channel', async () => {
        const fs = fakeFs();
        const handler = registerWithOptions({
            execFile: jest.fn((cmd, args, opts, cb) => cb(null, '', '')),
            fs,
            dockerUtil: { composeUp: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }), findContainer: jest.fn().mockResolvedValue(null) },
        });
        await handler({ install_path: '/tmp/xns' });

        expect(fs.writeFile).toHaveBeenCalledWith('/tmp/xns/.env', expect.any(String), { mode: 0o600 });
        expect(fs.chmod).toHaveBeenCalledWith('/tmp/xns/.env', 0o600);
    });

    test.each([
        ['block list with comments in it and after each item', 'services:\n  xns:\n    ports:\n      # BIND_ADDRESS picks the interface\n      - "${BIND_ADDRESS:-}${UI_PORT:-8888}:8888"   # web dashboard\n      - "${BIND_ADDRESS:-}${S3_PORT:-9000}:9000"   # S3 API\n    environment:\n      - NODE_ENV=production\n  grafana:\n    image: grafana/grafana\n'],
        ['flow list', 'services:\n  xns:\n    ports: ["${BIND_ADDRESS:-}8888:8888", "${BIND_ADDRESS:-}9000:9000"]\n'],
        ['unquoted short syntax', 'services:\n  xns:\n    ports:\n      - ${BIND_ADDRESS:-}8888:8888\n'],
        ['items at the key indent', 'services:\n  xns:\n    ports:\n    - "${BIND_ADDRESS:-}8888:8888"\n    image: x\n'],
    ])('bind_address set and every published port uses BIND_ADDRESS (%s) → installs', async (_label, compose) => {
        const fs = fakeFs();
        const { execFile } = curlWritingInto(fs, { [CHANNEL_COMPOSE_URL]: compose, [CHANNEL_ENV_URL]: RELEASE_PROFILE_LINE });
        const composeUp = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
        const handler = registerWithOptions({
            execFile,
            fs,
            dockerUtil: { composeUp, findContainer: jest.fn().mockResolvedValue(null) },
        });

        const parsed = JSON.parse((await handler({ install_path: '/tmp/xns', bind_address: '127.0.0.1' })).content[0].text);

        expect(composeUp).toHaveBeenCalledTimes(1);
        expect(parsed.binding.bind_address_applied).toMatch(/^yes — the channel compose uses BIND_ADDRESS on every published port/);
    });

    test('compose_url path → bind_address_applied says unknown', async () => {
        const handler = registerWithOptions({
            execFile: jest.fn((cmd, args, opts, cb) => cb(null, '', '')),
            dockerUtil: {
                composeUp: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
                findContainer: jest.fn().mockResolvedValue(null),
            },
        });

        const parsed = JSON.parse((await handler({
            install_path: '/tmp/xns',
            bind_address: '10.0.0.1',
            compose_url: 'https://releases.xns.tech/custom.yml',
        })).content[0].text);

        expect(parsed.source).toBe('compose_url');
        expect(parsed.binding.bind_address_applied).toMatch(/unknown/);
    });

    // --- E-A3 / W12: TLS switches in success JSON ---

    test('TLS switches default to off in success JSON', async () => {
        const fs = fakeFs();
        const handler = registerWithOptions({
            execFile: jest.fn((cmd, args, opts, cb) => cb(null, '', '')),
            fs,
            dockerUtil: {
                composeUp: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
                findContainer: jest.fn().mockResolvedValue(null),
            },
        });

        const parsed = JSON.parse((await handler({ install_path: '/tmp/xns' })).content[0].text);

        expect(parsed.tls.ui_tls_enabled.requested).toBe(false);
        expect(parsed.tls.ui_tls_enabled.effective).toBe(false);
        expect(parsed.tls.s3_tls_enabled.requested).toBe(false);
        expect(parsed.tls.s3_tls_enabled.effective).toBe(false);
    });

    test('TLS switches requested=true → effective still false (not wired)', async () => {
        const fs = fakeFs();
        const handler = registerWithOptions({
            execFile: jest.fn((cmd, args, opts, cb) => cb(null, '', '')),
            fs,
            dockerUtil: {
                composeUp: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
                findContainer: jest.fn().mockResolvedValue(null),
            },
        });

        const parsed = JSON.parse((await handler({
            install_path: '/tmp/xns',
            ui_tls_enabled: true,
            s3_tls_enabled: true,
        })).content[0].text);

        expect(parsed.tls.ui_tls_enabled.requested).toBe(true);
        expect(parsed.tls.ui_tls_enabled.effective).toBe(false);
        expect(parsed.tls.ui_tls_enabled.note).toMatch(/not wired/i);
        expect(parsed.tls.s3_tls_enabled.requested).toBe(true);
        expect(parsed.tls.s3_tls_enabled.effective).toBe(false);
        expect(parsed.tls.s3_tls_enabled.note).toMatch(/not wired/i);
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
                    image: 'releases.xns.tech/xns-relayer:alpha-latest',
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

    // --- W3-AC4: channelComposeUrl injectable seam ---

    // Override is honored: a custom channelComposeUrl replaces the default channel URL.
    test('channelComposeUrl override is honored (custom URL used, not default)', async () => {
        const execFileCalls = [];
        const fs = fakeFs();
        const handler = registerWithOptions({
            execFile: jest.fn((cmd, args, opts, cb) => { execFileCalls.push({ cmd, args }); cb(null, '', ''); }),
            fs,
            channelComposeUrl: 'https://custom.example.com/my-compose.yml',
            dockerUtil: {
                composeUp: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
                findContainer: jest.fn().mockResolvedValue(null),
            },
        });

        const result = await handler({ install_path: '/tmp/xns' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        const curl = execFileCalls.find((c) => c.cmd === 'curl');
        expect(curl.args).toContain('https://custom.example.com/my-compose.yml');
        expect(curl.args).not.toContain(CHANNEL_COMPOSE_URL);
    });

    // No override: production uses the default channel URL — byte-identical behavior.
    test('no channelComposeUrl override → default channel URL used', async () => {
        const execFileCalls = [];
        const fs = fakeFs();
        const handler = registerWithOptions({
            execFile: jest.fn((cmd, args, opts, cb) => { execFileCalls.push({ cmd, args }); cb(null, '', ''); }),
            fs,
            // No channelComposeUrl in options — should fall through to module default.
            dockerUtil: {
                composeUp: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
                findContainer: jest.fn().mockResolvedValue(null),
            },
        });

        const result = await handler({ install_path: '/tmp/xns' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        const curl = execFileCalls.find((c) => c.cmd === 'curl');
        expect(curl.args).toContain(CHANNEL_COMPOSE_URL);
    });

    // BUG-229: install_relayer writes its files on the machine running the MCP
    // but compose up runs on the Docker host. With a remote daemon it refuses
    // before touching anything.
    describe('caught error text never reaches the client', () => {
        const RAW = 'EACCES: permission denied, open /home/alice/.secret/thing';
        let errSpy;
        beforeEach(() => { errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
        afterEach(() => errSpy.mockRestore());

        function stubFs() {
            return {
                readFile: jest.fn().mockResolvedValue('services: {}\nCOMPOSE_PROFILES=loki\n'),
                writeFile: jest.fn().mockResolvedValue(),
                chmod: jest.fn().mockResolvedValue(),
                mkdtemp: jest.fn(async (prefix) => `${prefix}TEST`),
                rm: jest.fn().mockResolvedValue(),
            };
        }

        function handlerWith({ execFile, composeUp, fs = stubFs() }) {
            return registerWithOptions({
                execFile,
                fs,
                dockerUtil: {
                    composeUp: composeUp || jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
                    findContainer: jest.fn().mockResolvedValue(null),
                },
            });
        }

        test('mkdir failure → fixed message to the client, raw error only in the server log', async () => {
            const fs = stubFs();
            const execFile = jest.fn((cmd, args, opts, cb) => cb(cmd === 'mkdir' ? new Error(RAW) : null, '', ''));
            const handler = handlerWith({ execFile, fs });
            const result = await handler({ install_path: '/opt/xns-relayer' });
            const parsed = JSON.parse(result.content[0].text);

            expect(result.isError).toBe(true);
            // The folder is created after both downloads are checked.
            expect(execFile.mock.calls.map((c) => c[0])).toEqual(['curl', 'curl', 'mkdir']);
            expect(parsed.error).toBe('Relayer installation failed: Failed to create directory /opt/xns-relayer — check that the path is writable on this machine and no file sits at or along it');
            expect(fs.writeFile).not.toHaveBeenCalled();
            expect(result.content[0].text).not.toContain('EACCES');
            expect(errSpy.mock.calls.flat().join(' ')).toContain(RAW);
        });

        test('compose up failure → the install files stay; only the temporary folder is removed', async () => {
            const fs = stubFs();
            const handler = handlerWith({
                execFile: jest.fn((cmd, args, opts, cb) => cb(null, '', '')),
                composeUp: jest.fn().mockRejectedValue(new Error('boom')),
                fs,
            });
            const parsed = JSON.parse((await handler({ install_path: '/tmp/xns' })).content[0].text);

            expect(parsed.error).toBe('Relayer installation failed: See server log for detail.');
            expect(fs.rm.mock.calls).toEqual([[STAGE, { recursive: true, force: true }]]);
        });

        test('compose up failure → generic message, raw error only in the server log', async () => {
            const handler = handlerWith({
                execFile: jest.fn((cmd, args, opts, cb) => cb(null, '', '')),
                composeUp: jest.fn().mockRejectedValue(new Error(RAW)),
            });
            const result = await handler({ install_path: '/opt/xns-relayer' });
            const parsed = JSON.parse(result.content[0].text);

            expect(result.isError).toBe(true);
            expect(parsed.error).toBe('Relayer installation failed: See server log for detail.');
            expect(result.content[0].text).not.toContain('EACCES');
            expect(errSpy.mock.calls.flat().join(' ')).toContain(RAW);
        });

        test('compose_url download failure → fixed message, no curl text', async () => {
            const handler = handlerWith({ execFile: jest.fn((cmd, args, opts, cb) => cb(cmd === 'curl' ? new Error(RAW) : null, '', '')) });
            const result = await handler({ install_path: '/opt/xns-relayer', compose_url: 'https://releases.xns.tech/dc.yml' });
            const parsed = JSON.parse(result.content[0].text);

            expect(result.isError).toBe(true);
            expect(parsed.error).toBe('Relayer installation failed: Failed to download compose file');
            expect(result.content[0].text).not.toContain('EACCES');
            expect(errSpy.mock.calls.flat().join(' ')).toContain(RAW);
        });

    });

    describe('remote Docker host — install refuses', () => {
        const { createDockerUtil } = require('../lib/dockerUtil');

        // Fakes for every side effect the install could have. Real detection
        // (createDockerUtil) feeds the gate when `env`/`contextEndpoint` is given.
        function build({ env, contextEndpoint, getDockerHost } = {}) {
            const installExec = jest.fn((cmd, args, opts, cb) => cb(null, '', ''));
            const writeFile = jest.fn().mockResolvedValue();
            const readFile = jest.fn().mockResolvedValue('services: {}\nCOMPOSE_PROFILES=loki\n');
            const dockerExec = jest.fn((cmd, args, opts, cb) => {
                if (args[0] === 'context') return cb(null, `${contextEndpoint || 'unix:///var/run/docker.sock'}\n`, '');
                return cb(null, '', '');
            });
            let dockerUtil;
            if (getDockerHost) {
                dockerUtil = {
                    composeUp: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
                    findContainer: jest.fn().mockResolvedValue(null),
                    getDockerHost,
                };
            } else {
                dockerUtil = createDockerUtil({ execFile: dockerExec, env: env || {} });
                jest.spyOn(dockerUtil, 'composeUp');
                jest.spyOn(dockerUtil, 'findContainer');
            }
            const fs = { readFile, writeFile, chmod: jest.fn().mockResolvedValue(), mkdtemp: jest.fn(async (prefix) => `${prefix}TEST`), rm: jest.fn().mockResolvedValue() };
            const handler = registerWithOptions({ execFile: installExec, fs, dockerUtil });
            return { handler, installExec, writeFile, readFile, dockerExec, dockerUtil };
        }

        function expectNothingHappened({ installExec, writeFile, dockerExec, dockerUtil }) {
            expect(installExec).not.toHaveBeenCalled();          // no mkdir, no curl
            expect(writeFile).not.toHaveBeenCalled();            // no compose or .env
            expect(dockerUtil.composeUp).not.toHaveBeenCalled();
            expect(dockerUtil.findContainer).not.toHaveBeenCalled();
            // Real-util runs: the only docker call allowed is the context lookup.
            for (const call of dockerExec.mock.calls) {
                expect(call[1]).not.toContain('compose');
            }
        }

        test('DOCKER_HOST=ssh://user@box → refuses, names box, touches nothing', async () => {
            const ctx = build({ env: { DOCKER_HOST: 'ssh://user@box' } });
            const result = await ctx.handler({ install_path: '/opt/xns-relayer' });
            const parsed = JSON.parse(result.content[0].text);

            expect(result.isError).toBe(true);
            expect(parsed.success).toBe(false);
            expect(parsed.error).toContain('box');
            expect(parsed.error).toMatch(/nothing was written and nothing was started/);
            expect(parsed.docker_host).toBe('box');
            expect(parsed.docker_endpoint).toBe('ssh://user@box');
            expect(parsed.remediation).toMatch(/Run the MCP on box/);
            expect(parsed.remediation).toMatch(/Node\.js 24/);
            expect(parsed.remediation).toMatch(/unset DOCKER_HOST/);
            expectNothingHappened(ctx);
        });

        test('DOCKER_HOST with a password → refusal never echoes the password', async () => {
            const ctx = build({ env: { DOCKER_HOST: 'ssh://user:s3cret@box' } });
            const result = await ctx.handler({ install_path: '/opt/xns-relayer' });
            const parsed = JSON.parse(result.content[0].text);

            expect(result.isError).toBe(true);
            expect(parsed.docker_endpoint).toBe('ssh://user:***@box');
            expect(result.content[0].text).not.toContain('s3cret');
            expectNothingHappened(ctx);
        });

        test('DOCKER_HOST=tcp://0.0.0.0 → a local daemon, installs', async () => {
            const ctx = build({ env: { DOCKER_HOST: 'tcp://0.0.0.0:2375' } });
            const result = await ctx.handler({ install_path: '/opt/xns-relayer' });
            const parsed = JSON.parse(result.content[0].text);

            expect(result.isError).toBeUndefined();
            expect(parsed.success).toBe(true);
            expect(ctx.dockerUtil.composeUp).toHaveBeenCalled();
        });

        test('ssh Docker context (DOCKER_HOST unset) → same refusal, touches nothing', async () => {
            const ctx = build({ env: {}, contextEndpoint: 'ssh://deploy@ctx-box.lan:2222' });
            const result = await ctx.handler({ install_path: '/opt/xns-relayer' });
            const parsed = JSON.parse(result.content[0].text);

            expect(result.isError).toBe(true);
            expect(parsed.error).toContain('ctx-box.lan');
            expect(parsed.docker_endpoint).toBe('ssh://deploy@ctx-box.lan:2222');
            expectNothingHappened(ctx);
        });

        test('DOCKER_HOST=tcp://… → refuses (other remote scheme)', async () => {
            const ctx = build({ env: { DOCKER_HOST: 'tcp://10.0.0.5:2376' } });
            const result = await ctx.handler({ install_path: '/opt/xns-relayer' });
            const parsed = JSON.parse(result.content[0].text);

            expect(result.isError).toBe(true);
            expect(parsed.error).toContain('10.0.0.5');
            expectNothingHappened(ctx);
        });

        test('refusal also applies with compose_url set', async () => {
            const ctx = build({ env: { DOCKER_HOST: 'ssh://user@box' } });
            const result = await ctx.handler({ install_path: '/opt/x', compose_url: 'https://releases.xns.tech/c.yml' });

            expect(result.isError).toBe(true);
            expectNothingHappened(ctx);
        });

        test('unix socket DOCKER_HOST → installs locally', async () => {
            const ctx = build({ env: { DOCKER_HOST: 'unix:///var/run/docker.sock' } });
            const result = await ctx.handler({ install_path: '/opt/xns-relayer' });
            const parsed = JSON.parse(result.content[0].text);

            expect(parsed.success).toBe(true);
            expect(result.isError).toBeUndefined();
            expect(ctx.installExec.mock.calls.map((c) => c[0])).toEqual(['curl', 'curl', 'mkdir']);
            expect(ctx.writeFile).toHaveBeenCalled();
            expect(ctx.dockerUtil.composeUp).toHaveBeenCalledTimes(1);
        });

        test('no DOCKER_HOST and a local default context → installs locally', async () => {
            const ctx = build({ env: {}, contextEndpoint: 'unix:///var/run/docker.sock' });
            const parsed = JSON.parse((await ctx.handler({ install_path: '/opt/xns-relayer' })).content[0].text);

            expect(parsed.success).toBe(true);
            expect(ctx.dockerUtil.composeUp).toHaveBeenCalledTimes(1);
        });

        // Detection failure and incomplete metadata keep the old rule: fall back
        // to local and install, because there is no host to name.
        test('getDockerHost throwing → installs locally', async () => {
            const ctx = build({ getDockerHost: jest.fn().mockRejectedValue(new Error('docker context inspect exploded')) });
            const parsed = JSON.parse((await ctx.handler({ install_path: '/opt/xns-relayer' })).content[0].text);

            expect(parsed.success).toBe(true);
            expect(ctx.dockerUtil.composeUp).toHaveBeenCalledTimes(1);
        });

        test.each([
            ['empty host', { remote: true, host: '', endpoint: 'tcp://' }],
            ['whitespace host', { remote: true, host: '  ', endpoint: 'tcp://' }],
            ['host localhost', { remote: true, host: 'localhost', endpoint: 'tcp://localhost:2375' }],
            ['missing host', { remote: true }],
        ])('remote:true with %s → installs locally', async (_label, hostResult) => {
            const ctx = build({ getDockerHost: jest.fn().mockResolvedValue(hostResult) });
            const parsed = JSON.parse((await ctx.handler({ install_path: '/opt/xns-relayer' })).content[0].text);

            expect(parsed.success).toBe(true);
            expect(ctx.dockerUtil.composeUp).toHaveBeenCalledTimes(1);
        });

        // Older injected dockerUtil mocks have no getDockerHost at all.
        test('dockerUtil without getDockerHost → installs locally', async () => {
            const composeUp = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
            const handler = registerWithOptions({
                execFile: jest.fn((cmd, args, opts, cb) => cb(null, '', '')),
                fs: {
                    readFile: jest.fn().mockResolvedValue('COMPOSE_PROFILES=loki\n'),
                    writeFile: jest.fn().mockResolvedValue(),
                    chmod: jest.fn().mockResolvedValue(),
                    mkdtemp: jest.fn(async (prefix) => `${prefix}TEST`),
                    rm: jest.fn().mockResolvedValue(),
                },
                dockerUtil: { composeUp, findContainer: jest.fn().mockResolvedValue(null) },
            });
            const parsed = JSON.parse((await handler({ install_path: '/opt/xns-relayer' })).content[0].text);

            expect(parsed.success).toBe(true);
            expect(composeUp).toHaveBeenCalledTimes(1);
        });
    });
});
