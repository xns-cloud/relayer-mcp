'use strict';

describe('check_claim_status', () => {
    let server;

    beforeEach(() => {
        server = { registerTool: jest.fn() };
    });

    function registerWithOptions(opts) {
        const { readRegistration } = require('./helpers/mockRegistration');
        const register = require('../tools/checkClaimStatus');
        register(server, {
            pollIntervalMs: 10,
            sleep: jest.fn().mockResolvedValue(undefined),
            ...opts,
        });
        return readRegistration(server).handler;
    }

    // AC-15: STATE_3 → auto-proceed
    test('STATE_3 → success with installation_id', async () => {
        const handler = registerWithOptions({
            httpClient: {
                get: jest.fn().mockResolvedValue({
                    status: 200,
                    data: {
                        state: 'STATE_3',
                        detail: 'Claimed',
                        installation_id: 'inst-123',
                        claimed_at: '2026-05-26T12:00:00Z',
                    },
                }),
                post: jest.fn(),
            },
        });

        const result = await handler({ claim_id: 'claim-abc', timeout_ms: 5000 });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.state).toBe('STATE_3');
        expect(parsed.installation_id).toBe('inst-123');
    });

    // AC-15: polls through STATE_1 → STATE_2 → STATE_3
    test('polls through state transitions', async () => {
        const states = ['STATE_1', 'STATE_2', 'STATE_3'];
        let idx = 0;
        const handler = registerWithOptions({
            httpClient: {
                get: jest.fn().mockImplementation(async () => {
                    const state = states[Math.min(idx++, states.length - 1)];
                    return {
                        status: 200,
                        data: {
                            state,
                            detail: state,
                            installation_id: state === 'STATE_3' ? 'inst-123' : undefined,
                        },
                    };
                }),
                post: jest.fn(),
            },
        });

        const result = await handler({ claim_id: 'claim-abc', timeout_ms: 5000 });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.state).toBe('STATE_3');
    });

    // AC-15a: 402 → continue_polling:false
    test('402 → stop polling, payment required', async () => {
        const handler = registerWithOptions({
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 402, data: {} }),
                post: jest.fn(),
            },
        });

        const result = await handler({ claim_id: 'claim-abc', timeout_ms: 5000 });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.continue_polling).toBe(false);
        expect(parsed.message).toContain('payment method');
    });

    // AC-16: 404 → expired
    test('404 → session expired', async () => {
        const handler = registerWithOptions({
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 404, data: {} }),
                post: jest.fn(),
            },
        });

        const result = await handler({ claim_id: 'claim-abc', timeout_ms: 5000 });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.expired).toBe(true);
        expect(parsed.message).toContain('start_claim');
    });

    // R3-PREC-1: isError=true for non-402 errors (404, 5xx), undefined for 402 graceful stop
    test('404 → isError is true (not undefined)', async () => {
        const handler = registerWithOptions({
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 404, data: {} }),
                post: jest.fn(),
            },
        });

        const result = await handler({ claim_id: 'claim-abc', timeout_ms: 5000 });
        expect(result.isError).toBe(true);
    });

    test('5xx → isError is true', async () => {
        const handler = registerWithOptions({
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 500, data: { error: 'server error' } }),
                post: jest.fn(),
            },
        });

        const result = await handler({ claim_id: 'claim-abc', timeout_ms: 5000 });
        expect(result.isError).toBe(true);
    });

    test('402 → isError is undefined (graceful stop)', async () => {
        const handler = registerWithOptions({
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 402, data: {} }),
                post: jest.fn(),
            },
        });

        const result = await handler({ claim_id: 'claim-abc', timeout_ms: 5000 });
        expect(result.isError).toBeUndefined();
    });

    test('STATE_3 success → isError is undefined', async () => {
        const handler = registerWithOptions({
            httpClient: {
                get: jest.fn().mockResolvedValue({
                    status: 200,
                    data: { state: 'STATE_3', installation_id: 'inst-1' },
                }),
                post: jest.fn(),
            },
        });

        const result = await handler({ claim_id: 'claim-abc', timeout_ms: 5000 });
        expect(result.isError).toBeUndefined();
    });

    // AC-16: timeout → expired + suggest new claim
    test('timeout → session expired message', async () => {
        const handler = registerWithOptions({
            httpClient: {
                get: jest.fn().mockResolvedValue({
                    status: 200,
                    data: { state: 'STATE_1', detail: 'Pending' },
                }),
                post: jest.fn(),
            },
        });

        const result = await handler({ claim_id: 'claim-abc', timeout_ms: 50 });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.expired).toBe(true);
        expect(parsed.message).toContain('start_claim');
    });
});
