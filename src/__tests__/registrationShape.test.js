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

const { readRegistration } = require('./helpers/mockRegistration');

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

// The title a client shows for each tool: plain words, never the snake_case name.
const TITLES = {
    check_prerequisites: 'Check prerequisites',
    start_registration: 'Start registration',
    check_email_verified: 'Check email verification',
    install_relayer: 'Install the Relayer',
    check_relayer_health: 'Check Relayer health',
    start_claim: 'Start claim',
    check_claim_status: 'Check claim status',
    get_host_tags: 'Get host tags',
    configure_vpd: 'Configure host selection (VPD)',
    verify_storage: 'Verify storage',
    setup_cli_credentials: 'Set up CLI credentials',
    describe_settings: 'Describe settings',
    update_settings: 'Update settings',
    restart_service: 'Restart service',
    manage_backups: 'Manage backups',
};

describe('T1 Contract-Gap: tools-list-entry-sample config shape', () => {
    test('every tool config carries its plain-words title, non-empty description, object inputSchema, annotations', () => {
        const failures = [];

        for (const mod of ALL_TOOL_MODULES) {
            const server = { registerTool: jest.fn() };
            require(mod)(server);

            let name;
            let config;
            try {
                ({ name, config } = readRegistration(server));
            } catch {
                failures.push(`${mod}: registerTool was not called`);
                continue;
            }
            const label = `${mod} (registered as "${name}")`;
            if (config.title !== TITLES[name]) {
                failures.push(`${label}: title "${config.title}" !== "${TITLES[name]}"`);
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
