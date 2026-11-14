'use strict';

const FIX_COMMAND = 'sudo nsenter -t $(pgrep -o dockerd) -m mount --make-rshared /';

const mountinfo = (rootOptional) => [
    `22 1 8:1 / / rw,relatime ${rootOptional} - ext4 /dev/sda1 rw`,
    '30 22 0:5 / /dev rw,nosuid shared:2 - devtmpfs udev rw',
].join('\n');

// A fake /proc: pid -> { comm, mountinfo }. Missing files reject like ENOENT.
function fakeProc(processes, extra = {}) {
    const files = { ...extra };
    for (const [pid, p] of Object.entries(processes)) {
        files[`/proc/${pid}/comm`] = `${p.comm}\n`;
        if (p.mountinfo !== undefined) files[`/proc/${pid}/mountinfo`] = p.mountinfo;
    }
    return {
        readdir: jest.fn(async () => [...Object.keys(processes), 'self', 'cpuinfo']),
        readFile: jest.fn(async (file) => {
            if (!(file in files)) throw Object.assign(new Error(`ENOENT ${file}`), { code: 'ENOENT' });
            return files[file];
        }),
    };
}

async function runCheck({ procFs, platform = 'linux', env = {}, dockerHost = { remote: false, host: 'localhost', endpoint: null } }) {
    const { readRegistration } = require('./helpers/mockRegistration');
    const register = require('../tools/checkPrerequisites');
    const server = { registerTool: jest.fn() };
    register(server, {
        statfs: async () => ({ bavail: 500 * 10 ** 9, bsize: 1 }),
        platform,
        env,
        procFs,
        dockerUtil: {
            docker: jest.fn().mockResolvedValue({ stdout: '24.0.0', stderr: '' }),
            getDockerHost: jest.fn().mockResolvedValue(dockerHost),
            containerProject: jest.fn().mockResolvedValue(null),
            findContainer: jest.fn().mockResolvedValue(null),
        },
        httpClient: { get: jest.fn().mockResolvedValue({ status: 200, data: {} }), post: jest.fn() },
        checkPort: jest.fn().mockResolvedValue(true),
    });
    const parsed = JSON.parse((await readRegistration(server).handler({})).content[0].text);
    return { parsed, check: parsed.checks.find((c) => c.name === 'root_mount_propagation') };
}

describe('check_prerequisites root mount propagation', () => {
    test('a private root fails with the fix command and blocks the result', async () => {
        const procFs = fakeProc({ 200: { comm: 'dockerd', mountinfo: mountinfo('') } });
        const { parsed, check } = await runCheck({ procFs });

        expect(check.passed).toBe(false);
        expect(check.detail).toContain('Created');
        expect(check.remediation).toContain(FIX_COMMAND);
        expect(check.remediation).not.toContain('wsl --shutdown');
        expect(parsed.success).toBe(false);
    });

    test('a private root on WSL (kernel version) also says it resets on restart', async () => {
        const procFs = fakeProc({ 200: { comm: 'dockerd', mountinfo: mountinfo('') } }, { '/proc/version': 'Linux version 6.1 (microsoft-standard-WSL2)' });
        const { check } = await runCheck({ procFs });

        expect(check.passed).toBe(false);
        expect(check.remediation).toContain(FIX_COMMAND);
        expect(check.remediation).toContain('wsl --shutdown');
    });

    test('a private root with WSL_DISTRO_NAME set says it resets on restart', async () => {
        const procFs = fakeProc({ 200: { comm: 'dockerd', mountinfo: mountinfo('') } });
        const { check } = await runCheck({ procFs, env: { WSL_DISTRO_NAME: 'Ubuntu' } });

        expect(check.remediation).toContain('wsl --shutdown');
    });

    test('a shared root passes', async () => {
        const procFs = fakeProc({ 200: { comm: 'dockerd', mountinfo: mountinfo('shared:1') } });
        const { parsed, check } = await runCheck({ procFs });

        expect(check.passed).toBe(true);
        expect(check.skipped).toBeUndefined();
        expect(parsed.success).toBe(true);
    });

    test('a slave root (master:) passes', async () => {
        const procFs = fakeProc({ 200: { comm: 'dockerd', mountinfo: mountinfo('master:3') } });
        const { check } = await runCheck({ procFs });

        expect(check.passed).toBe(true);
        expect(check.skipped).toBeUndefined();
    });

    test('shared on a mount other than / does not pass a private root', async () => {
        const procFs = fakeProc({ 200: { comm: 'dockerd', mountinfo: mountinfo('') } });
        const { check } = await runCheck({ procFs });

        expect(check.passed).toBe(false);
    });

    test('no local dockerd skips without failing', async () => {
        const procFs = fakeProc({ 1: { comm: 'systemd', mountinfo: mountinfo('') }, 50: { comm: 'bash' } });
        const { parsed, check } = await runCheck({ procFs });

        expect(check.passed).toBe(true);
        expect(check.skipped).toBe(true);
        expect(parsed.success).toBe(true);
    });

    test('a non-Linux host skips without reading /proc', async () => {
        const procFs = fakeProc({ 200: { comm: 'dockerd', mountinfo: mountinfo('') } });
        const { check } = await runCheck({ procFs, platform: 'darwin' });

        expect(check.skipped).toBe(true);
        expect(procFs.readdir).not.toHaveBeenCalled();
    });

    test('a remote Docker daemon skips the check', async () => {
        const procFs = fakeProc({ 200: { comm: 'dockerd', mountinfo: mountinfo('') } });
        const { check } = await runCheck({ procFs, dockerHost: { remote: true, host: 'box.example', endpoint: 'ssh://box.example' } });

        expect(check.passed).toBe(true);
        expect(check.skipped).toBe(true);
    });

    test("falls back to PID 1's mountinfo when the daemon's is unreadable", async () => {
        const procFs = fakeProc({ 200: { comm: 'dockerd' }, 1: { comm: 'systemd', mountinfo: mountinfo('') } });
        const { check } = await runCheck({ procFs });

        expect(check.passed).toBe(false);
        expect(check.remediation).toContain(FIX_COMMAND);
    });

    test('skips when neither mountinfo can be read', async () => {
        const procFs = fakeProc({ 200: { comm: 'dockerd' } });
        const { check } = await runCheck({ procFs });

        expect(check.passed).toBe(true);
        expect(check.skipped).toBe(true);
    });
});
