'use strict';

const { checkNodeVersion, MIN_MAJOR } = require('../lib/nodeVersion');

describe('checkNodeVersion', () => {
    test('Node 24+ → ok, no message', () => {
        for (const v of ['24.0.0', '24.15.0', '25.1.0']) {
            const result = checkNodeVersion(v);
            expect(result.ok).toBe(true);
            expect(result.message).toBeNull();
        }
    });

    // Node 20 no longer gets security fixes, so 20 and 22 are refused too.
    test('Node 22 and Node 20 → fail with the Node 24 nvm steps', () => {
        for (const v of ['22.20.0', '20.19.0']) {
            const result = checkNodeVersion(v);
            expect(result.ok).toBe(false);
            expect(result.message).toContain('Node.js 24 or newer');
            expect(result.message).toContain(`v${v}`);
            expect(result.message).toContain('nvm install 24');
        }
    });

    test('the bundle manifest asks for the same Node floor', () => {
        const manifest = require('../../manifest.json');
        expect(manifest.compatibility.runtimes.node).toBe('>=24.0.0');
    });

    // Homelab feedback: Ubuntu's default apt repo ships Node 18 — the failure
    // message must hand the user the nvm install path, not a bare error.
    test('Node 18 → fails with nvm remediation', () => {
        const result = checkNodeVersion('18.19.1');

        expect(result.ok).toBe(false);
        expect(result.major).toBe(18);
        expect(result.message).toContain('v18.19.1');
        expect(result.message).toContain(`Node.js ${MIN_MAJOR} or newer`);
        expect(result.message).toContain('nvm install 24');
        expect(result.message).toContain('Ubuntu');
        expect(result.message).toContain('NodeSource');
    });

    test('garbage version string → fails safe (does not claim ok)', () => {
        expect(checkNodeVersion('').ok).toBe(false);
        expect(checkNodeVersion('beta').ok).toBe(false);
        expect(checkNodeVersion(undefined).ok).toBe(false);
    });

    test('MIN_MAJOR matches package.json engines floor', () => {
        const { engines } = require('../../package.json');
        expect(engines.node).toBe(`>=${MIN_MAJOR}`);
    });
});
