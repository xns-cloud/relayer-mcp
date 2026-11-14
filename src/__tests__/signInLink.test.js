'use strict';

const { createTokenManager } = require('../lib/ensureToken');
const { acquireToken } = require('../lib/oidcAuth');
const registerManageBackups = require('../tools/manageBackups');
const registerVerifyStorage = require('../tools/verifyStorage');
const registerSetupCliCredentials = require('../tools/setupCliCredentials');

function memoryTokenState() {
    let state = null;
    return { get: () => state, set: (s) => { state = s; }, clear: () => { state = null; } };
}

// A loopback listener whose callback the test fires by hand.
function fakeListener() {
    const created = [];
    const createServer = jest.fn((handler) => {
        const srv = {
            listen: (port, host, cb) => { cb(); },
            address: () => ({ port: 12345 }),
            close: jest.fn(),
        };
        created.push({ srv, handler });
        return srv;
    });
    return { created, createServer };
}

function callbackFor(authorizeUrl, handler) {
    const state = new URL(authorizeUrl).searchParams.get('state');
    handler({ url: `/callback?code=the-code&state=${state}` }, { writeHead: jest.fn(), end: jest.fn() });
}

const httpClient = {
    post: jest.fn().mockResolvedValue({
        status: 200,
        data: { access_token: 'signed-in-token', refresh_token: 'r', expires_in: 300 },
    }),
    get: jest.fn(),
};

