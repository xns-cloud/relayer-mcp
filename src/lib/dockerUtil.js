'use strict';

const net = require('net');
const { execFile: nodeExecFile } = require('child_process');

// Every loopback spelling a Docker endpoint can carry: localhost, the whole
// 127/8 block, the 0.0.0.0 / [::] wildcards, [::1], and IPv4-mapped 127/8
// ([::ffff:127.0.0.1], which URL normalizes to [::ffff:7f00:1]).
function isLoopbackHost(name) {
    if (['localhost', '0.0.0.0', '[::1]', '[::]'].includes(name)) return true;
    if (net.isIPv4(name)) return name.startsWith('127.');
    const mapped = /^\[::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}\]$/.exec(name);
    return Boolean(mapped) && (parseInt(mapped[1], 16) >> 8) === 127;
}

/**
 * Replace the password in an endpoint URL's userinfo with ***. An ssh:// or
 * tcp:// DOCKER_HOST can carry one, and tools echo the endpoint back to the
 * client. The password runs to the LAST '@' before the path, query or
 * fragment, as URL parsers (and Docker's own) read it, so a password
 * containing '@' is fully masked and an '@' after the authority is left alone.
 *
 * @param {string|null|undefined} endpoint
 * @returns {string|null}
 */
function redactEndpoint(endpoint) {
    if (typeof endpoint !== 'string') return endpoint ?? null;
    return endpoint.replace(/^([a-z][a-z0-9+.-]*:\/\/[^:@/?#]*):[^/?#]*@/i, '$1:***@');
}

/**
 * Parse a Docker endpoint URL into { remote, host }.
 *
 * unix:// and npipe:// sockets are local by definition. ssh:// and tcp://
 * point at another machine — unless the hostname is loopback. Anything
 * unparseable falls back to local, matching pre-context behavior.
 *
 * @param {string} endpoint - e.g. 'unix:///var/run/docker.sock', 'ssh://user@host'
 * @returns {{remote: boolean, host: string}}
 */
function parseDockerEndpoint(endpoint) {
    const local = { remote: false, host: 'localhost' };
    if (!endpoint) return local;
    if (endpoint.startsWith('unix://') || endpoint.startsWith('npipe://')) return local;
    try {
        const { hostname } = new URL(endpoint);
        // URL.hostname keeps IPv6 brackets ('tcp://[::1]:2375' → '[::1]') and
        // does not lowercase tcp:// or ssh:// hosts, so compare lowercased.
        // install_relayer refuses a remote daemon, so every loopback form —
        // the whole 127/8 block, the 0.0.0.0 / [::] wildcards — must read local.
        const name = hostname.toLowerCase();
        if (!name || isLoopbackHost(name)) return local;
        return { remote: true, host: hostname };
    } catch {
        return local;
    }
}

// Docker failure causes, first match wins (permission denied before daemon
// stopped: a denied socket can also print "Is the docker daemon running?"; pull
// refused before port in use: a pull error may mention a port).
const FAILURE_PATTERNS = [
    { key: 'permission_denied', pattern: /permission denied/i },
    { key: 'daemon_stopped', pattern: /cannot connect to the docker daemon|is the docker daemon running/i },
    { key: 'out_of_disk', pattern: /no space left on device/i },
    { key: 'pull_refused', pattern: /pull access denied|requested access to the resource is denied|unauthorized|manifest unknown/i },
    { key: 'port_in_use', pattern: /port is already allocated|address already in use/i },
];

// The host side of a bind in Docker's text: "0.0.0.0:8888", "[::]:8888",
// "0.0.0.0:9000:172.18.0.2:9000/tcp" (the first address is the host's).
const BIND_HOST_PORT = /(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]*\]):(\d{1,5})\b/i;

/**
 * Classify a rejected docker() call into a known failure cause.
 *
 * Reads ONLY error.stderr (set by docker() below). error.message embeds the
 * command line, so a compose path containing "8888" or "port" would otherwise
 * be mistaken for that cause. The returned key never carries Docker's text.
 *
 * @param {Error|null|undefined} err - Rejection from docker()/composeUp()
 * @returns {{key: string, port?: number|null}|null} null when nothing matches
 */
function classifyDockerFailure(err) {
    const stderr = err?.stderr;
    if (typeof stderr !== 'string' || stderr === '') return null;
    const match = FAILURE_PATTERNS.find(({ pattern }) => pattern.test(stderr));
    if (!match) return null;
    if (match.key !== 'port_in_use') return { key: match.key };
    const bind = BIND_HOST_PORT.exec(stderr);
    return { key: match.key, port: bind ? Number(bind[1]) : null };
}

/**
 * Docker utility — runs Docker CLI commands using execFile (no shell).
 * Security non-negotiable: NEVER use exec() or spawn({ shell: true }).
 * TP-30 enforced.
 *
 * @param {object} [options]
 * @param {function} [options.execFile] - Injected execFile (testing)
 * @param {object} [options.env] - Injected environment (testing); defaults to process.env
 */
function createDockerUtil(options = {}) {
    const _execFile = options.execFile || nodeExecFile;
    const _env = options.env || process.env;

    /**
     * Run a docker command with args.
     *
     * @param {string[]} args - Docker CLI arguments (e.g. ['compose', '-f', path, 'up', '-d'])
     * @param {object} [execOptions] - Options passed to execFile (cwd, env, timeout, etc.)
     * @returns {Promise<{stdout: string, stderr: string}>}
     */
    function docker(args, execOptions = {}) {
        return new Promise((resolve, reject) => {
            _execFile('docker', args, { timeout: 120000, ...execOptions }, (err, stdout, stderr) => {
                if (err) {
                    const error = new Error(`docker ${args[0]} failed: ${err.message}`);
                    error.stdout = stdout;
                    error.stderr = stderr;
                    error.code = err.code;
                    return reject(error);
                }
                resolve({ stdout: stdout || '', stderr: stderr || '' });
            });
        });
    }

    /**
     * Run docker compose up -d with a given compose file path.
     *
     * @param {string} composePath - Absolute path to docker-compose file
     * @param {object} [execOptions] - Extra execFile options (cwd, env). Lets the
     *   caller resolve .env interpolation + relative binds in the install dir.
     * @returns {Promise<{stdout: string, stderr: string}>}
     */
    async function composeUp(composePath, execOptions = {}) {
        return docker(['compose', '-f', composePath, 'up', '-d'], { timeout: 300000, ...execOptions });
    }

    /**
     * Check if a container is running by name/partial match.
     *
     * @param {string} name - Container name or partial match
     * @returns {Promise<boolean>}
     */
    async function isContainerRunning(name) {
        try {
            const { stdout } = await docker(['ps', '--filter', `name=${name}`, '--format', '{{.Status}}']);
            return stdout.trim().toLowerCase().includes('up');
        } catch {
            return false;
        }
    }

    /**
     * Find a container by EXACT name — running or stopped. A stopped container
     * still owns its name and still breaks `docker compose up`, so callers
     * doing install preflight must use this, not isContainerRunning.
     *
     * Best-effort: if docker itself is unreachable, returns null and lets the
     * caller's real docker command surface the error.
     *
     * @param {string} name - Exact container name
     * @returns {Promise<{name: string, status: string, image: string, running: boolean}|null>}
     */
    async function findContainer(name) {
        try {
            // docker ps --filter name= treats the value as a regex — escape
            // metacharacters (names may contain '.') so the anchor stays exact.
            const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const { stdout } = await docker([
                'ps', '-a',
                '--filter', `name=^${escaped}$`,
                '--format', '{{.Names}}\t{{.Status}}\t{{.Image}}',
            ]);
            const line = stdout.trim().split('\n').filter(Boolean)[0];
            if (!line) return null;
            const [foundName, status = '', image = ''] = line.split('\t');
            return { name: foundName, status, image, running: status.toLowerCase().startsWith('up') };
        } catch {
            return null;
        }
    }

    /**
     * Host ports a container publishes (`docker port <name>`), e.g.
     * "8888/tcp -> 0.0.0.0:8888" and "8888/tcp -> [::]:8888" give [8888].
     *
     * Best-effort like findContainer: an unreachable daemon or an unknown
     * container gives [], so the caller's port check stands as it was.
     *
     * @param {string} name - Exact container name
     * @returns {Promise<number[]>} unique host ports, in output order
     */
    async function containerHostPorts(name) {
        try {
            const { stdout } = await docker(['port', String(name)]);
            const ports = stdout.split('\n')
                .map((line) => /->\s*\S*:(\d{1,5})\s*$/.exec(line.trim()))
                .filter(Boolean)
                .map((m) => Number(m[1]));
            return [...new Set(ports)];
        } catch {
            return [];
        }
    }

    /**
     * Resolve which machine the Docker daemon actually runs on.
     *
     * Claude Code may run on a management node with the Docker CLI pointed at a
     * separate server (DOCKER_HOST or an ssh:// docker context). Tools that
     * probe ports or hit http://localhost must target THIS host instead.
     *
     * Precedence mirrors the Docker CLI: DOCKER_HOST env var wins, then the
     * active context's endpoint. Unparseable/missing → local.
     *
     * @returns {Promise<{remote: boolean, host: string, endpoint: string|null}>}
     */
    async function getDockerHost() {
        if (_env.DOCKER_HOST) {
            return { ...parseDockerEndpoint(_env.DOCKER_HOST), endpoint: _env.DOCKER_HOST };
        }
        try {
            const { stdout } = await docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
            const endpoint = stdout.trim();
            return { ...parseDockerEndpoint(endpoint), endpoint: endpoint || null };
        } catch {
            return { remote: false, host: 'localhost', endpoint: null };
        }
    }

    return { docker, composeUp, isContainerRunning, findContainer, containerHostPorts, getDockerHost };
}

module.exports = { createDockerUtil, parseDockerEndpoint, redactEndpoint, classifyDockerFailure };
