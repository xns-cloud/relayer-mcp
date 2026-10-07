'use strict';

/**
 * realDockerOutput-t1.test.js — E-A9 T1 verify phase.
 *
 * check_prerequisites and install_relayer driven by the text Docker 29.8.1 and
 * Compose v5.5.1 actually print (fixtures/docker-cli-stderr.json, captured from a
 * live engine), through the real createDockerUtil over a fake execFile shaped like
 * Node's: a non-zero exit gives err.code = 1 with stderr as the callback's third
 * argument, never as a property of err.
 *
 * Docker 29 is what the one-command install puts on a fresh Ubuntu 24.04 or
 * Debian 12 machine (docker-ce from Docker's apt repo), so these are the strings a
 * new visitor's MCP sees. The builder suites drive the same paths with
 * hand-written rejections (stderr set on err) and older Docker wording.
 */

const { z } = require('zod');
const { createDockerUtil } = require('../lib/dockerUtil');
const { readRegistration } = require('./helpers/mockRegistration');
const real = require('./fixtures/docker-cli-stderr.json');
const prereqContract = require('./fixtures/check-prerequisites-failures.json');
const causesContract = require('./fixtures/install-relayer-causes.json');

const D5_COMMAND = 'curl -fsSL https://releases.scpri.me/relayer/install.sh | sh';
const GENERIC = causesContract.causes.find((c) => c.key === 'unmatched').exact_response;

/**
 * A docker CLI stand-in answering each subcommand with real Docker output.
 * `answers` maps a subcommand key to { stdout } or { stderr } (failure, exit 1).
 */
function dockerExecFile(answers) {
    return jest.fn((cmd, args, opts, cb) => {
        const key = args[0] === 'compose' ? `compose ${args.includes('version') ? 'version' : 'up'}` : args[0];
        const answer = answers[key] || { stdout: '' };
        if (answer.stderr !== undefined) {
            const err = new Error(`Command failed: docker ${args.join(' ')}\n${answer.stderr}`);
            err.code = 1;
            return cb(err, answer.stdout || '', answer.stderr);
        }
        return cb(null, answer.stdout, '');
    });
}

function checkPrerequisites({ answers, portFree = () => true, groupFile = 'docker:x:999:alice\n', userInfo = () => ({ username: 'alice' }) }) {
    const execFile = dockerExecFile(answers);
    const server = { registerTool: jest.fn() };
    require('../tools/checkPrerequisites')(server, {
        dockerUtil: createDockerUtil({ execFile, env: {} }),
        httpClient: { get: jest.fn().mockResolvedValue({ status: 200, data: {} }), post: jest.fn() },
        checkPort: jest.fn(async (port) => portFree(port)),
        environmentProbe: () => ({ ephemeral: false, signals: [] }),
        statfs: jest.fn(async () => ({ bavail: 500 * 10 ** 9, bsize: 1 })),
        userInfo,
        fs: { readFile: jest.fn(async () => groupFile) },
    });
    const { handler } = readRegistration(server);
    return {
        execFile,
        run: async () => JSON.parse((await handler({})).content[0].text),
    };
}

const check = (parsed, name) => parsed.checks.find((c) => c.name === name);
const failedNames = (parsed) => parsed.checks.filter((c) => !c.passed).map((c) => c.name);
const calledSubcommands = (execFile) => execFile.mock.calls.map((c) => c[1][0]);

