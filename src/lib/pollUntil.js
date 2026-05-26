'use strict';

/**
 * Poll a check function at a fixed interval until it resolves truthy
 * or the timeout elapses.
 *
 * @param {object} opts
 * @param {function(): Promise<*>} opts.fn - Async check function. Return truthy to stop.
 * @param {number} opts.intervalMs - Poll interval in ms
 * @param {number} opts.timeoutMs - Total timeout in ms
 * @param {function} [opts.sleep] - Injectable sleep (testing). Default: real setTimeout.
 * @returns {Promise<{result: *, timedOut: boolean}>}
 */
async function pollUntil({ fn, intervalMs, timeoutMs, sleep }) {
    const _sleep = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const result = await fn();
        if (result) {
            return { result, timedOut: false };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await _sleep(Math.min(intervalMs, remaining));
    }

    return { result: null, timedOut: true };
}

module.exports = { pollUntil };
