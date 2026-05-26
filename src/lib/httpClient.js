'use strict';

const axios = require('axios');

/**
 * Thin HTTP client wrapper around axios with sensible defaults.
 * All tool modules use this instead of raw axios for consistent
 * timeout, JSON handling, and error shapes.
 *
 * @param {object} [options]
 * @param {object} [options.axios] - Injected axios instance (testing)
 * @param {number} [options.timeout] - Default timeout in ms (default: 15000)
 */
function createHttpClient(options = {}) {
    const instance = options.axios || axios.create({
        timeout: options.timeout ?? 15000,
        headers: { 'Content-Type': 'application/json' },
        validateStatus: () => true, // let callers inspect status
    });

    return {
        /**
         * @param {string} url
         * @param {object} [config]
         * @returns {Promise<{status: number, data: *}>}
         */
        async get(url, config = {}) {
            const resp = await instance.get(url, config);
            return { status: resp.status, data: resp.data };
        },

        /**
         * @param {string} url
         * @param {*} body
         * @param {object} [config]
         * @returns {Promise<{status: number, data: *}>}
         */
        async post(url, body, config = {}) {
            const resp = await instance.post(url, body, config);
            return { status: resp.status, data: resp.data };
        },
    };
}

module.exports = { createHttpClient };
