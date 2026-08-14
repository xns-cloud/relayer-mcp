'use strict';

const { generateVerifier, generateChallenge, acquireToken, refreshToken } = require('../lib/oidcAuth');

describe('oidcAuth', () => {
    describe('PKCE challenge generation', () => {
        test('generateVerifier returns URL-safe base64 string', () => {
            const verifier = generateVerifier();
            expect(typeof verifier).toBe('string');
            expect(verifier.length).toBeGreaterThanOrEqual(32);
            // URL-safe base64: no +, /, or =
            expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
        });

        test('generateChallenge returns S256 hash of verifier', () => {
            const verifier = generateVerifier();
            const challenge = generateChallenge(verifier);
            expect(typeof challenge).toBe('string');
            expect(challenge.length).toBeGreaterThan(0);
            // URL-safe base64
            expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);

            // Same verifier → same challenge
            const challenge2 = generateChallenge(verifier);
            expect(challenge2).toBe(challenge);
        });

        test('different verifiers produce different challenges', () => {
            const v1 = generateVerifier();
            const v2 = generateVerifier();
            expect(generateChallenge(v1)).not.toBe(generateChallenge(v2));
        });
    });

    describe('acquireToken', () => {
        test('completes OIDC flow and returns token', async () => {
            // Mock the loopback server + browser flow
            const mockServer = {
                listen: jest.fn((port, host, cb) => {
                    cb();
                }),
                address: jest.fn(() => ({ port: 12345 })),
                close: jest.fn(),
            };

            let requestHandler;
            const createServer = jest.fn((handler) => {
                requestHandler = handler;
                return mockServer;
            });

            const openBrowser = jest.fn().mockImplementation(async (url) => {
                // Extract the state from the authorize URL to echo it back
                const authorizeUrl = new URL(url);
                const state = authorizeUrl.searchParams.get('state');
                const mockReq = {
                    url: `/callback?code=test-auth-code&state=${state}`,
                };
                const mockRes = {
                    writeHead: jest.fn(),
                    end: jest.fn(),
                };
                requestHandler(mockReq, mockRes);
            });

            const httpClient = {
                post: jest.fn().mockResolvedValue({
                    status: 200,
                    data: {
                        access_token: 'test-access-token',
                        refresh_token: 'test-refresh-token',
                        expires_in: 300,
                    },
                }),
                get: jest.fn(),
            };

            const result = await acquireToken({
                clientId: 'relayer-native',
                realm: 'scprime',
                keycloakUrl: 'https://auth.xns.tech/auth',
                createServer,
                openBrowser,
                httpClient,
            });

            expect(result.access_token).toBe('test-access-token');
            expect(result.refresh_token).toBe('test-refresh-token');
            expect(result.expires_at).toBeGreaterThan(Date.now());

            // Verify token exchange was called with code_verifier
            const postCall = httpClient.post.mock.calls[0];
            expect(postCall[0]).toContain('token');
            expect(postCall[1]).toContain('code=test-auth-code');
            expect(postCall[1]).toContain('code_verifier=');
        });

        // R3-RACE-1: regression test — srv.address() returns null after close()
        test('uses captured port, not srv.address() after close', async () => {
            let requestHandler;
            const mockServer = {
                listen: jest.fn((port, host, cb) => cb()),
                address: jest.fn()
                    .mockReturnValueOnce({ port: 54321 }) // first call in listen callback
                    .mockReturnValueOnce(null),            // would be null after close
                close: jest.fn(),
            };
            const createServer = jest.fn((handler) => {
                requestHandler = handler;
                return mockServer;
            });

            const openBrowser = jest.fn().mockImplementation(async (url) => {
                const authorizeUrl = new URL(url);
                const state = authorizeUrl.searchParams.get('state');
                requestHandler(
                    { url: `/callback?code=race-code&state=${state}` },
                    { writeHead: jest.fn(), end: jest.fn() },
                );
            });

            const httpClient = {
                post: jest.fn().mockResolvedValue({
                    status: 200,
                    data: {
                        access_token: 'race-access',
                        refresh_token: 'race-refresh',
                        expires_in: 300,
                    },
                }),
                get: jest.fn(),
            };

            const result = await acquireToken({
                createServer,
                openBrowser,
                httpClient,
            });

            expect(result.access_token).toBe('race-access');
            // Verify the token exchange used the correct redirect_uri with port 54321
            const postBody = httpClient.post.mock.calls[0][1];
            expect(postBody).toContain('redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2Fcallback');
        });

        test('rejects when OIDC returns error', async () => {
            let requestHandler;
            const createServer = jest.fn((handler) => {
                requestHandler = handler;
                return {
                    listen: jest.fn((port, host, cb) => cb()),
                    address: jest.fn(() => ({ port: 12345 })),
                    close: jest.fn(),
                };
            });

            const openBrowser = jest.fn().mockImplementation(async () => {
                requestHandler(
                    { url: '/callback?error=access_denied&error_description=User+denied' },
                    { writeHead: jest.fn(), end: jest.fn() },
                );
            });

            await expect(acquireToken({
                createServer,
                openBrowser,
                httpClient: { post: jest.fn(), get: jest.fn() },
            })).rejects.toThrow('OIDC error: access_denied');
        });

        test('rejects when token exchange fails', async () => {
            let requestHandler;
            const createServer = jest.fn((handler) => {
                requestHandler = handler;
                return {
                    listen: jest.fn((port, host, cb) => cb()),
                    address: jest.fn(() => ({ port: 12345 })),
                    close: jest.fn(),
                };
            });

            const openBrowser = jest.fn().mockImplementation(async (url) => {
                const authorizeUrl = new URL(url);
                const state = authorizeUrl.searchParams.get('state');
                requestHandler(
                    { url: `/callback?code=test-code&state=${state}` },
                    { writeHead: jest.fn(), end: jest.fn() },
                );
            });

            await expect(acquireToken({
                createServer,
                openBrowser,
                httpClient: {
                    post: jest.fn().mockResolvedValue({
                        status: 400,
                        data: { error: 'invalid_grant' },
                    }),
                    get: jest.fn(),
                },
            })).rejects.toThrow('Token exchange failed');
        });
        // R5-STATE-1: state mismatch → rejection
        test('rejects when callback state does not match expected state', async () => {
            let requestHandler;
            const createServer = jest.fn((handler) => {
                requestHandler = handler;
                return {
                    listen: jest.fn((port, host, cb) => cb()),
                    address: jest.fn(() => ({ port: 12345 })),
                    close: jest.fn(),
                };
            });

            const openBrowser = jest.fn().mockImplementation(async () => {
                // Send a mismatched state value
                requestHandler(
                    { url: '/callback?code=stolen-code&state=wrong-state-value' },
                    { writeHead: jest.fn(), end: jest.fn() },
                );
            });

            await expect(acquireToken({
                createServer,
                openBrowser,
                httpClient: { post: jest.fn(), get: jest.fn() },
            })).rejects.toThrow('state mismatch');
        });
    });

    describe('BUG-366 fix set: sign-in window + charset', () => {
        test('sign-in timeout defaults to 30 minutes and honors timeoutMs override', async () => {
            jest.useFakeTimers();
            try {
                const mockServer = {
                    listen: jest.fn((port, host, cb) => cb()),
                    address: jest.fn(() => ({ port: 12345 })),
                    close: jest.fn(),
                };
                const createServer = jest.fn(() => mockServer);
                const openBrowser = jest.fn().mockResolvedValue(undefined);

                const pDefault = acquireToken({ createServer, openBrowser, httpClient: { post: jest.fn() } });
                pDefault.catch(() => {});
                jest.advanceTimersByTime(300000);
                // 5 minutes in: the old hard-coded window would have fired
                let settled = false;
                pDefault.then(() => { settled = true; }, () => { settled = true; });
                await Promise.resolve();
                expect(settled).toBe(false);
                jest.advanceTimersByTime(1500001);
                await expect(pDefault).rejects.toThrow('timed out after 30 minutes');

                const pShort = acquireToken({ createServer, openBrowser, httpClient: { post: jest.fn() }, timeoutMs: 60000 });
                pShort.catch(() => {});
                jest.advanceTimersByTime(60001);
                await expect(pShort).rejects.toThrow('timed out after 1 minute');
            } finally {
                jest.useRealTimers();
            }
        });

        test('invalid timeoutMs values fall back to the 30-minute default (CR MR29)', async () => {
            jest.useFakeTimers();
            try {
                for (const bad of [-5, 0, 'abc', NaN, 1.5, 2 ** 31]) {
                    const mockServer = {
                        listen: jest.fn((port, host, cb) => cb()),
                        address: jest.fn(() => ({ port: 12345 })),
                        close: jest.fn(),
                    };
                    const p = acquireToken({
                        createServer: jest.fn(() => mockServer),
                        openBrowser: jest.fn().mockResolvedValue(undefined),
                        httpClient: { post: jest.fn() },
                        timeoutMs: bad,
                    });
                    p.catch(() => {});
                    jest.advanceTimersByTime(1800001);
                    await expect(p).rejects.toThrow('timed out after 30 minutes');
                }
            } finally {
                jest.useRealTimers();
            }
        });

        test('synchronous browser completion leaves no live timer (CR MR29)', async () => {
            jest.useFakeTimers();
            try {
                const mockServer = {
                    listen: jest.fn((port, host, cb) => cb()),
                    address: jest.fn(() => ({ port: 12345 })),
                    close: jest.fn(),
                };
                let requestHandler;
                const createServer = jest.fn((h) => { requestHandler = h; return mockServer; });
                // Synchronous completion: the callback fires inside openBrowser
                const openBrowser = jest.fn().mockImplementation((url) => {
                    const state = new URL(url).searchParams.get('state');
                    requestHandler({ url: `/callback?code=c&state=${state}` }, { writeHead: jest.fn(), end: jest.fn() });
                    return Promise.resolve();
                });
                const httpClient = {
                    post: jest.fn().mockResolvedValue({ status: 200, data: { access_token: 'a', refresh_token: 'r', expires_in: 300 } }),
                };

                const result = await acquireToken({ createServer, openBrowser, httpClient });
                expect(result.access_token).toBe('a');
                expect(jest.getTimerCount()).toBe(0);
            } finally {
                jest.useRealTimers();
            }
        });

        test('callback pages declare utf-8 charset (mojibake regression)', async () => {
            const mockServer = {
                listen: jest.fn((port, host, cb) => cb()),
                address: jest.fn(() => ({ port: 12345 })),
                close: jest.fn(),
            };
            let requestHandler;
            const createServer = jest.fn((handler) => { requestHandler = handler; return mockServer; });
            const writeHead = jest.fn();
            const openBrowser = jest.fn().mockImplementation(async (url) => {
                const state = new URL(url).searchParams.get('state');
                requestHandler({ url: `/callback?code=c&state=${state}` }, { writeHead, end: jest.fn() });
            });
            const httpClient = {
                post: jest.fn().mockResolvedValue({ status: 200, data: { access_token: 'a', refresh_token: 'r', expires_in: 300 } }),
            };

            await acquireToken({ createServer, openBrowser, httpClient });
            expect(writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/html; charset=utf-8' });
        });
    });

    describe('refreshToken', () => {
        test('refreshes and returns new token', async () => {
            const httpClient = {
                post: jest.fn().mockResolvedValue({
                    status: 200,
                    data: {
                        access_token: 'new-access-token',
                        refresh_token: 'new-refresh-token',
                        expires_in: 300,
                    },
                }),
                get: jest.fn(),
            };

            const result = await refreshToken({
                refreshToken: 'old-refresh-token',
                httpClient,
            });

            expect(result.access_token).toBe('new-access-token');
            expect(result.refresh_token).toBe('new-refresh-token');
            expect(result.expires_at).toBeGreaterThan(Date.now());

            const postBody = httpClient.post.mock.calls[0][1];
            expect(postBody).toContain('grant_type=refresh_token');
            expect(postBody).toContain('refresh_token=old-refresh-token');
        });

        test('rejects when refresh fails', async () => {
            await expect(refreshToken({
                refreshToken: 'bad-token',
                httpClient: {
                    post: jest.fn().mockResolvedValue({
                        status: 400,
                        data: { error: 'invalid_grant' },
                    }),
                    get: jest.fn(),
                },
            })).rejects.toThrow('Token refresh failed');
        });
    });
});
