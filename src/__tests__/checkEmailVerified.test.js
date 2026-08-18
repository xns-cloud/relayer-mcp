'use strict';

describe('check_email_verified', () => {
    let server;

    beforeEach(() => {
        server = { registerTool: jest.fn() };
    });

    function registerWithOptions(opts) {
        const { readRegistration } = require('./helpers/mockRegistration');
        const register = require('../tools/checkEmailVerified');
        register(server, {
            pollIntervalMs: 10,
            pollTimeoutMs: 100,
            sleep: jest.fn().mockResolvedValue(undefined),
            ...opts,
        });
        return readRegistration(server).handler;
    }

    // TP-13: verified:true → auto-proceed (AC-9)
    test('verified:true → immediate success', async () => {
        const handler = registerWithOptions({
            httpClient: {
                get: jest.fn().mockResolvedValue({
                    status: 200,
                    data: { verified: true },
                }),
                post: jest.fn(),
            },
        });

        const result = await handler({ email: 'test@example.com', poll: true });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.verified).toBe(true);
        expect(parsed.message).toContain('verified');
    });

    // TP-14: three-state — verified:false, exists:true → keep polling (AC-10)
    test('verified:false, exists:true → polls then resolves on verified', async () => {
        let callCount = 0;
        const handler = registerWithOptions({
            httpClient: {
                get: jest.fn().mockImplementation(async () => {
                    callCount++;
                    if (callCount >= 3) {
                        return { status: 200, data: { verified: true } };
                    }
                    return { status: 200, data: { verified: false, exists: true } };
                }),
                post: jest.fn(),
            },
        });

        const result = await handler({ email: 'test@example.com', poll: true });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.verified).toBe(true);
    });

    // TP-15: three-state — verified:false, exists:false → no account (AC-10)
    test('verified:false, exists:false → needs registration', async () => {
        const handler = registerWithOptions({
            httpClient: {
                get: jest.fn().mockResolvedValue({
                    status: 200,
                    data: { verified: false, exists: false },
                }),
                post: jest.fn(),
            },
        });

        const result = await handler({ email: 'test@example.com', poll: true });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.verified).toBe(false);
        expect(parsed.exists).toBe(false);
        expect(parsed.message).toContain('start_registration');
    });

    // TP-16: 404 → no account
    test('404 → no account found', async () => {
        const handler = registerWithOptions({
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 404, data: {} }),
                post: jest.fn(),
            },
        });

        const result = await handler({ email: 'test@example.com', poll: true });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.exists).toBe(false);
    });

    // TP-17: timeout → resend (AC-11)
    test('timeout → sends resend and reports expiry', async () => {
        const getMock = jest.fn().mockResolvedValue({
            status: 200,
            data: { verified: false, exists: true },
        });

        const handler = registerWithOptions({
            pollTimeoutMs: 50,
            pollIntervalMs: 10,
            httpClient: {
                get: getMock,
                post: jest.fn(),
            },
        });

        const result = await handler({ email: 'test@example.com', poll: true });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.resent).toBe(true);
        expect(parsed.message).toContain('timed out');
        // Verify resend was called
        const resendCalls = getMock.mock.calls.filter((c) =>
            c[0].includes('resend=true'),
        );
        expect(resendCalls.length).toBeGreaterThanOrEqual(1);
    });

    // TP-18: 429 → rate limit
    test('429 → rate limited', async () => {
        const handler = registerWithOptions({
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 429, data: {} }),
                post: jest.fn(),
            },
        });

        const result = await handler({ email: 'test@example.com', poll: true });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.rate_limited).toBe(true);
    });

    // Single check mode (poll=false)
    test('poll=false → single check only', async () => {
        const getMock = jest.fn().mockResolvedValue({
            status: 200,
            data: { verified: false, exists: true },
        });

        const handler = registerWithOptions({
            httpClient: { get: getMock, post: jest.fn() },
        });

        const result = await handler({ email: 'test@example.com', poll: false });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.verified).toBe(false);
        expect(parsed.exists).toBe(true);
        expect(getMock).toHaveBeenCalledTimes(1);
    });
});
