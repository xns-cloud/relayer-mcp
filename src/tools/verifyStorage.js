'use strict';

const { z } = require('zod');
const { createS3Client } = require('../lib/s3Client');
const { createDockerUtil } = require('../lib/dockerUtil');
const { createHttpClient } = require('../lib/httpClient');

/**
 * Tool 10: verify_storage
 *
 * Self-provisioning S3 round-trip verification. When called with only a
 * muse_token, mints a throwaway IAM user with a scoped policy restricted to
 * mcp-verify-* buckets, runs CreateBucket -> PutObject -> GetObject -> Compare,
 * and tears everything down in finally — pass or fail.
 *
 * Optional access_key_id/secret_access_key skip minting entirely.
 * The minted credential lives in memory only — zero fs usage.
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

module.exports = function registerVerifyStorage(server, options = {}) {
    const _createS3Client = options.createS3Client || createS3Client;
    const docker = options.dockerUtil || createDockerUtil(options);
    const http = options.httpClient || createHttpClient(options);

    server.tool(
        'verify_storage',
        'Verify the S3-compatible storage gateway is working by performing a round-trip test: create a test bucket, upload a small object, download it, and compare. Provisions a temporary scoped IAM credential automatically using your OIDC session — no manual key management needed. The throwaway credential and test data are removed after the test, pass or fail. By default targets port 9000 on the machine the Docker daemon runs on (auto-detected from the Docker context); pass endpoint to override.',
        {
            muse_token: z.string().optional().describe('Keycloak/Muse token — the same token used for get_host_tags and configure_vpd. Required when access_key_id and secret_access_key are not provided.'),
            access_key_id: z.string().optional().describe('S3 access key ID — when provided with secret_access_key, skips automatic credential provisioning'),
            secret_access_key: z.string().optional().describe('S3 secret access key — when provided with access_key_id, skips automatic credential provisioning'),
            relayer_ui_url: z.string().trim().url().optional().default('http://localhost:8888').describe('Relayer UI base URL (default: http://localhost:8888)'),
            endpoint: z.string().trim().url().optional().describe('S3 endpoint URL. Default: http://{docker-host}:9000. Pass an explicit IP (e.g. http://192.168.1.100:9000) when auto-detection cannot reach the host.'),
        },
        async ({ muse_token, access_key_id, secret_access_key, relayer_ui_url = 'http://localhost:8888', endpoint }) => {
            const runTs = Date.now();
            const testBucket = `mcp-verify-${runTs}`;
            const testKey = 'verify-test.txt';
            const testContent = `relayer-mcp verification ${runTs}`;
            let currentStep = 'init';
            let endpointAutoDetected = false;

            let mintedUser = null;
            let mintedPolicyName = null;
            let bucketCreated = false;
            let policyCreated = false;
            let policyAttached = false;
            let mintConfirmed = false;
            let bucketConfirmed = false;
            let policyConfirmed = false;
            let attachConfirmed = false;
            let effectiveAK = access_key_id;
            let effectiveSK = secret_access_key;
            let result;
            let isError = false;

            const baseUrl = relayer_ui_url.replace(/\/+$/, '');

            try {
                const hostCheck = validateHostAllowlist(baseUrl);
                if (!hostCheck.allowed) {
                    throw new Error(`relayer_ui_url rejected: ${hostCheck.reason}`);
                }

                if (!endpoint) {
                    const { host } = await docker.getDockerHost();
                    endpoint = `http://${host}:9000`;
                    endpointAutoDetected = true;
                }

                const usePassthrough = effectiveAK && effectiveSK;

                if (!usePassthrough) {
                    if (!muse_token) {
                        throw new Error('muse_token is required when access_key_id and secret_access_key are not provided');
                    }

                    currentStep = 'MintUser';
                    const userName = `mcp-verify-${runTs}`;
                    mintedUser = userName;
                    const { status: mintStatus, data: mintData } = await http.post(
                        `${baseUrl}/api/v1/mc/user`,
                        { user: userName },
                        { headers: { keycloaktoken: muse_token } }
                    );
                    if (mintStatus !== 200) {
                        throw new Error(`Mint user failed (HTTP ${mintStatus})`);
                    }
                    effectiveAK = mintData?.access_key;
                    effectiveSK = mintData?.secret_key;

                    if (mintData?.success === false || !effectiveAK || !effectiveSK) {
                        throw new Error('Mint user failed: response missing access_key/secret_key');
                    }
                    mintConfirmed = true;

                    currentStep = 'CreatePolicy';
                    mintedPolicyName = `mcp-verify-policy-${runTs}`;
                    policyCreated = true;
                    const policyDocument = JSON.stringify({
                        Version: '2012-10-17',
                        Statement: [{
                            Effect: 'Allow',
                            Action: [
                                's3:CreateBucket',
                                's3:DeleteBucket',
                                's3:ListBucket',
                                's3:PutObject',
                                's3:GetObject',
                                's3:DeleteObject',
                            ],
                            Resource: [
                                'arn:aws:s3:::mcp-verify-*',
                                'arn:aws:s3:::mcp-verify-*/*',
                            ],
                        }],
                    });
                    const { status: policyStatus, data: policyData } = await http.post(
                        `${baseUrl}/api/v1/mc/policy-create`,
                        { name: mintedPolicyName, type: 'json', json: policyDocument },
                        { headers: { keycloaktoken: muse_token } }
                    );
                    if (policyStatus !== 200) {
                        throw new Error(`Create policy failed (HTTP ${policyStatus})`);
                    }
                    if (!policyData?.success) {
                        throw new Error('Create policy failed');
                    }
                    policyConfirmed = true;

                    currentStep = 'AttachPolicy';
                    policyAttached = true;
                    const { status: attachStatus, data: attachData } = await http.post(
                        `${baseUrl}/api/v1/mc/policy`,
                        { name: mintedUser, policy: mintedPolicyName },
                        { headers: { keycloaktoken: muse_token } }
                    );
                    if (attachStatus !== 200) {
                        throw new Error(`Attach policy failed (HTTP ${attachStatus})`);
                    }
                    if (attachData?.status !== 'attached') {
                        throw new Error('Attach policy failed');
                    }
                    attachConfirmed = true;
                }

                const s3 = _createS3Client({
                    endpoint,
                    accessKeyId: effectiveAK,
                    secretAccessKey: effectiveSK,
                });

                currentStep = 'CreateBucket';
                bucketCreated = true;
                await s3.createBucket(testBucket);
                bucketConfirmed = true;

                currentStep = 'PutObject';
                await s3.putObject(testBucket, testKey, testContent);

                currentStep = 'GetObject';
                const retrieved = await s3.getObject(testBucket, testKey);

                currentStep = 'Compare';
                if (retrieved !== testContent) {
                    result = {
                        success: false,
                        error: 'Storage verification failed at Compare: uploaded content does not match downloaded content.',
                        endpoint,
                        failing_step: 'Compare',
                    };
                    isError = true;
                } else {
                    const explicitIpHint = endpointAutoDetected
                        ? 'If auto-detection cannot reach the host, pass an explicit endpoint (e.g. "http://<ip>:9000").'
                        : null;
                    result = {
                        success: true,
                        message: `S3 storage verification passed. Successfully created bucket, uploaded object, and verified download at ${endpoint}.`,
                        endpoint,
                        test_bucket: testBucket,
                        ...(explicitIpHint ? { note: explicitIpHint } : {}),
                    };
                }
            } catch (err) {
                console.error(`[verify_storage] ${currentStep}: ${err.message}`);
                const explicitIpHint = endpointAutoDetected
                    ? ' If the endpoint cannot be reached, pass an explicit IP via the endpoint option (e.g. "http://<ip>:9000").'
                    : '';
                result = {
                    success: false,
                    error: `Storage verification failed at ${currentStep}. See server log for detail.${explicitIpHint}`,
                    endpoint,
                    failing_step: currentStep,
                };
                isError = true;
            } finally {
                const warnings = [];

                if (bucketCreated) {
                    try {
                        const s3Cleanup = _createS3Client({
                            endpoint,
                            accessKeyId: effectiveAK,
                            secretAccessKey: effectiveSK,
                        });
                        await s3Cleanup.deleteObject(testBucket, testKey).catch(() => {});
                        await s3Cleanup.deleteBucket(testBucket);
                    } catch (e) {
                        if (bucketConfirmed) {
                            console.error(`[verify_storage] Bucket cleanup failed: ${e.message}`);
                            warnings.push('Test bucket cleanup failed (see server log)');
                        }
                    }
                }

                if (policyAttached) {
                    try {
                        const { data: detachData } = await http.post(
                            `${baseUrl}/api/v1/mc/policy-detach`,
                            { name: mintedUser, policy: mintedPolicyName },
                            { headers: { keycloaktoken: muse_token } }
                        );
                        if (detachData?.status !== 'detached') {
                            if (attachConfirmed) {
                                console.error(`[verify_storage] Policy detach failed: ${JSON.stringify(detachData)}`);
                                warnings.push('Policy detach failed (see server log)');
                            }
                        }
                    } catch (e) {
                        if (attachConfirmed) {
                            console.error(`[verify_storage] Policy detach failed: ${e.message}`);
                            warnings.push('Policy detach failed (see server log)');
                        }
                    }
                }

                if (mintedUser) {
                    try {
                        const { data: delUserData } = await http.del(
                            `${baseUrl}/api/v1/mc/user/${mintedUser}`,
                            { headers: { keycloaktoken: muse_token } }
                        );
                        if (delUserData?.success === false) {
                            if (mintConfirmed) {
                                console.error(`[verify_storage] User cleanup failed: ${JSON.stringify(delUserData)}`);
                                warnings.push('User cleanup failed (see server log)');
                            }
                        }
                    } catch (e) {
                        if (mintConfirmed) {
                            console.error(`[verify_storage] User cleanup failed: ${e.message}`);
                            warnings.push('User cleanup failed (see server log)');
                        }
                    }
                }

                if (policyCreated) {
                    try {
                        const { data: delPolicyData } = await http.del(
                            `${baseUrl}/api/v1/mc/policy/${mintedPolicyName}`,
                            { headers: { keycloaktoken: muse_token } }
                        );
                        if (delPolicyData?.status !== 'deleted') {
                            if (policyConfirmed) {
                                console.error(`[verify_storage] Policy cleanup failed: ${JSON.stringify(delPolicyData)}`);
                                warnings.push('Policy cleanup failed (see server log)');
                            }
                        }
                    } catch (e) {
                        if (policyConfirmed) {
                            console.error(`[verify_storage] Policy cleanup failed: ${e.message}`);
                            warnings.push('Policy cleanup failed (see server log)');
                        }
                    }
                }

                if (warnings.length > 0 && result) {
                    result.cleanup_warning = warnings.join('; ');
                }
            }

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(result, null, 2),
                }],
                ...(isError ? { isError: true } : {}),
            };
        },
    );
};

module.exports.validateHostAllowlist = validateHostAllowlist;
