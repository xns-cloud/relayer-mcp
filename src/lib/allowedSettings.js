'use strict';

/**
 * The curated settings whitelist shared by describe_settings and update_settings.
 *
 * Deliberately a WHITELIST, not a blocklist (Ken, 2026-06-11): the Relayer
 * exposes ~74 tunables via GET /api/v1/config, but the MCP surfaces only the
 * operator-relevant "big ones" — worker/concurrency tuning, the backup
 * schedule, and the cost center (CCID). Everything else (SSL, database,
 * encryption keys, erasure geometry, inter-service wiring) is rejected so an
 * agent can never be talked into touching it. Add keys here only with the
 * matching group name from relayer-ui server/src/data/env_listing.json.
 *
 * `group` is the section of /relayer/conf/relayer_configuration.json the key
 * lives under (relayer-ui Config.js read/write contract). `CostCenter` is the
 * one top-level key (group: null).
 */
const ALLOWED_SETTINGS = {
    HOSTIO_UPLOAD_WORKERS: {
        group: 'HostIO',
        type: 'Number',
        note: 'Parallel upload workers. Restart of hostio required to take effect.',
    },
    HOSTIO_DOWNLOAD_WORKERS: {
        group: 'HostIO',
        type: 'Number',
        note: 'Parallel download workers. Restart of hostio required to take effect.',
    },
    HOSTIO_UTILITY_OPERATIONS_WORKERS: {
        group: 'HostIO',
        type: 'Number',
        note: 'Workers for background/utility operations. Restart of hostio required.',
    },
    HOSTIO_SIMULTANEOUS_UPLOADS: {
        group: 'HostIO',
        type: 'Number',
        note: 'Upload concurrency to hosts. The server enforces a resource-aware ceiling and will reject values above it — the rejection message names the ceiling. Restart of hostio required.',
    },
    HOSTIO_SIMULTANEOUS_DOWNLOADS: {
        group: 'HostIO',
        type: 'Number',
        note: 'Per-host download concurrency. Restart of hostio required.',
    },
    BACKUP_ENABLED: {
        group: 'Backup',
        type: 'Boolean',
        note: 'Enable/disable the scheduled configuration backup.',
    },
    BACKUP_FREQUENCY: {
        group: 'Backup',
        type: 'Number',
        note: 'Backup cadence in minutes.',
    },
    BACKUP_THRESHOLD: {
        group: 'Backup',
        type: 'Number',
        note: 'Change threshold that triggers a backup.',
    },
    BACKUP_RETENTION: {
        group: 'Backup',
        type: 'Number',
        note: 'Number of backup archives to keep.',
    },
    CostCenter: {
        group: null, // top-level key in relayer_configuration.json
        type: 'String',
        note: 'The billing cost center (CCID). Changing it re-authenticates the Relayer against the new cost center using your OIDC session and requires a service restart. This changes who is billed — confirm with the operator before applying.',
    },
};

const JS_TYPE_BY_CATALOG_TYPE = {
    Number: 'number',
    Boolean: 'boolean',
    String: 'string',
    Big: 'number',
};

function isAllowed(key) {
    return Object.prototype.hasOwnProperty.call(ALLOWED_SETTINGS, key);
}

/**
 * Validate a value's JS type against the whitelist entry's catalog type.
 * Semantic validation (ranges, ceilings) stays server-side — the server's
 * rejection messages pass through to the agent verbatim.
 */
function typeError(key, value) {
    if (!isAllowed(key)) {
        return `${key} is not an allowed setting`;
    }
    const expected = JS_TYPE_BY_CATALOG_TYPE[ALLOWED_SETTINGS[key].type];
    if (expected && typeof value !== expected) {
        return `${key} expects a ${expected}, got ${typeof value}`;
    }
    return null;
}

/** Nearest allowed-key suggestion for typo'd/hallucinated names. */
function suggestKey(unknownKey) {
    const upper = String(unknownKey).toUpperCase();
    let best = null;
    let bestScore = 0;
    for (const key of Object.keys(ALLOWED_SETTINGS)) {
        const k = key.toUpperCase();
        let score = 0;
        // Cheap shared-bigram similarity — enough to catch transpositions/typos.
        for (let i = 0; i < upper.length - 1; i++) {
            if (k.includes(upper.slice(i, i + 2))) score++;
        }
        if (score > bestScore) {
            bestScore = score;
            best = key;
        }
    }
    return bestScore >= 3 ? best : null;
}

module.exports = { ALLOWED_SETTINGS, isAllowed, typeError, suggestKey };
