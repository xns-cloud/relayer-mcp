'use strict';

const { acquireToken, refreshToken } = require('./oidcAuth');
const sharedTokenState = require('./tokenState');

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

        // Full OIDC sign-in
        const newState = await _acquireToken(oidcOpts);
        _tokenState.set(newState);
        return newState.access_token;
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
