'use strict';

/**
 * Shared OIDC token state — single module-level cache shared by
 * getHostTags and configureVpd (and any future authenticated tools).
 *
 * Eliminates duplicate browser sign-ins caused by independent
 * `let tokenState = null` declarations in each tool module.
 */
let tokenState = null;

function get() {
    return tokenState;
}

function set(state) {
    tokenState = state;
}

function clear() {
    tokenState = null;
}

module.exports = { get, set, clear };
