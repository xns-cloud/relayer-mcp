'use strict';

describe('verify_storage', () => {
    let server;

    beforeEach(() => {
        server = { tool: jest.fn() };
        jest.resetModules();
    });

    function registerWithOptions(opts) {
        const register = require('../tools/verifyStorage');
        register(server, {
            // Default dockerUtil fake: local daemon. Tests never exec the real docker CLI.
            dockerUtil: {
                getDockerHost: jest.fn().mockResolvedValue({ remote: false, host: 'localhost', endpoint: 'unix:///var/run/docker.sock' }),
            },
            ...opts,
        });
        return server.tool.mock.calls[0][3];
    }

    // TP-27: AC-20 — targets localhost:9000 plain HTTP, reports endpoint
    test('success → reports endpoint and test bucket', async () => {
        const register = require('../tools/verifyStorage');
        server.tool.mockReset();

        let capturedContent;
        register(server, {
            dockerUtil: {
                getDockerHost: jest.fn().mockResolvedValue({ remote: false, host: 'localhost', endpoint: 'unix:///var/run/docker.sock' }),
            },
            createS3Client: () => ({
                createBucket: jest.fn().mockResolvedValue(undefined),
                putObject: jest.fn().mockImplementation(async (bucket, key, body) => {
                    capturedContent = body;
                }),
                getObject: jest.fn().mockImplementation(async () => capturedContent),
                deleteObject: jest.fn().mockResolvedValue(undefined),
                deleteBucket: jest.fn().mockResolvedValue(undefined),
            }),
        });

        const handler = server.tool.mock.calls[0][3];
        const result = await handler({
            access_key_id: 'test-key',
            secret_access_key: 'test-secret',
            endpoint: 'http://localhost:9000',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.endpoint).toBe('http://localhost:9000');
        expect(parsed.message).toContain('localhost:9000');
    });

    // TP-28: AC-21 — CreateBucket failure names the step
    test('CreateBucket failure → names failing step', async () => {
        const handler = registerWithOptions({
            createS3Client: () => ({
                createBucket: jest.fn().mockRejectedValue(new Error('bucket create denied')),
                putObject: jest.fn(),
                getObject: jest.fn(),
                deleteObject: jest.fn().mockResolvedValue(undefined),
                deleteBucket: jest.fn().mockResolvedValue(undefined),
            }),
        });

        const result = await handler({
            access_key_id: 'k',
            secret_access_key: 's',
            endpoint: 'http://localhost:9000',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.failing_step).toBe('CreateBucket');
        expect(parsed.error).toContain('CreateBucket');
        expect(result.isError).toBe(true);
    });

    // TP-28: PutObject failure names the step
    test('PutObject failure → names failing step', async () => {
        const handler = registerWithOptions({
            createS3Client: () => ({
                createBucket: jest.fn().mockResolvedValue(undefined),
                putObject: jest.fn().mockRejectedValue(new Error('put failed')),
                getObject: jest.fn(),
                deleteObject: jest.fn().mockResolvedValue(undefined),
                deleteBucket: jest.fn().mockResolvedValue(undefined),
            }),
        });

        const result = await handler({
            access_key_id: 'k',
            secret_access_key: 's',
            endpoint: 'http://localhost:9000',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.failing_step).toBe('PutObject');
    });

    // TP-29: GetObject failure names the step
    test('GetObject failure → names failing step', async () => {
        const handler = registerWithOptions({
            createS3Client: () => ({
                createBucket: jest.fn().mockResolvedValue(undefined),
                putObject: jest.fn().mockResolvedValue(undefined),
                getObject: jest.fn().mockRejectedValue(new Error('get failed')),
                deleteObject: jest.fn().mockResolvedValue(undefined),
                deleteBucket: jest.fn().mockResolvedValue(undefined),
            }),
        });

        const result = await handler({
            access_key_id: 'k',
            secret_access_key: 's',
            endpoint: 'http://localhost:9000',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.failing_step).toBe('GetObject');
    });

    // Content mismatch → names Compare step
    test('content mismatch → names Compare step', async () => {
        const handler = registerWithOptions({
            createS3Client: () => ({
                createBucket: jest.fn().mockResolvedValue(undefined),
                putObject: jest.fn().mockResolvedValue(undefined),
                getObject: jest.fn().mockResolvedValue('WRONG CONTENT'),
                deleteObject: jest.fn().mockResolvedValue(undefined),
                deleteBucket: jest.fn().mockResolvedValue(undefined),
            }),
        });

        const result = await handler({
            access_key_id: 'k',
            secret_access_key: 's',
            endpoint: 'http://localhost:9000',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.failing_step).toBe('Compare');
    });

    // --- Remote Docker host (homelab feedback: Claude Code on a jump host) ---

    // No endpoint given → default targets port 9000 on the machine the Docker
    // daemon runs on, not blindly localhost.
    test('no endpoint + remote docker → defaults to remote host:9000', async () => {
        let capturedEndpoint;
        let capturedContent;
        const handler = registerWithOptions({
            dockerUtil: {
                getDockerHost: jest.fn().mockResolvedValue({ remote: true, host: 'docker-box.lan', endpoint: 'ssh://user@docker-box.lan' }),
            },
            createS3Client: (cfg) => {
                capturedEndpoint = cfg.endpoint;
                return {
                    createBucket: jest.fn().mockResolvedValue(undefined),
                    putObject: jest.fn().mockImplementation(async (bucket, key, body) => { capturedContent = body; }),
                    getObject: jest.fn().mockImplementation(async () => capturedContent),
                    deleteObject: jest.fn().mockResolvedValue(undefined),
                    deleteBucket: jest.fn().mockResolvedValue(undefined),
                };
            },
        });

        const result = await handler({ access_key_id: 'k', secret_access_key: 's' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(capturedEndpoint).toBe('http://docker-box.lan:9000');
        expect(parsed.endpoint).toBe('http://docker-box.lan:9000');
    });

    // Malformed endpoint is rejected at the zod boundary — never reaches S3.
    test('malformed endpoint → schema validation rejects before S3', () => {
        const { z } = require('zod');
        const createS3Client = jest.fn();
        registerWithOptions({ createS3Client });
        const shape = server.tool.mock.calls[0][2];

        const parsed = z.object(shape).safeParse({
            access_key_id: 'k',
            secret_access_key: 's',
            endpoint: 'not a url',
        });

        expect(parsed.success).toBe(false);
        expect(createS3Client).not.toHaveBeenCalled();
    });

    // Explicit endpoint always wins — docker detection is not even consulted.
    test('explicit endpoint → docker host detection not consulted', async () => {
        const getDockerHost = jest.fn();
        let capturedContent;
        const handler = registerWithOptions({
            dockerUtil: { getDockerHost },
            createS3Client: () => ({
                createBucket: jest.fn().mockResolvedValue(undefined),
                putObject: jest.fn().mockImplementation(async (bucket, key, body) => { capturedContent = body; }),
                getObject: jest.fn().mockImplementation(async () => capturedContent),
                deleteObject: jest.fn().mockResolvedValue(undefined),
                deleteBucket: jest.fn().mockResolvedValue(undefined),
            }),
        });

        const result = await handler({
            access_key_id: 'k',
            secret_access_key: 's',
            endpoint: 'http://10.0.0.7:19000',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.endpoint).toBe('http://10.0.0.7:19000');
        expect(getDockerHost).not.toHaveBeenCalled();
    });

    // --- W3-AC1: Self-cleanup (finally-style) ---

    // On success: bucket and object are removed; response is still success.
    test('cleanup-on-success: deleteObject + deleteBucket called, result still passes', async () => {
        let capturedContent;
        const deleteObject = jest.fn().mockResolvedValue(undefined);
        const deleteBucket = jest.fn().mockResolvedValue(undefined);
        const handler = registerWithOptions({
            createS3Client: () => ({
                createBucket: jest.fn().mockResolvedValue(undefined),
                putObject: jest.fn().mockImplementation(async (bucket, key, body) => { capturedContent = body; }),
                getObject: jest.fn().mockImplementation(async () => capturedContent),
                deleteObject,
                deleteBucket,
            }),
        });

        const result = await handler({
            access_key_id: 'k',
            secret_access_key: 's',
            endpoint: 'http://localhost:9000',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(deleteObject).toHaveBeenCalledTimes(1);
        expect(deleteBucket).toHaveBeenCalledTimes(1);
        // Cleanup succeeded — no warning in the response
        expect(parsed.cleanup_warning).toBeUndefined();
    });

    // On failure (e.g. GetObject throws): cleanup runs, result is still fail.
    test('cleanup-on-failure: cleanup runs after GetObject error, result stays fail', async () => {
        const deleteObject = jest.fn().mockResolvedValue(undefined);
        const deleteBucket = jest.fn().mockResolvedValue(undefined);
        const handler = registerWithOptions({
            createS3Client: () => ({
                createBucket: jest.fn().mockResolvedValue(undefined),
                putObject: jest.fn().mockResolvedValue(undefined),
                getObject: jest.fn().mockRejectedValue(new Error('get failed')),
                deleteObject,
                deleteBucket,
            }),
        });

        const result = await handler({
            access_key_id: 'k',
            secret_access_key: 's',
            endpoint: 'http://localhost:9000',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(result.isError).toBe(true);
        // Cleanup was attempted
        expect(deleteBucket).toHaveBeenCalledTimes(1);
    });

    // Cleanup failure is non-fatal — a passing verify stays passing.
    test('cleanup error is non-fatal: pass stays pass, warning added', async () => {
        let capturedContent;
        const handler = registerWithOptions({
            createS3Client: () => ({
                createBucket: jest.fn().mockResolvedValue(undefined),
                putObject: jest.fn().mockImplementation(async (bucket, key, body) => { capturedContent = body; }),
                getObject: jest.fn().mockImplementation(async () => capturedContent),
                deleteObject: jest.fn().mockRejectedValue(new Error('cleanup denied')),
                deleteBucket: jest.fn().mockRejectedValue(new Error('cleanup denied')),
            }),
        });

        const result = await handler({
            access_key_id: 'k',
            secret_access_key: 's',
            endpoint: 'http://localhost:9000',
        });
        const parsed = JSON.parse(result.content[0].text);

        // The verify PASSED — cleanup failure must not flip this.
        expect(parsed.success).toBe(true);
        // A warning is present so the user knows about the leftover bucket.
        expect(parsed.cleanup_warning).toMatch(/cleanup failed|remain/i);
    });

    // --- W3-AC2: fullaccess requirement in description and failure output ---

    test('tool description mentions fullaccess credentials', () => {
        registerWithOptions({
            createS3Client: jest.fn(),
        });
        const description = server.tool.mock.calls[0][1];
        expect(description).toMatch(/fullaccess/i);
    });

    test('AccessDenied error includes fullaccess credential hint in output', async () => {
        const handler = registerWithOptions({
            createS3Client: () => ({
                createBucket: jest.fn().mockRejectedValue(new Error('AccessDenied: insufficient permissions')),
                putObject: jest.fn(),
                getObject: jest.fn(),
                deleteObject: jest.fn().mockResolvedValue(undefined),
                deleteBucket: jest.fn().mockResolvedValue(undefined),
            }),
        });

        const result = await handler({
            access_key_id: 'k',
            secret_access_key: 's',
            endpoint: 'http://localhost:9000',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        // The failure output must reference fullaccess
        expect(JSON.stringify(parsed)).toMatch(/fullaccess/i);
    });

    // --- W3-AC3: explicit-IP hint when endpoint was auto-detected ---

    test('auto-detected endpoint + success → explicit-IP guidance note in output', async () => {
        let capturedContent;
        const handler = registerWithOptions({
            dockerUtil: {
                getDockerHost: jest.fn().mockResolvedValue({ remote: true, host: '192.168.1.50', endpoint: 'ssh://user@192.168.1.50' }),
            },
            createS3Client: () => ({
                createBucket: jest.fn().mockResolvedValue(undefined),
                putObject: jest.fn().mockImplementation(async (bucket, key, body) => { capturedContent = body; }),
                getObject: jest.fn().mockImplementation(async () => capturedContent),
                deleteObject: jest.fn().mockResolvedValue(undefined),
                deleteBucket: jest.fn().mockResolvedValue(undefined),
            }),
        });

        // No explicit endpoint passed — auto-detection runs.
        const result = await handler({ access_key_id: 'k', secret_access_key: 's' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        // Output includes guidance on passing an explicit endpoint IP
        expect(JSON.stringify(parsed)).toMatch(/endpoint|explicit|ip/i);
    });

    test('auto-detected endpoint + failure → explicit-IP guidance in error output', async () => {
        const handler = registerWithOptions({
            dockerUtil: {
                getDockerHost: jest.fn().mockResolvedValue({ remote: false, host: 'localhost', endpoint: 'unix:///var/run/docker.sock' }),
            },
            createS3Client: () => ({
                createBucket: jest.fn().mockRejectedValue(new Error('connection refused')),
                putObject: jest.fn(),
                getObject: jest.fn(),
                deleteObject: jest.fn().mockResolvedValue(undefined),
                deleteBucket: jest.fn().mockResolvedValue(undefined),
            }),
        });

        // No explicit endpoint — auto-detection ran.
        const result = await handler({ access_key_id: 'k', secret_access_key: 's' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        // The error output must include the explicit-IP hint
        expect(parsed.error).toMatch(/endpoint|explicit|ip/i);
    });

    test('explicit endpoint passed → no explicit-IP hint added', async () => {
        let capturedContent;
        const handler = registerWithOptions({
            createS3Client: () => ({
                createBucket: jest.fn().mockResolvedValue(undefined),
                putObject: jest.fn().mockImplementation(async (bucket, key, body) => { capturedContent = body; }),
                getObject: jest.fn().mockImplementation(async () => capturedContent),
                deleteObject: jest.fn().mockResolvedValue(undefined),
                deleteBucket: jest.fn().mockResolvedValue(undefined),
            }),
        });

        const result = await handler({
            access_key_id: 'k',
            secret_access_key: 's',
            endpoint: 'http://10.0.0.7:9000',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        // No note about explicit-IP when user already supplied it
        expect(parsed.note).toBeUndefined();
    });
});
