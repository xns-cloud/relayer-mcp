'use strict';

describe('register_account', () => {
    let server;

    beforeEach(() => {
        server = { tool: jest.fn() };
    });

    function registerWithHttp(httpMock) {
        const register = require('../tools/registerAccount');
        register(server, { httpClient: httpMock });
        return server.tool.mock.calls[0][3]; // handler
    }

    // TP-9: 201 → success message naming email
    test('201 → success with email and userId', async () => {
        const handler = registerWithHttp({
            post: jest.fn().mockResolvedValue({
                status: 201,
                data: { success: true, userId: 'u-123', message: 'Verification email sent' },
            }),
            get: jest.fn(),
        });

        const result = await handler({ email: 'test@example.com', password: 'Abc12345' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.email).toBe('test@example.com');
        expect(parsed.userId).toBe('u-123');
        expect(parsed.message).toContain('test@example.com');
        expect(parsed.message).toContain('auth.xns.tech');
    });

    // TP-10: 409 → next_action skip hint (AC-6)
    test('409 → already registered + next_action skip hint', async () => {
        const handler = registerWithHttp({
            post: jest.fn().mockResolvedValue({
                status: 409,
                data: { success: false, message: 'Email already registered' },
            }),
            get: jest.fn(),
        });

        const result = await handler({ email: 'existing@example.com', password: 'Abc12345' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.next_action).toBe('skip_to_install');
        expect(parsed.message).toContain('already has an account');
    });

    // TP-11: 422 → names specific validation error (AC-7)
    test('422 → validation error with specific message', async () => {
        const handler = registerWithHttp({
            post: jest.fn().mockResolvedValue({
                status: 422,
                data: { success: false, message: 'Password must contain at least one uppercase letter' },
            }),
            get: jest.fn(),
        });

        const result = await handler({ email: 'test@example.com', password: 'short' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.message).toContain('uppercase');
        expect(result.isError).toBe(true);
    });

    // TP-3: 429 → rate limited
    test('429 → rate limited message', async () => {
        const handler = registerWithHttp({
            post: jest.fn().mockResolvedValue({
                status: 429,
                data: { success: false, message: 'Too many requests' },
            }),
            get: jest.fn(),
        });

        const result = await handler({ email: 'test@example.com', password: 'Abc12345' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(result.isError).toBe(true);
    });

    // TP-12: tool description mentions email + auth.xns.tech (AC-8)
    test('tool description mentions verification and auth.xns.tech', () => {
        const register = require('../tools/registerAccount');
        register(server);
        const description = server.tool.mock.calls[0][1];

        expect(description).toContain('auth.xns.tech');
        expect(description).toContain('verify');
    });

    // Network error handling
    test('network error → error result', async () => {
        const handler = registerWithHttp({
            post: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
            get: jest.fn(),
        });

        const result = await handler({ email: 'test@example.com', password: 'Abc12345' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.error).toContain('ECONNREFUSED');
        expect(result.isError).toBe(true);
    });
});
