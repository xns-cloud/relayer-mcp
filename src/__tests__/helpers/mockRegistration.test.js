'use strict';

/**
 * T1 Contract-Gap: readRegistration helper behavior.
 *
 * The shared helper (mockRegistration.js) is now load-bearing for ~18
 * test files' access to the registerTool mock shape. No existing test
 * covers the helper itself — a change to its default-index behavior or
 * its handling of a missing call would silently affect every consumer.
 */

const { readRegistration } = require('./mockRegistration');

describe('readRegistration', () => {
    test('defaults to callIndex 0 when omitted', () => {
        const server = { registerTool: jest.fn() };
        server.registerTool('only_tool', { description: 'd', inputSchema: {}, annotations: { readOnlyHint: true } }, () => {});

        const withDefault = readRegistration(server);
        const withExplicitZero = readRegistration(server, 0);

        expect(withDefault).toEqual(withExplicitZero);
        expect(withDefault.name).toBe('only_tool');
    });

    test('reads the correct call when multiple tools are registered on one mock server', () => {
        const server = { registerTool: jest.fn() };
        server.registerTool('first', { description: 'd1', inputSchema: {}, annotations: {} }, () => 'h1');
        server.registerTool('second', { description: 'd2', inputSchema: {}, annotations: {} }, () => 'h2');

        expect(readRegistration(server, 0).name).toBe('first');
        expect(readRegistration(server, 1).name).toBe('second');
    });

    test('throws rather than silently returning undefined for a call index that was never made', () => {
        const server = { registerTool: jest.fn() };
        server.registerTool('only_tool', { description: 'd', inputSchema: {}, annotations: {} }, () => {});

        // callIndex 1 was never called — a wrong-index bug in a consuming
        // test file must fail loud, not read a matching-shaped undefined.
        expect(() => readRegistration(server, 1)).toThrow();
    });
});
