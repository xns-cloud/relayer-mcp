'use strict';

const { acquireToken, refreshToken } = require('./oidcAuth');
const sharedTokenState = require('./tokenState');

// One pending browser sign-in per token state, shared by every tool that
// builds a token manager on that state. Keyed by the state module so
// injected test state stays isolated from the real one.
const pendingSignIns = new WeakMap();

// The sign-in link redirects to 127.0.0.1:<port> on the machine running this
// server, so the browser has to reach that port.
function signInLinkMessage(url) {
    const message = `Open this link in a browser on this machine to sign in to XNS (on WSL the Windows browser works), then call this tool again: ${url}`;
    let port = '';
    try {
        port = new URL(new URL(url).searchParams.get('redirect_uri')).port;
    } catch {
        return message;
    }
    if (!port) return message;
    return `${message}\nIf your browser is on another machine, first forward the port with: ssh -L ${port}:127.0.0.1:${port} <this machine>`;
}

/**
 * Create an ensureToken function with injectable deps for testing.
 * Used by getHostTags and configureVpd — both need OIDC token
 * management with the same refresh/re-auth logic.
 *
 * @param {object} [options]
 * @param {function} [options.acquireToken] - Injected acquireToken (testing)
 * @param {function} [options.refreshToken] - Injected refreshToken (testing)
 * @param {object} [options.oidcOptions] - Extra OIDC config
 * @param {object} [options._tokenStateModule] - Injected token state module (testing)
 * @param {object} [options._tokenState] - Initial token state to set (testing)
 * @returns {{ensureToken: function, getTokenState: function, setTokenState: function}}
 */
function createTokenManager(options = {}) {
    const _acquireToken = options.acquireToken || acquireToken;
    const _refreshToken = options.refreshToken || refreshToken;
    const oidcOpts = options.oidcOptions || {};
    const _tokenState = options._tokenStateModule || sharedTokenState;

    if (options._tokenState !== undefined) {
        _tokenState.set(options._tokenState);
    }

    /**
     * Ensure we have a valid OIDC token. Re-auth on 401 or expiry.
     * @returns {Promise<string>} access_token
     */
    async function ensureToken() {
        const tokenState = _tokenState.get();
        // Try refresh if we have a token near expiry
        if (tokenState && tokenState.refresh_token) {
            if (Date.now() >= tokenState.expires_at - 30000) {
                try {
                    const newState = await _refreshToken({
                        refreshToken: tokenState.refresh_token,
                        ...oidcOpts,
                    });
                    _tokenState.set(newState);
                    return newState.access_token;
                } catch {
                    // Refresh failed — fall through to full re-auth
                    _tokenState.clear();
                }
            } else {
                return tokenState.access_token;
            }
        }

        // Full OIDC sign-in — join one already waiting for the person, if any
        let pending = pendingSignIns.get(_tokenState);
        if (pending) return raceSignInOrLink(pending);

        pending = startSignIn();
        pendingSignIns.set(_tokenState, pending);
        pending.signIn.then(
            () => { clearPending(pending); },
            () => { clearPending(pending); },
        );

        return raceSignInOrLink(pending);
    }

    // Either the sign-in finishes, or the browser could not be opened and the
    // person needs the link. The sign-in keeps running in that case. A call that
    // joins a pending sign-in gets the same race, so it never waits blind.
    function raceSignInOrLink(pending) {
        return Promise.race([
            pending.signIn,
            pending.link.then((url) => {
                const err = new Error(signInLinkMessage(url));
                err.code = 'SIGNIN_LINK';
                err.authorizeUrl = url;
                throw err;
            }),
        ]);
    }

    function startSignIn() {
        let reportLink;
        const link = new Promise((resolve) => { reportLink = resolve; });
        const signIn = _acquireToken({ ...oidcOpts, onBrowserOpenFailed: reportLink })
            .then((newState) => {
                _tokenState.set(newState);
                return newState.access_token;
            });
        return { signIn, link };
    }

    function clearPending(pending) {
        if (pendingSignIns.get(_tokenState) === pending) pendingSignIns.delete(_tokenState);
    }

    /**
     * Clear token state and re-acquire — used after a 401 response.
     * @returns {Promise<string>} access_token
     */
    async function reauth() {
        _tokenState.clear();
        return ensureToken();
    }

    return {
        ensureToken,
        reauth,
        getTokenState: () => _tokenState.get(),
        setTokenState: (s) => { _tokenState.set(s); },
    };
}

module.exports = { createTokenManager };
