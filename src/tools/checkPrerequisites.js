'use strict';

const net = require('net');
const os = require('os');
const path = require('path');
const { createHttpClient } = require('../lib/httpClient');
const { createDockerUtil, redactEndpoint, classifyDockerFailure } = require('../lib/dockerUtil');
const { environmentProbe: defaultEnvironmentProbe } = require('../lib/environmentProbe');

// The one-command install (installs Docker, the compose plugin and the Relayer).
const INSTALL_COMMAND = 'curl -fsSL https://releases.scpri.me/relayer/install.sh | sh';

// The container the install script and install_relayer start.
const RELAYER_CONTAINER = 'xns-relayer';

// The Compose project the install script and install_relayer start the stack
// under, and the two monitoring containers the release compose names outright
// (container_name). A container with one of these names that belongs to some
// other project makes `docker compose up` fail with a name conflict.
const RELAYER_PROJECT = 'xns-relayer';
const FIXED_CONTAINER_NAMES = ['prometheus', 'alertmanager'];

// install_relayer's default install_path; the install script uses the same dir.
const DEFAULT_INSTALL_DIR = '/opt/xns-relayer';

// 10 GB in decimal bytes: fails at 10*10^9 - 1, passes at 10*10^9.
const MIN_FREE_BYTES = 10 * 10 ** 9;
const BYTES_PER_GB = 10 ** 9;

const GROUP_NOTE = 'the Docker socket refuses this user until the docker group applies (see docker_group)';

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

/**
 * Free space as "9.99 GB", rounded DOWN so a figure just under the threshold
 * never prints as "10.00 GB".
 */
function formatGb(bytes) {
    return `${(Math.floor(bytes / (BYTES_PER_GB / 100)) / 100).toFixed(2)} GB`;
}

/**
 * statfs the nearest existing ancestor of `target` (the install dir usually
 * does not exist before the install). Only ENOENT walks up; any other error
 * propagates so the caller reports the leg as unreadable, never as passed.
 *
 * @returns {Promise<{path: string, freeBytes: number}>}
 */
async function freeBytesAt(statfs, target) {
    let current = path.resolve(target);
    for (;;) {
        try {
            const stats = await statfs(current);
            return { path: current, freeBytes: Number(stats.bavail) * Number(stats.bsize) };
        } catch (err) {
            const parent = path.dirname(current);
            if (err?.code !== 'ENOENT' || parent === current) throw err;
            current = parent;
        }
    }
}

/**
 * True when /etc/group's docker line lists the user. An unreadable file reads
 * as "not listed", which names the add-group command (safe either way).
 */
async function isInDockerGroup(readFile, username) {
    try {
        const groupFile = await readFile('/etc/group', 'utf8');
        const line = String(groupFile).split('\n').find((l) => l.startsWith('docker:'));
        if (!line) return false;
        const members = (line.split(':')[3] || '').split(',').map((m) => m.trim());
        return members.includes(username);
    } catch (err) {
        console.error(`[check_prerequisites] could not read /etc/group: ${err.message}`);
        return false;
    }
}

