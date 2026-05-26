'use strict';

const { pollUntil } = require('../lib/pollUntil');

describe('pollUntil', () => {
    test('resolves immediately when fn returns truthy on first call', async () => {
        const fn = jest.fn().mockResolvedValue({ done: true });
        const { result, timedOut } = await pollUntil({
            fn,
            intervalMs: 100,
            timeoutMs: 5000,
            sleep: jest.fn(),
        });
        expect(timedOut).toBe(false);
        expect(result).toEqual({ done: true });
        expect(fn).toHaveBeenCalledTimes(1);
    });

    test('polls until fn returns truthy', async () => {
        let callCount = 0;
        const fn = jest.fn().mockImplementation(async () => {
            callCount++;
            return callCount >= 3 ? { success: true } : null;
        });
        const sleep = jest.fn().mockResolvedValue(undefined);

        const { result, timedOut } = await pollUntil({
            fn,
            intervalMs: 100,
            timeoutMs: 5000,
            sleep,
        });

        expect(timedOut).toBe(false);
        expect(result).toEqual({ success: true });
        expect(fn).toHaveBeenCalledTimes(3);
        expect(sleep).toHaveBeenCalledTimes(2);
    });

    test('times out when fn never returns truthy', async () => {
        const fn = jest.fn().mockResolvedValue(null);
        // Simulate time passing by advancing Date.now
        let now = 1000;
        const originalNow = Date.now;
        Date.now = jest.fn(() => {
            now += 200; // each call advances 200ms
            return now;
        });

        const sleep = jest.fn().mockResolvedValue(undefined);

        const { result, timedOut } = await pollUntil({
            fn,
            intervalMs: 100,
            timeoutMs: 500,
            sleep,
        });

        expect(timedOut).toBe(true);
        expect(result).toBeNull();

        Date.now = originalNow;
    });

    test('sleep receives min of intervalMs and remaining time', async () => {
        let callCount = 0;
        const fn = jest.fn().mockImplementation(async () => {
            callCount++;
            return callCount >= 2 ? 'done' : null;
        });
        const sleepCalls = [];
        const sleep = jest.fn().mockImplementation(async (ms) => {
            sleepCalls.push(ms);
        });

        await pollUntil({
            fn,
            intervalMs: 100,
            timeoutMs: 5000,
            sleep,
        });

        expect(sleepCalls[0]).toBeLessThanOrEqual(100);
    });
});
