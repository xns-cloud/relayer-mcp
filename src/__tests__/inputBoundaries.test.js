'use strict';

/**
 * Input-boundary regression tests for the fixes made in MR !33 (CodeRabbit review).
 *
 * Each test here pins a boundary that was previously open. They are grouped by the
 * defect they prevent rather than by tool, because the point is the behavior, not the
 * file it lives in.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { z } = require('zod');
const { validateHostAllowlist } = require('../lib/hostAllowlist');
const { mockRelayer } = require('./helpers/mockRelayer');

// What setup_cli_credentials asks the Relayer for, in order, when nothing fails.
const SETUP_PATHS = ['/api/v1/mc/user', '/api/v1/mc/policy-create', '/api/v1/mc/policy'];

// setup_cli_credentials writes under the home folder: point it at a throwaway one, never
// at the credentials of whoever runs the tests.
let testHome;
beforeEach(() => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xns-home-'));
    jest.spyOn(os, 'homedir').mockReturnValue(testHome);
});
afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(testHome, { recursive: true, force: true });
});

// Token manager wiring for setup_cli_credentials: an in-memory token state and a
// sign-in that returns a fixed token, so no browser or network is involved.
function tokenOptions(accessToken = 'SECRET') {
    let state = null;
    return {
        acquireToken: async () => ({ access_token: accessToken, refresh_token: 'r', expires_at: Date.now() + 3600000 }),
        _tokenStateModule: { get: () => state, set: (s) => { state = s; }, clear: () => { state = null; } },
    };
}

function register(modulePath, options = {}) {
    const captured = {};
    const server = { registerTool: (name, config, handler) => { captured[name] = { config, handler }; } };
    require(modulePath)(server, options);
    return captured;
}

describe('setup_cli_credentials sends the server token only to the server-owned base', () => {
    function build(extra = {}) {
        const relayer = mockRelayer();
        const tools = register('../tools/setupCliCredentials', {
            ...tokenOptions('MANAGER-TOKEN'),
            httpClient: relayer.httpClient,
            ...extra,
        });
        return { calls: relayer.calls, ...tools['setup_cli_credentials'] };
    }

    test('takes no relayer_ui_url and no muse_token input', () => {
        const { config } = build();
        expect(Object.keys(config.inputSchema)).not.toContain('relayer_ui_url');
        expect(Object.keys(config.inputSchema)).not.toContain('muse_token');
    });

    test.each([
        'http://evil.example.com',
        'https://attacker.io:8888',
        'http://169.254.169.254',
        'http://10.0.0.5:8888',
    ])('a caller-passed relayer_ui_url %s is ignored; the request goes to the default base', async (url) => {
        const { calls, config, handler } = build();
        const args = z.object(config.inputSchema).parse({ relayer_ui_url: url });

        await handler({ ...args, relayer_ui_url: url });

        expect(calls.map((c) => c.url)).toEqual(SETUP_PATHS.map((p) => `http://localhost:8888${p}`));
        for (const { config: sent } of calls) {
            expect(sent.headers.keycloaktoken).toBe('MANAGER-TOKEN');
            // A redirect on a token-bearing request would hand the token to another host.
            expect(sent.maxRedirects).toBe(0);
        }
    });

    test('ui_port picks the port on the server-owned host; a caller relayer_ui_url is still ignored', async () => {
        const { calls, config, handler } = build();
        const args = z.object(config.inputSchema).parse({ ui_port: 8889 });

        await handler({ ...args, relayer_ui_url: 'http://evil.example.com:8889' });

        expect(calls.map((c) => c.url)).toEqual(SETUP_PATHS.map((p) => `http://localhost:8889${p}`));
    });

    test.each([0, 65536, 8888.5, '8889'])('ui_port %p is rejected', (bad) => {
        const { config } = build();
        expect(z.object(config.inputSchema).safeParse({ ui_port: bad }).success).toBe(false);
    });

    test('uses the server-configured base when one is set, still ignoring a caller URL', async () => {
        const { calls, config, handler } = build({ relayerUiBase: 'http://192.168.1.50:8888/' });
        const args = z.object(config.inputSchema).parse({});

        await handler({ ...args, relayer_ui_url: 'http://evil.example.com' });

        expect(calls.map((c) => c.url)).toEqual(SETUP_PATHS.map((p) => `http://192.168.1.50:8888${p}`));
    });

    test('re-authenticates once and retries when the Relayer answers 401', async () => {
        let refused = false;
        const relayer = mockRelayer({
            routes: {
                'POST /user': () => {
                    if (refused) return { status: 200, data: { access_key: 'AK', secret_key: 'SK' } };
                    refused = true;
                    return { status: 401, data: {} };
                },
            },
        });
        let signIns = 0;
        let state = null;
        const tools = register('../tools/setupCliCredentials', {
            acquireToken: async () => { signIns += 1; return { access_token: `T${signIns}`, refresh_token: 'r', expires_at: Date.now() + 3600000 }; },
            _tokenStateModule: { get: () => state, set: (s) => { state = s; }, clear: () => { state = null; } },
            httpClient: relayer.httpClient,
        });
        const { config, handler } = tools['setup_cli_credentials'];
        const args = z.object(config.inputSchema).parse({});

        const parsed = JSON.parse((await handler(args)).content[0].text);

        expect(relayer.routes()).toEqual(['POST /user', 'POST /user', 'POST /policy-create', 'POST /policy']);
        // The fresh token carries the rest of the run.
        expect(relayer.calls.map((c) => c.config.headers.keycloaktoken)).toEqual(['T1', 'T2', 'T2', 'T2']);
        expect(parsed.success).toBe(true);
    });
});

describe('the persisted S3 endpoint is derived, not string-patched', () => {
    // The old regex only rewrote an existing :port slot. Every case below was wrong
    // before (MR !33, Fable pass): portless URLs kept 80/443, query/fragment survived
    // into the persisted endpoint, and ':digits' in a PATH could be rewritten instead.
    async function endpointFor(relayerUiUrl) {
        const tools = register('../tools/setupCliCredentials', {
            ...tokenOptions(),
            relayerUiBase: relayerUiUrl,
            httpClient: mockRelayer().httpClient,
        });
        const { config, handler } = tools['setup_cli_credentials'];
        const args = z.object(config.inputSchema).parse({});
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

    test('always targets port 9000', async () => {
        for (const u of ['http://localhost', 'http://127.0.0.1', 'http://10.0.0.5', 'http://192.168.1.1']) {
            expect(await endpointFor(u)).toMatch(/:9000$/);
        }
    });
});

describe('the credentials file does not persist the Muse token', () => {
    // The xns CLI requires the KEY to exist (5-key schema) but never reads its value:
    // `_ = p.MuseToken` in internal/credentials/store.go validateProfile is the only
    // reference, and its comment says "muse_token may be empty". Writing the live JWT
    // there left a short-lived, unrenewable credential on disk granting Muse-API reach
    // beyond S3, for no consumer.
    test('writes the muse_token key present but empty, and keeps the S3 keys', async () => {
        const tools = register('../tools/setupCliCredentials', {
            ...tokenOptions(),
            httpClient: mockRelayer({ keys: { access_key: 'AKIAEXAMPLE', secret_key: 'wJalrSECRET' } }).httpClient,
        });
        const { config, handler } = tools['setup_cli_credentials'];
        const args = z.object(config.inputSchema).parse({
            installation_id: 'cc-test-001',
        });

        await handler(args);

        const raw = fs.readFileSync(path.join(testHome, '.xns', 'credentials'), 'utf8');
        const profile = JSON.parse(raw).profiles.default;

        // The key must still be present — the CLI's schema is 5-key.
        expect(Object.keys(profile)).toContain('muse_token');
        expect(profile.muse_token).toBe('');
        // The token must not appear anywhere in the file, under any key.
        expect(raw).not.toContain('eyJHEADER');
        // The credentials the CLI actually needs are still written.
        expect(profile.access_key_id).toBe('AKIAEXAMPLE');
        expect(profile.secret_access_key).toBe('wJalrSECRET');
        expect(profile.cost_center_id).toBe('cc-test-001');
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
