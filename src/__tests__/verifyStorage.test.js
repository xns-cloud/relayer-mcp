'use strict';

describe('verify_storage', () => {
    let server;

    beforeEach(() => {
        server = { tool: jest.fn() };
    });

    function registerWithOptions(opts) {
        const register = require('../tools/verifyStorage');
        register(server, opts);
        return server.tool.mock.calls[0][3];
    }

    // TP-27: AC-20 — targets localhost:9000 plain HTTP, reports endpoint
    test('success → reports endpoint and test bucket', async () => {
        const handler = registerWithOptions({
            createS3Client: () => ({
                createBucket: jest.fn().mockResolvedValue(undefined),
                putObject: jest.fn().mockResolvedValue(undefined),
                getObject: jest.fn().mockImplementation(async () => {
                    // Return matching content
                    return expect.any(String);
                }),
            }),
        });

        // Need to match the test content — use a custom s3 mock
        const register = require('../tools/verifyStorage');
        server.tool.mockReset();

        let capturedContent;
        register(server, {
            createS3Client: () => ({
                createBucket: jest.fn().mockResolvedValue(undefined),
                putObject: jest.fn().mockImplementation(async (bucket, key, body) => {
                    capturedContent = body;
                }),
                getObject: jest.fn().mockImplementation(async () => capturedContent),
            }),
        });

        const handler2 = server.tool.mock.calls[0][3];
        const result = await handler2({
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
});
