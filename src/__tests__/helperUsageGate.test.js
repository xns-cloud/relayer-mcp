'use strict';

/**
 * T1 Contract-Gap: AC1 regression lock.
 *
 * AC1 requires zero server.tool call-sites and full routing through the
 * shared mockRegistration helper. A file that reaches into
 * `registerTool.mock.calls[...]` positionally instead of going through
 * `readRegistration` is a latent AC1 violation the annotation/shape
 * tests would not catch (it can still pass while duplicating the coupling
 * the helper exists to remove). This test fails the build if any test
 * file (other than the helper itself) does that.
 */

const fs = require('fs');
const path = require('path');

const TESTS_DIR = __dirname;
// Any direct indexed access, not just the two-index form. Tuple destructuring
// (`const [name, config] = ...mock.calls[0]`) bypasses the helper just as much
// as `...mock.calls[0][1]` does, and the narrower pattern missed it (CR thread 1).
// `.mock.calls.length` is untouched — it reads no registration field.
const POSITIONAL_READ = /registerTool\.mock\.calls\[/;
const SELF_EXEMPT = new Set(['mockRegistration.test.js', 'helperUsageGate.test.js']);

function listTestFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...listTestFiles(full));
        } else if (entry.name.endsWith('.test.js')) {
            out.push(full);
        }
    }
    return out;
}

describe('helper usage gate', () => {
    test('no test file indexes registerTool.mock.calls directly outside the helper', () => {
        const offenders = [];

        for (const file of listTestFiles(TESTS_DIR)) {
            // Two files legitimately contain the pattern: the helper's own test
            // (it exercises the indexing) and this gate (its regex and comments
            // spell the pattern out).
            if (SELF_EXEMPT.has(path.basename(file))) continue;
            const content = fs.readFileSync(file, 'utf8');
            if (POSITIONAL_READ.test(content)) {
                offenders.push(path.relative(TESTS_DIR, file));
            }
        }

        expect(offenders).toEqual([]);
    });
});