module.exports = function registerCheckPrerequisites(server, options = {}) {
    const docker = options.dockerUtil || createDockerUtil(options);
    const http = options.httpClient || createHttpClient(options);
    const _checkPort = options.checkPort || checkPort;
    const _environmentProbe = options.environmentProbe || defaultEnvironmentProbe;
    const _statfs = options.statfs || require('fs').promises.statfs;
    const _readFile = options.fs?.readFile || require('fs').promises.readFile;
    const _userInfo = options.userInfo || os.userInfo;

    /**
     * install_relayer is fresh-install only; an existing xns-relayer container
     * (running or stopped, any channel) would fail it with a name conflict.
     * A RUNNING one (e.g. the one the install script started) is ready to use,
     * so its remediation never says to stop or remove it.
     */
    async function checkExistingInstall(dockerState) {
        if (dockerState === 'denied') {
            return { name: 'existing_install', passed: true, skipped: true, detail: `Existing-install check skipped — ${GROUP_NOTE}.` };
        }
        let existing;
        try {
            existing = await docker.findContainer(RELAYER_CONTAINER);
        } catch {
            return { name: 'existing_install', passed: true, detail: 'Existing-install check skipped (Docker not reachable)' };
        }
        if (!existing) {
            return { name: 'existing_install', passed: true, detail: 'No existing xns-relayer container — ready for a fresh install' };
        }
        const detail = `An existing 'xns-relayer' container was found (status: ${existing.status}; image: ${existing.image}).`;
        if (existing.running) {
            return {
                name: 'existing_install',
                passed: true,
                warning: true,
                detail,
                remediation: 'This Relayer is already installed and running, and install_relayer performs fresh installs only, so skip install_relayer and continue onboarding with check_relayer_health against it.',
            };
        }
        return {
            name: 'existing_install',
            passed: true,
            warning: true,
            detail,
            remediation: 'install_relayer performs fresh installs only. To replace the existing deployment: docker stop xns-relayer && docker rm xns-relayer (data directory is preserved), then install. To keep it, skip install_relayer and continue onboarding against the existing deployment.',
        };
    }

    /**
     * The remote Docker host a failed `docker info` was aimed at, or null when
     * the daemon is local or the host cannot be resolved.
     */
    async function remoteHostOf() {
        try {
            const raw = await docker.getDockerHost();
            const host = typeof raw?.host === 'string' ? raw.host.trim() : '';
            if (!raw?.remote || host === '' || host === 'localhost') return null;
            return { remote: true, host, endpoint: redactEndpoint(raw.endpoint) };
        } catch {
            return null;
        }
    }

    /** Containers named prometheus/alertmanager that are not this Relayer's. */
    async function checkFixedNames(dockerState, dockerHost) {
        const name = 'fixed_container_names';
        if (dockerState !== 'ok' || dockerHost.remote) {
            return { name, passed: true, skipped: true, detail: 'Container-name check skipped — Docker is not readable on this machine.' };
        }
        const foreign = [];
        for (const containerName of FIXED_CONTAINER_NAMES) {
            const project = await docker.containerProject(containerName);
            if (project !== null && project !== RELAYER_PROJECT) foreign.push(containerName);
        }
        if (foreign.length === 0) {
            return { name, passed: true, detail: 'No other container is named prometheus or alertmanager' };
        }
        return {
            name,
            passed: false,
            detail: `A container named ${foreign.join(' and ')} already exists and is not part of the Relayer; the Relayer needs those names`,
            remediation: `Rename it (docker rename ${foreign[0]} ${foreign[0]}-old) or remove it, then re-run check_prerequisites.`,
        };
    }

    /** One filesystem leg of the disk check. */
    async function diskLeg(which, target) {
        try {
            const { path: fsPath, freeBytes } = await freeBytesAt(_statfs, target);
            return { which, path: fsPath, free_bytes: freeBytes, passed: freeBytes >= MIN_FREE_BYTES };
        } catch (err) {
            console.error(`[check_prerequisites] statfs ${target} failed: ${err.message}`);
            return { which, path: target, passed: true, skipped: true, detail: `Free space on the ${which} could not be read` };
        }
    }

    /** The Docker root leg: only for a local daemon whose `docker info` answered. */
    async function dockerRootLeg(dockerState, dockerHost) {
        const which = 'Docker root';
        if (dockerHost.remote) {
            return { which, passed: true, skipped: true, detail: `Docker root check skipped — the Docker daemon runs on ${dockerHost.host}, so its disk must be checked there` };
        }
        if (dockerState !== 'ok') {
            return { which, passed: true, skipped: true, detail: 'Docker root check skipped — docker info is not readable' };
        }
        let rootDir = '';
        try {
            const { stdout } = await docker.docker(['info', '--format', '{{.DockerRootDir}}']);
            rootDir = String(stdout).trim();
        } catch (err) {
            console.error(`[check_prerequisites] docker info DockerRootDir failed: ${err.message}`);
        }
        if (!path.isAbsolute(rootDir)) {
            return { which, passed: true, skipped: true, detail: 'Docker root check skipped — docker info gave no Docker root directory' };
        }
        return diskLeg(which, rootDir);
    }

    async function checkDisk(dockerState, dockerHost) {
        const filesystems = [
            await dockerRootLeg(dockerState, dockerHost),
            await diskLeg('install dir', DEFAULT_INSTALL_DIR),
        ];
        const short = filesystems.filter((f) => !f.passed);
        if (short.length === 0) {
            return { name: 'disk', passed: true, detail: 'At least 10 GB is free on the Docker root and the install dir', filesystems };
        }
        const where = short.map((f) => `${formatGb(f.free_bytes)} free on the ${f.which} (${f.path})`).join(' and ');
        return {
            name: 'disk',
            passed: false,
            detail: `Not enough disk space: ${where}; the Relayer needs at least 10 GB free on each`,
            remediation: `Free up space until at least 10 GB is free on ${short.map((f) => `${f.path} (${f.which})`).join(' and ')}, then re-run check_prerequisites. Check with: df -h ${short.map((f) => f.path).join(' ')}`,
            filesystems,
        };
    }

    server.registerTool(
        'check_prerequisites',
        {
            title: 'check_prerequisites',
            description: 'Check system prerequisites for XNS Relayer installation: Docker installed and its daemon running (local or remote via DOCKER_HOST / ssh:// context), the Docker compose plugin, docker group access for this user, required ports (8888, 9000, 9443; a port held by the running xns-relayer container passes), no container from another project named prometheus or alertmanager, an existing xns-relayer installation, at least 10 GB free on the Docker root and the install directory, and network connectivity to console.xns.tech and auth.xns.tech. Also fails the check when the Docker daemon is on another machine (install_file_location), because install_relayer refuses in that case; run the MCP on the Docker host instead. Run this first before any other relayer tool.',
            inputSchema: {
                /* no parameters */
            },
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                openWorldHint: true,
            },
        },
        async () => {
            const checks = [];
            let allPassed = true;

            // 1. Docker available — and WHERE it runs. With DOCKER_HOST or an
            // ssh:// context (e.g. Claude Code on a jump host), the daemon is
            // on another machine and the local checks below must adapt.
            const DEFAULT_DOCKER_HOST = { remote: false, host: 'localhost', endpoint: null };
            let dockerHost = DEFAULT_DOCKER_HOST;
            // 'ok' | 'missing' (no docker CLI) | 'stopped' (daemon unreachable) |
            // 'denied' (socket refuses this user: the daemon runs).
            let dockerState = 'ok';
            try {
                await docker.docker(['info', '--format', '{{.ServerVersion}}']);
                const raw = await docker.getDockerHost();
                // remote without a usable host is incomplete metadata — treat
                // as local so the port checks run instead of silently skipping
                // against a host we cannot name.
                const remoteHost = typeof raw?.host === 'string' ? raw.host.trim() : '';
                const isRemote = Boolean(raw?.remote) && remoteHost !== '' && remoteHost !== 'localhost';
                dockerHost = {
                    remote: isRemote,
                    host: isRemote ? remoteHost : 'localhost',
                    endpoint: redactEndpoint(raw?.endpoint),  // echoed in the docker check detail
                };
                checks.push({
                    name: 'docker',
                    passed: true,
                    detail: dockerHost.remote
                        ? `Docker is running on a remote host (${dockerHost.host}, via ${dockerHost.endpoint})`
                        : 'Docker is running',
                });
            } catch (err) {
                // Missing is decided by the spawn code, never by message text:
                // a daemon error can say "no such file or directory" too.
                const remote = err?.code === 'ENOENT' ? null : await remoteHostOf();
                if (err?.code === 'ENOENT') {
                    dockerState = 'missing';
                    allPassed = false;
                    checks.push({
                        name: 'docker',
                        passed: false,
                        detail: 'Docker is not installed on this machine',
                        remediation: `Run the one-command install, which installs Docker, the compose plugin and the Relayer: ${INSTALL_COMMAND} (Ubuntu 24.04 or Debian 12). To install on a different persistent machine, run this MCP on that machine (a Docker host with Node.js 20) rather than pointing at it remotely.`,
                    });
                } else if (remote) {
                    // DECISION: a failing `docker info` against an ssh:// or tcp://
                    // DOCKER_HOST is a problem with that host, not with this user's
                    // docker group, and the daemon-stopped command would be run on
                    // the wrong machine. Name the host; the remote checks that
                    // follow (install_file_location, ports skipped) then apply.
                    dockerState = 'stopped';
                    dockerHost = remote;
                    allPassed = false;
                    checks.push({
                        name: 'docker',
                        passed: false,
                        detail: `The Docker daemon on ${remote.host} (via ${remote.endpoint}) could not be reached`,
                        remediation: `Check the connection and that Docker is running on ${remote.host}, and that your user there can use it (docker group on ${remote.host}, not on this machine). Or unset DOCKER_HOST / switch to the default Docker context to use this machine.`,
                    });
                } else if (classifyDockerFailure(err)?.key === 'permission_denied') {
                    // The daemon answered and refused this user: Docker is fine,
                    // the docker_group check below carries the one failure.
                    dockerState = 'denied';
                    checks.push({
                        name: 'docker',
                        passed: true,
                        detail: 'Docker is installed and its daemon is running, but the Docker socket refuses this user',
                    });
                } else {
                    dockerState = 'stopped';
                    allPassed = false;
                    checks.push({
                        name: 'docker',
                        passed: false,
                        detail: 'Docker is installed, but the Docker daemon is not running',
                        remediation: 'Start the Docker daemon: sudo systemctl start docker',
                    });
                }
            }

            // 1a. Compose plugin. `docker compose version` needs no daemon, so it
            // runs when the daemon is down or the socket refuses; only a missing
            // docker CLI skips it (Docker-missing is then the one failure).
            if (dockerState === 'missing') {
                checks.push({ name: 'docker_compose', passed: true, skipped: true, detail: 'Compose plugin check skipped — Docker is not installed (the one-command install adds both)' });
            } else {
                try {
                    await docker.docker(['compose', 'version']);
                    checks.push({ name: 'docker_compose', passed: true, detail: 'The Docker compose plugin is installed' });
                } catch {
                    allPassed = false;
                    checks.push({
                        name: 'docker_compose',
                        passed: false,
                        detail: 'The Docker compose plugin is missing',
                        remediation: "Install it from Docker's apt repository: sudo apt-get install docker-compose-plugin",
                    });
                }
            }

            // 1b. docker group. Decided by `docker info` itself: only a denied
            // socket is a group problem (root and rootless Docker answer without
            // the group). /etc/group then tells "not added" from "added, but this
            // session predates it".
            if (dockerState === 'denied') {
                allPassed = false;
                const username = _userInfo().username;
                if (await isInDockerGroup(_readFile, username)) {
                    checks.push({
                        name: 'docker_group',
                        passed: false,
                        detail: `${username} is in the docker group, but this session started before the group was added, so the Docker socket still refuses it`,
                        remediation: 'Your session predates the group change: log out and back in (or reboot), then re-run check_prerequisites. Nothing needs reinstalling.',
                    });
                } else {
                    checks.push({
                        name: 'docker_group',
                        passed: false,
                        detail: `${username} is not in the docker group, so the Docker socket refuses it`,
                        remediation: `Add yourself to the docker group: sudo usermod -aG docker ${username} — then log out and back in and re-run check_prerequisites.`,
                    });
                }
            } else if (dockerState === 'ok') {
                checks.push({ name: 'docker_group', passed: true, detail: 'This user can reach the Docker daemon' });
            } else {
                checks.push({ name: 'docker_group', passed: true, skipped: true, detail: 'Docker group check skipped — the Docker daemon is not reachable' });
            }

            // 1b. install_relayer refuses when the daemon is on another machine
            // (it writes docker-compose.yml and .env on THIS machine). Fail here
            // so a passing check is never followed by a refused install.
            if (dockerHost.remote) {
                allPassed = false;
                checks.push({
                    name: 'install_file_location',
                    passed: false,
                    detail: `The Docker daemon is on ${dockerHost.host}, not this machine. install_relayer will refuse: it writes docker-compose.yml and .env on this machine, not on ${dockerHost.host}.`,
                    remediation: `Run the MCP on ${dockerHost.host} (install Node.js 20 there and point your MCP client at it), then run check_prerequisites and install_relayer from there. Or unset DOCKER_HOST / switch to the default Docker context to install on this machine.`,
                });
            }

            // 2-3. Required ports. The bind-probe runs on THIS machine — when
            // the Docker daemon is remote, the containers (and their port
            // bindings) live on the remote host, so a local probe would test
            // the wrong machine. Report skipped instead of a false answer.
            const requiredPorts = [
                { port: 8888, name: 'port_8888', service: 'the Relayer UI', inUseRemediation: 'Port 8888 is required for the Relayer UI. Stop the service using this port, or install with a different port via install_relayer ui_port.' },
                { port: 9000, name: 'port_9000', service: 'the S3 gateway', inUseRemediation: 'Port 9000 is required for the S3 gateway. Stop the service using this port (common conflict: another S3-compatible service), or install with a different port via install_relayer s3_port.' },
                // The release compose publishes the S3 HTTPS port too. install_relayer
                // has no parameter for it, so the only fix is to free it.
                { port: 9443, name: 'port_9443', service: 'the S3 HTTPS port', inUseRemediation: 'Port 9443 is required for the S3 HTTPS port. Stop the service using this port; install_relayer ui_port and s3_port do not move it.' },
            ];
            // The install script leaves its own xns-relayer holding 8888/9000.
            // Those ports are "in use" by the Relayer itself: a pass, not a
            // conflict. Looked up once, only when a bind-probe finds a port held.
            let ownPorts = null;
            const relayerHostPorts = async () => {
                if (ownPorts) return ownPorts;
                ownPorts = [];
                const container = await docker.findContainer(RELAYER_CONTAINER);
                if (container?.running) {
                    // containerHostPorts answers [] on any docker failure.
                    ownPorts = await docker.containerHostPorts(RELAYER_CONTAINER);
                }
                return ownPorts;
            };
            for (const { port, name, inUseRemediation } of requiredPorts) {
                if (dockerState === 'denied') {
                    // Who holds the port cannot be read through a refused socket,
                    // and right after the install script it is our own Relayer.
                    checks.push({ name, passed: true, skipped: true, detail: `Port ${port} check skipped — ${GROUP_NOTE}.` });
                    continue;
                }
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
                    } else if (dockerState === 'ok' && (await relayerHostPorts()).includes(port)) {
                        checks.push({ name, passed: true, detail: `Port ${port} is in use by the running ${RELAYER_CONTAINER} container (this Relayer), which is expected` });
                    } else {
                        allPassed = false;
                        checks.push({ name, passed: false, detail: `Port ${port} is already in use`, remediation: inUseRemediation });
                    }
                } catch {
                    allPassed = false;
                    checks.push({ name, passed: false, detail: `Could not check port ${port}`, remediation: 'Ensure you have permission to bind ports. On Linux, non-root users may need to use ports above 1024.' });
                }
            }

            // 3a. The release compose fixes the names prometheus and alertmanager.
            // A container of that name from another Compose project stops the install.
            const fixedNames = await checkFixedNames(dockerState, dockerHost);
            if (!fixedNames.passed) allPassed = false;
            checks.push(fixedNames);

            // 3b. Existing installation — warn early, here.
            checks.push(await checkExistingInstall(dockerState));

            // 3c. Ephemeral environment — finding, never a failure.
            try {
                const probe = _environmentProbe();
                if (probe.ephemeral) {
                    const remoteDocker = dockerHost.remote;
                    checks.push({
                        name: 'ephemeral_environment',
                        passed: true,
                        warning: true,
                        detail: remoteDocker
                            ? `This environment appears to be ephemeral (${probe.signals.join('; ')}), but Docker targets a remote host (${dockerHost.host}). Persistence depends on the remote Docker host.`
                            : `This environment appears to be ephemeral (${probe.signals.join('; ')}). A Relayer installed here will be lost when the container exits.`,
                        remediation: remoteDocker
                            ? `install_relayer will refuse while Docker targets ${dockerHost.host}. Run the MCP on ${dockerHost.host} (a persistent Docker host) instead of from this ephemeral environment.`
                            : 'Install on a persistent Docker host instead. If you are running from a sandbox or CI, run the MCP on a persistent Docker host rather than here.',
                    });
                } else {
                    checks.push({ name: 'ephemeral_environment', passed: true, detail: 'Environment appears persistent — install will survive restarts' });
                }
            } catch {
                checks.push({ name: 'ephemeral_environment', passed: true, detail: 'Ephemeral-environment check skipped (probe error)' });
            }

            // 4. Disk space: at least 10 GB free on BOTH the Docker root (images
            // land there; often its own volume) and the install dir's filesystem.
            const diskCheck = await checkDisk(dockerState, dockerHost);
            if (!diskCheck.passed) allPassed = false;
            checks.push(diskCheck);

            // 5-6. Network connectivity
            const connectivityChecks = [
                { url: 'https://console.xns.tech/health', name: 'connectivity_console', host: 'console.xns.tech' },
                { url: 'https://auth.xns.tech/auth/realms/scprime/.well-known/openid-configuration', name: 'connectivity_auth', host: 'auth.xns.tech' },
                // The registry install_relayer pulls from (release channel, anonymous).
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
