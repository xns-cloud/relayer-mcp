'use strict';

const { defaultDockerUtil, createMintingHttpMock, createPassingS3Mock, registerWithOptions: _registerWithOptions } = require('./helpers/verifyStorageFixtures');

describe('verify_storage', () => {
    let server;

    beforeEach(() => {
        server = { tool: jest.fn() };
        jest.resetModules();
    });

    function registerWithOptions(opts) {
        return _registerWithOptions(server, opts);
    }

    // --- TP-1: AC-1 happy path — mint only, no keys ---

    test('mint path happy: round-trip passes with only muse_token', async () => {
        const s3 = createPassingS3Mock();
        const httpMock = createMintingHttpMock();
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => s3,
        });

        const result = await handler({
            muse_token: 'test-jwt',
            endpoint: 'http://localhost:9000',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.endpoint).toBe('http://localhost:9000');
        expect(parsed.message).toContain('localhost:9000');
        expect(result.isError).toBeUndefined();
    });

    test('mint path: sends keycloaktoken header on mint call', async () => {
        const s3 = createPassingS3Mock();
        const httpMock = createMintingHttpMock();
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => s3,
        });

        await handler({ muse_token: 'my-jwt', endpoint: 'http://localhost:9000' });

        const mintCall = httpMock.post.mock.calls.find(([url]) => url.endsWith('/mc/user'));
        expect(mintCall).toBeDefined();
        expect(mintCall[2].headers.keycloaktoken).toBe('my-jwt');
    });

    test('mint path: uses minted credentials for S3 client', async () => {
        let capturedCreds;
        const httpMock = createMintingHttpMock();
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: (cfg) => {
                capturedCreds = cfg;
                return createPassingS3Mock();
            },
        });

        await handler({ muse_token: 'jwt', endpoint: 'http://localhost:9000' });

        expect(capturedCreds.accessKeyId).toBe('ak-minted');
        expect(capturedCreds.secretAccessKey).toBe('sk-minted');
    });

    // --- TP-2: AC-3/4 teardown on fail + step naming ---

    test('TP-2: GetObject failure names step and runs teardown', async () => {
        const deleteObject = jest.fn().mockResolvedValue(undefined);
        const deleteBucket = jest.fn().mockResolvedValue(undefined);
        const httpMock = createMintingHttpMock();
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => ({
                createBucket: jest.fn().mockResolvedValue(undefined),
                putObject: jest.fn().mockResolvedValue(undefined),
                getObject: jest.fn().mockRejectedValue(new Error('get failed')),
                deleteObject,
                deleteBucket,
            }),
        });

        const result = await handler({ muse_token: 'jwt', endpoint: 'http://localhost:9000' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.failing_step).toBe('GetObject');
        expect(parsed.error).toContain('GetObject');
        expect(result.isError).toBe(true);

        expect(deleteBucket).toHaveBeenCalled();
        const detachCall = httpMock.post.mock.calls.find(([url]) => url.endsWith('/mc/policy-detach'));
        expect(detachCall).toBeDefined();
        expect(httpMock.del).toHaveBeenCalled();
    });

    // --- TP-3: AC-4 teardown failure non-fatal ---

    test('TP-3: cleanup error is non-fatal — pass stays pass, warning added', async () => {
        const s3 = createPassingS3Mock();
        s3.deleteObject = jest.fn().mockRejectedValue(new Error('cleanup denied'));
        s3.deleteBucket = jest.fn().mockRejectedValue(new Error('cleanup denied'));
        const httpMock = createMintingHttpMock();
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => s3,
        });

        const result = await handler({ muse_token: 'jwt', endpoint: 'http://localhost:9000' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.cleanup_warning).toMatch(/cleanup failed/i);
    });

    // --- Mint step failures ---

    test('MintUser failure names failing step', async () => {
        const httpMock = createMintingHttpMock({
            mint: { status: 403, data: { message: 'Forbidden' } },
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
        expect(result.isError).toBe(true);
    });

    test('CreatePolicy failure names failing step', async () => {
        const httpMock = createMintingHttpMock({
            policyCreate: { status: 200, data: { success: false, message: 'policy error' } },
        });
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => createPassingS3Mock(),
        });

        const result = await handler({ muse_token: 'jwt', endpoint: 'http://localhost:9000' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.failing_step).toBe('CreatePolicy');
        expect(parsed.error).toContain('CreatePolicy');
    });

    test('CreatePolicy failure cleans up minted user', async () => {
        const httpMock = createMintingHttpMock({
            policyCreate: { status: 200, data: { success: false, message: 'policy error' } },
        });
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => createPassingS3Mock(),
        });

        await handler({ muse_token: 'jwt', endpoint: 'http://localhost:9000' });

        const deleteUserCall = httpMock.del.mock.calls.find(([url]) => url.includes('/mc/user/'));
        expect(deleteUserCall).toBeDefined();
    });

    test('AttachPolicy failure names failing step', async () => {
        const httpMock = createMintingHttpMock({
            attach: { status: 200, data: { status: 'error', message: 'attach failed' } },
        });
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => createPassingS3Mock(),
        });

        const result = await handler({ muse_token: 'jwt', endpoint: 'http://localhost:9000' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.failing_step).toBe('AttachPolicy');
    });

    // --- S3 round-trip step naming ---

    test('CreateBucket failure names failing step', async () => {
        const httpMock = createMintingHttpMock();
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => ({
                createBucket: jest.fn().mockRejectedValue(new Error('bucket create denied')),
                putObject: jest.fn(),
                getObject: jest.fn(),
                deleteObject: jest.fn().mockResolvedValue(undefined),
                deleteBucket: jest.fn().mockResolvedValue(undefined),
            }),
        });

        const result = await handler({ muse_token: 'jwt', endpoint: 'http://localhost:9000' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.failing_step).toBe('CreateBucket');
        expect(result.isError).toBe(true);
    });

    test('PutObject failure names failing step', async () => {
        const httpMock = createMintingHttpMock();
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => ({
                createBucket: jest.fn().mockResolvedValue(undefined),
                putObject: jest.fn().mockRejectedValue(new Error('put failed')),
                getObject: jest.fn(),
                deleteObject: jest.fn().mockResolvedValue(undefined),
                deleteBucket: jest.fn().mockResolvedValue(undefined),
            }),
        });

        const result = await handler({ muse_token: 'jwt', endpoint: 'http://localhost:9000' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.failing_step).toBe('PutObject');
    });

    test('content mismatch names Compare step', async () => {
        const httpMock = createMintingHttpMock();
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => ({
                createBucket: jest.fn().mockResolvedValue(undefined),
                putObject: jest.fn().mockResolvedValue(undefined),
                getObject: jest.fn().mockResolvedValue('WRONG CONTENT'),
                deleteObject: jest.fn().mockResolvedValue(undefined),
                deleteBucket: jest.fn().mockResolvedValue(undefined),
            }),
        });

        const result = await handler({ muse_token: 'jwt', endpoint: 'http://localhost:9000' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.failing_step).toBe('Compare');
    });

    // --- Teardown order verification ---

    test('successful mint path: teardown calls detach, delete user, delete policy', async () => {
        const s3 = createPassingS3Mock();
        const httpMock = createMintingHttpMock();
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => s3,
        });

        await handler({ muse_token: 'jwt', endpoint: 'http://localhost:9000' });

        expect(s3.deleteObject).toHaveBeenCalled();
        expect(s3.deleteBucket).toHaveBeenCalled();

        const detachCall = httpMock.post.mock.calls.find(([url]) => url.endsWith('/mc/policy-detach'));
        expect(detachCall).toBeDefined();

        const deleteUserCall = httpMock.del.mock.calls.find(([url]) => url.includes('/mc/user/'));
        expect(deleteUserCall).toBeDefined();

        const deletePolicyCall = httpMock.del.mock.calls.find(([url]) => url.includes('/mc/policy/'));
        expect(deletePolicyCall).toBeDefined();
    });

    // --- Passthrough path ---

    test('passthrough: access_key_id + secret_access_key skip minting', async () => {
        const httpMock = { post: jest.fn(), del: jest.fn(), get: jest.fn() };
        let capturedCreds;
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: (cfg) => {
                capturedCreds = cfg;
                return createPassingS3Mock();
            },
        });

        const result = await handler({
            muse_token: 'jwt',
            access_key_id: 'operator-ak',
            secret_access_key: 'operator-sk',
            endpoint: 'http://localhost:9000',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(capturedCreds.accessKeyId).toBe('operator-ak');
        expect(capturedCreds.secretAccessKey).toBe('operator-sk');
        expect(httpMock.post).not.toHaveBeenCalledWith(
            expect.stringContaining('/mc/user'),
            expect.anything(),
            expect.anything()
        );
    });

    test('passthrough: muse_token not required when keys provided', async () => {
        const handler = registerWithOptions({
            httpClient: { post: jest.fn(), del: jest.fn(), get: jest.fn() },
            createS3Client: () => createPassingS3Mock(),
        });

        const result = await handler({
            access_key_id: 'ak',
            secret_access_key: 'sk',
            endpoint: 'http://localhost:9000',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
    });

    // --- Missing muse_token → BUG-366: falls back to OIDC session, no init error ---

    test('missing muse_token without keys falls back to OIDC sign-in (BUG-366)', async () => {
        const acquireMock = jest.fn().mockResolvedValue({
            access_token: 'fallback-jwt',
            refresh_token: 'ref',
            expires_at: Date.now() + 600000,
        });
        const handler = registerWithOptions({
            httpClient: createMintingHttpMock(),
            createS3Client: () => createPassingS3Mock(),
            _tokenStateModule: (() => {
                let state = null;
                return { get: () => state, set: (s) => { state = s; }, clear: () => { state = null; } };
            })(),
            acquireToken: acquireMock,
        });

        const result = await handler({ endpoint: 'http://localhost:9000' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(acquireMock).toHaveBeenCalled();
    });

    // --- Remote Docker host ---

    test('no endpoint + remote docker: defaults to remote host:9000', async () => {
        let capturedEndpoint;
        const httpMock = createMintingHttpMock();
        const handler = registerWithOptions({
            dockerUtil: {
                getDockerHost: jest.fn().mockResolvedValue({ remote: true, host: 'docker-box.lan', endpoint: 'ssh://user@docker-box.lan' }),
            },
            httpClient: httpMock,
            createS3Client: (cfg) => {
                capturedEndpoint = cfg.endpoint;
                return createPassingS3Mock();
            },
        });

        const result = await handler({ muse_token: 'jwt' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(capturedEndpoint).toBe('http://docker-box.lan:9000');
        expect(parsed.endpoint).toBe('http://docker-box.lan:9000');
    });

    test('explicit endpoint: docker host detection not consulted', async () => {
        const getDockerHost = jest.fn();
        const httpMock = createMintingHttpMock();
        const handler = registerWithOptions({
            dockerUtil: { getDockerHost },
            httpClient: httpMock,
            createS3Client: () => createPassingS3Mock(),
        });

        const result = await handler({
            muse_token: 'jwt',
            endpoint: 'http://10.0.0.7:19000',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.endpoint).toBe('http://10.0.0.7:19000');
        expect(getDockerHost).not.toHaveBeenCalled();
    });

    // --- Endpoint validation ---

    test('malformed endpoint rejected at zod boundary', () => {
        const { z } = require('zod');
        registerWithOptions({ createS3Client: jest.fn(), httpClient: createMintingHttpMock() });
        const shape = server.tool.mock.calls[0][2];

        const parsed = z.object(shape).safeParse({
            muse_token: 'jwt',
            endpoint: 'not a url',
        });

        expect(parsed.success).toBe(false);
    });

    test('malformed relayer_ui_url rejected at zod boundary', () => {
        const { z } = require('zod');
        registerWithOptions({ createS3Client: jest.fn(), httpClient: createMintingHttpMock() });
        const shape = server.tool.mock.calls[0][2];

        const parsed = z.object(shape).safeParse({
            muse_token: 'jwt',
            relayer_ui_url: 'not a url',
        });

        expect(parsed.success).toBe(false);
    });

    // --- Host allowlist ---

    test('public relayer_ui_url rejected before any HTTP call', async () => {
        const httpMock = createMintingHttpMock();
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => createPassingS3Mock(),
        });

        const result = await handler({
            muse_token: 'jwt',
            relayer_ui_url: 'https://evil.example.com',
            endpoint: 'http://localhost:9000',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.failing_step).toBe('init');
        expect(result.isError).toBe(true);
        expect(httpMock.post).not.toHaveBeenCalled();
        expect(httpMock.del).not.toHaveBeenCalled();
    });

    test('localhost relayer_ui_url accepted', async () => {
        const httpMock = createMintingHttpMock();
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => createPassingS3Mock(),
        });

        const result = await handler({
            muse_token: 'jwt',
            relayer_ui_url: 'http://localhost:8888',
            endpoint: 'http://localhost:9000',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
    });

    test('192.168.x relayer_ui_url accepted', async () => {
        const httpMock = createMintingHttpMock();
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => createPassingS3Mock(),
        });

        const result = await handler({
            muse_token: 'jwt',
            relayer_ui_url: 'http://192.168.1.100:8888',
            endpoint: 'http://localhost:9000',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
    });

    // --- Trailing-slash normalization ---

    test('trailing slash on relayer_ui_url normalized (no double slash in paths)', async () => {
        const httpMock = createMintingHttpMock();
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => createPassingS3Mock(),
        });

        await handler({
            muse_token: 'jwt',
            relayer_ui_url: 'http://localhost:8888/',
            endpoint: 'http://localhost:9000',
        });

        const mintCall = httpMock.post.mock.calls.find(([url]) => url.includes('/mc/user'));
        expect(mintCall).toBeDefined();
        expect(mintCall[0]).not.toContain('//api');
    });

    // --- Error text not leaked to client ---

    test('error text is generic — no err.message in response', async () => {
        const httpMock = createMintingHttpMock({
            mint: { status: 500, data: { message: 'internal server error with secrets' } },
        });
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => createPassingS3Mock(),
        });

        const result = await handler({ muse_token: 'jwt', endpoint: 'http://localhost:9000' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.error).toContain('See server log for detail');
        expect(parsed.error).not.toContain('internal server error with secrets');
    });

    // --- Description checks ---

    test('tool description does not mention fullaccess', () => {
        registerWithOptions({ createS3Client: jest.fn(), httpClient: createMintingHttpMock() });
        const description = server.tool.mock.calls[0][1];
        expect(description.toLowerCase()).not.toContain('fullaccess');
    });

    test('tool description mentions OIDC/automatic provisioning', () => {
        registerWithOptions({ createS3Client: jest.fn(), httpClient: createMintingHttpMock() });
        const description = server.tool.mock.calls[0][1];
        expect(description).toMatch(/automatic|OIDC|provision/i);
    });

    // --- Auto-detected endpoint hints ---

    test('auto-detected endpoint + success: explicit-IP note in output', async () => {
        const httpMock = createMintingHttpMock();
        const handler = registerWithOptions({
            dockerUtil: {
                getDockerHost: jest.fn().mockResolvedValue({ remote: true, host: '192.168.1.50', endpoint: 'ssh://user@192.168.1.50' }),
            },
            httpClient: httpMock,
            createS3Client: () => createPassingS3Mock(),
        });

        const result = await handler({ muse_token: 'jwt' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(JSON.stringify(parsed)).toMatch(/endpoint|explicit|ip/i);
    });

    test('auto-detected endpoint + failure: explicit-IP hint in error', async () => {
        const httpMock = createMintingHttpMock();
        const handler = registerWithOptions({
            dockerUtil: {
                getDockerHost: jest.fn().mockResolvedValue({ remote: false, host: 'localhost', endpoint: 'unix:///var/run/docker.sock' }),
            },
            httpClient: httpMock,
            createS3Client: () => ({
                createBucket: jest.fn().mockRejectedValue(new Error('connection refused')),
                putObject: jest.fn(),
                getObject: jest.fn(),
                deleteObject: jest.fn().mockResolvedValue(undefined),
                deleteBucket: jest.fn().mockResolvedValue(undefined),
            }),
        });

        const result = await handler({ muse_token: 'jwt' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.error).toMatch(/endpoint|explicit|ip/i);
    });

    test('explicit endpoint passed: no explicit-IP hint', async () => {
        const httpMock = createMintingHttpMock();
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => createPassingS3Mock(),
        });

        const result = await handler({
            muse_token: 'jwt',
            endpoint: 'http://10.0.0.7:9000',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.note).toBeUndefined();
    });

    // --- Schema checks ---

    test('access_key_id and secret_access_key are optional in schema', () => {
        registerWithOptions({ createS3Client: jest.fn(), httpClient: createMintingHttpMock() });
        const schema = server.tool.mock.calls[0][2];
        expect(schema.access_key_id.isOptional()).toBe(true);
        expect(schema.secret_access_key.isOptional()).toBe(true);
    });

    test('muse_token is optional in schema', () => {
        registerWithOptions({ createS3Client: jest.fn(), httpClient: createMintingHttpMock() });
        const schema = server.tool.mock.calls[0][2];
        expect(schema.muse_token.isOptional()).toBe(true);
    });

    // --- Scoped policy document ---

    test('mint path creates a scoped policy restricted to mcp-verify-* buckets', async () => {
        const httpMock = createMintingHttpMock();
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => createPassingS3Mock(),
        });

        await handler({ muse_token: 'jwt', endpoint: 'http://localhost:9000' });

        const policyCall = httpMock.post.mock.calls.find(([url]) => url.endsWith('/mc/policy-create'));
        expect(policyCall).toBeDefined();
        const [, body] = policyCall;
        const doc = JSON.parse(body.json);
        expect(doc.Statement[0].Resource).toContain('arn:aws:s3:::mcp-verify-*');
        expect(doc.Statement[0].Resource).toContain('arn:aws:s3:::mcp-verify-*/*');
        expect(doc.Statement[0].Action).toContain('s3:CreateBucket');
        expect(doc.Statement[0].Action).toContain('s3:DeleteBucket');
        expect(doc.Statement[0].Action).toContain('s3:PutObject');
        expect(doc.Statement[0].Action).toContain('s3:GetObject');
        expect(doc.Statement[0].Action).toContain('s3:DeleteObject');
    });

    // --- validateHostAllowlist unit tests ---

    test('validateHostAllowlist: loopback addresses accepted', () => {
        const { validateHostAllowlist } = require('../tools/verifyStorage');
        expect(validateHostAllowlist('http://localhost:8888').allowed).toBe(true);
        expect(validateHostAllowlist('http://127.0.0.1:8888').allowed).toBe(true);
        expect(validateHostAllowlist('http://127.0.0.99:8888').allowed).toBe(true);
        expect(validateHostAllowlist('http://[::1]:8888').allowed).toBe(true);
    });

    test('validateHostAllowlist: RFC1918 addresses accepted', () => {
        const { validateHostAllowlist } = require('../tools/verifyStorage');
        expect(validateHostAllowlist('http://10.0.0.1:8888').allowed).toBe(true);
        expect(validateHostAllowlist('http://10.255.255.255:8888').allowed).toBe(true);
        expect(validateHostAllowlist('http://172.16.0.1:8888').allowed).toBe(true);
        expect(validateHostAllowlist('http://172.31.255.255:8888').allowed).toBe(true);
        expect(validateHostAllowlist('http://192.168.0.1:8888').allowed).toBe(true);
        expect(validateHostAllowlist('http://192.168.255.255:8888').allowed).toBe(true);
    });

    test('validateHostAllowlist: .local hostnames accepted', () => {
        const { validateHostAllowlist } = require('../tools/verifyStorage');
        expect(validateHostAllowlist('http://myhost.local:8888').allowed).toBe(true);
    });

    test('validateHostAllowlist: public IPs rejected', () => {
        const { validateHostAllowlist } = require('../tools/verifyStorage');
        expect(validateHostAllowlist('http://8.8.8.8:8888').allowed).toBe(false);
        expect(validateHostAllowlist('https://evil.example.com:8888').allowed).toBe(false);
    });

    test('validateHostAllowlist: 172.32.x is not RFC1918', () => {
        const { validateHostAllowlist } = require('../tools/verifyStorage');
        expect(validateHostAllowlist('http://172.32.0.1:8888').allowed).toBe(false);
    });

    // --- Intent-flag cleanup: bucket created before response ---

    test('intent-flag: bucket cleanup attempted even when createBucket throws after server acted', async () => {
        let s3CleanupCalled = false;
        const httpMock = createMintingHttpMock();
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => ({
                createBucket: jest.fn().mockRejectedValue(new Error('timeout after server created')),
                putObject: jest.fn(),
                getObject: jest.fn(),
                deleteObject: jest.fn().mockImplementation(async () => { s3CleanupCalled = true; }),
                deleteBucket: jest.fn().mockImplementation(async () => { s3CleanupCalled = true; }),
            }),
        });

        const result = await handler({ muse_token: 'jwt', endpoint: 'http://localhost:9000' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.failing_step).toBe('CreateBucket');
        expect(s3CleanupCalled).toBe(true);
    });

    test('intent-flag: user cleanup attempted even when mint throws after server acted', async () => {
        const httpMock = createMintingHttpMock();
        const originalPost = httpMock.post;
        httpMock.post = jest.fn().mockImplementation(async (url, ...rest) => {
            if (url.endsWith('/mc/user')) {
                throw new Error('timeout after server created user');
            }
            return originalPost(url, ...rest);
        });
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => createPassingS3Mock(),
        });

        await handler({ muse_token: 'jwt', endpoint: 'http://localhost:9000' });

        const deleteUserCall = httpMock.del.mock.calls.find(([url]) => url.includes('/mc/user/'));
        expect(deleteUserCall).toBeDefined();
    });

    // --- maxRedirects: 0 on token-bearing requests ---

    test('token-bearing requests set maxRedirects 0 to prevent redirect-based token leak', async () => {
        const httpMock = createMintingHttpMock();
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => createPassingS3Mock(),
        });

        await handler({ muse_token: 'jwt', endpoint: 'http://localhost:9000' });

        const mintCall = httpMock.post.mock.calls.find(([url]) => url.endsWith('/mc/user'));
        expect(mintCall).toBeDefined();
        expect(mintCall[2].maxRedirects).toBe(0);

        const detachCall = httpMock.post.mock.calls.find(([url]) => url.endsWith('/mc/policy-detach'));
        expect(detachCall).toBeDefined();
        expect(detachCall[2].maxRedirects).toBe(0);
    });

    test('teardown delete calls set maxRedirects 0', async () => {
        const httpMock = createMintingHttpMock();
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => createPassingS3Mock(),
        });

        await handler({ muse_token: 'jwt', endpoint: 'http://localhost:9000' });

        const deleteUserCall = httpMock.del.mock.calls.find(([url]) => url.includes('/mc/user/'));
        expect(deleteUserCall).toBeDefined();
        expect(deleteUserCall[1].maxRedirects).toBe(0);

        const deletePolicyCall = httpMock.del.mock.calls.find(([url]) => url.includes('/mc/policy/'));
        expect(deletePolicyCall).toBeDefined();
        expect(deletePolicyCall[1].maxRedirects).toBe(0);
    });

    // --- Lost-response orphan: cleanup warning when creation unconfirmed ---

    test('lost mint response (transport throw) + failed user deletion → cleanup_warning present', async () => {
        const httpMock = createMintingHttpMock();
        const originalPost = httpMock.post;
        httpMock.post = jest.fn().mockImplementation(async (url, ...rest) => {
            if (url.endsWith('/mc/user')) {
                throw new Error('socket hang up');
            }
            return originalPost(url, ...rest);
        });
        httpMock.del = jest.fn().mockImplementation(async (url) => {
            if (url.includes('/mc/user/')) {
                return { status: 200, data: { success: false, message: 'deletion failed' } };
            }
            return { status: 200, data: { status: 'deleted' } };
        });
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => createPassingS3Mock(),
        });

        const result = await handler({ muse_token: 'jwt', endpoint: 'http://localhost:9000' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.cleanup_warning).toMatch(/user cleanup failed/i);
    });

    test('lost mint response + user deletion returns not-found → no cleanup_warning', async () => {
        const httpMock = createMintingHttpMock();
        const originalPost = httpMock.post;
        httpMock.post = jest.fn().mockImplementation(async (url, ...rest) => {
            if (url.endsWith('/mc/user')) {
                throw new Error('socket hang up');
            }
            return originalPost(url, ...rest);
        });
        httpMock.del = jest.fn().mockImplementation(async (url) => {
            if (url.includes('/mc/user/')) {
                return { status: 200, data: { success: false, message: 'user not found' } };
            }
            return { status: 200, data: { status: 'deleted' } };
        });
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => createPassingS3Mock(),
        });

        const result = await handler({ muse_token: 'jwt', endpoint: 'http://localhost:9000' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.cleanup_warning).toBeUndefined();
    });

    // --- BUG-366: session fallback + definitive-failure cleanup + safe errors ---

    function createIsolatedTokenState(initial) {
        let state = initial;
        return { get: () => state, set: (s) => { state = s; }, clear: () => { state = null; } };
    }

    test('BUG-366: no muse_token, no keys → reuses shared OIDC session for mint', async () => {
        const s3 = createPassingS3Mock();
        const httpMock = createMintingHttpMock();
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => s3,
            _tokenStateModule: createIsolatedTokenState({
                access_token: 'session-jwt',
                refresh_token: 'ref',
                expires_at: Date.now() + 600000,
            }),
            acquireToken: jest.fn(),
        });

        const result = await handler({ endpoint: 'http://localhost:9000' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        const mintCall = httpMock.post.mock.calls.find(([url]) => url.endsWith('/mc/user'));
        expect(mintCall[2].headers.keycloaktoken).toBe('session-jwt');
    });

    test('BUG-366: no session at all → starts browser sign-in via acquireToken', async () => {
        const s3 = createPassingS3Mock();
        const httpMock = createMintingHttpMock();
        const acquireMock = jest.fn().mockResolvedValue({
            access_token: 'fresh-jwt',
            refresh_token: 'ref',
            expires_at: Date.now() + 600000,
        });
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => s3,
            _tokenStateModule: createIsolatedTokenState(null),
            acquireToken: acquireMock,
        });

        const result = await handler({ endpoint: 'http://localhost:9000' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(acquireMock).toHaveBeenCalled();
        const mintCall = httpMock.post.mock.calls.find(([url]) => url.endsWith('/mc/user'));
        expect(mintCall[2].headers.keycloaktoken).toBe('fresh-jwt');
    });

    test('BUG-366: sign-in failure → failing_step SignIn with authored guidance, no cleanup', async () => {
        const httpMock = createMintingHttpMock();
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => { throw new Error('must not reach S3'); },
            _tokenStateModule: createIsolatedTokenState(null),
            acquireToken: jest.fn().mockRejectedValue(new Error('Token exchange failed (HTTP 400): {"error":"provider text"}')),
        });

        const result = await handler({ endpoint: 'http://localhost:9000' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.failing_step).toBe('SignIn');
        expect(parsed.error).toContain('Run get_host_tags first');
        expect(parsed.error).not.toContain('provider text');
        expect(parsed.cleanup_warning).toBeUndefined();
        expect(httpMock.del).not.toHaveBeenCalled();
    });

    test('BUG-366: definitive mint refusal (HTTP 401) → no cleanup attempt, no warning', async () => {
        const httpMock = createMintingHttpMock({ mint: { status: 401, data: { success: false, message: 'Unauthorized' } } });
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => { throw new Error('must not reach S3'); },
        });

        const result = await handler({ muse_token: 'bad-jwt', endpoint: 'http://localhost:9000' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.failing_step).toBe('MintUser');
        expect(parsed.cleanup_warning).toBeUndefined();
        expect(httpMock.del).not.toHaveBeenCalled();
    });

    test('BUG-366: mint network error (no response) → cleanup still attempted', async () => {
        const httpMock = createMintingHttpMock();
        httpMock.post.mockImplementation(async (url) => {
            if (url.endsWith('/mc/user')) throw new Error('socket hang up');
            return { status: 404, data: {} };
        });
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => { throw new Error('must not reach S3'); },
        });

        const result = await handler({ muse_token: 'jwt', endpoint: 'http://localhost:9000' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        const delUserCall = httpMock.del.mock.calls.find(([url]) => url.includes('/mc/user/'));
        expect(delUserCall).toBeDefined();
    });

    test('CR MR29: session fallback refused for a caller-selected relayer_ui_url', async () => {
        const httpMock = createMintingHttpMock();
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => { throw new Error('must not reach S3'); },
            _tokenStateModule: (() => {
                let state = { access_token: 'session-jwt', refresh_token: 'r', expires_at: Date.now() + 600000 };
                return { get: () => state, set: (s) => { state = s; }, clear: () => { state = null; } };
            })(),
            acquireToken: jest.fn(),
        });

        const result = await handler({
            relayer_ui_url: 'http://192.168.1.50:8888',
            endpoint: 'http://localhost:9000',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.failing_step).toBe('init');
        expect(parsed.error).toContain('server-configured Relayer UI base');
        // The session token must never have left the process
        expect(httpMock.post).not.toHaveBeenCalled();
    });

    test('CR MR29: session fallback honors a server-configured relayerUiBase', async () => {
        const s3 = createPassingS3Mock();
        const httpMock = createMintingHttpMock();
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => s3,
            relayerUiBase: 'http://192.168.1.50:8888',
            _tokenStateModule: (() => {
                let state = { access_token: 'session-jwt', refresh_token: 'r', expires_at: Date.now() + 600000 };
                return { get: () => state, set: (s) => { state = s; }, clear: () => { state = null; } };
            })(),
            acquireToken: jest.fn(),
        });

        const result = await handler({
            relayer_ui_url: 'http://192.168.1.50:8888',
            endpoint: 'http://localhost:9000',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        const mintCall = httpMock.post.mock.calls.find(([url]) => url.includes('/mc/user'));
        expect(mintCall[0]).toContain('http://192.168.1.50:8888');
    });

    test('CR MR29: explicit muse_token still works against a custom (allowlisted) relayer_ui_url', async () => {
        const s3 = createPassingS3Mock();
        const httpMock = createMintingHttpMock();
        const handler = registerWithOptions({
            httpClient: httpMock,
            createS3Client: () => s3,
        });

        const result = await handler({
            muse_token: 'explicit-jwt',
            relayer_ui_url: 'http://192.168.1.50:8888',
            endpoint: 'http://localhost:9000',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
    });

    test('BUG-366: allowlist rejection message reaches the client (self-authored)', async () => {
        const handler = registerWithOptions({
            httpClient: createMintingHttpMock(),
            createS3Client: () => { throw new Error('must not reach S3'); },
        });

        const result = await handler({
            muse_token: 'jwt',
            relayer_ui_url: 'https://evil.example.com',
            endpoint: 'http://localhost:9000',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.failing_step).toBe('init');
        expect(parsed.error).toContain('not a loopback');
    });
});
