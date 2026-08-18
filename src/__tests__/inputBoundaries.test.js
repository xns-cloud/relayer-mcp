'use strict';

/**
 * Input-boundary regression tests for the fixes made in MR !33 (CodeRabbit review).
 *
 * Each test here pins a boundary that was previously open. They are grouped by the
 * defect they prevent rather than by tool, because the point is the behaviour, not the
 * file it lives in.
 */

const { z } = require('zod');
const { validateHostAllowlist } = require('../lib/hostAllowlist');

function register(modulePath, options = {}) {
    const captured = {};
    const server = { registerTool: (name, config, handler) => { captured[name] = { config, handler }; } };
    require(modulePath)(server, options);
    return captured;
}

describe('setup_cli_credentials does not forward the Muse token to arbitrary hosts', () => {
    // The handler sends muse_token as a `keycloaktoken` header to relayer_ui_url.
    // Before this guard, a caller could name any host and receive a valid token.
    const hostileTargets = [
        'http://evil.example.com',
        'https://attacker.io:8888',
        'http://169.254.169.254',       // cloud instance metadata
        'http://8.8.8.8:8888',
    ];

    test.each(hostileTargets)('refuses %s without making any request', async (url) => {
        const posts = [];
        const tools = register('../tools/setupCliCredentials', {
            httpClient: {
                post: async (u, b, c) => { posts.push({ u, c }); return { status: 200, data: { access_key: 'AK', secret_key: 'SK' } }; },
                get: async () => ({ status: 200, data: {} }),
            },
        });
        const { config, handler } = tools['setup_cli_credentials'];
        const args = z.object(config.inputSchema).parse({ muse_token: 'SECRET', relayer_ui_url: url });

        const parsed = JSON.parse((await handler(args)).content[0].text);

        expect(parsed.success).toBe(false);
        // The token must not have left the process at all.
        expect(posts).toHaveLength(0);
    });

    test('allows a loopback target and sends the token there with redirects disabled', async () => {
        const posts = [];
        const tools = register('../tools/setupCliCredentials', {
            httpClient: {
                post: async (u, b, c) => { posts.push({ u, c }); return { status: 200, data: { access_key: 'AK', secret_key: 'SK' } }; },
                get: async () => ({ status: 200, data: {} }),
            },
        });
        const { config, handler } = tools['setup_cli_credentials'];
        const args = z.object(config.inputSchema).parse({ muse_token: 'SECRET', relayer_ui_url: 'http://localhost:8888' });

        await handler(args);

        expect(posts).toHaveLength(1);
        expect(posts[0].u).toContain('localhost:8888');
        // A redirect on a token-bearing request would hand the token to the target,
        // defeating the allowlist.
        expect(posts[0].c.maxRedirects).toBe(0);
    });

    test('rejects a non-URL string before it reaches the allowlist', () => {
        const tools = register('../tools/setupCliCredentials');
        const { config } = tools['setup_cli_credentials'];
        expect(() => z.object(config.inputSchema).parse({ muse_token: 't', relayer_ui_url: 'not-a-url' })).toThrow();
    });
});

