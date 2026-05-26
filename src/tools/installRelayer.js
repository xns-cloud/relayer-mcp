'use strict';

const { z } = require('zod');
const { createDockerUtil } = require('../lib/dockerUtil');

/**
 * Tool 4: install_relayer
 * AC-12: confirms "containers starting"; no manual shell.
 * TP-30: uses execFile, no shell (security non-negotiable).
 *
 * Downloads a docker-compose file from a URL and runs docker compose up -d.
 * The compose URL is a build input (R4) — the operator or agent provides it.
 */
module.exports = function registerInstallRelayer(server, options = {}) {
    const docker = options.dockerUtil || createDockerUtil(options);
    const _execFile = options.execFile;

    server.tool(
        'install_relayer',
        'Install and start the XNS Relayer by running docker compose with the provided compose file URL. Downloads the compose file and starts all containers. No manual shell commands needed.',
        {
            compose_url: z.string().url().describe('URL to the docker-compose.yml file for the XNS Relayer alpha release'),
            install_path: z.string().optional().default('/opt/xns-relayer').describe('Directory to install the compose file into'),
        },
        async ({ compose_url, install_path }) => {
            try {
                const { execFile: nodeExecFile } = require('child_process');
                const execFileFn = _execFile || nodeExecFile;
                const path = require('path');
                const composePath = path.join(install_path, 'docker-compose.yml');

                // Create install directory
                await new Promise((resolve, reject) => {
                    execFileFn('mkdir', ['-p', install_path], {}, (err) => {
                        if (err) return reject(new Error(`Failed to create directory ${install_path}: ${err.message}`));
                        resolve();
                    });
                });

                // Download compose file using curl (execFile, no shell)
                await new Promise((resolve, reject) => {
                    execFileFn('curl', ['-fsSL', '-o', composePath, compose_url], { timeout: 60000 }, (err, stdout, stderr) => {
                        if (err) return reject(new Error(`Failed to download compose file: ${err.message}`));
                        resolve();
                    });
                });

                // Run docker compose up -d
                await docker.composeUp(composePath);

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: true,
                            message: 'XNS Relayer containers are starting. Use check_relayer_health to monitor when all services are ready.',
                            compose_path: composePath,
                            install_path,
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            error: `Relayer installation failed: ${err.message}`,
                        }),
                    }],
                    isError: true,
                };
            }
        },
    );
};
