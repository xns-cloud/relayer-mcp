'use strict';

describe('start_registration', () => {
    let server;

    beforeEach(() => {
        server = { tool: jest.fn() };
    });

    function registerWithOptions(opts = {}) {
        const register = require('../tools/startRegistration');
        register(server, opts);
        return server.tool.mock.calls[0][3];
    }

    test('registers tool with name start_registration', () => {
        require('../tools/startRegistration')(server);
        expect(server.tool).toHaveBeenCalledTimes(1);
        expect(server.tool.mock.calls[0][0]).toBe('start_registration');
    });

    test('returns registration_url with correct Keycloak host', async () => {
        const handler = registerWithOptions();
        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.registration_url).toContain('auth.xns.tech');
    });

    test('registration URL targets the scprime realm', async () => {
        const handler = registerWithOptions();
        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.registration_url).toContain('/realms/scprime/');
    });

    test('registration URL uses relayer-native client ID', async () => {
        const handler = registerWithOptions();
        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.registration_url).toContain('client_id=relayer-native');
    });

    test('registration URL points at the openid-connect/registrations endpoint', async () => {
        const handler = registerWithOptions();
        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.registration_url).toContain('/protocol/openid-connect/registrations');
    });

    test('returns a message mentioning check_email_verified', async () => {
        const handler = registerWithOptions();
        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.message).toContain('check_email_verified');
    });

    test('tool schema accepts no parameters', () => {
        registerWithOptions();
        const schema = server.tool.mock.calls[0][2];
        expect(Object.keys(schema)).toHaveLength(0);
    });

    test('tool schema does not accept a password', () => {
        registerWithOptions();
        const schema = server.tool.mock.calls[0][2];
        expect(Object.keys(schema)).not.toContain('password');
    });

    test('tool description does not mention password handling', () => {
        registerWithOptions();
        const description = server.tool.mock.calls[0][1];
        expect(description.toLowerCase()).not.toContain('password');
    });

    test('registration URL includes ported loopback redirect_uri', async () => {
        const handler = registerWithOptions();
        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);
        const url = new URL(parsed.registration_url);

        const redirectUri = url.searchParams.get('redirect_uri');
        expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    });

    test('registration URL includes code_challenge with method S256', async () => {
        const handler = registerWithOptions();
        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);
        const url = new URL(parsed.registration_url);

        expect(url.searchParams.get('code_challenge')).toBeTruthy();
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    });

    test('two calls produce different code_challenge values', async () => {
        const handler = registerWithOptions();
        const result1 = await handler({});
        const result2 = await handler({});
        const url1 = new URL(JSON.parse(result1.content[0].text).registration_url);
        const url2 = new URL(JSON.parse(result2.content[0].text).registration_url);

        expect(url1.searchParams.get('code_challenge')).not.toBe(url2.searchParams.get('code_challenge'));
    });

    test('custom Keycloak options are respected', async () => {
        const handler = registerWithOptions({
            keycloakUrl: 'https://custom-auth.example.com/auth',
            realm: 'custom-realm',
            clientId: 'custom-client',
        });
        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.registration_url).toContain('custom-auth.example.com');
        expect(parsed.registration_url).toContain('/realms/custom-realm/');
        expect(parsed.registration_url).toContain('client_id=custom-client');
    });
});
