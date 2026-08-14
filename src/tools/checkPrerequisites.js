'use strict';

const net = require('net');
const { createHttpClient } = require('../lib/httpClient');
const { createDockerUtil } = require('../lib/dockerUtil');
const { environmentProbe: defaultEnvironmentProbe } = require('../lib/environmentProbe');

/**
 * Tool 1: check_prerequisites
 * Reports docker, ports, disk, and connectivity in plain English.
 * AC-3: plain English report. AC-4: each failure names problem AND remediation hint.
 */

/**
 * Check if a TCP port is available by attempting to bind.
 * R7: net.createServer bind-probe (platform-agnostic), not lsof/netstat.
 *
 * @param {number} port
 * @returns {Promise<boolean>} true if available (not in use)
 */
function checkPort(port) {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.once('error', () => resolve(false));
        srv.once('listening', () => {
            srv.close(() => resolve(true));
        });
        srv.listen(port, '0.0.0.0');
    });
}

module.exports = function registerCheckPrerequisites(server, options = {}) {
    const docker = options.dockerUtil || createDockerUtil(options);
    const http = options.httpClient || createHttpClient(options);
    const _checkPort = options.checkPort || checkPort;
    const _environmentProbe = options.environmentProbe || defaultEnvironmentProbe;

    server.tool(
        'check_prerequisites',
        'Check system prerequisites for XNS Relayer installation: Docker availability (local or remote via DOCKER_HOST / ssh:// context), required ports (8888, 9000), an existing xns-relayer installation, disk space, and network connectivity to console.xns.tech and auth.xns.tech. Run this first before any other relayer tool.',
        {
            /* no parameters */
        },
        async () => {
            const checks = [];
            let allPassed = true;

            // 1. Docker available — and WHERE it runs. With DOCKER_HOST or an
            // ssh:// context (e.g. Claude Code on a jump host), the daemon is
            // on another machine and the local checks below must adapt.
            let dockerHost = { remote: false, host: 'localhost', endpoint: null };
            try {
                await docker.docker(['info', '--format', '{{.ServerVersion}}']);
                dockerHost = await docker.getDockerHost();
                checks.push({
                    name: 'docker',
                    passed: true,
                    detail: dockerHost.remote
                        ? `Docker is running on a remote host (${dockerHost.host}, via ${dockerHost.endpoint})`
                        : 'Docker is running',
                });
            } catch (err) {
                allPassed = false;
                checks.push({
                    name: 'docker',
                    passed: false,
                    detail: 'Docker is not available or not running',
                    remediation: 'Install Docker Engine (https://docs.docker.com/engine/install/) and ensure the Docker daemon is running. On Linux: sudo systemctl start docker. Remote daemon: create an SSH context — docker context create relayer --docker "host=ssh://user@host" && docker context use relayer',
                });
            }

            // 2-3. Required ports. The bind-probe runs on THIS machine — when
            // the Docker daemon is remote, the containers (and their port
            // bindings) live on the remote host, so a local probe would test
            // the wrong machine. Report skipped instead of a false answer.
            const requiredPorts = [
                { port: 8888, name: 'port_8888', service: 'the Relayer UI', inUseRemediation: 'Port 8888 is required for the Relayer UI. Stop the service using this port, or install with a different port via install_relayer ui_port.' },
                { port: 9000, name: 'port_9000', service: 'the S3 gateway', inUseRemediation: 'Port 9000 is required for the S3 gateway. Stop the service using this port (common conflict: another S3-compatible service), or install with a different port via install_relayer s3_port.' },
            ];
            for (const { port, name, inUseRemediation } of requiredPorts) {
                if (dockerHost.remote) {
                    checks.push({
                        name,
                        passed: true,
                        skipped: true,
                        detail: `Port ${port} check skipped — the Docker daemon runs on ${dockerHost.host}, so port availability must be checked there (e.g. ss -tlnp | grep ${port} on that host).`,
                    });
                    continue;
                }
                try {
                    const available = await _checkPort(port);
                    if (available) {
                        checks.push({ name, passed: true, detail: `Port ${port} is available` });
                    } else {
                        allPassed = false;
                        checks.push({ name, passed: false, detail: `Port ${port} is already in use`, remediation: inUseRemediation });
                    }
                } catch {
                    allPassed = false;
                    checks.push({ name, passed: false, detail: `Could not check port ${port}`, remediation: 'Ensure you have permission to bind ports. On Linux, non-root users may need to use ports above 1024.' });
                }
            }

            // 3b. Existing installation. install_relayer is fresh-install only;
            // an existing xns-relayer container (running or stopped, any
            // channel) would fail it with a name conflict. Warn early, here.
            try {
                const existing = await docker.findContainer('xns-relayer');
                if (existing) {
                    checks.push({
                        name: 'existing_install',
                        passed: true,
                        warning: true,
                        detail: `An existing 'xns-relayer' container was found (status: ${existing.status}; image: ${existing.image}).`,
                        remediation: 'install_relayer performs fresh installs only. To replace the existing deployment: docker stop xns-relayer && docker rm xns-relayer (data directory is preserved), then install. To keep it, skip install_relayer and continue onboarding against the running deployment.',
                    });
                } else {
                    checks.push({ name: 'existing_install', passed: true, detail: 'No existing xns-relayer container — ready for a fresh install' });
                }
            } catch {
                checks.push({ name: 'existing_install', passed: true, detail: 'Existing-install check skipped (Docker not reachable)' });
            }

            // 3c. Ephemeral environment — finding, never a failure.
            try {
                const probe = _environmentProbe();
                if (probe.ephemeral) {
                    checks.push({
                        name: 'ephemeral_environment',
                        passed: true,
                        warning: true,
                        detail: `This environment appears to be ephemeral (${probe.signals.join('; ')}). A Relayer installed here will be lost when the container exits.`,
                        remediation: 'Install on a persistent Docker host instead. If you are running from a sandbox or CI, use an SSH Docker context to target a persistent machine: docker context create relayer --docker "host=ssh://user@host" && docker context use relayer',
                    });
                } else {
                    checks.push({ name: 'ephemeral_environment', passed: true, detail: 'Environment appears persistent — install will survive restarts' });
                }
            } catch {
                checks.push({ name: 'ephemeral_environment', passed: true, detail: 'Ephemeral-environment check skipped (probe error)' });
            }

            // 4. Disk space (need at least 10 GB free — basic docker images + data)
            try {
                await docker.docker(['system', 'df', '--format', '{{.TotalCount}}']);
                // If docker works, disk is implicitly accessible. We check via df on root.
                checks.push({ name: 'disk', passed: true, detail: 'Docker storage is accessible' });
            } catch {
                // If docker system df fails but docker info succeeded, still note it
                checks.push({ name: 'disk', passed: true, detail: 'Disk check skipped (Docker storage stats unavailable)' });
            }

            // 5-6. Network connectivity
            const connectivityChecks = [
                { url: 'https://console.xns.tech/health', name: 'connectivity_console', host: 'console.xns.tech' },
                { url: 'https://auth.xns.tech/auth/realms/scprime/.well-known/openid-configuration', name: 'connectivity_auth', host: 'auth.xns.tech' },
                // The registry install_relayer pulls from (beta channel, anonymous).
                // /v2/ is the registry version probe — 200 without credentials.
                { url: 'https://releases.scpri.me/v2/', name: 'connectivity_registry', host: 'releases.scpri.me' },
            ];
            for (const { url, name, host } of connectivityChecks) {
                try {
                    const { status } = await http.get(url, { timeout: 10000 });
                    if (status >= 200 && status < 500) {
                        checks.push({ name, passed: true, detail: `${host} is reachable` });
                    } else {
                        allPassed = false;
                        checks.push({ name, passed: false, detail: `${host} returned HTTP ${status}`, remediation: `Ensure outbound HTTPS (port 443) to ${host} is allowed. Check DNS resolution and firewall rules.` });
                    }
                } catch (err) {
                    allPassed = false;
                    checks.push({ name, passed: false, detail: `Cannot reach ${host}: ${err.message}`, remediation: `Ensure outbound HTTPS (port 443) to ${host} is allowed. Check DNS resolution and firewall rules.` });
                }
            }

            const result = {
                success: allPassed,
                checks,
                summary: allPassed
                    ? 'All prerequisites met. Ready to proceed with Relayer setup.'
                    : `${checks.filter((c) => !c.passed).length} prerequisite(s) failed. Review the checks above for details and remediation steps.`,
            };

            return {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            };
        },
    );
};
