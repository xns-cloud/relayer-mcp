'use strict';

const { createTokenManager } = require('../lib/ensureToken');
const { acquireToken } = require('../lib/oidcAuth');
const registerManageBackups = require('../tools/manageBackups');

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

describe('sign-in when the browser cannot be opened', () => {
    test('first call rejects promptly with the link; a second call gets the token after the callback, with one listener', async () => {
        const listener = fakeListener();
        const openedUrls = [];
        const tokenMgr = managerWithFailingBrowser(listener, openedUrls);

        const first = await tokenMgr.ensureToken().then(() => null, (err) => err);

        expect(first).toBeInstanceOf(Error);
        expect(first.code).toBe('SIGNIN_LINK');
        expect(first.message).toContain(openedUrls[0]);
        expect(first.message).toContain('/protocol/openid-connect/auth?');

        // The person signs in; the callback reaches the still-waiting listener.
        const second = tokenMgr.ensureToken();
        callbackFor(openedUrls[0], listener.created[0].handler);

        await expect(second).resolves.toBe('signed-in-token');
        expect(listener.createServer).toHaveBeenCalledTimes(1);
    });

    test('a different token manager on the same state joins the pending sign-in', async () => {
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
        const joined = make().ensureToken();
        callbackFor(openedUrls[0], listener.created[0].handler);

        await expect(joined).resolves.toBe('signed-in-token');
        expect(listener.createServer).toHaveBeenCalledTimes(1);
    });

    test('after the pending sign-in times out, the next call starts a fresh one', async () => {
        const listener = fakeListener();
        const openedUrls = [];
        const tokenMgr = createTokenManager({
            acquireToken,
            _tokenStateModule: memoryTokenState(),
            oidcOptions: {
                timeoutMs: 20,
                createServer: listener.createServer,
                httpClient,
                openBrowser: async (url) => { openedUrls.push(url); throw new Error('no browser'); },
            },
        });

        await tokenMgr.ensureToken().catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 60));
        const next = await tokenMgr.ensureToken().then(() => null, (err) => err);

        expect(listener.createServer).toHaveBeenCalledTimes(2);
        expect(next.code).toBe('SIGNIN_LINK');
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
                    timeoutMs: 20,
                    createServer: listener.createServer,
                    httpClient,
                    openBrowser: async () => { throw new Error('no browser'); },
                },
            });
            await tokenMgr.ensureToken().catch(() => {});
            await new Promise((resolve) => setTimeout(resolve, 80));
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
                timeoutMs: 20,
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
        await new Promise((resolve) => setTimeout(resolve, 60));
    });
});
