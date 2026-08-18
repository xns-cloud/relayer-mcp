'use strict';

/**
 * T1 Contract-Gap: registerTool config-shape contract.
 *
 * Source of truth: epic-E-A2/fixtures/tools-list-entry-sample.json.
 * Asserts every one of the 15 tools passes a registerTool config object
 * shaped { title, description, inputSchema, annotations } and that
 * `description` survived the server.tool -> registerTool migration
 * non-empty for all 15. annotations.test.js already covers the
 * `annotations` field in depth; this file covers title/description/
 * inputSchema, which no existing test asserts — a silently dropped
 * description would not fail any pre-existing test.
 */

const ALL_TOOL_MODULES = [
    '../tools/checkPrerequisites',
    '../tools/startRegistration',
    '../tools/checkEmailVerified',
    '../tools/installRelayer',
    '../tools/checkRelayerHealth',
    '../tools/startClaim',
    '../tools/checkClaimStatus',
    '../tools/getHostTags',
    '../tools/configureVpd',
    '../tools/verifyStorage',
    '../tools/setupCliCredentials',
    '../tools/describeSettings',
    '../tools/updateSettings',
    '../tools/restartService',
    '../tools/manageBackups',
];

describe('T1 Contract-Gap: tools-list-entry-sample config shape', () => {
    test('every tool config carries title, non-empty description, object inputSchema, annotations', () => {
        const failures = [];

        for (const mod of ALL_TOOL_MODULES) {
            const server = { registerTool: jest.fn() };
            require(mod)(server);

            const [name, config] = server.registerTool.mock.calls[0] || [];
            const label = `${mod} (registered as "${name}")`;

            if (!config) {
                failures.push(`${label}: registerTool was not called`);
                continue;
            }
            if (config.title !== name) {
                failures.push(`${label}: title "${config.title}" !== registered name "${name}"`);
            }
            if (typeof config.description !== 'string' || config.description.trim().length === 0) {
                failures.push(`${label}: description missing or empty`);
            }
            if (typeof config.inputSchema !== 'object' || config.inputSchema === null) {
                failures.push(`${label}: inputSchema is not an object`);
            }
            if (typeof config.annotations !== 'object' || config.annotations === null) {
                failures.push(`${label}: annotations missing`);
            }
        }

        expect(failures).toEqual([]);
    });
});
