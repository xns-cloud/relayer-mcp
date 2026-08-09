'use strict';

/**
 * installRelayer.binding-t1.test.js — E-A2 T1 verify phase.
 *
 * The build's three binding tests all drive NON-default ports or the
 * compose_url override. The modal operator path — `install_relayer` with no
 * port arguments at all, where the Zod defaults fill 8888/9000 — is untested,
 * and AC8 ("the installer prints the binding at install time") is mostly about
 * exactly that path.
 *
 * Second gap: nothing pins the stated binding to the binding actually handed to
 * docker compose. A drift there is the confidently-wrong readout AC7/AC8 exist
 * to kill, one layer up.
 */

const { z } = require('zod');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('install_relayer binding — T1 gaps (E-A2/D5, AC8)', () => {
    let server;
    let installPath;

    beforeEach(() => {
        server = { tool: jest.fn() };
        // execFile (and therefore mkdir -p) is faked, so the install dir has to
        // exist for the real .env write on the default path.
        installPath = fs.mkdtempSync(path.join(os.tmpdir(), 'xns-a2-'));
    });

    function registerWithOptions(opts) {
        const register = require('../tools/installRelayer');
        register(server, opts);
        const [, , shape, handler] = server.tool.mock.calls[0];
        return (args) => handler(z.object(shape).parse(args));
    }

    function run(composeUp, extraArgs = {}) {
        const handler = registerWithOptions({
            execFile: jest.fn((cmd, args, opts, cb) => cb(null, '', '')),
            dockerUtil: {
                composeUp,
                findContainer: jest.fn().mockResolvedValue(null),
            },
        });
        return handler({ install_path: installPath, ...extraArgs });
    }

    test('default install (no port arguments) still states the binding', async () => {
        const composeUp = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
        const result = await run(composeUp);
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.binding.ui).toEqual({ host_port: 8888, container_port: 8888 });
        expect(parsed.binding.s3).toEqual({ host_port: 9000, container_port: 9000 });
        expect(parsed.binding.composed_from).toContain('UI_PORT=8888');
        expect(parsed.binding.reachability).toContain('docker port');
    });

    test('the stated binding matches what was handed to docker compose', async () => {
        const composeUp = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
        const result = await run(composeUp);
        const parsed = JSON.parse(result.content[0].text);

        const passedEnv = composeUp.mock.calls[0][1].env;
        expect(passedEnv.UI_PORT).toBe(String(parsed.binding.ui.host_port));
        expect(passedEnv.S3_PORT).toBe(String(parsed.binding.s3.host_port));
    });

    test('a caller-supplied compose_url leaves container_port absent, not guessed', async () => {
        const composeUp = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
        const result = await run(composeUp, {
            compose_url: 'https://example.invalid/custom-compose.yml',
        });
        const parsed = JSON.parse(result.content[0].text);

        // This process never reads the caller's compose, so it cannot know the
        // container ports. Absent beats a restated 8888/9000 it cannot stand behind.
        expect(parsed.binding.ui.container_port).toBeNull();
        expect(parsed.binding.s3.container_port).toBeNull();
        // The host side is still known — it is what we handed to docker compose.
        expect(parsed.binding.ui.host_port).toBe(8888);
        expect(parsed.binding.s3.host_port).toBe(9000);
    });
});
