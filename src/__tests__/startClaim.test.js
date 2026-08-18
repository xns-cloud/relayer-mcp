'use strict';

describe('start_claim', () => {
    let server;

    beforeEach(() => {
        server = { registerTool: jest.fn() };
    });

    function registerWithHttp(httpMock) {
        const { readRegistration } = require('./helpers/mockRegistration');
        const register = require('../tools/startClaim');
        register(server, { httpClient: httpMock });
        return readRegistration(server).handler;
    }

    // AC-14: success → claim_url + expires_at
    test('success → returns claim_url and expires_at', async () => {
        const handler = registerWithHttp({
            post: jest.fn().mockResolvedValue({
                status: 200,
                data: {
                    claim_id: 'claim-abc',
                    claim_url: 'https://console.xns.tech/claim/abc',
                    expires_at: '2026-05-26T12:00:00Z',
                },
            }),
            get: jest.fn(),
        });

        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.claim_id).toBe('claim-abc');
        expect(parsed.claim_url).toContain('claim/abc');
        expect(parsed.expires_at).toBe('2026-05-26T12:00:00Z');
        expect(parsed.message).toContain('expires');
    });

    // AC-15a: 402 → continue_polling:false, specific message
    test('402 → continue_polling:false + payment message', async () => {
        const handler = registerWithHttp({
            post: jest.fn().mockResolvedValue({
                status: 402,
                data: { success: false, message: 'Payment required' },
            }),
            get: jest.fn(),
        });

        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.continue_polling).toBe(false);
        expect(parsed.message).toContain('payment method');
    });

    // 502 → upstream error
    test('502 → upstream error message', async () => {
        const handler = registerWithHttp({
            post: jest.fn().mockResolvedValue({
                status: 502,
                data: { success: false, error: 'Failed to initiate claim' },
            }),
            get: jest.fn(),
        });

        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(result.isError).toBe(true);
    });

    // Network error
    test('network error → error result', async () => {
        const handler = registerWithHttp({
            post: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
            get: jest.fn(),
        });

        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(result.isError).toBe(true);
    });
});
