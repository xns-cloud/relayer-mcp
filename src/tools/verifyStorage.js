'use strict';

const { z } = require('zod');
const { createS3Client } = require('../lib/s3Client');

/**
 * Tool 10: verify_storage
 * AC-20: targets localhost:9000 plain HTTP; reports endpoint.
 * AC-21: verify fail → names the failing step (CreateBucket/PutObject/GetObject).
 * R6: S3 credentials must be provided (from relayer-ui IAM key-mgmt flow).
 *
 * Performs a round-trip verification: CreateBucket → PutObject → GetObject → compare.
 */
module.exports = function registerVerifyStorage(server, options = {}) {
    const _createS3Client = options.createS3Client || createS3Client;

    server.tool(
        'verify_storage',
        'Verify the S3-compatible storage gateway is working by performing a round-trip test: create a test bucket, upload a small object, download it, and compare. Targets http://localhost:9000 (the local S3 gateway). You must provide S3 access credentials — these can be found in the Relayer configuration or generated via the Relayer UI.',
        {
            access_key_id: z.string().describe('S3 access key ID'),
            secret_access_key: z.string().describe('S3 secret access key'),
            endpoint: z.string().optional().default('http://localhost:9000').describe('S3 endpoint URL (default: http://localhost:9000)'),
        },
        async ({ access_key_id, secret_access_key, endpoint }) => {
            const testBucket = `mcp-verify-${Date.now()}`;
            const testKey = 'verify-test.txt';
            const testContent = `relayer-mcp verification ${Date.now()}`;
            let currentStep = 'init';

            try {
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
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: 'Storage verification failed at Compare: uploaded content does not match downloaded content. The S3 gateway may have data integrity issues.',
                                endpoint,
                                failing_step: 'Compare',
                            }),
                        }],
                        isError: true,
                    };
                }

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: true,
                            message: `S3 storage verification passed. Successfully created bucket, uploaded object, and verified download at ${endpoint}.`,
                            endpoint,
                            test_bucket: testBucket,
                        }, null, 2),
                    }],
                };
            } catch (err) {
                // AC-21: name the failing step
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            error: `Storage verification failed at ${currentStep}: ${err.message}`,
                            endpoint,
                            failing_step: currentStep,
                        }),
                    }],
                    isError: true,
                };
            }
        },
    );
};
