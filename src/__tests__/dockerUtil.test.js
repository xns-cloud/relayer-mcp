'use strict';

const { createDockerUtil, parseDockerEndpoint, redactEndpoint, classifyDockerFailure } = require('../lib/dockerUtil');

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
        // install_relayer refuses a remote daemon, so every loopback spelling must read local
        ['tcp://LOCALHOST:2375', false, 'localhost'],   // tcp:// hosts are not lowercased by URL
        ['ssh://user@LocalHost', false, 'localhost'],
        ['tcp://127.0.0.2:2375', false, 'localhost'],   // whole 127/8 block is loopback
        ['tcp://127.255.255.254:2375', false, 'localhost'],
        ['tcp://0.0.0.0:2375', false, 'localhost'],     // wildcard bind address used as a target
        ['tcp://[::]:2375', false, 'localhost'],
        ['tcp://128.0.0.1:2375', true, '128.0.0.1'],    // just outside 127/8
        ['tcp://127.example.com:2375', true, '127.example.com'], // a hostname, not a 127.x address
        ['tcp://[::ffff:127.0.0.1]:2375', false, 'localhost'], // IPv4-mapped loopback
        ['tcp://[::ffff:128.0.0.1]:2375', true, '[::ffff:8000:1]'], // IPv4-mapped, outside 127/8
        ['', false, 'localhost'],
        ['not a url at all', false, 'localhost'],        // unparseable → local fallback
    ])('%s → remote=%s host=%s', (endpoint, remote, host) => {
        expect(parseDockerEndpoint(endpoint)).toEqual({ remote, host });
    });
});

