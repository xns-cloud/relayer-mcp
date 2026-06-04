'use strict';

const { checkNodeVersion, MIN_MAJOR } = require('../lib/nodeVersion');

describe('checkNodeVersion', () => {
    test('Node 20+ → ok, no message', () => {
        for (const v of ['20.0.0', '20.11.1', '22.4.0']) {
            const result = checkNodeVersion(v);
            expect(result.ok).toBe(true);
            expect(result.message).toBeNull();
        }
    });

    // Homelab feedback: Ubuntu's default apt repo ships Node 18 — the failure
    // message must hand the user the nvm install path, not a bare error.
    test('Node 18 → fails with nvm remediation', () => {
        const result = checkNodeVersion('18.19.1');

        expect(result.ok).toBe(false);
        expect(result.major).toBe(18);
        expect(result.message).toContain('v18.19.1');
        expect(result.message).toContain(`Node.js ${MIN_MAJOR} or newer`);
        expect(result.message).toContain('nvm install 20');
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
