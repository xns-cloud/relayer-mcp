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

    // --- Default path: fetch the channel bundle, user authors nothing ---------

    const CHANNEL_COMPOSE_URL = 'https://releases.scpri.me/relayer/beta/docker-compose.yml';

    function fakeFs() {
        const writes = {};
        return {
            writes,
            readFile: jest.fn().mockResolvedValue('BUNDLED_COMPOSE_TEMPLATE\n'),
            writeFile: jest.fn(async (p, data) => { writes[p] = data; }),
        };
    }

    // The released install IS the channel bundle (relayer + monitoring stack).
    // A first-time user supplies no compose_url; the tool fetches the canonical
    // beta channel compose and writes the .env for them. Guards the live gap
    // where the bundled relayer-only template installed no prometheus/grafana
    // and the UI's Monitoring section was dead.
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
        // curl fetched the canonical channel compose into the install dir.
        const curl = execFileCalls.find((c) => c.cmd === 'curl');
        expect(curl.args).toContain(CHANNEL_COMPOSE_URL);
        expect(curl.args).toContain('/tmp/xns/docker-compose.yml');
        // The bundled template is NOT read on the happy path.
        expect(fs.readFile).not.toHaveBeenCalled();
        // .env written with default ports.
        expect(fs.writes['/tmp/xns/.env']).toBe('UI_PORT=8888\nS3_PORT=9000\nBIND_ADDRESS=\n');
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
            compose_url: 'https://example.com/docker-compose.yml',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.binding.composed_from).not.toContain('/tmp/xns/.env');
        expect(parsed.binding.composed_from).toContain('no .env written');
        expect(parsed.binding.composed_from).toContain('docker compose');
        expect(fs.writeFile).not.toHaveBeenCalled();
    });

    // Offline resilience: if the channel fetch fails, the bundled template is
    // the fallback — the install still completes and SAYS it fell back.
    test('channel fetch failure → falls back to bundled template', async () => {
        const fs = fakeFs();
        const composeUp = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
        const handler = registerWithOptions({
            execFile: jest.fn((cmd, args, opts, cb) => {
                if (cmd === 'curl') return cb(new Error('could not resolve host'));
                cb(null, '', '');
            }),
            fs,
            dockerUtil: { composeUp, findContainer: jest.fn().mockResolvedValue(null) },
        });

        const result = await handler({ install_path: '/tmp/xns' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.source).toBe('bundled-fallback');
        expect(parsed.note).toMatch(/fell back|fall.?back/i);
        // Bundled template written to docker-compose.yml; .env still written.
        expect(fs.writes['/tmp/xns/docker-compose.yml']).toBe('BUNDLED_COMPOSE_TEMPLATE\n');
        expect(fs.writes['/tmp/xns/.env']).toBe('UI_PORT=8888\nS3_PORT=9000\nBIND_ADDRESS=\n');
        expect(composeUp).toHaveBeenCalled();
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

        expect(fs.writes['/tmp/xns/.env']).toBe('UI_PORT=18888\nS3_PORT=19000\nBIND_ADDRESS=\n');
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

        expect(fs.writes['/tmp/xns/.env']).toBe('UI_PORT=8888\nS3_PORT=9000\nBIND_ADDRESS=127.0.0.1:\n');
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
            await expect(handler({ install_path: '/tmp/xns', bind_address: addr })).resolves.toBeDefined();
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

    test('channel path → bind_address_applied says unknown', async () => {
        const fs = fakeFs();
        const handler = registerWithOptions({
            execFile: jest.fn((cmd, args, opts, cb) => cb(null, '', '')),
            fs,
            dockerUtil: {
                composeUp: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
                findContainer: jest.fn().mockResolvedValue(null),
            },
        });

        const parsed = JSON.parse((await handler({ install_path: '/tmp/xns', bind_address: '127.0.0.1' })).content[0].text);

        expect(parsed.source).toBe('channel');
        expect(parsed.binding.bind_address_applied).toMatch(/unknown/);
        expect(parsed.binding.bind_address_applied).toMatch(/does not read the fetched file/);
    });

    test('bundled-fallback path → bind_address_applied says yes', async () => {
        const fs = fakeFs();
        const handler = registerWithOptions({
            execFile: jest.fn((cmd, args, opts, cb) => {
                if (cmd === 'curl') return cb(new Error('offline'));
                cb(null, '', '');
            }),
            fs,
            dockerUtil: {
                composeUp: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
                findContainer: jest.fn().mockResolvedValue(null),
            },
        });

        const parsed = JSON.parse((await handler({ install_path: '/tmp/xns', bind_address: '127.0.0.1' })).content[0].text);

        expect(parsed.source).toBe('bundled-fallback');
        expect(parsed.binding.bind_address_applied).toMatch(/^yes/);
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
            compose_url: 'https://example.com/custom.yml',
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

    // --- Bundled fallback template — contract with the channel bundle ---------
    // The default install fetches the channel bundle; this file is the OFFLINE
    // FALLBACK and must keep SERVICE PARITY with it. Guards the live gap where
    // the template was relayer-only: MCP installs shipped no prometheus/grafana
    // and the UI's Monitoring section was dead. Reads the real file on disk
    // (not the mock) so any drift is caught in CI.

    function readTemplate() {
        const path = require('path');
        const realFs = require('fs');
        return realFs.readFileSync(path.join(__dirname, '..', 'templates', 'docker-compose.yml'), 'utf8');
    }

    test('fallback template keeps service parity with the channel bundle', () => {
        const template = readTemplate();
        // Full bundle: relayer + the monitoring stack that powers the UI's
        // Monitoring section. A missing service here = a degraded install.
        for (const service of ['xns:', 'prometheus:', 'grafana:', 'node-exporter:']) {
            expect(template).toMatch(new RegExp(`^\\s{2}${service}\\s*$`, 'm'));
        }
        // privileged matches the channel compose (samba / fuse / disk management).
        expect(template).toMatch(/^\s*privileged:\s*true/m);
    });

    test('fallback template pins the releases-registry beta channel', () => {
        const template = readTemplate();

        expect(template).toMatch(/^\s*image:\s*releases\.scpri\.me\/xns-relayer:beta-latest\s*(#.*)?$/m);
        expect(template).toMatch(/^\s*image:\s*releases\.scpri\.me\/relayer-prometheus:beta-latest\s*(#.*)?$/m);
        expect(template).toMatch(/^\s*image:\s*releases\.scpri\.me\/relayer-grafana:beta-latest\s*(#.*)?$/m);
        expect(template).not.toMatch(/^\s*image:.*:stable/m);
    });

    // STORAGE-STRATEGY PARITY (beta-tester report 2026-06-09, tacom, bug #2):
    // the fallback MUST use the SAME volume strategy as the channel bundle —
    // the named volume `relayer_data:/relayer`. When the two diverged (channel =
    // named volume, fallback = bind mount ./data), an online-vs-offline install
    // silently switched the mount target and the user's buckets "vanished" (data
    // orphaned in the other volume). A bind mount here is the bug. Keep in sync
    // with deploy/relayer-beta/docker-compose.yml.
    test('fallback template uses the named relayer_data volume (NOT a bind mount)', () => {
        const template = readTemplate();

        // relayer service mounts the named volume...
        expect(template).toMatch(/^\s*-\s*relayer_data:\/relayer\s*(#.*)?$/m);
        // ...declared in the top-level volumes block.
        expect(template).toMatch(/^volumes:/m);
        expect(template).toMatch(/^\s{2}relayer_data:\s*$/m);
        // and NEVER the bind mount that caused the data-orphaning flip.
        expect(template).not.toMatch(/^\s*-\s*\.\/data:\/relayer/m);
    });

    // PULL PARITY (tacom bug #1): `docker compose up -d` (the only command
    // install_relayer runs) must fetch the current :beta-latest image, not a
    // stale local cache. pull_policy: always makes that declarative — the same
    // line is required on the channel bundle.
    test('fallback template sets pull_policy: always on the relayer service', () => {
        const template = readTemplate();
        expect(template).toMatch(/^\s*pull_policy:\s*always\s*$/m);
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

    // Fleet-safety regression: Docker Hub scprime/* tags are production FLEET
    // artifacts, not a release channel — the 0.3.0 template pointed there and
    // installed a 10-month-stale image. A Hub (or any non-releases-registry)
    // image reference must never return to the bundled install. The ONE allowed
    // upstream image is prom/node-exporter (public multi-arch, matches the
    // channel bundle — deploy.py: "node-exporter is upstream multi-arch,
    // nothing to build").
    test('fallback template never references Docker Hub or fleet images', () => {
        const template = readTemplate();

        const imageLines = template.split('\n').filter((l) => /^\s*image:/.test(l));
        expect(imageLines).toHaveLength(4);
        for (const line of imageLines) {
            expect(line).not.toContain('scprime/');
            expect(line).not.toContain('docker.io');
            expect(line).toMatch(/releases\.scpri\.me\/|image:\s*prom\/node-exporter:v[\d.]+/);
        }
        // node-exporter stays version-pinned, not :latest.
        expect(template).not.toMatch(/node-exporter:latest/);
    });

    // BUG-229 / BUG-230: the MCP and the Docker daemon are routinely different
    // machines (DOCKER_HOST or an ssh:// context — the README recommends exactly
    // that from an ephemeral sandbox). The install files are written locally
    // while the containers start remotely, and the old response reported a single
    // install_path that was only true on one of them. These tests pin the
    // response telling the truth about which machine holds what.
    describe('remote Docker host — file location is stated, not implied', () => {
        function remoteHandler(overrides = {}) {
            return registerWithOptions({
                execFile: jest.fn((cmd, args, opts, cb) => cb(null, '', '')),
                fs: { readFile: jest.fn(), writeFile: jest.fn().mockResolvedValue() },
                dockerUtil: {
                    composeUp: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
                    findContainer: jest.fn().mockResolvedValue(null),
                    getDockerHost: jest.fn().mockResolvedValue({ remote: true, host: 'docker-box.lan', endpoint: 'ssh://admin@docker-box.lan' }),
                    ...overrides,
                },
            });
        }

        test('remote host → action_required names both machines and what breaks', async () => {
            const handler = remoteHandler();
            const parsed = JSON.parse((await handler({ install_path: '/opt/xns-relayer' })).content[0].text);

            expect(parsed.success).toBe(true);
            expect(parsed.action_required).toContain('docker-box.lan');
            expect(parsed.action_required).toContain('/opt/xns-relayer');
            expect(parsed.action_required).toContain('restarting, changing ports, or upgrading');
        });

        // Deliberately no generated shell command: a wrong one that looks right
        // is worse than none, and the correct form depends on the user's scp
        // version, shell, ssh port, bastion and sudo policy. The response points
        // at the README's worked examples instead.
        test('remote host → no generated shell command in the response', async () => {
            const handler = remoteHandler();
            const parsed = JSON.parse((await handler({ install_path: '/opt/xns-relayer' })).content[0].text);
            const whole = JSON.stringify(parsed);

            // Named tools, not one prior flag shape: `scp -` and `ssh -t` would
            // pass for `scp /opt/x host:/opt`, `rsync -av`, `docker cp` or a
            // heredoc, none of which we intend to emit either.
            for (const tool of [/\bscp\b/, /\brsync\b/, /\bsftp\b/, /\bdocker cp\b/, /\btar c/]) {
                expect(whole).not.toMatch(tool);
            }
            // Catches `ssh -t host …`, `ssh -J bastion host …`, `ssh -i key host …`
            // and `ssh user@host …`; the earlier shape required a quoted argument
            // in a fixed position and matched only one of them.
            expect(whole).not.toMatch(/\bssh\s+(-|[\w.-]+@)/);
            expect(parsed.action_required).toContain('Moving the install files to the Docker host');
        });

        // move_files carries the values a person substitutes into whichever
        // README template matches their setup.
        // The tool description and CHANGELOG both promise action_required leads
        // the payload. Nothing read the key order, so moving the spread below
        // `message` stayed green.
        test('action_required is the first field after success', async () => {
            const handler = remoteHandler();
            const parsed = JSON.parse((await handler({ install_path: '/opt/xns-relayer' })).content[0].text);

            expect(Object.keys(parsed).slice(0, 2)).toEqual(['success', 'action_required']);
        });

        // move_files.destination_path must not be edited by the user: compose
        // takes its project name from the directory basename and prefixes volume
        // names with it, so a differently-named directory is a different project
        // with empty volumes.
        test('remote host → action_required warns against renaming the directory', async () => {
            const handler = remoteHandler();
            const parsed = JSON.parse((await handler({ install_path: '/opt/xns-relayer' })).content[0].text);

            expect(parsed.action_required).toContain('Keep the same directory name');
            expect(parsed.action_required).toContain('project name');
        });

        // Which of the three README recovery paths applies. Without it the
        // no-ssh example cannot be followed from the response alone.
        // toBeTruthy() here would pass if the override path handed back the
        // channel URL — the exact regression the field exists to prevent — so
        // each case asserts its own URL.
        test.each([
            ['channel', {}, 'channel', 'https://releases.scpri.me/relayer/beta/docker-compose.yml'],
            ['compose_url override', { compose_url: 'https://example.com/dc.yml' }, 'compose_url', 'https://example.com/dc.yml'],
        ])('%s → move_files.compose_source and compose_url agree', async (_label, extra, expectedSource, expectedUrl) => {
            const handler = remoteHandler();
            const parsed = JSON.parse((await handler({ install_path: '/opt/xns-relayer', ...extra })).content[0].text);

            expect(parsed.move_files.compose_source).toBe(expectedSource);
            expect(parsed.move_files.compose_source).toBe(parsed.source);
            expect(parsed.move_files.compose_url).toBe(expectedUrl);
        });

        // The bundled fallback is the one path with no URL to fetch — the file
        // itself has to travel, and the response has to say so.
        test('bundled fallback → compose_url is null so the README sends the file, not a curl', async () => {
            const handler = registerWithOptions({
                execFile: jest.fn((cmd, args, opts, cb) => cb(cmd === 'curl' ? new Error('offline') : null, '', '')),
                fs: { readFile: jest.fn().mockResolvedValue('services: {}'), writeFile: jest.fn().mockResolvedValue() },
                dockerUtil: {
                    composeUp: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
                    findContainer: jest.fn().mockResolvedValue(null),
                    getDockerHost: jest.fn().mockResolvedValue({ remote: true, host: 'docker-box.lan', endpoint: 'ssh://admin@docker-box.lan' }),
                },
            });
            const parsed = JSON.parse((await handler({ install_path: '/opt/xns-relayer' })).content[0].text);

            expect(parsed.move_files.compose_source).toBe('bundled-fallback');
            expect(parsed.move_files.compose_url).toBeNull();
        });

        // resolveDockerHost keeps the endpoint on the local branch on purpose;
        // dropping the spread to plain LOCAL_DOCKER_HOST used to pass.
        test('local host → the detected endpoint is still reported', async () => {
            const handler = remoteHandler({
                getDockerHost: jest.fn().mockResolvedValue({ remote: false, host: 'localhost', endpoint: 'unix:///var/run/docker.sock' }),
            });
            const parsed = JSON.parse((await handler({ install_path: '/opt/xns-relayer' })).content[0].text);

            expect(parsed.file_location.docker_endpoint).toBe('unix:///var/run/docker.sock');
        });

        // installRelayer.js and checkPrerequisites.js both send the user to a
        // README heading by name. Renaming the heading would strand all three
        // pointers with nothing failing.
        test('the README heading the response points at actually exists', () => {
            const readme = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'README.md'), 'utf8');
            expect(readme).toMatch(/^### Moving the install files to the Docker host$/m);
        });

        test('remote host → move_files names both machines, both paths and the endpoint', async () => {
            const handler = remoteHandler();
            const parsed = JSON.parse((await handler({ install_path: '/opt/xns-relayer' })).content[0].text);

            expect(parsed.move_files).toMatchObject({
                source_path: '/opt/xns-relayer',
                destination_machine: 'docker-box.lan',
                destination_path: '/opt/xns-relayer',
                docker_endpoint: 'ssh://admin@docker-box.lan',
                files: ['docker-compose.yml', '.env'],
            });
            expect(parsed.move_files.source_machine).toMatch(/this machine/i);
        });

        // The escape hatch for a Docker host with no ssh route at all: the two
        // files can be recreated by hand, so the env body has to come back.
        test('remote host → move_files carries the env contents verbatim', async () => {
            const handler = remoteHandler();
            const parsed = JSON.parse((await handler({ install_path: '/opt/xns-relayer', ui_port: 9999, s3_port: 7777 })).content[0].text);

            expect(parsed.move_files.env_contents).toBe('UI_PORT=9999\nS3_PORT=7777\nBIND_ADDRESS=\n');
        });

        // The compose_url override path writes no env file, so there is nothing
        // to hand back and nothing to claim was written.
        test('compose_url override → env contents null and .env not listed', async () => {
            const handler = remoteHandler();
            const parsed = JSON.parse((await handler({
                install_path: '/opt/xns-relayer',
                compose_url: 'https://example.com/docker-compose.yml',
            })).content[0].text);

            expect(parsed.move_files.env_contents).toBeNull();
            expect(parsed.move_files.files).toEqual(['docker-compose.yml']);
            expect(parsed.action_required).toContain('docker-compose.yml was written');
            expect(parsed.action_required).not.toContain('and the env file');
        });

        test('local host → no move_files block', async () => {
            const handler = remoteHandler({
                getDockerHost: jest.fn().mockResolvedValue({ remote: false, host: 'localhost', endpoint: 'unix:///var/run/docker.sock' }),
            });
            const parsed = JSON.parse((await handler({ install_path: '/opt/xns-relayer' })).content[0].text);

            expect(parsed.move_files).toBeUndefined();
        });

        test('remote host → file_location separates where files landed from where containers run', async () => {
            const handler = remoteHandler();
            const parsed = JSON.parse((await handler({ install_path: '/opt/xns-relayer' })).content[0].text);

            expect(parsed.file_location.same_machine).toBe(false);
            expect(parsed.file_location.docker_host).toBe('docker-box.lan');
            expect(parsed.file_location.files_written_on).toMatch(/not the docker host/i);
        });

        test('remote host → the top-level message points at action_required', async () => {
            const handler = remoteHandler();
            const parsed = JSON.parse((await handler({ install_path: '/opt/xns-relayer' })).content[0].text);

            expect(parsed.message).toContain('action_required');
            expect(parsed.message).toContain('docker-box.lan');
        });

        test('local host → no action_required, file_location says same machine', async () => {
            const handler = registerWithOptions({
                execFile: jest.fn((cmd, args, opts, cb) => cb(null, '', '')),
                fs: { readFile: jest.fn(), writeFile: jest.fn().mockResolvedValue() },
                dockerUtil: {
                    composeUp: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
                    findContainer: jest.fn().mockResolvedValue(null),
                    getDockerHost: jest.fn().mockResolvedValue({ remote: false, host: 'localhost', endpoint: 'unix:///var/run/docker.sock' }),
                },
            });
            const parsed = JSON.parse((await handler({ install_path: '/opt/xns-relayer' })).content[0].text);

            expect(parsed.action_required).toBeUndefined();
            expect(parsed.file_location.same_machine).toBe(true);
        });

        // "remote" with no nameable host is incomplete metadata, not a remote
        // install. Same rule checkPrerequisites already applies — do not warn
        // about a machine we cannot name.
        test('remote flag without a usable host → treated as local', async () => {
            const handler = remoteHandler({
                getDockerHost: jest.fn().mockResolvedValue({ remote: true, host: '  ', endpoint: 'tcp://' }),
            });
            const parsed = JSON.parse((await handler({ install_path: '/opt/xns-relayer' })).content[0].text);

            expect(parsed.action_required).toBeUndefined();
            expect(parsed.file_location.same_machine).toBe(true);
        });

        // Host detection is advisory. It must never be the reason an install fails.
        test('getDockerHost throwing does not fail the install', async () => {
            const handler = remoteHandler({
                getDockerHost: jest.fn().mockRejectedValue(new Error('docker context inspect exploded')),
            });
            const parsed = JSON.parse((await handler({ install_path: '/opt/xns-relayer' })).content[0].text);

            expect(parsed.success).toBe(true);
            expect(parsed.file_location.same_machine).toBe(true);
        });

        // Older injected dockerUtil mocks (and any caller predating the helper)
        // have no getDockerHost at all.
        test('dockerUtil without getDockerHost does not fail the install', async () => {
            const handler = registerWithOptions({
                execFile: jest.fn((cmd, args, opts, cb) => cb(null, '', '')),
                fs: { readFile: jest.fn(), writeFile: jest.fn().mockResolvedValue() },
                dockerUtil: {
                    composeUp: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
                    findContainer: jest.fn().mockResolvedValue(null),
                },
            });
            const parsed = JSON.parse((await handler({ install_path: '/opt/xns-relayer' })).content[0].text);

            expect(parsed.success).toBe(true);
            expect(parsed.file_location.same_machine).toBe(true);
        });

        // mkdir runs on the MCP machine. On a laptop driving a remote daemon,
        // /opt needs root and this is the first thing that fails — the error has
        // to name which machine refused.
        test('mkdir failure under a remote host names the local machine', async () => {
            const failingHandler = registerWithOptions({
                execFile: jest.fn((cmd, args, opts, cb) => cb(cmd === 'mkdir' ? new Error('EACCES: permission denied') : null, '', '')),
                dockerUtil: {
                    composeUp: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
                    findContainer: jest.fn().mockResolvedValue(null),
                    getDockerHost: jest.fn().mockResolvedValue({ remote: true, host: 'docker-box.lan', endpoint: 'ssh://admin@docker-box.lan' }),
                },
            });
            const parsed = JSON.parse((await failingHandler({ install_path: '/opt/xns-relayer' })).content[0].text);

            expect(parsed.success).toBe(false);
            expect(parsed.error).toContain('docker-box.lan');
            expect(parsed.error).toContain('this machine');
            expect(parsed.error).toContain('NOT the Docker host docker-box.lan');
        });
    });
});
