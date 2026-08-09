'use strict';

/**
 * E-B1 T1: Registry / npm identity contract tests.
 *
 * E-B1 is a metadata-and-docs epic — no runtime behavior changed. The regressions
 * that can actually happen here are IDENTITY DRIFT ones: package.json and
 * server.json disagreeing after someone edits one of them, keywords rotting, or
 * README claims drifting from the code.
 *
 * Contract source: epic-E-B1/fixtures/registry-identity.json (PRD §6:82, DC7).
 * Rule: mcpName and packages[0].identifier are IMMUTABLE. A repository-URL change
 * must land in package.json AND server.json in the SAME commit.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(repoRoot, p), 'utf8'));
const hostOf = (url) => new URL(String(url).replace(/^git\+/, '')).host;

const pkg = readJson('package.json');
const serverJson = readJson('server.json');
const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

// Frozen identity values — these are the registry-published strings. If a test
// here fails, the fix is almost never "update the expectation".
const IMMUTABLE_MCP_NAME = 'tech.xns/relayer';
const IMMUTABLE_NPM_NAME = '@xns-cloud/relayer-mcp';

describe('E-B1 identity contract: npm ↔ MCP registry', () => {
    test('mcpName is the immutable registry name and matches server.json name', () => {
        expect(pkg.mcpName).toBe(IMMUTABLE_MCP_NAME);
        expect(serverJson.name).toBe(IMMUTABLE_MCP_NAME);
    });

    test('server.json packages[0].identifier is the immutable npm package name', () => {
        expect(pkg.name).toBe(IMMUTABLE_NPM_NAME);
        expect(serverJson.packages).toHaveLength(1);
        expect(serverJson.packages[0].identifier).toBe(IMMUTABLE_NPM_NAME);
        expect(serverJson.packages[0].registryType).toBe('npm');
    });

    // Three copies of the version exist. A release that bumps one and not the
    // others publishes a registry entry pointing at a tarball that doesn't exist.
    test('version is identical in package.json, server.json, and packages[0]', () => {
        expect(serverJson.version).toBe(pkg.version);
        expect(serverJson.packages[0].version).toBe(pkg.version);
        expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    });

    // DC7 (PRD §7:100): if the repository URL ever moves to GitHub, package.json
    // repository + bugs AND server.json repository must move in the same commit.
    // This test doesn't care WHICH host — only that all four agree.
    test('DC7: repository host agrees across package.json (repository + bugs) and server.json', () => {
        const pkgRepoHost = hostOf(pkg.repository.url);

        expect(hostOf(pkg.bugs.url)).toBe(pkgRepoHost);
        expect(hostOf(serverJson.repository.url)).toBe(pkgRepoHost);
    });

    test('server.json repository.source matches the repository host', () => {
        const expectedSource = hostOf(serverJson.repository.url).includes('github')
            ? 'github'
            : 'gitlab';
        expect(serverJson.repository.source).toBe(expectedSource);
    });
});

describe('E-B1 keyword contract (AC1a)', () => {
    test('keywords is a non-empty array of unique, lowercase, trimmed strings', () => {
        expect(Array.isArray(pkg.keywords)).toBe(true);
        expect(pkg.keywords.length).toBeGreaterThan(4); // expanded beyond the original four

        for (const kw of pkg.keywords) {
            expect(typeof kw).toBe('string');
            expect(kw).toBe(kw.trim());
            expect(kw).toBe(kw.toLowerCase());
            expect(kw.length).toBeGreaterThan(0);
        }

        expect(new Set(pkg.keywords).size).toBe(pkg.keywords.length);
    });

    // The expansion must be additive — dropping an original keyword silently
    // breaks any existing search/discovery that already matched on it.
    test('keywords still include the original four', () => {
        for (const kw of ['mcp', 'relayer', 'xns', 'onboarding']) {
            expect(pkg.keywords).toContain(kw);
        }
    });
});

describe('E-B1 README drift contract (AC2a)', () => {
    const registeredTools = require('../index').server._registeredTools;

    test('README tool count matches the number of tools index.js registers', () => {
        const registered = Object.keys(registeredTools).length;

        const prose = readme.match(/Provides (\d+) tools/);
        expect(prose).not.toBeNull();
        expect(Number(prose[1])).toBe(registered);

        // The numbered Tools table must have one row per registered tool.
        const rows = readme.match(/^\| \d+ \| `[a-z_]+` \|/gm) || [];
        expect(rows).toHaveLength(registered);
    });

    // The README must not restate THIS package's version anywhere: the badge and
    // `@latest` carry it, and a literal goes stale the next time package.json is
    // bumped (AC2a: "no version/dist-tag text false vs published state").
    // Unrelated versions (nvm installer, relayer-ui minimums) are fine.
    test('README pins no hardcoded package version (badges/@latest only)', () => {
        const escapedPkg = IMMUTABLE_NPM_NAME.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&');
        expect(readme).not.toMatch(new RegExp(`${escapedPkg}@\\d`));
        expect(readme).not.toContain(`v${pkg.version}`);
        expect(readme).not.toMatch(new RegExp(`version\\s+${pkg.version.replace(/\./g, '\\.')}`, 'i'));
    });

    test('README badges and install snippet use the exact npm package name', () => {
        expect(readme).toContain(`npx ${IMMUTABLE_NPM_NAME}@latest`);
        expect(readme).toContain(`img.shields.io/npm/v/${IMMUTABLE_NPM_NAME}`);
        expect(readme).toContain(`https://www.npmjs.com/package/${IMMUTABLE_NPM_NAME}`);
    });
});

describe('E-B1 GitHub presence contract (AC11)', () => {
    const contributing = fs.readFileSync(path.join(repoRoot, 'CONTRIBUTING.md'), 'utf8');
    const prTemplate = fs.readFileSync(
        path.join(repoRoot, '.github', 'PULL_REQUEST_TEMPLATE.md'),
        'utf8',
    );

    test('CONTRIBUTING.md states the mirror is read-only and points at GitLab', () => {
        expect(contributing).toMatch(/read-only\s+\*{0,2}mirror|\*{0,2}read-only\*{0,2}\s+mirror/i);
        expect(contributing).toContain('https://gitlab.com/scpcorp/relayer-mcp');
        expect(contributing).toContain('https://gitlab.com/scpcorp/relayer-mcp/-/issues');
    });

    test('PR template states the mirror is read-only and points at GitLab', () => {
        expect(prTemplate).toMatch(/read-only mirror/i);
        expect(prTemplate).toContain('https://gitlab.com/scpcorp/relayer-mcp');
    });

    // Contribution entry points must agree with the canonical repository host that
    // package.json/server.json declare — otherwise the mirror sends people nowhere.
    test('contribution docs point at the same host package.json declares', () => {
        const pkgHost = hostOf(pkg.repository.url);
        expect(contributing).toContain(pkgHost);
        expect(prTemplate).toContain(pkgHost);
    });
});
