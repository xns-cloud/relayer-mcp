'use strict';

const nodeFs = require('fs');

describe('environmentProbe', () => {
    function createFakeFs({ dockerenv = false, cgroupContent = null, systemd = true } = {}) {
        return {
            accessSync: jest.fn().mockImplementation((path) => {
                if (path === '/.dockerenv' && !dockerenv) {
                    throw new Error('ENOENT');
                }
                if (path === '/run/systemd/system' && !systemd) {
                    throw new Error('ENOENT');
                }
            }),
            readFileSync: jest.fn().mockImplementation((path) => {
                if (path === '/proc/1/cgroup' && cgroupContent !== null) {
                    return cgroupContent;
                }
                throw new Error('ENOENT');
            }),
            constants: nodeFs.constants,
        };
    }

    test('ephemeral true: /.dockerenv + no systemd', () => {
        const { environmentProbe } = require('../lib/environmentProbe');
        const result = environmentProbe({
            fs: createFakeFs({ dockerenv: true, systemd: false }),
        });

        expect(result.ephemeral).toBe(true);
        expect(result.signals.length).toBeGreaterThanOrEqual(2);
    });

    test('ephemeral true: cgroup references docker + no systemd', () => {
        const { environmentProbe } = require('../lib/environmentProbe');
        const result = environmentProbe({
            fs: createFakeFs({
                cgroupContent: '12:devices:/docker/abc123\n',
                systemd: false,
            }),
        });

        expect(result.ephemeral).toBe(true);
        expect(result.signals).toEqual(
            expect.arrayContaining([
                expect.stringContaining('container runtime'),
                expect.stringContaining('systemd'),
            ])
        );
    });

    test('ephemeral false: native host with systemd', () => {
        const { environmentProbe } = require('../lib/environmentProbe');
        const result = environmentProbe({
            fs: createFakeFs({ systemd: true }),
        });

        expect(result.ephemeral).toBe(false);
    });

    test('ephemeral false: single signal alone does not trigger', () => {
        const { environmentProbe } = require('../lib/environmentProbe');
        const result = environmentProbe({
            fs: createFakeFs({ dockerenv: true, systemd: true }),
        });

        expect(result.ephemeral).toBe(false);
        expect(result.signals.length).toBe(1);
    });

    test('cgroup with kubepods is detected', () => {
        const { environmentProbe } = require('../lib/environmentProbe');
        const result = environmentProbe({
            fs: createFakeFs({
                cgroupContent: '1:name=systemd:/kubepods/burstable/pod123\n',
                systemd: false,
            }),
        });

        expect(result.ephemeral).toBe(true);
        expect(result.signals).toEqual(
            expect.arrayContaining([
                expect.stringContaining('container runtime'),
            ])
        );
    });

    test('signals array describes each detected indicator', () => {
        const { environmentProbe } = require('../lib/environmentProbe');
        const result = environmentProbe({
            fs: createFakeFs({ dockerenv: true, systemd: false }),
        });

        for (const sig of result.signals) {
            expect(typeof sig).toBe('string');
            expect(sig.length).toBeGreaterThan(0);
        }
    });
});
