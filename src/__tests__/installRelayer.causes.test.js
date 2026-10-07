'use strict';

/**
 * installRelayer.causes.test.js — E-A9 AC-24 (TP-30).
 *
 * An install_relayer failure names its cause in a fixed sentence (port 8888 or
 * 9000 in use, pull refused, daemon stopped, out of disk, socket permission
 * denied) and never carries Docker's own text; an unmatched failure keeps the
 * generic line. The handler runs over the real createDockerUtil with a fake
 * execFile, so every rejection has the shape Docker produces in production:
 * `docker compose failed: Command failed: docker compose -f <path> up -d\n<stderr>`.
 *
 * The cause table is the in-repo copy of the sprint fixture
 * (fixtures/install-relayer-causes.json).
 */

const path = require('path');
const { z } = require('zod');
const { createDockerUtil } = require('../lib/dockerUtil');
const causesFixture = require('./fixtures/install-relayer-causes.json');
const { readRegistration } = require('./helpers/mockRegistration');

const GENERIC = 'Relayer installation failed: See server log for detail.';
const FAILED_PREFIX = 'Relayer installation failed: ';
const SUBSTRING_LENGTH = 20;

const STDERR = {
    port8888: 'Error response from daemon: driver failed programming external connectivity on endpoint xns-relayer (8f0c2d9e1b7a): Bind for 0.0.0.0:8888 failed: port is already allocated',
    port9000: 'Error response from daemon: failed to bind host port for 0.0.0.0:9000:172.18.0.2:9000/tcp: address already in use',
    pullWithPort: "Error response from daemon: pull access denied for releases.scpri.me:443/xns-relayer, repository does not exist or may require 'docker login': denied: requested access to the resource is denied (registry port 443)",
    daemonStopped: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    outOfDisk: 'failed to register layer: write /var/lib/docker/overlay2/4c1e0f6b2a/diff/usr/lib/node_modules/npm/index.js: no space left on device',
    permissionDenied: 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/info": dial unix /var/run/docker.sock: connect: permission denied',
    unknown: 'yaml: unmarshal errors:\n  line 12: cannot unmarshal !!str `eighty` into int',
};

// Every string value anywhere in the parsed response.
function allStrings(value) {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(allStrings);
    if (value && typeof value === 'object') return Object.values(value).flatMap(allStrings);
    return [];
}

function expectNoStderrSubstring(result, stderr) {
    const fields = [result.content[0].text, ...allStrings(JSON.parse(result.content[0].text))];
    for (let i = 0; i + SUBSTRING_LENGTH <= stderr.length; i += 1) {
        const piece = stderr.slice(i, i + SUBSTRING_LENGTH);
        for (const field of fields) {
            if (field.includes(piece)) {
                throw new Error(`response field carries Docker's text: "${piece}"`);
            }
        }
    }
}

/**
 * install_relayer over a real dockerUtil. `infoStderr` makes `docker info`
 * fail; `composeStderr` makes `docker compose up` fail. Docker's own error
 * message embeds the command line, as Node's execFile does.
 */
function build({ infoStderr = null, composeStderr = null, installPath = '/opt/xns-relayer', uiPort, s3Port } = {}) {
    const dockerExec = jest.fn((cmd, args, opts, cb) => {
        const fail = (stderr) => {
            const err = new Error(`Command failed: docker ${args.join(' ')}\n${stderr}`);
            err.code = 1;
            cb(err, '', stderr);
        };
        if (args[0] === 'context') return cb(null, 'unix:///var/run/docker.sock\n', '');
        if (args[0] === 'info') return infoStderr ? fail(infoStderr) : cb(null, '27.3.1\n', '');
        if (args[0] === 'ps') return infoStderr ? fail(infoStderr) : cb(null, '', '');
        if (args[0] === 'compose') return composeStderr ? fail(composeStderr) : cb(null, '', '');
        return cb(null, '', '');
    });
    const installExec = jest.fn((cmd, args, opts, cb) => cb(null, '', ''));
    const store = {};
    const fs = {
        readFile: jest.fn(async (p) => {
            if (p in store) return store[p];
            if (p.endsWith('.env')) return 'COMPOSE_PROFILES=${RELAYER_AUDIT_MODE:-loki}\n';
            return 'services: {}\n';
        }),
        writeFile: jest.fn(async (p, data) => { store[p] = data; }),
        chmod: jest.fn(async () => {}),
    };
    const dockerUtil = createDockerUtil({ execFile: dockerExec, env: {} });
    const server = { registerTool: jest.fn() };
    require('../tools/installRelayer')(server, { execFile: installExec, fs, dockerUtil });
    const { schema, handler } = readRegistration(server);
    const args = { install_path: installPath };
    if (uiPort) args.ui_port = uiPort;
    if (s3Port) args.s3_port = s3Port;
    const run = () => handler(z.object(schema).parse(args));
    return { run, dockerExec, installExec, fs };
}