// The callback exchanges the code over an async call; wait until the token lands.
async function waitForToken(tokenMgr) {
    while (!tokenMgr.getTokenState()) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

function managerWithFailingBrowser(listener, openedUrls) {
    return createTokenManager({
        acquireToken,
        _tokenStateModule: memoryTokenState(),
        oidcOptions: {
            createServer: listener.createServer,
            httpClient,
            openBrowser: async (url) => { openedUrls.push(url); throw new Error('spawn xdg-open ENOENT'); },
        },
    });
}

// Short sign-in timeout, driven by fake timers so no test depends on real time.
const SIGNIN_TIMEOUT_MS = 20;

describe('sign-in when the browser cannot be opened', () => {
    beforeEach(() => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('first call rejects with the link and the port to forward; a call joining while pending gets the link at once; one listener', async () => {
        const listener = fakeListener();
        const openedUrls = [];
        const tokenMgr = managerWithFailingBrowser(listener, openedUrls);

        const first = await tokenMgr.ensureToken().then(() => null, (err) => err);

        expect(first).toBeInstanceOf(Error);
        expect(first.code).toBe('SIGNIN_LINK');
        expect(first.message).toContain(openedUrls[0]);
        expect(first.message).toContain('/protocol/openid-connect/auth?');
        const port = new URL(new URL(openedUrls[0]).searchParams.get('redirect_uri')).port;
        expect(port).not.toBe('');
        expect(first.message).toContain(`ssh -L ${port}:127.0.0.1:${port}`);
        expect(first.message).toContain('on this machine');

        // Still waiting for the person: a second call must not block.
        const joined = await tokenMgr.ensureToken().then(() => null, (err) => err);
        expect(joined.code).toBe('SIGNIN_LINK');
        expect(joined.message).toBe(first.message);
        expect(listener.createServer).toHaveBeenCalledTimes(1);
    });

    test('a call made after the person finished signing in gets the token', async () => {
        const listener = fakeListener();
        const openedUrls = [];
        const tokenMgr = managerWithFailingBrowser(listener, openedUrls);

        await tokenMgr.ensureToken().catch(() => {});
        callbackFor(openedUrls[0], listener.created[0].handler);
        await waitForToken(tokenMgr);

        await expect(tokenMgr.ensureToken()).resolves.toBe('signed-in-token');
        expect(listener.createServer).toHaveBeenCalledTimes(1);
    });

    test('a different token manager on the same state joins the pending sign-in and gets the link at once', async () => {
        const listener = fakeListener();
        const openedUrls = [];
        const stateModule = memoryTokenState();
        const make = () => createTokenManager({
            acquireToken,
            _tokenStateModule: stateModule,
            oidcOptions: {
                createServer: listener.createServer,
                httpClient,
                openBrowser: async (url) => { openedUrls.push(url); throw new Error('no browser'); },
            },
        });

        await make().ensureToken().catch(() => {});
        const joined = await make().ensureToken().then(() => null, (err) => err);

        expect(joined.code).toBe('SIGNIN_LINK');
        expect(joined.authorizeUrl).toBe(openedUrls[0]);
        expect(listener.createServer).toHaveBeenCalledTimes(1);

        const other = make();
        callbackFor(openedUrls[0], listener.created[0].handler);
        await waitForToken(other);
        await expect(other.ensureToken()).resolves.toBe('signed-in-token');
    });

    test('after the pending sign-in times out, the next call starts a fresh one', async () => {
        const listener = fakeListener();
        const openedUrls = [];
        const tokenMgr = createTokenManager({
            acquireToken,
            _tokenStateModule: memoryTokenState(),
            oidcOptions: {
                timeoutMs: SIGNIN_TIMEOUT_MS,
                createServer: listener.createServer,
                httpClient,
                openBrowser: async (url) => { openedUrls.push(url); throw new Error('no browser'); },
            },
        });

        await tokenMgr.ensureToken().catch(() => {});
        await jest.advanceTimersByTimeAsync(SIGNIN_TIMEOUT_MS * 5);
        const next = await tokenMgr.ensureToken().then(() => null, (err) => err);

        expect(listener.createServer).toHaveBeenCalledTimes(2);
        expect(next.code).toBe('SIGNIN_LINK');
    });

    test('a sign-in that timed out is reported once in the next link message', async () => {
        const listener = fakeListener();
        const openedUrls = [];
        const tokenMgr = createTokenManager({
            acquireToken,
            _tokenStateModule: memoryTokenState(),
            oidcOptions: {
                timeoutMs: SIGNIN_TIMEOUT_MS,
                createServer: listener.createServer,
                httpClient,
                openBrowser: async (url) => { openedUrls.push(url); throw new Error('no browser'); },
            },
        });

        const first = await tokenMgr.ensureToken().then(() => null, (err) => err);
        expect(first.message).not.toContain('did not finish');
        await jest.advanceTimersByTimeAsync(SIGNIN_TIMEOUT_MS * 5);

        const next = await tokenMgr.ensureToken().then(() => null, (err) => err);
        expect(next.code).toBe('SIGNIN_LINK');
        expect(next.message).toMatch(/^The last sign-in did not finish: it timed out before the browser came back\. Open this link/);
        expect(next.message).toContain(openedUrls[1]);

        // Reported once: a call joining the same pending sign-in does not repeat it.
        const joined = await tokenMgr.ensureToken().then(() => null, (err) => err);
        expect(joined.message).not.toContain('did not finish');
        await jest.advanceTimersByTimeAsync(SIGNIN_TIMEOUT_MS * 5);
    });

    test('a failed token exchange after the link was handed out is reported in the next link message', async () => {
        const listener = fakeListener();
        const openedUrls = [];
        const failingHttp = { post: jest.fn().mockResolvedValue({ status: 400, data: { error: 'invalid_grant' } }), get: jest.fn() };
        const tokenMgr = createTokenManager({
            acquireToken,
            _tokenStateModule: memoryTokenState(),
            oidcOptions: {
                createServer: listener.createServer,
                httpClient: failingHttp,
                openBrowser: async (url) => { openedUrls.push(url); throw new Error('no browser'); },
            },
        });

        await tokenMgr.ensureToken().catch(() => {});
        callbackFor(openedUrls[0], listener.created[0].handler);
        while (failingHttp.post.mock.calls.length === 0) {
            await new Promise((resolve) => setImmediate(resolve));
        }
        await new Promise((resolve) => setImmediate(resolve));

        const next = await tokenMgr.ensureToken().then(() => null, (err) => err);
        expect(next.code).toBe('SIGNIN_LINK');
        expect(next.message).toContain('The last sign-in did not finish: the token exchange failed (HTTP 400). Open this link');
        // The provider's response body stays in the server log.
        expect(next.message).not.toContain('invalid_grant');
        expect(listener.createServer).toHaveBeenCalledTimes(2);
    });

    test('an unrecognized sign-in failure is reported with a fixed sentence, not its own text', async () => {
        const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
        const link = 'https://auth.example/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A12345%2Fcallback';
        let fail;
        let calls = 0;
        const fakeAcquire = jest.fn(({ onBrowserOpenFailed }) => new Promise((resolve, reject) => {
            calls += 1;
            onBrowserOpenFailed(link);
            if (calls === 1) fail = reject;
        }));
        const tokenMgr = createTokenManager({ acquireToken: fakeAcquire, _tokenStateModule: memoryTokenState() });

        await tokenMgr.ensureToken().catch(() => {});
        fail(new Error('connect ECONNREFUSED /internal/path secret-field=abc'));
        await new Promise((resolve) => setImmediate(resolve));

        const next = await tokenMgr.ensureToken().then(() => null, (err) => err);
        expect(next.code).toBe('SIGNIN_LINK');
        expect(next.message).toContain('The last sign-in did not finish: it stopped with an error (see the server log). Open this link');
        expect(next.message).not.toContain('ECONNREFUSED');
        expect(errorLog.mock.calls.flat().join(' ')).toContain('ECONNREFUSED');
        errorLog.mockRestore();
    });

    test('setup_cli_credentials does not return a token manager error text to the caller', async () => {
        const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
        let handler;
        const http = { get: jest.fn(), post: jest.fn() };
        registerSetupCliCredentials({ registerTool: (name, config, fn) => { handler = fn; } }, {
            acquireToken: jest.fn().mockRejectedValue(new Error('Token refresh failed (HTTP 500): {"internal":"/srv/keycloak"}')),
            _tokenStateModule: memoryTokenState(),
            httpClient: http,
        });

        const parsed = JSON.parse((await handler({ installation_id: '' })).content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.error).toBe('Setting up CLI credentials failed. See the server log for detail, then call setup_cli_credentials again.');
        expect(errorLog.mock.calls.flat().join(' ')).toContain('/srv/keycloak');
        expect(http.post).not.toHaveBeenCalled();
        errorLog.mockRestore();
    });

    test('a pending sign-in that times out with nobody waiting raises no unhandled rejection', async () => {
        const listener = fakeListener();
        const unhandled = [];
        const onUnhandled = (reason) => { unhandled.push(reason); };
        process.on('unhandledRejection', onUnhandled);
        try {
            const tokenMgr = createTokenManager({
                acquireToken,
                _tokenStateModule: memoryTokenState(),
                oidcOptions: {
                    timeoutMs: SIGNIN_TIMEOUT_MS,
                    createServer: listener.createServer,
                    httpClient,
                    openBrowser: async () => { throw new Error('no browser'); },
                },
            });
            await tokenMgr.ensureToken().catch(() => {});
            await jest.advanceTimersByTimeAsync(SIGNIN_TIMEOUT_MS * 5);
        } finally {
            process.removeListener('unhandledRejection', onUnhandled);
        }
        expect(unhandled).toEqual([]);
    });

    test('manage_backups hands the sign-in link to the agent', async () => {
        const listener = fakeListener();
        const openedUrls = [];
        const tokenMgrOptions = {
            acquireToken,
            _tokenStateModule: memoryTokenState(),
            oidcOptions: {
                timeoutMs: SIGNIN_TIMEOUT_MS,
                createServer: listener.createServer,
                httpClient,
                openBrowser: async (url) => { openedUrls.push(url); throw new Error('no browser'); },
            },
        };
        let handler;
        registerManageBackups({ registerTool: (name, config, fn) => { handler = fn; } }, { ...tokenMgrOptions, httpClient: { get: jest.fn(), post: jest.fn() } });

        const result = await handler({ action: 'list' });

        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text).error).toContain(openedUrls[0]);
        await jest.advanceTimersByTimeAsync(SIGNIN_TIMEOUT_MS * 5);
    });

    test('verify_storage hands the sign-in link to the agent', async () => {
        const listener = fakeListener();
        const openedUrls = [];
        let handler;
        const http = { get: jest.fn(), post: jest.fn(), del: jest.fn() };
        registerVerifyStorage({ registerTool: (name, config, fn) => { handler = fn; } }, {
            acquireToken,
            _tokenStateModule: memoryTokenState(),
            oidcOptions: {
                createServer: listener.createServer,
                httpClient,
                openBrowser: async (url) => { openedUrls.push(url); throw new Error('no browser'); },
            },
            httpClient: http,
            dockerUtil: { getDockerHost: jest.fn().mockResolvedValue({ remote: false, host: 'localhost', endpoint: null }) },
        });

        const result = await handler({ endpoint: 'http://localhost:9000' });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain(openedUrls[0]);
        expect(http.post).not.toHaveBeenCalled();
    });

    test('setup_cli_credentials hands the sign-in link to the agent', async () => {
        const listener = fakeListener();
        const openedUrls = [];
        let handler;
        const http = { get: jest.fn(), post: jest.fn() };
        registerSetupCliCredentials({ registerTool: (name, config, fn) => { handler = fn; } }, {
            acquireToken,
            _tokenStateModule: memoryTokenState(),
            oidcOptions: {
                createServer: listener.createServer,
                httpClient,
                openBrowser: async (url) => { openedUrls.push(url); throw new Error('no browser'); },
            },
            httpClient: http,
        });

        const parsed = JSON.parse((await handler({ installation_id: '' })).content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.error).toContain(openedUrls[0]);
        expect(http.post).not.toHaveBeenCalled();
    });
});
