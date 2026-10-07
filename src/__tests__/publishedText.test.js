'use strict';

/**
 * BUG-1172: the npm tarball is public. Every file it ships must describe the
 * release URLs without naming our internal hosts or release tooling — a
 * comment once named both.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

// Internal names that must never reach a published file.
// publish-release / publish-install-script are deploy.py modes: internal tooling.
const INTERNAL_NAMES = [/\bweb0\d\b/i, /\bdeploy\.py\b/i, /\bpublish-release\b/i, /\bpublish-install-script\b/i];

// npm adds these to every tarball whatever `files` says.
const ALWAYS_SHIPPED = ['package.json', 'README.md'];

function publishedFiles() {
    const out = [];
    const walk = (abs) => {
        const stat = fs.statSync(abs);
        if (stat.isDirectory()) {
            for (const name of fs.readdirSync(abs)) walk(path.join(abs, name));
        } else {
            out.push(abs);
        }
    };
    for (const entry of [...pkg.files, ...ALWAYS_SHIPPED]) walk(path.join(repoRoot, entry));
    return out;
}

describe('BUG-1172: published files name no internal infrastructure', () => {
    const files = publishedFiles();

    test('the files list resolves to real files, including the install tool and template', () => {
        const rel = files.map((f) => path.relative(repoRoot, f));
        expect(rel).toContain(path.join('src', 'tools', 'installRelayer.js'));
        expect(rel).toContain(path.join('src', 'templates', 'docker-compose.yml'));
        expect(rel).toContain('README.md');
    });

    test.each(INTERNAL_NAMES.map((re) => [String(re), re]))('no published file matches %s', (_label, re) => {
        const hits = files
            .filter((f) => re.test(fs.readFileSync(f, 'utf8')))
            .map((f) => path.relative(repoRoot, f));
        expect(hits).toEqual([]);
    });
});
