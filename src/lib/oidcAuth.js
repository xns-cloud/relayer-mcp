'use strict';

const crypto = require('crypto');
const http = require('http');
const { createHttpClient } = require('./httpClient');

const DEFAULT_KEYCLOAK_URL = 'https://auth.xns.tech/auth';
const DEFAULT_REALM = 'scprime';
const DEFAULT_CLIENT_ID = 'relayer-native';

/**
 * OIDC Authorization Code + PKCE (S256) token acquisition.
 *
 * Performs a browser-based OIDC sign-in flow:
 * 1. Generate PKCE verifier + S256 challenge
 * 2. Start a 127.0.0.1 loopback HTTP listener on an ephemeral port
 * 3. Build the authorize URL and open the browser (or return the URL)
 * 4. Capture the authorization code on the redirect
 * 5. Exchange code for access_token + refresh_token
 *
 * Interface is kept clean for future extraction to @xns/relayer-auth (CLI reuse).
 *
 * @param {object} opts
 * @param {string} [opts.clientId] - Keycloak public client ID
 * @param {string} [opts.realm] - Keycloak realm
 * @param {string} [opts.keycloakUrl] - Base Keycloak URL
 * @param {string[]} [opts.scopes] - OIDC scopes
 * @param {object} [opts.httpClient] - Injected HTTP client (testing)
 * @param {function} [opts.openBrowser] - Injected browser opener (testing)
 * @param {function} [opts.createServer] - Injected http.createServer (testing)
 * @returns {Promise<{access_token: string, expires_at: number, refresh_token: string, authorize_url: string}>}
 */
async function acquireToken(opts = {}) {
    const clientId = opts.clientId || DEFAULT_CLIENT_ID;
    const realm = opts.realm || DEFAULT_REALM;
    const keycloakUrl = opts.keycloakUrl || DEFAULT_KEYCLOAK_URL;
    const scopes = opts.scopes || ['openid'];
    const httpClient = opts.httpClient || createHttpClient({ timeout: 15000 });
    const openBrowser = opts.openBrowser || defaultOpenBrowser;
    const _createServer = opts.createServer || http.createServer.bind(http);

    // 1. PKCE verifier + S256 challenge
    const verifier = generateVerifier();
    const challenge = generateChallenge(verifier);

    // 2. Loopback listener on ephemeral port (R7: platform-agnostic bind)
    const { code, redirectUri } = await captureAuthCode({
        clientId,
        realm,
        keycloakUrl,
        scopes,
        verifier,
        challenge,
        openBrowser,
        createServer: _createServer,
    });

    // 5. Exchange code for tokens
    const tokenUrl = `${keycloakUrl}/realms/${realm}/protocol/openid-connect/token`;
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
    }).toString();

    const { status, data } = await httpClient.post(tokenUrl, body, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    if (status !== 200) {
        throw new Error(`Token exchange failed (HTTP ${status}): ${JSON.stringify(data)}`);
    }

    return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + (data.expires_in * 1000),
        authorize_url: undefined, // already consumed
    };
}

/**
 * Refresh an access token using a refresh_token.
 *
 * @param {object} opts
 * @param {string} opts.refreshToken
 * @param {string} [opts.clientId]
 * @param {string} [opts.realm]
 * @param {string} [opts.keycloakUrl]
 * @param {object} [opts.httpClient]
 * @returns {Promise<{access_token: string, expires_at: number, refresh_token: string}>}
 */
async function refreshToken(opts = {}) {
    const clientId = opts.clientId || DEFAULT_CLIENT_ID;
    const realm = opts.realm || DEFAULT_REALM;
    const keycloakUrl = opts.keycloakUrl || DEFAULT_KEYCLOAK_URL;
    const httpClient = opts.httpClient || createHttpClient({ timeout: 15000 });

    const tokenUrl = `${keycloakUrl}/realms/${realm}/protocol/openid-connect/token`;
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: opts.refreshToken,
    }).toString();

    const { status, data } = await httpClient.post(tokenUrl, body, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    if (status !== 200) {
        throw new Error(`Token refresh failed (HTTP ${status}): ${JSON.stringify(data)}`);
    }

    return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + (data.expires_in * 1000),
    };
}