describe('the persisted S3 endpoint is derived, not string-patched', () => {
    // The old regex only rewrote an existing :port slot. Every case below was wrong
    // before (MR !33, Fable pass): portless URLs kept 80/443, query/fragment survived
    // into the persisted endpoint, and ':digits' in a PATH could be rewritten instead.
    async function endpointFor(relayerUiUrl) {
        const tools = register('../tools/setupCliCredentials', {
            httpClient: {
                post: async () => ({ status: 200, data: { access_key: 'AK', secret_key: 'SK' } }),
                get: async () => ({ status: 200, data: {} }),
            },
        });
        const { config, handler } = tools['setup_cli_credentials'];
        const args = z.object(config.inputSchema).parse({ muse_token: 'T', relayer_ui_url: relayerUiUrl });
        return JSON.parse((await handler(args)).content[0].text).s3_endpoint;
    }

    test.each([
        ['http://localhost:8888', 'http://localhost:9000'],
        ['http://192.168.1.50', 'http://192.168.1.50:9000'],      // was http://192.168.1.50 (port 80)
        ['http://myhost.local', 'http://myhost.local:9000'],       // was port 80
        ['http://10.0.0.5:8888?x=1', 'http://10.0.0.5:9000'],      // query no longer persisted
        ['http://10.0.0.5:8888#f', 'http://10.0.0.5:9000'],        // fragment no longer persisted
        ['http://10.0.0.5/x:123/y', 'http://10.0.0.5:9000/x:123/y'], // path no longer rewritten
        ['http://10.0.0.5:8888/sub', 'http://10.0.0.5:9000/sub'],  // real path preserved
    ])('%s -> %s', async (input, expected) => {
        expect(await endpointFor(input)).toBe(expected);
    });

    test('always targets port 9000 for every host the allowlist accepts', async () => {
        for (const u of ['http://localhost', 'http://127.0.0.1', 'http://10.0.0.5', 'http://192.168.1.1']) {
            expect(await endpointFor(u)).toMatch(/:9000$/);
        }
    });
});

describe('manage_backups rejects selections that would silently widen a restore', () => {
    const shape = () => register('../tools/manageBackups')['manage_backups'].config.inputSchema;

    // The handler sent `{ file }` for an empty array — indistinguishable from omitting
    // the field, i.e. a FULL restore, on a tool flagged destructive.
    test('an explicitly empty components array is rejected, not treated as "everything"', () => {
        expect(() => z.object(shape()).parse({ action: 'restore', file: 'a.zip', components: [] })).toThrow();
    });

    test('omitting components still means restore everything', () => {
        expect(z.object(shape()).parse({ action: 'restore', file: 'a.zip' }).components).toBeUndefined();
    });

    test.each([
        ['../../etc/passwd', 'traversal'],
        ['a/b.zip', 'path separator'],
        ['   ', 'whitespace only'],
    ])('rejects %s (%s) as an archive name', (file) => {
        expect(() => z.object(shape()).parse({ action: 'restore', file })).toThrow();
    });

    test('accepts a real archive name from the list action', () => {
        expect(z.object(shape()).parse({ action: 'restore', file: '1718000000000.zip' }).file).toBe('1718000000000.zip');
    });
});

describe('numeric inputs are bounded', () => {
    test('check_relayer_health ports reject 0 and above 65535', () => {
        const shape = register('../tools/checkRelayerHealth')['check_relayer_health'].config.inputSchema;
        expect(() => z.object(shape).parse({ ui_port: 0 })).toThrow();
        expect(() => z.object(shape).parse({ s3_port: 65536 })).toThrow();
        expect(z.object(shape).parse({ ui_port: 8888, s3_port: 9000 }).ui_port).toBe(8888);
    });

    test('check_claim_status rejects a non-positive or fractional poll timeout', () => {
        const shape = register('../tools/checkClaimStatus')['check_claim_status'].config.inputSchema;
        expect(() => z.object(shape).parse({ claim_id: 'c', timeout_ms: 0 })).toThrow();
        expect(() => z.object(shape).parse({ claim_id: 'c', timeout_ms: -1 })).toThrow();
        expect(() => z.object(shape).parse({ claim_id: 'c', timeout_ms: 1.5 })).toThrow();
        expect(z.object(shape).parse({ claim_id: 'c' }).timeout_ms).toBe(600000);
    });
});

describe('the shared host allowlist', () => {
    test.each([
        ['http://localhost:8888', true],
        ['http://127.0.0.1', true],
        ['http://10.0.0.5', true],
        ['http://192.168.1.10', true],
        ['http://172.16.0.1', true],
        ['http://box.local', true],
        ['http://evil.example.com', false],
        ['http://169.254.169.254', false],
        ['http://172.32.0.1', false],   // just outside 172.16/12
        ['garbage', false],
    ])('%s -> allowed=%s', (url, expected) => {
        expect(validateHostAllowlist(url).allowed).toBe(expected);
    });
});
