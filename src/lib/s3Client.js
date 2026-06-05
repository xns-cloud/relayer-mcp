'use strict';

const {
    S3Client,
    CreateBucketCommand,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
    DeleteBucketCommand,
} = require('@aws-sdk/client-s3');

/**
 * S3 client for verify_storage (Tool 10).
 * Targets localhost:9000 plain HTTP with forcePathStyle.
 *
 * @param {object} [options]
 * @param {string} [options.endpoint] - S3 endpoint (default: http://localhost:9000)
 * @param {string} [options.region] - AWS region (default: us-east-1)
 * @param {string} options.accessKeyId
 * @param {string} options.secretAccessKey
 * @param {object} [options.s3Client] - Injected S3Client instance (testing)
 */
function createS3Client(options = {}) {
    const client = options.s3Client || new S3Client({
        endpoint: options.endpoint || 'http://localhost:9000',
        region: options.region || 'us-east-1',
        forcePathStyle: true,
        credentials: {
            accessKeyId: options.accessKeyId,
            secretAccessKey: options.secretAccessKey,
        },
    });

    return {
        /**
         * @param {string} bucket
         * @returns {Promise<void>}
         */
        async createBucket(bucket) {
            await client.send(new CreateBucketCommand({ Bucket: bucket }));
        },

        /**
         * @param {string} bucket
         * @param {string} key
         * @param {Buffer|string} body
         * @returns {Promise<void>}
         */
        async putObject(bucket, key, body) {
            await client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: body,
            }));
        },

        /**
         * @param {string} bucket
         * @param {string} key
         * @returns {Promise<string>}
         */
        async getObject(bucket, key) {
            const resp = await client.send(new GetObjectCommand({
                Bucket: bucket,
                Key: key,
            }));
            return resp.Body.transformToString();
        },

        /**
         * @param {string} bucket
         * @param {string} key
         * @returns {Promise<void>}
         */
        async deleteObject(bucket, key) {
            await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        },

        /**
         * @param {string} bucket
         * @returns {Promise<void>}
         */
        async deleteBucket(bucket) {
            await client.send(new DeleteBucketCommand({ Bucket: bucket }));
        },

        /** Expose the raw client for advanced use */
        client,
    };
}

module.exports = { createS3Client };
