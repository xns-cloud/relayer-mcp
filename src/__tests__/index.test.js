'use strict';

/**
 * R2-TEST-1: Entrypoint regression test.
 * Verifies index.js registers exactly 15 tools with the correct names.
 */

describe('index.js entrypoint', () => {
    test('registers exactly 15 tools with expected names', () => {
        const { server } = require('../index');

        const expectedTools = [
            'check_prerequisites',
            'start_registration',
            'check_email_verified',
            'install_relayer',
            'check_relayer_health',
            'start_claim',
            'check_claim_status',
            'get_host_tags',
            'configure_vpd',
            'verify_storage',
            'setup_cli_credentials',
            'describe_settings',
            'update_settings',
            'restart_service',
            'manage_backups',
        ];

        // Access the internal tool registry
        const registeredNames = Object.keys(server._registeredTools);

        expect(registeredNames).toHaveLength(15);
        expect(registeredNames.sort()).toEqual(expectedTools.sort());
    });
});
