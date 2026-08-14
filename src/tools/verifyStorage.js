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
            relayer_ui_url: z.string().optional().default('http://localhost:8888').describe('Relayer UI base URL (default: http://localhost:8888)'),
            endpoint: z.string().trim().url().optional().describe('S3 endpoint URL. Default: http://{docker-host}:9000. Pass an explicit IP (e.g. http://192.168.1.100:9000) when auto-detection cannot reach the host.'),
        },
        async ({ muse_token, access_key_id, secret_access_key, relayer_ui_url, endpoint }) => {
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
            let effectiveAK = access_key_id;
            let effectiveSK = secret_access_key;
            let result;
            let isError = false;

            try {
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
                    const { status: mintStatus, data: mintData } = await http.post(
                        `${relayer_ui_url}/api/v1/mc/user`,
                        { user: userName },
                        { headers: { keycloaktoken: muse_token } }
                    );
                    if (mintStatus !== 200) {
                        const detail = mintData?.message || mintData?.error || JSON.stringify(mintData);
                        throw new Error(`Mint user failed (HTTP ${mintStatus}): ${detail}`);
                    }
                    effectiveAK = mintData.access_key;
                    effectiveSK = mintData.secret_key;
                    mintedUser = userName;

                    if (mintData.success === false || !effectiveAK || !effectiveSK) {
                        const msg = mintData.message || mintData.Message || mintData.error || mintData.Error || 'response missing access_key/secret_key';
                        throw new Error(`Mint user failed: ${msg}`);
                    }

                    currentStep = 'CreatePolicy';
                    mintedPolicyName = `mcp-verify-policy-${runTs}`;
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
                    const { data: policyData } = await http.post(
                        `${relayer_ui_url}/api/v1/mc/policy-create`,
                        { name: mintedPolicyName, type: 'json', json: policyDocument },
                        { headers: { keycloaktoken: muse_token } }
                    );
                    // MC proxy echoes {success: true, policy} — Go response discarded
                    if (!policyData?.success) {
                        const detail = policyData?.message || policyData?.error || JSON.stringify(policyData);
                        throw new Error(`Create policy failed: ${detail}`);
                    }
                    policyCreated = true;

                    currentStep = 'AttachPolicy';
                    const { data: attachData } = await http.post(
                        `${relayer_ui_url}/api/v1/mc/policy`,
                        { name: mintedUser, policy: mintedPolicyName },
                        { headers: { keycloaktoken: muse_token } }
                    );
                    // Attach returns {status:"attached"} with NO success field
                    if (attachData?.status !== 'attached') {
                        const detail = attachData?.message || attachData?.error || JSON.stringify(attachData);
                        throw new Error(`Attach policy failed: ${detail}`);
                    }
                    policyAttached = true;
                }

                const s3 = _createS3Client({
                    endpoint,
                    accessKeyId: effectiveAK,
                    secretAccessKey: effectiveSK,
                });

                currentStep = 'CreateBucket';
                await s3.createBucket(testBucket);
                bucketCreated = true;

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
                const explicitIpHint = endpointAutoDetected
                    ? ' If the endpoint cannot be reached, pass an explicit IP via the endpoint option (e.g. "http://<ip>:9000").'
                    : '';
                result = {
                    success: false,
                    error: `Storage verification failed at ${currentStep}: ${err.message}.${explicitIpHint}`,
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
                        warnings.push(`Test bucket cleanup failed: ${e.message}`);
                    }
                }

                if (policyAttached) {
                    try {
                        const { data: detachData } = await http.post(
                            `${relayer_ui_url}/api/v1/mc/policy-detach`,
                            { name: mintedUser, policy: mintedPolicyName },
                            { headers: { keycloaktoken: muse_token } }
                        );
                        if (detachData?.status !== 'detached') {
                            const detail = detachData?.message || JSON.stringify(detachData);
                            warnings.push(`Policy detach failed: ${detail}`);
                        }
                    } catch (e) {
                        warnings.push(`Policy detach failed: ${e.message}`);
                    }
                }

                if (mintedUser) {
                    try {
                        const { data: delUserData } = await http.del(
                            `${relayer_ui_url}/api/v1/mc/user/${mintedUser}`,
                            { headers: { keycloaktoken: muse_token } }
                        );
                        if (delUserData?.success === false) {
                            const detail = delUserData?.message || JSON.stringify(delUserData);
                            warnings.push(`User cleanup failed: ${detail}`);
                        }
                    } catch (e) {
                        warnings.push(`User cleanup failed: ${e.message}`);
                    }
                }

                if (policyCreated) {
                    try {
                        const { data: delPolicyData } = await http.del(
                            `${relayer_ui_url}/api/v1/mc/policy/${mintedPolicyName}`,
                            { headers: { keycloaktoken: muse_token } }
                        );
                        if (delPolicyData?.status !== 'deleted') {
                            const detail = delPolicyData?.message || JSON.stringify(delPolicyData);
                            warnings.push(`Policy cleanup failed: ${detail}`);
                        }
                    } catch (e) {
                        warnings.push(`Policy cleanup failed: ${e.message}`);
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
