'use strict';

// Pins the verify_storage contract against real relayer-ui MC proxy response
// shapes (see epic-e1 HANDOFF.md "Data Contracts Consumed"). Covers:
// error-shaped 200 bodies from mint/attach, and teardown calls that report
// failure via response body (httpClient sets `validateStatus: () => true`,
// so no HTTP status ever throws). The teardown tests verify that response-body
// failures ARE inspected and surfaced as cleanup_warning.

const { createMintingHttpMock, createPassingS3Mock, registerWithOptions: _registerWithOptions } = require('./helpers/verifyStorageFixtures');

describe('verify_storage — contract gaps', () => {
    let server;

    beforeEach(() => {
        server = { tool: jest.fn() };
        jest.resetModules();
    });

    function registerWithOptions(opts) {
        return _registerWithOptions(server, opts);
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
        // BUG-366: {success:false} is the provider's definitive "not created" —
        // attempting cleanup (and warning on its failure) would cry wolf.
        const deleteUserCall = httpMock.del.mock.calls.find(([url]) => url.includes('/mc/user/'));
        expect(deleteUserCall).toBeUndefined();
        expect(parsed.cleanup_warning).toBeUndefined();
    });

    // --- S1: mint 200 {success:false} — generic error, step named ---

    test('mint HTTP 200 with {success:false, message} reports failing step without leaking provider text', async () => {
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
        expect(parsed.error).toContain('MintUser');
        expect(parsed.error).toContain('See server log for detail');
    });

    // --- Attach: proxy error-path body has no `status` key at all ---

    test('AttachPolicy failure: proxy error body {success:false, message} (no status field) caught without leaking provider text', async () => {
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
        expect(parsed.error).toContain('See server log for detail');
    });

    // --- Teardown: response-body failures (no throw) ---

    test('teardown: detach responds 200 with {success:false, message} — surfaced as cleanup_warning', async () => {
        const httpMock = createMintingHttpMock({
            detach: { status: 200, data: { success: false, message: 'internal error during detach' } },
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

    test('teardown: delete-user responds 200 with {success:false, message} — surfaced as cleanup_warning', async () => {
        const httpMock = createMintingHttpMock({
            deleteUser: { status: 200, data: { success: false, message: 'access denied' } },
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

    test('teardown: delete-policy responds 200 with {success:false, message} — surfaced as cleanup_warning', async () => {
        const httpMock = createMintingHttpMock({
            deletePolicy: { status: 200, data: { success: false, message: 'access denied' } },
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
    // and surfaced — establishes the throw-path works alongside response-body
    // inspection.
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
