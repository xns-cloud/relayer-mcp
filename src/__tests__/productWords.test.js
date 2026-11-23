'use strict';

/**
 * productWords.test.js — what the package, the bundle, the README and the
 * privacy notice say the product is.
 *
 * XNS is cloud object storage; the Relayer is the gateway a user runs to
 * reach it. These tests pin the words that say so, the price line, the
 * Claude plugin commands, and the list of public hosts the server contacts.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const INSTRUCTIONS = require('../lib/serverInstructions');

const repoRoot = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');
const readJson = (file) => JSON.parse(read(file));

const ONE_LINE = 'S3-compatible cloud object storage from XNS, set up and managed by your AI assistant.';
const OPENING = 'XNS is S3-compatible cloud object storage. $6.00 per TB per month. $0 egress, uncapped. 30-day minimum retention, no early-delete fee. You reach it through the Relayer, a small gateway that runs on your own machine, so the S3 endpoint and keys stay on hardware you control.';
const PRICE_LINE = '$6.00 per TB per month. $0 egress, uncapped. 30-day minimum retention, no early-delete fee.';
const PLUGIN_ADD = '/plugin marketplace add xns-cloud/xns-storage-plugin';
const PLUGIN_INSTALL = '/plugin install xns-storage@xns-cloud';
const CONNECTOR_INSTALL = '/plugin install xns-relayer@xns-cloud';
const BY_HAND = 'claude mcp add --scope user relayer -- npx @xns-cloud/relayer-mcp@latest';
const NPX_LINE = 'npx @xns-cloud/relayer-mcp@latest';

const count = (text, needle) => text.split(needle).length - 1;

// The section that starts at `heading` and runs to the next `## ` heading.
function section(text, heading) {
    const start = text.indexOf(`\n${heading}\n`);
    if (start < 0) return '';
    const rest = text.slice(start + heading.length + 2);
    const end = rest.indexOf('\n## ');
    return end < 0 ? rest : rest.slice(0, end);
}

// Tracked files plus new files git does not ignore, so node_modules and other
// ignored folders are never read. A listed path missing on disk is skipped.
function repoFiles() {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: repoRoot, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .filter((f) => fs.existsSync(path.join(repoRoot, f)) && fs.statSync(path.join(repoRoot, f)).isFile());
}

describe('product words', () => {
    test('the top changelog entry is the version package.json carries, 0.14.2', () => {
        const pkg = readJson('package.json');
        const top = read('CHANGELOG.md').split('\n').find((l) => l.startsWith('## ['));
        const match = /^## \[(\d+\.\d+\.\d+)\] — \d{4}-\d{2}-\d{2}$/.exec(top);

        expect(match).not.toBeNull();
        expect(match[1]).toBe(pkg.version);
        expect(pkg.version).toBe('0.14.2');
    });

    test('the server instructions end on the plugin being optional and pin no package version', () => {
        expect(INSTRUCTIONS.endsWith('The tools work the same without the plugin.')).toBe(true);
        expect(INSTRUCTIONS).not.toMatch(/@xns-cloud\/relayer-mcp@\d/);
    });

    test('package.json, server.json and manifest.json carry the same one-line description', () => {
        const descriptions = [readJson('package.json').description, readJson('server.json').description, readJson('manifest.json').description];

        for (const d of descriptions) {
            expect(d).toBe(ONE_LINE);
            expect(d).toHaveLength(85);
        }
    });

    test('the bundle is named XNS Cloud Storage and its long description opens with what XNS is and costs', () => {
        const manifest = readJson('manifest.json');
        const paragraphs = manifest.long_description.split('\n\n');

        expect(manifest.display_name).toBe('XNS Cloud Storage');
        expect(manifest.long_description.startsWith(OPENING)).toBe(true);
        expect(paragraphs[1]).toBe("The server runs locally on your machine and talks to your Relayer over loopback or your private network only — connections to public addresses are refused by design. Sign-in happens in your browser against XNS's identity service; the agent never sees your password.");
    });

    test('no file in the repo calls the storage something the user runs as their own host', () => {
        const barred = ['host', 'yourself'].join(' ');
        const hits = repoFiles().filter((f) => read(f).toLowerCase().includes(barred));

        expect(hits).toEqual([]);
    });

    test('no file outside the changelog and the CI file uses the removed keyword; the other keywords stay', () => {
        const keyword = ['self', 'hosted'].join('-');
        const exempt = new Set(['CHANGELOG.md', '.gitlab-ci.yml']);
        const hits = repoFiles().filter((f) => !exempt.has(f) && read(f).toLowerCase().includes(keyword));

        expect(hits).toEqual([]);
        expect(readJson('package.json').keywords).toEqual(expect.arrayContaining(['relayer', 'mcp', 'xns', 'onboarding']));
    });

    test('wherever "$0 egress" appears, it is inside the whole price line', () => {
        const texts = {
            'README.md': read('README.md'),
            'manifest.json long_description': readJson('manifest.json').long_description,
            'server instructions': INSTRUCTIONS,
        };

        for (const [where, text] of Object.entries(texts)) {
            const priceLines = count(text, PRICE_LINE);
            expect({ where, egress: count(text, '$0 egress') }).toEqual({ where, egress: priceLines });
            expect(priceLines).toBeGreaterThanOrEqual(1);
        }
    });

    test('the README opening names the product, the 15 tools and the plugin commands before the npx line', () => {
        const readme = read('README.md');
        const lines = readme.split('\n');
        const npxAt = lines.indexOf(NPX_LINE);
        const head = lines.slice(0, npxAt).join('\n');

        expect(npxAt).toBeGreaterThan(0);
        // Each command must be a whole line of its own, in this order.
        const order = [
            head.indexOf(ONE_LINE),
            head.indexOf('Provides 15 tools'),
            head.indexOf('xns-storage'),
            head.indexOf(`\n${PLUGIN_ADD}\n`),
            head.indexOf(`\n${PLUGIN_INSTALL}\n`),
            head.indexOf(`\n${CONNECTOR_INSTALL}\n`),
        ];
        expect(order.every((i) => i >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    test('the README Claude Code block offers the plugin first, the by-hand command second, and warns against both', () => {
        const readme = read('README.md');
        const from = readme.indexOf('**Claude Code**');
        const to = readme.indexOf('**Claude Desktop');
        const block = readme.slice(from, to);
        const blockLines = block.split('\n');

        expect(readme).not.toContain('if you registered nothing yet');
        expect(from).toBeGreaterThanOrEqual(0);
        expect(to).toBeGreaterThan(from);
        const order = [
            blockLines.indexOf(PLUGIN_ADD),
            blockLines.indexOf(PLUGIN_INSTALL),
            blockLines.indexOf(CONNECTOR_INSTALL),
            blockLines.indexOf('Without the plugins, register it by hand:'),
            blockLines.indexOf(BY_HAND),
            blockLines.indexOf('Do not add the `xns-relayer` plugin beside a `relayer` registration, whether you or the install script made it: with both, the 15 tools load twice. The `xns-storage` plugin carries no server, so it can go beside either.'),
        ];
        expect(order.every((i) => i >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        expect(count(readme.slice(to), '"relayer": {')).toBe(2);
        expect(readme.split('\n').filter((l) => l === '## Troubleshooting')).toHaveLength(1);
        expect(section(readme, '## Install')).toContain('When Claude Code is present, the script also registers this server with it.');
        // Only xns-relayer registers the server; xns-storage holds the skills.
        expect(count(readme, '`xns-relayer` registers this server')).toBe(2);
        expect(readme).not.toMatch(/`xns-storage`[^.\n]*registers/);
    });

    // The query string marks downloads from this README; quoted so zsh does
    // not read "?" as a glob.
    test('both README install lines fetch the quoted install.sh URL tagged src=github', () => {
        const readme = read('README.md');
        const ours = 'releases.xns.tech/relayer/install.sh';

        expect(readme.split('\n').filter((l) => l === "curl -fsSL 'https://releases.xns.tech/relayer/install.sh?src=github' | sh")).toHaveLength(2);
        expect(count(readme, ours)).toBe(2);
        expect(count(readme, `${ours}?src=github'`)).toBe(2);
    });

    test('the privacy notice and the README name Docker Hub beside the three XNS services', () => {
        const privacy = read('PRIVACY.md');
        const readme = read('README.md');
        const rows = privacy.split('\n').filter((l) => l.startsWith('| '));
        const installRows = rows.filter((l) => l.split('|')[1].trim() === 'Installing or updating the Relayer');

        expect(installRows).toHaveLength(1);
        expect(installRows[0]).toContain('releases.xns.tech');
        expect(installRows[0]).toContain('Docker Hub');
        expect(installRows[0]).toContain('prom/node-exporter');
        const above = rows.slice(rows.indexOf(installRows[0]) - 3, rows.indexOf(installRows[0]));
        expect(above).toEqual([
            '| Creating an account, signing in | Your credentials, entered by you in your own browser | `auth.xns.tech` (Keycloak) |',
            '| Claiming a Relayer to your account | The claim session and the installation\'s identity | `console.xns.tech` |',
            '| Reading or changing settings, host selection, backups | The setting values you ask to read or change | `console.xns.tech` |',
        ]);
        expect(section(privacy, '## Network boundary').replace(/\n/g, ' ')).toContain('Apart from those, the only public hosts contacted are the three XNS services named above and, for the `prom/node-exporter` image that an install pulls, Docker Hub.');
        expect(privacy).not.toContain('there is no input that reaches a public Relayer');
        expect(readme).not.toContain('No tool can be pointed at a public Relayer');
        expect(privacy).not.toContain('are the three XNS services named above.');
        expect(readme).not.toContain('The three XNS services it contacts are');
        expect(section(readme, '## Privacy Policy')).toContain('Otherwise the public hosts contacted are the three XNS services `auth.xns.tech`, `console.xns.tech` and `releases.xns.tech`, and Docker Hub for the `prom/node-exporter` image that an install pulls.');
    });
});
