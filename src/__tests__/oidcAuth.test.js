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
                // Simulate the browser completing the auth flow
                // The redirect comes back to the loopback server
                const mockReq = {
                    url: '/callback?code=test-auth-code&state=abc',
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

            const openBrowser = jest.fn().mockImplementation(async () => {
                requestHandler(
                    { url: '/callback?code=race-code&state=xyz' },
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

            const openBrowser = jest.fn().mockImplementation(async () => {
                requestHandler(
                    { url: '/callback?code=test-code&state=abc' },
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
