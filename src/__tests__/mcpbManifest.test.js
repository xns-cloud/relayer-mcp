'use strict';

/**
 * MCPB bundle manifest contract tests.
 *
 * manifest.json is a FOURTH place the server's identity is written down, alongside
 * package.json, server.json, and the running server itself. The CI publish job
 * validates package.json against server.json and the release tag; it knows nothing
 * about manifest.json. Without these tests a version bump or a tool rename lands
 * green while the bundle ships stale metadata to the Connectors Directory.
 *
 * Same discipline as registryIdentity.test.js: pin the file chain AND the runtime,
 * because a file-level chain says nothing about what the server actually registers.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(repoRoot, p), 'utf8'));

const manifest = readJson('manifest.json');
const pkg = readJson('package.json');
const serverJson = readJson('server.json');

describe('MCPB manifest: version chain', () => {
    test('manifest.json version matches package.json', () => {
        expect(manifest.version).toBe(pkg.version);
    });

    test('manifest.json version matches server.json', () => {
        expect(manifest.version).toBe(serverJson.version);
    });

    test('manifest declares the MCPB schema version the CLI validates against', () => {
        expect(manifest.manifest_version).toBe('0.3');
    });
});

describe('MCPB manifest: tool list matches what the server registers', () => {
    const registeredTools = require('../index').server._registeredTools;
    const registeredNames = Object.keys(registeredTools).sort();
    const manifestNames = manifest.tools.map((t) => t.name).sort();

    test('every registered tool appears in manifest.json', () => {
        expect(manifestNames).toEqual(registeredNames);
    });

    test('no manifest tool is missing a description', () => {
        const undescribed = manifest.tools.filter((t) => !t.description || !t.description.trim());
        expect(undescribed).toEqual([]);
    });
});

describe('MCPB manifest: fields the directory review reads', () => {
    test('entry point exists on disk', () => {
        expect(fs.existsSync(path.join(repoRoot, manifest.server.entry_point))).toBe(true);
    });

    test('a privacy policy URL is declared over https', () => {
        expect(Array.isArray(manifest.privacy_policies)).toBe(true);
        expect(manifest.privacy_policies.length).toBeGreaterThan(0);
        manifest.privacy_policies.forEach((url) => expect(url).toMatch(/^https:\/\//));
    });

    test('license matches package.json', () => {
        expect(manifest.license).toBe(pkg.license);
    });
});