describe('check_prerequisites over real Docker 29 output (AC-20, AC-22, AC-27)', () => {
    // CR-7 end to end: right after the script, the group is not live yet. Docker 29
    // words the refusal "docker API", not "Docker daemon socket".
    test('denied socket ("docker API" wording) → the group failure is the only failure, ports skipped, docker port never run', async () => {
        const denied = { stdout: real.stdout.info_format_on_failure, stderr: real.stderr.permission_denied };
        const ctx = checkPrerequisites({
            answers: { info: denied, ps: denied, port: denied, 'compose version': { stdout: real.stdout.compose_version } },
            portFree: () => false,
        });

        const parsed = await ctx.run();

        expect(failedNames(parsed)).toEqual(['docker_group']);
        expect(`${check(parsed, 'docker_group').detail} ${check(parsed, 'docker_group').remediation}`).toContain('log out and back in');
        expect(check(parsed, 'docker')).toMatchObject({ passed: true });
        expect(JSON.stringify(parsed)).not.toContain('systemctl start docker');
        for (const name of ['port_8888', 'port_9000']) {
            expect(check(parsed, name)).toMatchObject({ passed: true, skipped: true });
        }
        expect(calledSubcommands(ctx.execFile)).not.toContain('port');
        expect(check(parsed, 'docker_compose').passed).toBe(true);
    });

    test('denied socket and no passwd entry for the UID → docker_group still reported from $USER, the tool does not throw', async () => {
        const denied = { stdout: real.stdout.info_format_on_failure, stderr: real.stderr.permission_denied };
        const saved = process.env.USER;
        process.env.USER = 'alice';
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const ctx = checkPrerequisites({
                answers: { info: denied, ps: denied, port: denied, 'compose version': { stdout: real.stdout.compose_version } },
                userInfo: () => { throw Object.assign(new Error('ENOENT: no such file or directory, uv_os_get_passwd'), { code: 'ENOENT' }); },
            });

            const parsed = await ctx.run();

            expect(failedNames(parsed)).toEqual(['docker_group']);
            expect(`${check(parsed, 'docker_group').detail} ${check(parsed, 'docker_group').remediation}`).toContain('log out and back in');
        } finally {
            process.env.USER = saved;
            errSpy.mockRestore();
        }
    });

    // AC-20: Docker 29's daemon-down text says "no such file or directory" and
    // "if the daemon is running" — neither the ENOENT spawn code nor the old wording.
    test('daemon unreachable (Docker 29 wording) → only the daemon-stopped failure naming the start command, never the install command', async () => {
        const down = { stdout: real.stdout.info_format_on_failure, stderr: real.stderr.daemon_unreachable };
        const ctx = checkPrerequisites({ answers: { info: down, ps: down, 'compose version': { stdout: real.stdout.compose_version } } });

        const parsed = await ctx.run();

        expect(failedNames(parsed)).toEqual(['docker']);
        const docker = check(parsed, 'docker');
        expect(docker.remediation).toContain('sudo systemctl start docker');
        expect(docker.remediation).not.toContain(D5_COMMAND);
        expect(check(parsed, 'docker_group').passed).toBe(true);
    });

    // CR-1 end to end: the container lookup and the port list come from real
    // `docker ps -a --format` and `docker port` text (IPv4 and IPv6 rows, 9443 too).
    test('running xns-relayer from real ps/port output holding 8888 and 9000 → both pass naming it, success:true', async () => {
        const ctx = checkPrerequisites({
            answers: {
                info: { stdout: '29.8.1\n' },
                context: { stdout: 'unix:///var/run/docker.sock\n' },
                ps: { stdout: real.stdout.ps_a_running_xns_relayer },
                port: { stdout: real.stdout.port_xns_relayer },
                'compose version': { stdout: real.stdout.compose_version },
            },
            portFree: (port) => port !== 8888 && port !== 9000,
        });

        const parsed = await ctx.run();

        for (const name of ['port_8888', 'port_9000']) {
            expect(check(parsed, name).passed).toBe(true);
            expect(check(parsed, name).detail).toContain('xns-relayer');
        }
        expect(parsed.success).toBe(true);
        expect(JSON.stringify(parsed)).not.toContain(prereqContract.port_checks_with_own_container.no_text);
    });
});

