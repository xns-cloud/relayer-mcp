'use strict';

const { ALLOWED_SETTINGS, isAllowed, typeError, suggestKey } = require('../lib/allowedSettings');

describe('allowedSettings', () => {
    test('whitelist contains the curated set and nothing dangerous', () => {
        expect(isAllowed('HOSTIO_UPLOAD_WORKERS')).toBe(true);
        expect(isAllowed('BACKUP_ENABLED')).toBe(true);
        expect(isAllowed('CostCenter')).toBe(true);
        expect(isAllowed('S3GW_CREDENTIAL_ENCRYPTION_KEY')).toBe(false);
        expect(isAllowed('GENERAL_USE_CUSTOM_SSL')).toBe(false);
    });

    test('every entry names a group (or null for top-level) and a note', () => {
        for (const [key, meta] of Object.entries(ALLOWED_SETTINGS)) {
            expect(meta.note.length).toBeGreaterThan(10);
            expect(meta.group === null || typeof meta.group === 'string').toBe(true);
            expect(['Number', 'Boolean', 'String', 'Big']).toContain(meta.type);
            expect(key.length).toBeGreaterThan(0);
        }
    });

    test('typeError validates against the catalog type', () => {
        expect(typeError('HOSTIO_UPLOAD_WORKERS', 12)).toBeNull();
        expect(typeError('HOSTIO_UPLOAD_WORKERS', 'ten')).toContain('number');
        expect(typeError('BACKUP_ENABLED', false)).toBeNull();
        expect(typeError('BACKUP_ENABLED', 1)).toContain('boolean');
        expect(typeError('CostCenter', 'cc-1')).toBeNull();
    });

    test('typeError on an unknown key returns a message, never throws', () => {
        expect(() => typeError('NOT_A_SETTING', 1)).not.toThrow();
        expect(typeError('NOT_A_SETTING', 1)).toContain('not an allowed setting');
    });

    test('suggestKey catches near-misses and rejects garbage', () => {
        expect(suggestKey('HOSTIO_UPLOD_WORKERS')).toBe('HOSTIO_UPLOAD_WORKERS');
        expect(suggestKey('backup_enabled')).toBe('BACKUP_ENABLED');
        expect(suggestKey('zz')).toBeNull();
    });
});
