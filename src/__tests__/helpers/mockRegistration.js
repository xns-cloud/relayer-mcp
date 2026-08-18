'use strict';

/**
 * Shared mock-shape accessor for the registerTool API.
 *
 * Every test file that mocks the MCP server uses:
 *   server = { registerTool: jest.fn() };
 *
 * After a tool module calls server.registerTool(name, config, handler),
 * the mock captures the call as:
 *   server.registerTool.mock.calls[i] = [name, config, handler]
 *
 * This helper normalises access so a future SDK signature change
 * requires one edit, not 18 files.
 */

/**
 * Read one tool registration from a mock server.
 *
 * @param {object} server - The mock server with registerTool as jest.fn()
 * @param {number} [callIndex=0] - Which registration call to read
 * @returns {{ name: string, title: string, description: string, schema: object,
 *             handler: Function, annotations: object, config: object }}
 */
function readRegistration(server, callIndex = 0) {
    const [name, config, handler] = server.registerTool.mock.calls[callIndex];
    return {
        name,
        title: config.title,
        description: config.description,
        schema: config.inputSchema,
        handler,
        annotations: config.annotations,
        // The whole config, for assertions about the object's shape itself
        // (e.g. a field being absent) rather than a named field's value.
        config,
    };
}

module.exports = { readRegistration };
