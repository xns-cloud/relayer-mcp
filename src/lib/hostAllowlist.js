'use strict';

/**
 * Shared host allowlist for tools that send credentials to a caller-supplied URL.
 *
 * Several tools accept a Relayer base URL as a parameter and then attach a Muse/Keycloak
 * token to the request. Without a check, a caller can name any host and receive that
 * token. This module is the one place that decides which hosts are acceptable.
 *
 * Extracted from verifyStorage.js, which had the only copy — see MR !33 (CodeRabbit
 * flagged setup_cli_credentials forwarding a token to an unvalidated URL while a sibling
 * tool in the same repo already guarded the identical parameter).
 */

/**
 * Validate that a URL points to a loopback, RFC-1918 private, or .local host.
 * Rejects public/internet-routable hosts to prevent token forwarding.
 *
 * @param {string} urlString - A fully qualified URL
 * @returns {{ allowed: boolean, reason?: string }}
 */
function validateHostAllowlist(urlString) {
    let parsed;
    try {
        parsed = new URL(urlString);
    } catch {
        return { allowed: false, reason: 'URL is malformed' };
    }

    const hostname = parsed.hostname.toLowerCase();

    if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') {
        return { allowed: true };
    }

    if (hostname.endsWith('.local')) {
        return { allowed: true };
    }

    const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
        const octets = ipv4Match.slice(1).map(Number);
        if (octets[0] === 127) return { allowed: true };
        if (octets[0] === 10) return { allowed: true };
        if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return { allowed: true };
        if (octets[0] === 192 && octets[1] === 168) return { allowed: true };
        return { allowed: false, reason: `Host ${hostname} is not a loopback or private-network address. Allowed: localhost, 127.0.0.0/8, ::1, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, *.local` };
    }

    return { allowed: false, reason: `Host '${hostname}' is not a loopback, private-network, or .local address. Allowed: localhost, 127.0.0.0/8, ::1, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, *.local` };
}

// A redirect on a token-bearing request would hand the token to the redirect target,
// defeating the allowlist above. Never follow one.
const NO_REDIRECT_TOKEN_CONFIG = { maxRedirects: 0 };

module.exports = { validateHostAllowlist, NO_REDIRECT_TOKEN_CONFIG };
