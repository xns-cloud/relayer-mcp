'use strict';

/**
 * CROSS-BOUNDARY CONTRACT — relayer-ui's HostIO proxy (server/api/v1/Proxy.js)
 * wraps ANY upstream failure (HOSTIO down, 404 route, 4xx/5xx) as HTTP 200
 * with body `{ success: false, state: '<axios error message>' }`. A caller that
 * only checks the HTTP status reads those failures as success — that is exactly
 * how relayer-mcp <=0.5.2 returned proxy error objects as "tags".
 *
 * @param {*} data - response body from a /api/v1/proxy/hostio/* call
 * @returns {string|null} the failure message, or null if not a proxy failure
 */
function proxyFailure(data) {
    if (data && typeof data === 'object' && data.success === false && typeof data.state === 'string') {
        return data.state;
    }
    return null;
}

module.exports = { proxyFailure };
