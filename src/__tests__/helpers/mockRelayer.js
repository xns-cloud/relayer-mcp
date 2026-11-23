'use strict';

/**
 * An httpClient that answers the Relayer UI's /api/v1/mc routes by method and path, as a
 * Relayer does when setup_cli_credentials succeeds. `routes` replaces an answer, or adds
 * one: a value, or a function of the request body. Every request is kept in `calls`.
 */
function mockRelayer({ keys = { access_key: 'AK', secret_key: 'SK' }, routes = {} } = {}) {
    const calls = [];
    const answers = {
        'POST /user': { status: 200, data: keys },
        'POST /policy-create': { status: 200, data: { success: true } },
        'POST /policy': { status: 200, data: { status: 'attached' } },
        'DELETE /user/xns-cli': { status: 200, data: { status: 'deleted' } },
        ...routes,
    };
    const request = async (method, url, body, config) => {
        const route = `${method} ${url.split('/api/v1/mc')[1]}`;
        calls.push({ route, url, body, config });
        // The Relayer UI answers an engine refusal as HTTP 200 with success false.
        const answer = answers[route] ?? { status: 200, data: { success: false, message: 'policy not found' } };
        return typeof answer === 'function' ? answer(body) : answer;
    };
    return {
        calls,
        routes: () => calls.map((c) => c.route),
        httpClient: {
            get: (url, config) => request('GET', url, undefined, config),
            post: (url, body, config) => request('POST', url, body, config),
            del: (url, config) => request('DELETE', url, undefined, config),
        },
    };
}

module.exports = { mockRelayer };