/** install_relayer over the real dockerUtil; compose up fails with `upStderr`. */
async function installFailure({ upStderr, infoStderr, uiPort, s3Port }) {
    const execFile = dockerExecFile({
        info: infoStderr ? { stdout: real.stdout.info_format_on_failure, stderr: infoStderr } : { stdout: '29.8.1\n' },
        context: { stdout: 'unix:///var/run/docker.sock\n' },
        ps: infoStderr ? { stderr: infoStderr } : { stdout: '' },
        'compose up': upStderr ? { stderr: upStderr } : { stdout: '' },
    });
    const fs = {
        readFile: jest.fn(async (p) => (p.endsWith('.env') ? 'COMPOSE_PROFILES=${RELAYER_AUDIT_MODE:-loki}\n' : 'services: {}\n')),
        writeFile: jest.fn(async () => {}),
        chmod: jest.fn(async () => {}),
    };
    const server = { registerTool: jest.fn() };
    require('../tools/installRelayer')(server, {
        execFile: jest.fn((cmd, args, opts, cb) => cb(null, '', '')),
        fs,
        dockerUtil: createDockerUtil({ execFile, env: {} }),
    });
    const { schema, handler } = readRegistration(server);
    const args = { install_path: '/opt/xns-relayer' };
    if (uiPort) args.ui_port = uiPort;
    if (s3Port) args.s3_port = s3Port;
    const result = await handler(z.object(schema).parse(args));
    return { result, parsed: JSON.parse(result.content[0].text), fs };
}

function expectNoStderrWindow(result, stderr) {
    const text = result.content[0].text;
    const flat = stderr.replace(/\s+/g, ' ').trim();
    for (let i = 0; i + 20 <= flat.length; i += 1) {
        expect(text).not.toContain(flat.slice(i, i + 20));
    }
}

describe('install_relayer causes over real Docker 29 output (AC-24)', () => {
    let errSpy;
    beforeEach(() => { errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
    afterEach(() => errSpy.mockRestore());

    test.each([
        ['8888', 'ui_port', {}],
        ['9000', 's3_port', {}],
    ])('port %s taken (Docker 29 "failed to bind host port", compose progress lines first) → names the port, %s and docker rm xns-relayer', async (port, param, extra) => {
        const upStderr = real.stderr.compose_up_port_in_use.replace('{PORT}', port);
        const { parsed, result } = await installFailure({ upStderr, ...extra });

        expect(parsed.error).toContain(`Port ${port}`);
        expect(parsed.error).toContain(param);
        expect(parsed.error).toContain('docker rm -f xns-relayer');
        expectNoStderrWindow(result, upStderr);
    });

    test('denied socket ("docker API" wording) at the preflight → group sentence, nothing written, never the generic line', async () => {
        const { parsed, fs } = await installFailure({ infoStderr: real.stderr.permission_denied });

        expect(parsed.error).toContain('log out and back in');
        expect(parsed.error).not.toBe(GENERIC);
        expect(fs.writeFile).not.toHaveBeenCalled();
    });

    // AC-24 daemon_stopped: Docker 29 no longer prints "Cannot connect to the Docker
    // daemon" or "Is the docker daemon running"; it prints "failed to connect to the
    // docker API ... if the daemon is running".
    test('daemon unreachable at compose up (Docker 29 wording) → names sudo systemctl start docker, not the generic line', async () => {
        const stderr = real.stderr.daemon_unreachable;
        const { parsed, result } = await installFailure({ infoStderr: stderr, upStderr: stderr });

        expect(parsed.error).not.toBe(GENERIC);
        expect(parsed.error).toContain('sudo systemctl start docker');
        expectNoStderrWindow(result, stderr);
    });

    // AC-24 pull_refused: Docker 29 (containerd image store, the default on a fresh
    // install) reports a missing or refused image as "failed to resolve reference
    // ...: not found", with none of "pull access denied" / "manifest unknown".
    test('image not resolvable on releases.scpri.me (Docker 29 wording) → names releases.scpri.me, not the generic line', async () => {
        const stderr = real.stderr.compose_up_image_not_found;
        const { parsed } = await installFailure({ upStderr: stderr });

        expect(parsed.error).not.toBe(GENERIC);
        expect(parsed.error).toContain('releases.scpri.me');
        expect(parsed.error).not.toContain('docker rm -f xns-relayer');
    });
});
