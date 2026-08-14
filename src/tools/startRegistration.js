'use strict';

const DEFAULT_KEYCLOAK_URL = 'https://auth.xns.tech/auth';
const DEFAULT_REALM = 'scprime';
const DEFAULT_CLIENT_ID = 'relayer-native';

/**
 * Tool 2: start_registration
 *
 * Returns the Keycloak self-registration URL for the configured realm and
 * client. The agent presents this URL to the user for browser sign-up —
 * no password is ever handled by the MCP. After registration, use
 * check_email_verified to poll for verification status.
 */
module.exports = function registerStartRegistration(server, options = {}) {
    const keycloakUrl = options.keycloakUrl || DEFAULT_KEYCLOAK_URL;
    const realm = options.realm || DEFAULT_REALM;
    const clientId = options.clientId || DEFAULT_CLIENT_ID;

    server.tool(
        'start_registration',
        'Get the browser registration URL for creating a new XNS account. The user opens this URL in a browser to sign up via Keycloak — the agent never touches credentials. After signing up, use check_email_verified to poll for email verification.',
        {},
        async () => {
            const registrationUrl = `${keycloakUrl}/realms/${realm}/protocol/openid-connect/registrations?client_id=${encodeURIComponent(clientId)}&response_type=code&scope=openid`;

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        registration_url: registrationUrl,
                        message: `Open this URL in a browser to create an XNS account. After signing up, use check_email_verified to confirm the email address was verified.`,
                    }, null, 2),
                }],
            };
        },
    );
};
