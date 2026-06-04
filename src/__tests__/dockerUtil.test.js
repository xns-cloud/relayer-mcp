'use strict';

const { createDockerUtil, parseDockerEndpoint } = require('../lib/dockerUtil');

describe('parseDockerEndpoint', () => {
    test.each([
        ['unix:///var/run/docker.sock', false, 'localhost'],
        ['npipe:////./pipe/docker_engine', false, 'localhost'],
        ['ssh://user@docker-box.lan', true, 'docker-box.lan'],
        ['ssh://user@docker-box.lan:2222', true, 'docker-box.lan'],
        ['tcp://192.168.1.50:2376', true, '192.168.1.50'],
        ['tcp://127.0.0.1:2375', false, 'localhost'],   // loopback tcp = local
        ['tcp://[::1]:2375', false, 'localhost'],       // IPv6 loopback = local
        ['tcp://localhost:2375', false, 'localhost'],
        ['', false, 'localhost'],
        ['not a url at all', false, 'localhost'],        // unparseable → local fallback
    ])('%s → remote=%s host=%s', (endpoint, remote, host) => {
        expect(parseDockerEndpoint(endpoint)).toEqual({ remote, host });
    });
});

describe('dockerUtil.getDockerHost', () => {
    // DOCKER_HOST env var wins over the context — mirrors Docker CLI precedence.
    test('DOCKER_HOST env var takes precedence over context', async () => {
        const execFile = jest.fn(); // must never be called
        const util = createDockerUtil({ execFile, env: { DOCKER_HOST: 'ssh://admin@docker-box.lan' } });

        const result = await util.getDockerHost();

        expect(result).toEqual({ remote: true, host: 'docker-box.lan', endpoint: 'ssh://admin@docker-box.lan' });
        expect(execFile).not.toHaveBeenCalled();
    });

    test('no DOCKER_HOST → reads the active docker context endpoint', async () => {
        const execFile = jest.fn((cmd, args, opts, cb) => cb(null, 'ssh://user@10.0.0.5\n', ''));
        const util = createDockerUtil({ execFile, env: {} });

        const result = await util.getDockerHost();

        expect(result).toEqual({ remote: true, host: '10.0.0.5', endpoint: 'ssh://user@10.0.0.5' });
        expect(execFile.mock.calls[0][0]).toBe('docker');
        expect(execFile.mock.calls[0][1]).toEqual(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
    });

    test('local unix socket context → localhost, not remote', async () => {
        const execFile = jest.fn((cmd, args, opts, cb) => cb(null, 'unix:///var/run/docker.sock\n', ''));
        const util = createDockerUtil({ execFile, env: {} });

        const result = await util.getDockerHost();

        expect(result).toEqual({ remote: false, host: 'localhost', endpoint: 'unix:///var/run/docker.sock' });
    });

    test('docker context inspect failure → local fallback', async () => {
        const execFile = jest.fn((cmd, args, opts, cb) => cb(new Error('no docker')));
        const util = createDockerUtil({ execFile, env: {} });

        const result = await util.getDockerHost();

        expect(result).toEqual({ remote: false, host: 'localhost', endpoint: null });
    });
});

describe('dockerUtil.findContainer', () => {
    function utilWithPsOutput(stdout) {
        const execFile = jest.fn((cmd, args, opts, cb) => cb(null, stdout, ''));
        return { util: createDockerUtil({ execFile, env: {} }), execFile };
    }

    // Preflight must see stopped containers too — docker ps -a, exact-name anchor.
    test('queries docker ps -a with an exact-name filter', async () => {
        const { util, execFile } = utilWithPsOutput('');

        await util.findContainer('xns-relayer');

        const args = execFile.mock.calls[0][1];
        expect(args).toEqual(expect.arrayContaining(['ps', '-a', '--filter', 'name=^xns-relayer$']));
    });

    // docker's name= filter is a regex — metacharacters in names must be
    // escaped or the exact-match anchor silently widens.
    test('escapes regex metacharacters in the name filter', async () => {
        const { util, execFile } = utilWithPsOutput('');

        await util.findContainer('foo.bar');

        const args = execFile.mock.calls[0][1];
        expect(args).toContain('name=^foo\\.bar$');
    });

    test('running container → running: true with status and image', async () => {
        const { util } = utilWithPsOutput('xns-relayer\tUp 3 days\treleases.scpri.me/xns-relayer:alpha-latest\n');

        const result = await util.findContainer('xns-relayer');

        expect(result).toEqual({
            name: 'xns-relayer',
            status: 'Up 3 days',
            image: 'releases.scpri.me/xns-relayer:alpha-latest',
            running: true,
        });
    });

    test('stopped container → found with running: false', async () => {
        const { util } = utilWithPsOutput('xns-relayer\tExited (0) 2 weeks ago\tscprime/xns-relayer:beta\n');

        const result = await util.findContainer('xns-relayer');

        expect(result.running).toBe(false);
        expect(result.status).toContain('Exited');
    });

    test('no container → null', async () => {
        const { util } = utilWithPsOutput('\n');

        expect(await util.findContainer('xns-relayer')).toBeNull();
    });

    // Best-effort: docker unreachable → null; the caller's real command surfaces the error.
    test('docker error → null, does not throw', async () => {
        const execFile = jest.fn((cmd, args, opts, cb) => cb(new Error('cannot connect to docker daemon')));
        const util = createDockerUtil({ execFile, env: {} });

        expect(await util.findContainer('xns-relayer')).toBeNull();
    });
});
