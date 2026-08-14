'use strict';

const nodeFs = require('fs');

/**
 * Read-only environment probes to detect whether the current process is
 * running inside an ephemeral container (Docker, CI runner, sandbox).
 *
 * Ephemeral environments can run the Relayer install, but the installation
 * will be lost when the container exits. This is a finding (warning), not
 * a failure — allPassed must never flip.
 *
 * @param {object} [options]
 * @param {object} [options.fs] - Injected fs module (testing)
 * @param {number} [options.pid] - Override process PID (testing; avoids false PID-1 signal in CI containers)
 * @returns {{ ephemeral: boolean, signals: string[] }}
 */
function environmentProbe(options = {}) {
    const fs = options.fs || nodeFs;
    const pid = options.pid ?? process.pid;
    const signals = [];

    try {
        fs.accessSync('/.dockerenv', nodeFs.constants?.F_OK ?? 0);
        signals.push('/.dockerenv exists');
    } catch {
        // Not present — not a signal
    }

    try {
        const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
        if (/docker|containerd|kubepods|lxc/i.test(cgroup)) {
            signals.push('/proc/1/cgroup references a container runtime');
        }
    } catch {
        // Not readable — not a signal
    }

    if (pid === 1) {
        signals.push('Process is PID 1');
    }

    try {
        fs.accessSync('/run/systemd/system', nodeFs.constants?.F_OK ?? 0);
    } catch {
        signals.push('systemd is absent');
    }

    return {
        ephemeral: signals.length >= 2,
        signals,
    };
}

module.exports = { environmentProbe };
