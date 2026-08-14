'use strict';

const defaultDockerUtil = {
    getDockerHost: jest.fn().mockResolvedValue({ remote: false, host: 'localhost', endpoint: 'unix:///var/run/docker.sock' }),
};

function createMintingHttpMock(overrides = {}) {
    const defaults = {
        mint: { status: 200, data: { user_name: 'mcp-verify-test', access_key: 'ak-minted', secret_key: 'sk-minted', created_at: '2026-01-01' } },
        policyCreate: { status: 200, data: { success: true, policy: {} } },
        attach: { status: 200, data: { status: 'attached' } },
        detach: { status: 200, data: { status: 'detached' } },
        deleteUser: { status: 200, data: {} },
        deletePolicy: { status: 200, data: { status: 'deleted' } },
    };
    const r = { ...defaults, ...overrides };

    return {
        post: jest.fn().mockImplementation(async (url) => {
            if (url.endsWith('/mc/policy-create')) return r.policyCreate;
            if (url.endsWith('/mc/policy-detach')) return r.detach;
            if (url.endsWith('/mc/policy')) return r.attach;
            if (url.endsWith('/mc/user')) return r.mint;
            return { status: 404, data: {} };
        }),
        del: jest.fn().mockImplementation(async (url) => {
            if (url.includes('/mc/user/')) return r.deleteUser;
            if (url.includes('/mc/policy/')) return r.deletePolicy;
            return { status: 404, data: {} };
        }),
        get: jest.fn(),
    };
}

function createPassingS3Mock() {
    let capturedContent;
    return {
        createBucket: jest.fn().mockResolvedValue(undefined),
        putObject: jest.fn().mockImplementation(async (bucket, key, body) => { capturedContent = body; }),
        getObject: jest.fn().mockImplementation(async () => capturedContent),
        deleteObject: jest.fn().mockResolvedValue(undefined),
        deleteBucket: jest.fn().mockResolvedValue(undefined),
    };
}

function registerWithOptions(server, opts) {
    const register = require('../../tools/verifyStorage');
    register(server, {
        dockerUtil: defaultDockerUtil,
        ...opts,
    });
    return server.tool.mock.calls[0][3];
}

module.exports = {
    defaultDockerUtil,
    createMintingHttpMock,
    createPassingS3Mock,
    registerWithOptions,
};