/**
 * Generate a PKCE code verifier (43-128 chars, URL-safe base64).
 * @returns {string}
 */
function generateVerifier() {
    return crypto.randomBytes(32).toString('base64url');
}

/**
 * Generate a PKCE S256 challenge from a verifier.
 * @param {string} verifier
 * @returns {string}
 */
function generateChallenge(verifier) {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Start a loopback HTTP server, open the browser to the authorize URL,
 * and wait for the authorization code redirect.
 *
 * @param {object} opts
 * @returns {Promise<{code: string, redirectUri: string}>}
 */
function captureAuthCode(opts) {
    const { clientId, realm, keycloakUrl, scopes, verifier, challenge, openBrowser, createServer } = opts;

    return new Promise((resolve, reject) => {
        let timeoutHandle;
        let capturedPort;
        let expectedState;

        const srv = createServer((req, res) => {
            const url = new URL(req.url, `http://127.0.0.1`);

            const error = url.searchParams.get('error');
            if (error) {
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end('<html><body><h1>Authentication failed</h1><p>You can close this window.</p></body></html>');
                clearTimeout(timeoutHandle);
                srv.close();
                return reject(new Error(`OIDC error: ${error} — ${url.searchParams.get('error_description') || ''}`));
            }

            const code = url.searchParams.get('code');
            if (!code) {
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end('<html><body><h1>Missing authorization code</h1></body></html>');
                return; // Don't close server — wait for the real redirect
            }

            // R5-STATE-1: Validate OIDC state parameter to prevent CSRF
            const returnedState = url.searchParams.get('state');
            if (returnedState !== expectedState) {
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end('<html><body><h1>Invalid state parameter</h1><p>Possible CSRF attack. Please try again.</p></body></html>');
                clearTimeout(timeoutHandle);
                srv.close();
                return reject(new Error('OIDC callback state mismatch — possible CSRF. Please try again.'));
            }

            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>Authentication successful</h1><p>You can close this window and return to the agent.</p></body></html>');
            clearTimeout(timeoutHandle);

            // Capture redirect URI from the port stored in listen callback
            // BEFORE calling srv.close() — after close, srv.address() may return null
            const redirectUri = `http://127.0.0.1:${capturedPort}/callback`;
            srv.close();
            resolve({ code, redirectUri });
        });

        // Bind to 127.0.0.1:0 (ephemeral port) — R7 platform-agnostic
        srv.listen(0, '127.0.0.1', () => {
            capturedPort = srv.address().port;
            const redirectUri = `http://127.0.0.1:${capturedPort}/callback`;
            expectedState = crypto.randomBytes(16).toString('hex');

            const params = new URLSearchParams({
                response_type: 'code',
                client_id: clientId,
                redirect_uri: redirectUri,
                scope: scopes.join(' '),
                code_challenge: challenge,
                code_challenge_method: 'S256',
                state: expectedState,
            });

            const authorizeUrl = `${keycloakUrl}/realms/${realm}/protocol/openid-connect/auth?${params}`;

            // Open browser or return URL for the agent to present
            openBrowser(authorizeUrl).catch(() => {
                // If browser open fails, the authorize_url is still available
            });
        });

        // Timeout: 5 minutes for user to complete browser sign-in
        timeoutHandle = setTimeout(() => {
            srv.close();
            reject(new Error('OIDC sign-in timed out after 5 minutes. Please try again.'));
        }, 300000);
    });
}

/**
 * Default browser opener — platform-aware.
 * Uses execFile (not exec) to avoid shell interpolation of the URL.
 * @param {string} url
 * @returns {Promise<void>}
 */
function defaultOpenBrowser(url) {
    const { execFile } = require('child_process');
    return new Promise((resolve, reject) => {
        const platform = process.platform;
        let cmd, args;
        if (platform === 'darwin') {
            cmd = 'open';
            args = [url];
        } else if (platform === 'win32') {
            cmd = 'cmd';
            args = ['/c', 'start', '', url];
        } else {
            cmd = 'xdg-open';
            args = [url];
        }

        execFile(cmd, args, (err) => {
            if (err) return reject(err);
            resolve();
        });
    });
}

module.exports = { acquireToken, refreshToken, generateVerifier, generateChallenge };
