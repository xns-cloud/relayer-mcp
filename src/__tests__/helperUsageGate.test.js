'use strict';

/**
 * T1 Contract-Gap: AC1 regression lock.
 *
 * AC1 requires zero server.tool call-sites and full routing through the
 * shared mockRegistration helper. A file that reaches into
 * `registerTool.mock.calls[i]` positionally instead of going through
 * `readRegistration` is a latent AC1 violation the annotation/shape
 * tests would not catch (it can still pass while duplicating the coupling
 * the helper exists to remove). This test fails the build if any test
 * file (other than the helper itself) does that.
 */

const fs = require('fs');
const path = require('path');

const TESTS_DIR = __dirname;
const POSITIONAL_READ = /registerTool\.mock\.calls\[\d+\]\[\d+\]/;

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
    test('no test file reads registerTool.mock.calls[i][j] positionally outside the helper', () => {
        const offenders = [];

        for (const file of listTestFiles(TESTS_DIR)) {
            if (path.basename(file) === 'mockRegistration.test.js') continue; // exercises the helper's own indexing
            const content = fs.readFileSync(file, 'utf8');
            if (POSITIONAL_READ.test(content)) {
                offenders.push(path.relative(TESTS_DIR, file));
            }
        }

        expect(offenders).toEqual([]);
    });
});