async function errorFor(opts) {
    const ctx = build(opts);
    const result = await ctx.run();
    const parsed = JSON.parse(result.content[0].text);
    return { ...ctx, result, parsed };
}

describe('install_relayer failure causes (AC-24, TP-30)', () => {
    let errSpy;
    beforeEach(() => { errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
    afterEach(() => errSpy.mockRestore());

    test('the six known causes give six pairwise-different fixed phrases, none the generic line', async () => {
        const cases = [
            { composeStderr: STDERR.port8888 },
            { composeStderr: STDERR.port9000 },
            { composeStderr: STDERR.pullWithPort },
            { infoStderr: STDERR.daemonStopped, composeStderr: STDERR.daemonStopped },
            { composeStderr: STDERR.outOfDisk },
            { infoStderr: STDERR.permissionDenied },
        ];
        const errors = [];
        for (const opts of cases) {
            const { result, parsed } = await errorFor(opts);
            expect(result.isError).toBe(true);
            expect(parsed.success).toBe(false);
            expect(parsed.error.startsWith(FAILED_PREFIX)).toBe(true);
            expect(parsed.error).not.toBe(GENERIC);
            errors.push(parsed.error);
        }
        expect(new Set(errors).size).toBe(6);
    });

    test.each([
        ['8888', STDERR.port8888, 'ui_port'],
        ['9000', STDERR.port9000, 's3_port'],
    ])('port %s in use → names the port, the matching alternative and removing the leftover xns-relayer', async (port, stderr, param) => {
        const { parsed, result } = await errorFor({ composeStderr: stderr });

        expect(parsed.error).toContain(`Port ${port}`);
        expect(parsed.error).toContain(param);
        expect(parsed.error).toContain('docker rm xns-relayer');
        expectNoStderrSubstring(result, stderr);
    });

    test('custom ui_port 18888 in use → names 18888 and ui_port', async () => {
        const { parsed } = await errorFor({ composeStderr: 'Bind for 0.0.0.0:18888 failed: port is already allocated', uiPort: 18888 });

        expect(parsed.error).toContain('Port 18888');
        expect(parsed.error).toContain('ui_port');
        expect(parsed.error).not.toContain('s3_port');
    });

    test('a pull refusal that mentions a port is reported as pull refused, not port in use', async () => {
        const { parsed, result } = await errorFor({ composeStderr: STDERR.pullWithPort });

        expect(parsed.error).toContain('releases.scpri.me');
        expect(parsed.error).not.toContain('docker rm xns-relayer');
        expect(parsed.error).not.toMatch(/Port \d+/);
        expectNoStderrSubstring(result, STDERR.pullWithPort);
    });

    test('daemon stopped → names the start command', async () => {
        const { parsed, result } = await errorFor({ infoStderr: STDERR.daemonStopped, composeStderr: STDERR.daemonStopped });

        expect(parsed.error).toContain('sudo systemctl start docker');
        expectNoStderrSubstring(result, STDERR.daemonStopped);
    });

    test('out of disk → names freeing disk space on the Docker root', async () => {
        const { parsed, result } = await errorFor({ composeStderr: STDERR.outOfDisk });

        expect(parsed.error).toMatch(/disk/i);
        expect(parsed.error).toMatch(/Docker root/);
        expectNoStderrSubstring(result, STDERR.outOfDisk);
    });

    // M-72, SR-4: a denied socket is caught before anything is written and
    // before the existing-container lookup (which would swallow the denial).
    test('socket permission denied → "log out and back in", no file written, no existing-container lookup, never "See server log"', async () => {
        const { parsed, result, fs, installExec, dockerExec } = await errorFor({ infoStderr: STDERR.permissionDenied });

        expect(result.isError).toBe(true);
        expect(parsed.error).toContain('log out and back in');
        expect(parsed.error).toContain('usermod -aG docker');
        expect(parsed.error).not.toContain('See server log');
        expect(parsed.error).not.toContain('existing');
        expect(fs.writeFile).not.toHaveBeenCalled();
        expect(installExec).not.toHaveBeenCalled();
        expect(dockerExec.mock.calls.map((c) => c[1][0])).not.toContain('ps');
        expect(dockerExec.mock.calls.map((c) => c[1][0])).not.toContain('compose');
        expectNoStderrSubstring(result, STDERR.permissionDenied);
    });

    // A bind-mount permission error from compose up is not a socket denial, so
    // it must not say "nothing was written" or send the user to the docker group.
    test('permission denied on a bind-mount path from compose up → the generic line, not the group sentence', async () => {
        const stderr = "Error response from daemon: error while creating mount source path '/opt/xns-relayer/data': mkdir /opt/xns-relayer/data: permission denied";
        const { parsed } = await errorFor({ composeStderr: stderr });

        expect(parsed.error).toBe(GENERIC);
        expect(parsed.error).not.toContain('usermod');
    });

    test('Docker 29 "docker API" denial at the preflight → the group sentence, nothing written', async () => {
        const stderr = 'permission denied while trying to connect to the docker API at unix:///var/run/docker.sock';
        const { parsed, fs } = await errorFor({ infoStderr: stderr });

        expect(parsed.error).toContain('usermod -aG docker');
        expect(fs.writeFile).not.toHaveBeenCalled();
    });

    // The release compose also publishes 9443; ui_port / s3_port do not move it.
    test('port 9443 in use → its own sentence, no ui_port / s3_port advice', async () => {
        const stderr = 'Error response from daemon: driver failed programming external connectivity on endpoint xns-relayer (8f0c): Bind for 0.0.0.0:9443 failed: port is already allocated';
        const { parsed } = await errorFor({ composeStderr: stderr });

        expect(parsed.error).toContain('9443');
        expect(parsed.error).toContain('S3 HTTPS');
        expect(parsed.error).not.toMatch(/pass a different/);
        expect(parsed.error).toContain('docker rm xns-relayer');
    });

    test('docker info failing for another reason → the install continues as before', async () => {
        const { parsed, dockerExec } = await errorFor({ infoStderr: STDERR.daemonStopped, composeStderr: STDERR.daemonStopped });

        // It reached compose up (and failed there with the daemon cause).
        expect(dockerExec.mock.calls.map((c) => c[1][0])).toContain('compose');
        expect(parsed.error).toContain('sudo systemctl start docker');
    });

    test('unmatched failure → exactly today\'s generic line', async () => {
        const { parsed, result } = await errorFor({ composeStderr: STDERR.unknown });

        expect(parsed.error).toBe(GENERIC);
        expectNoStderrSubstring(result, STDERR.unknown);
    });

    // M-L14: err.message carries the compose path; a trigger word there must
    // not pick a cause when the stderr names none.
    test('trigger words only in the compose path → generic line', async () => {
        const { parsed, dockerExec } = await errorFor({ composeStderr: STDERR.unknown, installPath: '/tmp/port-8888' });

        const composeCall = dockerExec.mock.calls.find((c) => c[1][0] === 'compose');
        expect(composeCall[1]).toContain(path.join('/tmp/port-8888', 'docker-compose.yml'));
        expect(parsed.error).toBe(GENERIC);
    });

    test('Docker\'s stderr and message reach the server log, not the response', async () => {
        const { result } = await errorFor({ composeStderr: STDERR.port8888 });

        expect(errSpy.mock.calls.flat().join(' ')).toContain('port is already allocated');
        expect(result.content[0].text).not.toContain('port is already allocated');
    });
});

describe('install_relayer cause table matches the fixture (install-relayer-causes.json)', () => {
    let errSpy;
    beforeEach(() => { errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
    afterEach(() => errSpy.mockRestore());

    const knownCauses = causesFixture.causes.filter((c) => Array.isArray(c.stderr_matches));

    test('the fixture lists the five matched causes in its stated order, plus unmatched', () => {
        expect(knownCauses.map((c) => c.key)).toEqual(['permission_denied', 'daemon_stopped', 'out_of_disk', 'pull_refused', 'port_in_use']);
        const unmatched = causesFixture.causes.find((c) => c.key === 'unmatched');
        expect(unmatched.exact_response).toBe(GENERIC);
    });

    // Every stderr phrase the fixture lists, failing compose up, yields the
    // same sentence as that cause's representative case — and never the
    // generic line.
    const representative = {
        permission_denied: STDERR.permissionDenied,
        daemon_stopped: STDERR.daemonStopped,
        out_of_disk: STDERR.outOfDisk,
        pull_refused: STDERR.pullWithPort,
        port_in_use: STDERR.port8888,
    };
    const rows = knownCauses.flatMap((cause) => cause.stderr_matches.map((phrase) => [cause.key, phrase]));

    test.each(rows)('%s ← "%s"', async (key, phrase) => {
        const bind = key === 'port_in_use' ? 'Bind for 0.0.0.0:8888 failed: ' : '';
        const viaPhrase = await errorFor({ composeStderr: `Error response from daemon: ${bind}${phrase}` });
        const viaRepresentative = await errorFor({ composeStderr: representative[key] });

        expect(viaPhrase.parsed.error).not.toBe(GENERIC);
        expect(viaPhrase.parsed.error).toBe(viaRepresentative.parsed.error);
    });
});
