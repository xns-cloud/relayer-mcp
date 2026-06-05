'use strict';

const { z } = require('zod');
const { createS3Client } = require('../lib/s3Client');
const { createDockerUtil } = require('../lib/dockerUtil');

/**
 * Tool 10: verify_storage
 * AC-20: targets the S3 gateway on port 9000 plain HTTP; reports endpoint.
 * AC-21: verify fail → names the failing step (CreateBucket/PutObject/GetObject).
 * W3-AC1: cleanup in finally — always removes mcp-verify-* bucket/object; failure
 *         is non-fatal (noted in response, never flips pass→fail).
 * W3-AC2: fullaccess credential requirement stated in description and error output.
 * W3-AC3: explicit-IP hint when endpoint was auto-detected.
 * R6: S3 credentials must be provided (from relayer-ui IAM key-mgmt flow).
 *
 * Performs a round-trip verification: CreateBucket → PutObject → GetObject → compare.
 * Remote Docker: when endpoint is omitted, it defaults to port 9000 on the
 * machine the Docker daemon runs on (auto-detected), not blindly localhost.
 */
module.exports = function registerVerifyStorage(server, options = {}) {
    const _createS3Client = options.createS3Client || createS3Client;
    const docker = options.dockerUtil || createDockerUtil(options);

    server.tool(
        'verify_storage',
        'Verify the S3-compatible storage gateway is working by performing a round-trip test: create a test bucket, upload a small object, download it, and compare. IMPORTANT: you must supply fullaccess credentials — the admin key pair created via the Relayer UI IAM page (not a read-only or bucket-scoped key). By default targets port 9000 on the machine the Docker daemon runs on (auto-detected from the Docker context — supports remote ssh:// Docker hosts); pass endpoint to override with an explicit IP when auto-detection cannot reach the host.',
        {
            access_key_id: z.string().describe('S3 access key ID (fullaccess credentials from the Relayer UI IAM page)'),
            secret_access_key: z.string().describe('S3 secret access key (fullaccess credentials from the Relayer UI IAM page)'),
            endpoint: z.string().trim().url().optional().describe('S3 endpoint URL. Default: http://{docker-host}:9000, where {docker-host} is auto-detected from the Docker context. Pass an explicit IP (e.g. http://192.168.1.100:9000) when auto-detection cannot reach the host.'),
        },
        async ({ access_key_id, secret_access_key, endpoint }) => {
            const testBucket = `mcp-verify-${Date.now()}`;
            const testKey = 'verify-test.txt';
            const testContent = `relayer-mcp verification ${Date.now()}`;
            let currentStep = 'init';
            let endpointAutoDetected = false;

            let verifyResult = null;

            try {
                if (!endpoint) {
                    const { host } = await docker.getDockerHost();
                    endpoint = `http://${host}:9000`;
                    endpointAutoDetected = true;
                }
                const s3 = _createS3Client({
                    endpoint,
                    accessKeyId: access_key_id,
                    secretAccessKey: secret_access_key,
                });

                // Step 1: CreateBucket
                currentStep = 'CreateBucket';
                await s3.createBucket(testBucket);

                // Step 2: PutObject
                currentStep = 'PutObject';
                await s3.putObject(testBucket, testKey, testContent);

                // Step 3: GetObject
                currentStep = 'GetObject';
                const retrieved = await s3.getObject(testBucket, testKey);

                // Step 4: Compare
                currentStep = 'Compare';
                if (retrieved !== testContent) {
                    verifyResult = {
                        success: false,
                        error: 'Storage verification failed at Compare: uploaded content does not match downloaded content. The S3 gateway may have data integrity issues.',
                        endpoint,
                        failing_step: 'Compare',
                    };
                } else {
                    const explicitIpHint = endpointAutoDetected
                        ? `If auto-detection cannot reach the host, pass an explicit endpoint: endpoint option (e.g. "http://<ip>:9000").`
                        : null;

                    verifyResult = {
                        success: true,
                        message: `S3 storage verification passed. Successfully created bucket, uploaded object, and verified download at ${endpoint}.`,
                        endpoint,
                        test_bucket: testBucket,
                        ...(explicitIpHint ? { note: explicitIpHint } : {}),
                    };
                }

                // Cleanup: remove test object and bucket (W3-AC1)
                try {
                    await s3.deleteObject(testBucket, testKey);
                    await s3.deleteBucket(testBucket);
                } catch (cleanupErr) {
                    // Non-fatal: note it but never flip the result
                    verifyResult.cleanup_warning = `Test bucket cleanup failed (${cleanupErr.message}). The bucket "${testBucket}" may remain — remove it manually via the Relayer UI.`;
                }

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(verifyResult, null, 2),
                    }],
                    ...(verifyResult.success ? {} : { isError: true }),
                };
            } catch (err) {
                // Attempt cleanup even on error (W3-AC1)
                let cleanupWarning;
                if (currentStep !== 'init' && currentStep !== 'CreateBucket') {
                    // Bucket was created before the failure — try to clean up
                    try {
                        const s3Cleanup = _createS3Client({
                            endpoint,
                            accessKeyId: access_key_id,
                            secretAccessKey: secret_access_key,
                        });
                        await s3Cleanup.deleteObject(testBucket, testKey).catch(() => {});
                        await s3Cleanup.deleteBucket(testBucket);
                    } catch (cleanupErr) {
                        cleanupWarning = `Test bucket cleanup failed (${cleanupErr.message}). The bucket "${testBucket}" may remain — remove it manually.`;
                    }
                }

                const isCredentialError = /AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch|Forbidden|401|403/i.test(err.message);
                const credentialHint = isCredentialError
                    ? ' Ensure you are using fullaccess credentials from the Relayer UI IAM page (not a read-only or bucket-scoped key).'
                    : '';

                const explicitIpHint = endpointAutoDetected
                    ? ` If the endpoint cannot be reached, pass an explicit IP via the endpoint option (e.g. "http://<ip>:9000").`
                    : '';

                // AC-21: name the failing step
                const errorPayload = {
                    success: false,
                    error: `Storage verification failed at ${currentStep}: ${err.message}.${credentialHint}${explicitIpHint}`,
                    endpoint,
                    failing_step: currentStep,
                    ...(isCredentialError ? { credential_requirement: 'fullaccess credentials required — use the admin key pair from the Relayer UI IAM page.' } : {}),
                    ...(cleanupWarning ? { cleanup_warning: cleanupWarning } : {}),
                };

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(errorPayload),
                    }],
                    isError: true,
                };
            }
        },
    );
};
