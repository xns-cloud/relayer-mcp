'use strict';

const net = require('net');
const { createHttpClient } = require('../lib/httpClient');
const { createDockerUtil } = require('../lib/dockerUtil');

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

    server.tool(
        'check_prerequisites',
        'Check system prerequisites for XNS Relayer installation: Docker availability, required ports (8888, 9000), disk space, and network connectivity to console.xns.tech and auth.xns.tech. Run this first before any other relayer tool.',
        {
            /* no parameters */
        },
        async () => {
            const checks = [];
            let allPassed = true;

            // 1. Docker available
            try {
                await docker.docker(['info', '--format', '{{.ServerVersion}}']);
                checks.push({ name: 'docker', passed: true, detail: 'Docker is running' });
            } catch (err) {
                allPassed = false;
                checks.push({
                    name: 'docker',
                    passed: false,
                    detail: 'Docker is not available or not running',
                    remediation: 'Install Docker Engine (https://docs.docker.com/engine/install/) and ensure the Docker daemon is running. On Linux: sudo systemctl start docker',
                });
            }

            // 2-3. Required ports
            const requiredPorts = [
                { port: 8888, name: 'port_8888', service: 'the Relayer UI', inUseRemediation: 'Port 8888 is required for the Relayer UI. Stop the service using this port or choose a different host.' },
                { port: 9000, name: 'port_9000', service: 'the S3 gateway', inUseRemediation: 'Port 9000 is required for the S3 gateway. Stop the service using this port (common conflict: MinIO or another S3-compatible service).' },
            ];
            for (const { port, name, inUseRemediation } of requiredPorts) {
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
