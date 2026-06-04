'use strict';

const { execFile: nodeExecFile } = require('child_process');

/**
 * Parse a Docker endpoint URL into { remote, host }.
 *
 * unix:// and npipe:// sockets are local by definition. ssh:// and tcp://
 * point at another machine — unless the hostname is loopback. Anything
 * unparseable falls back to local, matching pre-context behaviour.
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
        if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1') return local;
        return { remote: true, host: hostname };
    } catch {
        return local;
    }
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
            const { stdout } = await docker([
                'ps', '-a',
                '--filter', `name=^${name}$`,
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

    return { docker, composeUp, isContainerRunning, findContainer, getDockerHost };
}

module.exports = { createDockerUtil, parseDockerEndpoint };