describe('redactEndpoint', () => {
    test.each([
        ['ssh://user:s3cret@box', 'ssh://user:***@box'],
        ['ssh://user:pa@ss@box:2222', 'ssh://user:***@box:2222'],   // password runs to the LAST '@'
        ['tcp://u:p@10.0.0.5:2376/path@x', 'tcp://u:***@10.0.0.5:2376/path@x'], // '@' in the path is not userinfo
        ['tcp://u:p@10.0.0.5:2376?x=a@b', 'tcp://u:***@10.0.0.5:2376?x=a@b'], // '@' in the query is not userinfo
        ['tcp://u:p@10.0.0.5:2376#a@b', 'tcp://u:***@10.0.0.5:2376#a@b'],     // nor in the fragment
        ['ssh://user@box', 'ssh://user@box'],                     // no password → unchanged
        ['unix:///var/run/docker.sock', 'unix:///var/run/docker.sock'],
        ['', ''],
    ])('%s → %s', (endpoint, expected) => {
        expect(redactEndpoint(endpoint)).toBe(expected);
    });

    test.each([[null], [undefined]])('%s → null', (endpoint) => {
        expect(redactEndpoint(endpoint)).toBeNull();
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

// E-A9 AC-24 / AC-27: failure classification and the container's published ports.

// Reject the way Node's execFile does: err.message embeds the command line and
// the stderr; createDockerUtil copies stderr and code onto its own error.
function rejectingUtil(stderr, { code = 1 } = {}) {
    const execFile = jest.fn((cmd, args, opts, cb) => {
        const err = new Error(`Command failed: docker ${args.join(' ')}\n${stderr}`);
        err.code = code;
        cb(err, '', stderr);
    });
    return createDockerUtil({ execFile, env: {} });
}

async function rejectionOf(promise) {
    try {
        await promise;
    } catch (err) {
        return err;
    }
    throw new Error('expected the docker call to reject');
}

describe('classifyDockerFailure', () => {
    test.each([
        ['permission_denied', 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/info": dial unix /var/run/docker.sock: connect: permission denied'],
        ['permission_denied', 'permission denied while trying to connect to the docker API at unix:///var/run/docker.sock'],
        ['daemon_stopped', 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'],
        ['daemon_stopped', 'failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory'],
        ['pull_refused', 'failed to resolve reference "releases.scpri.me/xns-relayer:release-latest": releases.scpri.me/xns-relayer:release-latest: not found'],
        ['out_of_disk', 'failed to register layer: write /var/lib/docker/overlay2/abc/diff/usr/bin/node: no space left on device'],
        ['pull_refused', 'Error response from daemon: pull access denied for releases.scpri.me/xns-relayer, repository does not exist or may require \'docker login\''],
        ['pull_refused', 'Error response from daemon: manifest unknown'],
        ['pull_refused', 'Error response from daemon: Head "https://releases.scpri.me/v2/xns-relayer/manifests/release-latest": unauthorized'],
        ['port_in_use', 'Error response from daemon: driver failed programming external connectivity on endpoint xns-relayer (0f3c): Bind for 0.0.0.0:8888 failed: port is already allocated'],
        ['port_in_use', 'Error response from daemon: failed to bind host port for 0.0.0.0:9000:172.18.0.2:9000/tcp: address already in use'],
    ])('stderr → %s', async (key, stderr) => {
        const err = await rejectionOf(rejectingUtil(stderr).composeUp('/opt/xns-relayer/docker-compose.yml'));
        expect(classifyDockerFailure(err)?.key).toBe(key);
    });

    test('port_in_use carries the host port from the bind text', async () => {
        const err8888 = await rejectionOf(rejectingUtil('Bind for 0.0.0.0:8888 failed: port is already allocated').composeUp('/x/docker-compose.yml'));
        const err9000 = await rejectionOf(rejectingUtil('failed to bind host port for 0.0.0.0:9000:172.18.0.2:9000/tcp: address already in use').composeUp('/x/docker-compose.yml'));
        const errV6 = await rejectionOf(rejectingUtil('Bind for [::]:18888 failed: port is already allocated').composeUp('/x/docker-compose.yml'));

        expect(classifyDockerFailure(err8888)).toEqual({ key: 'port_in_use', port: 8888 });
        expect(classifyDockerFailure(err9000)).toEqual({ key: 'port_in_use', port: 9000 });
        expect(classifyDockerFailure(errV6)).toEqual({ key: 'port_in_use', port: 18888 });
    });

    // M-44: a pull failure that mentions a port is still a pull failure.
    test('pull refusal mentioning a port classifies as pull_refused, not port_in_use', async () => {
        const stderr = 'Error response from daemon: pull access denied for releases.scpri.me:443/xns-relayer (port 443): address already in use by proxy';
        const err = await rejectionOf(rejectingUtil(stderr).composeUp('/x/docker-compose.yml'));
        expect(classifyDockerFailure(err).key).toBe('pull_refused');
    });

    // Permission denied wins over the daemon-stopped wording some CLIs append.
    test('permission denied is never classified as daemon_stopped', async () => {
        const stderr = 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock. Is the docker daemon running?';
        const err = await rejectionOf(rejectingUtil(stderr).docker(['info']));
        expect(classifyDockerFailure(err).key).toBe('permission_denied');
    });

    // A bind-mount or file permission error is not a socket denial: the group
    // advice and "nothing was written" would both be wrong for it.
    test('a permission denied that is not the Docker connection is not classified', async () => {
        const stderr = 'Error response from daemon: error while creating mount source path \'/opt/xns-relayer/data\': mkdir /opt/xns-relayer/data: permission denied';
        const err = await rejectionOf(rejectingUtil(stderr).composeUp('/x/docker-compose.yml'));
        expect(classifyDockerFailure(err)).toBeNull();
    });

    // M-L14: err.message embeds the compose path; only stderr may decide.
    test('a trigger word in the compose path (err.message) does not classify', async () => {
        const err = await rejectionOf(rejectingUtil('yaml: line 3: did not find expected key').composeUp('/tmp/port-8888/pull-no-space-left/docker-compose.yml'));
        expect(err.message).toContain('port-8888');
        expect(classifyDockerFailure(err)).toBeNull();
    });

    test.each([
        ['no stderr', Object.assign(new Error('Bind for 0.0.0.0:8888 failed: port is already allocated'), {})],
        ['empty stderr', Object.assign(new Error('permission denied'), { stderr: '' })],
        ['non-string stderr', Object.assign(new Error('x'), { stderr: Buffer.from('no space left on device') })],
        ['null error', null],
        ['undefined error', undefined],
    ])('%s → null', (_label, err) => {
        expect(classifyDockerFailure(err)).toBeNull();
    });
});

describe('dockerUtil.containerHostPorts', () => {
    test('parses IPv4 and IPv6 bindings into unique host ports', async () => {
        const execFile = jest.fn((cmd, args, opts, cb) => cb(null, [
            '8888/tcp -> 0.0.0.0:8888',
            '8888/tcp -> [::]:8888',
            '9000/tcp -> 0.0.0.0:9000',
            '9000/tcp -> [::]:9000',
            '9443/tcp -> 127.0.0.1:9443',
            '',
        ].join('\n'), ''));
        const util = createDockerUtil({ execFile, env: {} });

        expect(await util.containerHostPorts('xns-relayer')).toEqual([8888, 9000, 9443]);
        expect(execFile.mock.calls[0][1]).toEqual(['port', 'xns-relayer']);
    });

    test('container published on other host ports → those ports only', async () => {
        const execFile = jest.fn((cmd, args, opts, cb) => cb(null, '8888/tcp -> 0.0.0.0:18888\n9000/tcp -> 0.0.0.0:19000\n', ''));
        const util = createDockerUtil({ execFile, env: {} });

        expect(await util.containerHostPorts('xns-relayer')).toEqual([18888, 19000]);
    });

    test('docker error → empty list, does not throw', async () => {
        const util = rejectingUtil('Error response from daemon: No such container: xns-relayer');

        expect(await util.containerHostPorts('xns-relayer')).toEqual([]);
    });
});

describe('dockerUtil.containerProject', () => {
    test('reads the compose project label of an exact container name', async () => {
        const execFile = jest.fn((cmd, args, opts, cb) => cb(null, '/prometheus\tmonitoring\n', ''));
        const util = createDockerUtil({ execFile, env: {} });

        expect(await util.containerProject('prometheus')).toBe('monitoring');
        expect(execFile.mock.calls[0][1].slice(0, 3)).toEqual(['inspect', '--type', 'container']);
        expect(execFile.mock.calls[0][1].at(-1)).toBe('prometheus');
    });

    test('a container without the label → empty string', async () => {
        const execFile = jest.fn((cmd, args, opts, cb) => cb(null, '/prometheus\t\n', ''));
        const util = createDockerUtil({ execFile, env: {} });

        expect(await util.containerProject('prometheus')).toBe('');
    });

    test('no such container, or empty output → null', async () => {
        const missing = rejectingUtil('Error response from daemon: No such container: prometheus');
        const empty = createDockerUtil({ execFile: jest.fn((cmd, args, opts, cb) => cb(null, '', '')), env: {} });

        expect(await missing.containerProject('prometheus')).toBeNull();
        expect(await empty.containerProject('prometheus')).toBeNull();
    });
});
