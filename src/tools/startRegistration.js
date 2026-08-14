'use strict';

const {
    DEFAULT_KEYCLOAK_URL,
    DEFAULT_REALM,
    DEFAULT_CLIENT_ID,
    generateVerifier,
    generateChallenge,
} = require('../lib/oidcAuth');

/**
 * Tool 2: start_registration
 *
 * Returns the Keycloak self-registration URL for the configured realm and
 * client. The agent presents this URL to the user for browser sign-up —
 * no password is ever handled by the MCP. After registration, use
 * check_email_verified to poll for verification status.
 *
 * A fresh disposable PKCE pair is generated per call to satisfy the
 * relayer-native client's S256 requirement. The verifier is discarded —
 * no token exchange happens; check_email_verified is the completion signal.
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
            const verifier = generateVerifier();
            const challenge = generateChallenge(verifier);
            const redirectUri = 'http://127.0.0.1:41337/callback';

            const params = new URLSearchParams({
                client_id: clientId,
                response_type: 'code',
                scope: 'openid',
                redirect_uri: redirectUri,
                code_challenge: challenge,
                code_challenge_method: 'S256',
            });

            const registrationUrl = `${keycloakUrl}/realms/${realm}/protocol/openid-connect/registrations?${params}`;

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        registration_url: registrationUrl,
                        message: `Open this URL in a browser to create an XNS account. After signing up, use check_email_verified to confirm the email address was verified. Note: after completing registration, the browser may show a connection error on the final redirect page — this is expected and harmless.`,
                    }, null, 2),
                }],
            };
        },
    );
};
