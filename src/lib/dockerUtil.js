'use strict';

const { execFile: nodeExecFile } = require('child_process');

/**
 * Docker utility — runs Docker CLI commands using execFile (no shell).
 * Security non-negotiable: NEVER use exec() or spawn({ shell: true }).
 * TP-30 enforced.
 *
 * @param {object} [options]
 * @param {function} [options.execFile] - Injected execFile (testing)
 */
function createDockerUtil(options = {}) {
    const _execFile = options.execFile || nodeExecFile;

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
     * @returns {Promise<{stdout: string, stderr: string}>}
     */
    async function composeUp(composePath) {
        return docker(['compose', '-f', composePath, 'up', '-d'], { timeout: 300000 });
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

    return { docker, composeUp, isContainerRunning };
}

module.exports = { createDockerUtil };
