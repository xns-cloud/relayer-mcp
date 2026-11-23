'use strict';

/**
 * serverIntro.stdio.test.js — the running server introduces itself.
 *
 * Starts `node src/index.js`, sends initialize and tools/list over stdio, one
 * request per line, and reads the two replies.
 */

const path = require('path');
const { spawn } = require('child_process');
const INSTRUCTIONS = require('../lib/serverInstructions');

const repoRoot = path.resolve(__dirname, '..', '..');

const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };
const TOOLS_LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

function talkToServer(requests, expectedReplies) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(repoRoot, 'src', 'index.js')], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`no reply in time; stdout: ${out} stderr: ${err}`));
        }, 15000);
        child.stdout.on('data', (chunk) => {
            out += chunk;
            // A large reply can arrive in pieces: parse only complete lines.
            const lines = out.slice(0, out.lastIndexOf('\n') + 1).split('\n').filter(Boolean);
            if (lines.length >= expectedReplies) {
                clearTimeout(timer);
                child.kill();
                resolve(lines.map((l) => JSON.parse(l)));
            }
        });
        child.stderr.on('data', (chunk) => { err += chunk; });
        child.on('error', reject);
        child.stdin.write(requests.map((r) => JSON.stringify(r)).join('\n') + '\n');
    });
}

describe('server introduction over stdio', () => {
    let replies;
    beforeAll(async () => {
        replies = await talkToServer([INITIALIZE, TOOLS_LIST], 2);
    }, 20000);

    test('initialize returns the instructions (what XNS is, the price, the first tool and the plugin) and version 0.14.1', () => {
        const { instructions } = replies[0].result;

        expect(instructions).toBe(INSTRUCTIONS);
        expect(instructions).toContain('cloud object storage');
        expect(instructions).toContain('$6.00 per TB per month. $0 egress, uncapped. 30-day minimum retention, no early-delete fee.');
        expect(instructions).toContain('Start with check_prerequisites.');
        expect(instructions).toContain('xns-storage');
        expect(instructions).toContain('set-up-xns-storage');
        expect(instructions).toContain('use-xns-storage');
        const add = instructions.indexOf('/plugin marketplace add xns-cloud/xns-storage-plugin');
        const install = instructions.indexOf('/plugin install xns-storage@xns-cloud');
        expect(add).toBeGreaterThanOrEqual(0);
        expect(install).toBeGreaterThan(add);
        expect(replies[0].result.serverInfo.version).toBe('0.14.1');
    });

    test('tools/list returns 15 tools, each with a title in plain words', () => {
        const { tools } = replies[1].result;

        expect(tools).toHaveLength(15);
        for (const tool of tools) {
            expect(typeof tool.title).toBe('string');
            expect(tool.title).not.toContain('_');
        }
    });
});
