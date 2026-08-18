'use strict';

/**
 * E-A2 annotation-presence regression test.
 *
 * Asserts all 15 tools carry explicitly-set readOnlyHint, destructiveHint,
 * and openWorldHint via server._registeredTools[name].annotations.
 *
 * Source of truth: epic-E-A2/fixtures/tool-annotations.json.
 * A stripped annotation must fail the build (AC4).
 */

const path = require('path');
const fs = require('fs');

const { server } = require('../index');

// Load the annotation contract fixture.
const fixturePath = path.resolve(
    __dirname, '..', '..', '..', '..', '..', '..',
    'mnt', 'e', 'development', 'sprints', 'Inflight',
    '2026-08-agentic-discoverability-top_15',
    'epic-E-A2', 'fixtures', 'tool-annotations.json',
);

// Fall back to a local copy if the sprint fixture is not reachable (CI).
let fixtureData;
try {
    fixtureData = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
} catch {
    // Inline the contract so the test is self-contained even outside the
    // sprint tree. This MUST stay in sync with the fixture.
    fixtureData = {
        tools: [
            { name: 'check_prerequisites',   readOnlyHint: true,  destructiveHint: false, openWorldHint: true },
            { name: 'start_registration',    readOnlyHint: true,  destructiveHint: false, openWorldHint: false },
            { name: 'check_email_verified',  readOnlyHint: true,  destructiveHint: false, openWorldHint: true },
            { name: 'install_relayer',       readOnlyHint: false, destructiveHint: true,  openWorldHint: true },
            { name: 'check_relayer_health',  readOnlyHint: true,  destructiveHint: false, openWorldHint: true },
            { name: 'start_claim',           readOnlyHint: false, destructiveHint: false, openWorldHint: true },
            { name: 'check_claim_status',    readOnlyHint: true,  destructiveHint: false, openWorldHint: true },
            { name: 'get_host_tags',         readOnlyHint: true,  destructiveHint: false, openWorldHint: true },
            { name: 'configure_vpd',         readOnlyHint: false, destructiveHint: false, openWorldHint: true },
            { name: 'verify_storage',        readOnlyHint: false, destructiveHint: false, openWorldHint: true },
            { name: 'setup_cli_credentials', readOnlyHint: false, destructiveHint: true,  openWorldHint: true },
            { name: 'describe_settings',     readOnlyHint: true,  destructiveHint: false, openWorldHint: true },
            { name: 'update_settings',       readOnlyHint: false, destructiveHint: true,  openWorldHint: true },
            { name: 'restart_service',       readOnlyHint: false, destructiveHint: true,  openWorldHint: true },
            { name: 'manage_backups',        readOnlyHint: false, destructiveHint: true,  openWorldHint: true },
        ],
    };
}

const expectedByName = {};
for (const tool of fixtureData.tools) {
    expectedByName[tool.name] = {
        readOnlyHint: tool.readOnlyHint,
        destructiveHint: tool.destructiveHint,
        openWorldHint: tool.openWorldHint,
    };
}

const registeredTools = server._registeredTools;

describe('E-A2 annotation-presence contract', () => {
    test('exactly 15 tools are registered', () => {
        expect(Object.keys(registeredTools)).toHaveLength(15);
    });

    test('every registered tool has an annotations object', () => {
        for (const [name, tool] of Object.entries(registeredTools)) {
            expect(tool.annotations).toBeDefined();
            expect(typeof tool.annotations).toBe('object');
        }
    });

    // Parametrised: one test per tool so a failure names which one.
    test.each(fixtureData.tools.map((t) => t.name))(
        '%s annotations match the contract',
        (toolName) => {
            const tool = registeredTools[toolName];
            expect(tool).toBeDefined();
            expect(tool.annotations).toBeDefined();

            const expected = expectedByName[toolName];
            expect(tool.annotations.readOnlyHint).toBe(expected.readOnlyHint);
            expect(tool.annotations.destructiveHint).toBe(expected.destructiveHint);
            expect(tool.annotations.openWorldHint).toBe(expected.openWorldHint);
        },
    );

    // AC3: destructiveHint true on exactly 5 tools
    test('destructiveHint true on exactly 5 tools', () => {
        const destructive = Object.entries(registeredTools)
            .filter(([, t]) => t.annotations.destructiveHint === true)
            .map(([name]) => name)
            .sort();

        expect(destructive).toEqual([
            'install_relayer',
            'manage_backups',
            'restart_service',
            'setup_cli_credentials',
            'update_settings',
        ]);
    });

    // AC2: 7 read-only / 8 mutating
    test('readOnlyHint split is 7 read-only / 8 mutating', () => {
        const readOnly = Object.entries(registeredTools)
            .filter(([, t]) => t.annotations.readOnlyHint === true);
        const mutating = Object.entries(registeredTools)
            .filter(([, t]) => t.annotations.readOnlyHint === false);

        expect(readOnly).toHaveLength(7);
        expect(mutating).toHaveLength(8);
    });

    // All three hints must be explicitly set (not relying on spec defaults)
    test('no annotation relies on MCP spec defaults (all three hints set on every tool)', () => {
        for (const [name, tool] of Object.entries(registeredTools)) {
            expect(typeof tool.annotations.readOnlyHint).toBe('boolean');
            expect(typeof tool.annotations.destructiveHint).toBe('boolean');
            expect(typeof tool.annotations.openWorldHint).toBe('boolean');
        }
    });
});
