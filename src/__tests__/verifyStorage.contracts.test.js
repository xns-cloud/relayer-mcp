'use strict';

// Contract-gap probes for verify_storage against real relayer-ui MC proxy
// response shapes (see epic-e1 HANDOFF.md "Data Contracts Consumed"). These
// target scenarios the build's own verifyStorage.test.js does not exercise:
// error-shaped 200 bodies from mint/attach, and — the main finding —
// teardown calls that fail via response body rather than a thrown
// exception. httpClient.js sets `validateStatus: () => true`, so no HTTP
// status ever throws; only network-level errors (ECONNREFUSED, DNS, etc.)
// reach the teardown try/catch blocks in verifyStorage.js's `finally`.

describe('verify_storage — contract gaps', () => {
    let server;

    beforeEach(() => {
        server = { tool: jest.fn() };
        jest.resetModules();
    });

    const defaultDockerUtil = {
        getDockerHost: jest.fn().mockResolvedValue({ remote: false, host: 'localhost', endpoint: 'unix:///var/run/docker.sock' }),
    };

    function createMintingHttpMock(overrides = {}) {
        const defaults = {
            mint: { status: 200, data: { user_name: 'mcp-verify-test', access_key: 'ak-minted', secret_key: 'sk-minted', created_at: '2026-01-01' } },
            policyCreate: { status: 200, data: { success: true, policy: {} } },
            attach: { status: 200, data: { status: 'attached' } },
            detach: { status: 200, data: { status: 'detached' } },
            deleteUser: { status: 200, data: {} },
            deletePolicy: { status: 200, data: { status: 'deleted' } },
        };
        const r = { ...defaults, ...overrides };

        return {
            post: jest.fn().mockImplementation(async (url) => {
                if (url.endsWith('/mc/policy-create')) return r.policyCreate;
                if (url.endsWith('/mc/policy-detach')) return r.detach;
                if (url.endsWith('/mc/policy')) return r.attach;
                if (url.endsWith('/mc/user')) return r.mint;
                return { status: 404, data: {} };
            }),
            del: jest.fn().mockImplementation(async (url) => {
                if (url.includes('/mc/user/')) return r.deleteUser;
                if (url.includes('/mc/policy/')) return r.deletePolicy;
                return { status: 404, data: {} };
            }),
            get: jest.fn(),
        };
    }

    function createPassingS3Mock() {
        let capturedContent;
        return {
            createBucket: jest.fn().mockResolvedValue(undefined),
            putObject: jest.fn().mockImplementation(async (bucket, key, body) => { capturedContent = body; }),
            getObject: jest.fn().mockImplementation(async () => capturedContent),
            deleteObject: jest.fn().mockResolvedValue(undefined),
            deleteBucket: jest.fn().mockResolvedValue(undefined),
        };
    }

    function registerWithOptions(opts) {
        const register = require('../tools/verifyStorage');
        register(server, {
            dockerUtil: defaultDockerUtil,
            ...opts,
        });
        return server.tool.mock.calls[0][3];
    }

    // --- Mint: HTTP 200 with an error-shaped body ---

    test('mint HTTP 200 with error-shaped body (missing access_key/secret_key) fails at MintUser, not silently', async () => {
        const httpMock = createMintingHttpMock({
            mint: { status: 200, data: { success: false, message: 'cost_center is required' } },
        });
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => createPassingS3Mock(),
        });

        const result = await handler({ muse_token: 'jwt', endpoint: 'http://localhost:9000' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.failing_step).toBe('MintUser');
        expect(result.isError).toBe(true);
        // The just-minted user is still torn down even though provisioning
        // never yielded usable keys.
        const deleteUserCall = httpMock.del.mock.calls.find(([url]) => url.includes('/mc/user/'));
        expect(deleteUserCall).toBeDefined();
    });

    // --- S1: mint 200 {success:false} surfaces provider message ---

    test('mint HTTP 200 with {success:false, message} surfaces provider message in error', async () => {
        const httpMock = createMintingHttpMock({
            mint: { status: 200, data: { success: false, message: 'user already exists' } },
        });
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => createPassingS3Mock(),
        });

        const result = await handler({ muse_token: 'jwt', endpoint: 'http://localhost:9000' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.failing_step).toBe('MintUser');
        expect(parsed.error).toContain('user already exists');
    });

    // --- Attach: proxy error-path body has no `status` key at all ---

    test('AttachPolicy failure: proxy error body {success:false, message} (no status field) is caught and surfaced', async () => {
        const httpMock = createMintingHttpMock({
            attach: { status: 200, data: { success: false, message: 'user_name not found' } },
        });
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => createPassingS3Mock(),
        });

        const result = await handler({ muse_token: 'jwt', endpoint: 'http://localhost:9000' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.failing_step).toBe('AttachPolicy');
        expect(parsed.error).toContain('user_name not found');
    });

    // --- Teardown: response-body failures (no throw) — see file header ---

    test('teardown: detach responds 200 with {success:false, message} — expected to surface as cleanup_warning', async () => {
        const httpMock = createMintingHttpMock({
            detach: { status: 200, data: { success: false, message: 'user_name not found' } },
        });
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => createPassingS3Mock(),
        });

        const result = await handler({ muse_token: 'jwt', endpoint: 'http://localhost:9000' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true); // a teardown failure must never flip pass to fail
        expect(parsed.cleanup_warning).toMatch(/detach/i);
    });

    test('teardown: delete-user responds 200 with {success:false, message} — expected to surface as cleanup_warning', async () => {
        const httpMock = createMintingHttpMock({
            deleteUser: { status: 200, data: { success: false, message: 'not found' } },
        });
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => createPassingS3Mock(),
        });

        const result = await handler({ muse_token: 'jwt', endpoint: 'http://localhost:9000' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.cleanup_warning).toMatch(/user/i);
    });

    test('teardown: delete-policy responds 200 with {success:false, message} — expected to surface as cleanup_warning', async () => {
        const httpMock = createMintingHttpMock({
            deletePolicy: { status: 200, data: { success: false, message: 'not found' } },
        });
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => createPassingS3Mock(),
        });

        const result = await handler({ muse_token: 'jwt', endpoint: 'http://localhost:9000' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.cleanup_warning).toMatch(/polic/i);
    });

    // Contrast case: a genuine network-level throw during detach IS caught
    // and surfaced today — establishes the throw-path already works, so the
    // gap above is specifically about response-body inspection, not a
    // missing try/catch.
    test('teardown: detach network throw (ECONNREFUSED) surfaces as cleanup_warning', async () => {
        const httpMock = createMintingHttpMock();
        const basePost = httpMock.post;
        httpMock.post = jest.fn().mockImplementation(async (url, ...rest) => {
            if (url.endsWith('/mc/policy-detach')) throw new Error('connect ECONNREFUSED');
            return basePost(url, ...rest);
        });
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => createPassingS3Mock(),
        });

        const result = await handler({ muse_token: 'jwt', endpoint: 'http://localhost:9000' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.cleanup_warning).toMatch(/detach/i);
    });

    // --- Passthrough: zero provisioning/teardown HTTP calls ---

    test('passthrough: supplied keys used verbatim — zero mint/policy/teardown HTTP calls issued', async () => {
        const httpMock = { post: jest.fn(), del: jest.fn(), get: jest.fn() };
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => createPassingS3Mock(),
        });

        const result = await handler({
            muse_token: 'jwt',
            access_key_id: 'operator-ak',
            secret_access_key: 'operator-sk',
            endpoint: 'http://localhost:9000',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(httpMock.post).not.toHaveBeenCalled();
        expect(httpMock.del).not.toHaveBeenCalled();
    });
});
