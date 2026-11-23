'use strict';

/**
 * setup_cli_credentials: the permissions of the user it makes, and a ~/.xns/credentials
 * file that is already there.
 *
 * The gateway denies every request from a user with no policy, so a key without one is of
 * no use. The xns CLI keeps many named profiles in that file, and a Relayer shows an S3
 * secret key only once. A profile this tool drops cannot be recovered.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { z } = require('zod');
const { mockRelayer } = require('./helpers/mockRelayer');

let home;
let credsPath;

beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'xns-creds-'));
    credsPath = path.join(home, '.xns', 'credentials');
    jest.spyOn(os, 'homedir').mockReturnValue(home);
});

afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
});

const profile = (name) => ({
    endpoint: `https://${name}.example.com:9000`,
    access_key_id: `AK-${name}`,
    secret_access_key: `SK-${name}`,
    cost_center_id: `cc-${name}`,
    muse_token: '',
});

function seed(content) {
    fs.mkdirSync(path.dirname(credsPath), { recursive: true });
    fs.writeFileSync(credsPath, typeof content === 'string' ? content : JSON.stringify(content));
}

const readCreds = () => JSON.parse(fs.readFileSync(credsPath, 'utf8'));

const NEW_KEYS = { access_key: 'AK-new', secret_key: 'SK-new' };

// onUser runs while the Relayer is making the user; routes replaces other Relayer answers.
async function run({ onUser, routes = {} } = {}) {
    const relayer = mockRelayer({
        keys: NEW_KEYS,
        routes: {
            'POST /user': () => {
                if (onUser) onUser();
                return { status: 200, data: NEW_KEYS };
            },
            ...routes,
        },
    });
    let state = null;
    let tool;
    require('../tools/setupCliCredentials')(
        { registerTool: (name, config, handler) => { tool = { config, handler }; } },
        {
            acquireToken: async () => ({ access_token: 'T', refresh_token: 'r', expires_at: Date.now() + 3600000 }),
            _tokenStateModule: { get: () => state, set: (s) => { state = s; }, clear: () => { state = null; } },
            httpClient: relayer.httpClient,
        }
    );
    const args = z.object(tool.config.inputSchema).parse({ installation_id: 'cc-new' });
    const reply = JSON.parse((await tool.handler(args)).content[0].text);
    return { calls: relayer.calls, routes: relayer.routes(), reply };
}

const NEW_PROFILE = {
    endpoint: 'http://localhost:9000',
    access_key_id: 'AK-new',
    secret_access_key: 'SK-new',
    cost_center_id: 'cc-new',
    muse_token: '',
};

describe('an existing credentials file', () => {
    test('keeps every profile and the active one, and adds the new keys beside them', async () => {
        const before = {
            version: 1,
            profiles: { default: profile('home'), work: profile('work') },
            active_profile: 'work',
        };
        seed(before);

        const { reply } = await run();

        expect(readCreds()).toEqual({
            version: 1,
            profiles: { ...before.profiles, 'xns-cli': NEW_PROFILE },
            active_profile: 'work',
        });
        expect(reply).toMatchObject({ success: true, profile: 'xns-cli', active_profile: 'work' });
        expect(reply.message).toContain('xns --profile xns-cli ls');
    });

    test('takes the next free name when an earlier run already wrote xns-cli', async () => {
        const before = {
            version: 1,
            profiles: { default: profile('home'), 'xns-cli': profile('first') },
            active_profile: 'default',
        };
        seed(before);

        const { reply } = await run();

        expect(readCreds().profiles).toEqual({ ...before.profiles, 'xns-cli-2': NEW_PROFILE });
        expect(reply.profile).toBe('xns-cli-2');
    });

    test('fills the keyless default profile that `xns register` leaves', async () => {
        const empty = { endpoint: '', access_key_id: '', secret_access_key: '', cost_center_id: '', muse_token: '' };
        seed({ version: 1, profiles: { default: empty, work: profile('work') }, active_profile: 'default' });

        const { reply } = await run();

        expect(readCreds().profiles).toEqual({ default: NEW_PROFILE, work: profile('work') });
        expect(reply).toMatchObject({ success: true, profile: 'default', active_profile: 'default' });
        expect(reply.message).toContain('`xns ls`');
    });

    test('keeps a profile another program saves while the Relayer is answering', async () => {
        seed({ version: 1, profiles: { work: profile('work') }, active_profile: 'work' });

        await run({
            onUser: () => seed({ version: 1, profiles: { work: profile('work'), late: profile('late') }, active_profile: 'late' }),
        });

        expect(readCreds()).toEqual({
            version: 1,
            profiles: { work: profile('work'), late: profile('late'), default: NEW_PROFILE },
            active_profile: 'late',
        });
    });

    test('a file that stops being readable after the keys are issued: names the user to delete', async () => {
        seed({ version: 1, profiles: { work: profile('work') }, active_profile: 'work' });
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const { reply } = await run({ onUser: () => seed('not json') });

        expect(reply.error).toContain('delete the user xns-cli');
        expect(fs.readFileSync(credsPath, 'utf8')).toBe('not json');
    });

    test.each([
        ['not JSON', '[default]\naws_access_key_id = AKIA\n'],
        ['a JSON array', '[]'],
        ['another version', JSON.stringify({ version: 2, profiles: {}, active_profile: 'default' })],
        ['a profile list', JSON.stringify({ version: 1, profiles: [], active_profile: 'default' })],
        ['no profiles', JSON.stringify({ version: 1, active_profile: 'default' })],
    ])('%s: refused before a user is created, and the file is untouched', async (_, content) => {
        seed(content);

        const { routes, reply } = await run();

        expect(routes).toEqual([]);
        expect(fs.readFileSync(credsPath, 'utf8')).toBe(content);
        expect(reply.success).toBe(false);
        expect(reply.error).toContain('~/.xns/credentials');
    });

    test('an active_profile that names no profile is pointed at the new one', async () => {
        seed({ version: 1, profiles: { work: profile('work') }, active_profile: 'gone' });

        await run();

        expect(readCreds().active_profile).toBe('default');
    });

    test('ends at mode 0600 and leaves no temporary file', async () => {
        seed({ version: 1, profiles: { work: profile('work') }, active_profile: 'work' });
        fs.chmodSync(credsPath, 0o644);

        await run();

        // Windows reports a writable file as 0666 whatever mode it was created with.
        if (process.platform !== 'win32') expect(fs.statSync(credsPath).mode & 0o777).toBe(0o600);
        expect(fs.readdirSync(path.dirname(credsPath))).toEqual(['credentials']);
    });

    test('each write has its own temporary file and leaves the one the xns CLI uses alone', async () => {
        seed({ version: 1, profiles: { work: profile('work') }, active_profile: 'work' });
        fs.writeFileSync(`${credsPath}.tmp`, 'the CLI is writing this');
        const renames = jest.spyOn(fs, 'renameSync');

        await run();
        await run();

        expect(fs.readFileSync(`${credsPath}.tmp`, 'utf8')).toBe('the CLI is writing this');
        expect(new Set(renames.mock.calls.map(([from]) => from)).size).toBe(2);
        expect(Object.keys(readCreds().profiles)).toEqual(['work', 'default', 'xns-cli']);
    });

    test('a write that fails part way leaves the old file whole and names the user to delete', async () => {
        const before = { version: 1, profiles: { work: profile('work') }, active_profile: 'work' };
        seed(before);
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const realWrite = fs.writeFileSync;
        jest.spyOn(fs, 'writeFileSync').mockImplementationOnce((file) => {
            realWrite(file, '{"vers');
            throw new Error('ENOSPC');
        });

        const { reply } = await run();

        expect(reply.success).toBe(false);
        expect(reply.error).toContain('delete the user xns-cli');
        expect(readCreds()).toEqual(before);
        expect(fs.readdirSync(path.dirname(credsPath))).toEqual(['credentials']);
    });
});

describe('the permissions of the new user', () => {
    const POLICY = {
        Version: '2012-10-17',
        Statement: [{
            Effect: 'Allow',
            Action: [
                's3:GetObject', 's3:GetObjectVersion', 's3:HeadObject', 's3:ListBucket', 's3:ListBucketVersions',
                's3:ListAllMyBuckets', 's3:GetBucketLocation', 's3:GetBucketPolicy', 's3:GetBucketTagging',
                's3:GetBucketVersioning', 's3:GetObjectTagging', 's3:GetObjectAttributes',
                's3:ListBucketMultipartUploads', 's3:ListMultipartUploadParts', 's3:PutObject', 's3:DeleteObject',
                's3:CreateMultipartUpload', 's3:UploadPart', 's3:CompleteMultipartUpload', 's3:AbortMultipartUpload',
                's3:PutObjectTagging', 's3:DeleteObjectTagging', 's3:CreateBucket', 's3:DeleteBucket',
            ],
            Resource: ['arn:aws:s3:::*', 'arn:aws:s3:::*/*'],
        }],
    };
    const SECRET_TEXT = 'pq: internal text from the Relayer';
    const FAILURES = [
        ['HTTP 500', { status: 500, data: { message: SECRET_TEXT } }],
        ['a refusal', { status: 200, data: { success: false, message: SECRET_TEXT } }],
        ['no answer', () => { throw new Error(SECRET_TEXT); }],
        ['a web page', { status: 200, data: '<!doctype html>' }],
        ['an empty body', { status: 200, data: null }],
    ];
    const before = { version: 1, profiles: { work: profile('work') }, active_profile: 'work' };

    const policyTaken = { status: 200, data: { success: false, message: 'policy already exists' } };
    const stored = (name, policyJson) => ({ status: 200, data: { policy_name: name, policy_json: policyJson } });
    const expectNothingSaved = () => {
        expect(readCreds()).toEqual(before);
        expect(fs.readdirSync(path.dirname(credsPath))).toEqual(['credentials']);
    };

    beforeEach(() => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    test('a policy is created and attached to the user, with the token and no redirects, before anything is saved', async () => {
        let savedAtAttach;
        const { calls, routes, reply } = await run({
            routes: {
                'POST /policy': () => {
                    savedAtAttach = fs.existsSync(credsPath);
                    return { status: 200, data: { status: 'attached' } };
                },
            },
        });

        expect(routes).toEqual(['POST /user', 'POST /policy-create', 'POST /policy']);
        const [, create, attach] = calls;
        expect(create.body).toEqual({ name: 'xns-cli', type: 'json', json: expect.any(String) });
        expect(JSON.parse(create.body.json)).toEqual(POLICY);
        expect(attach.body).toEqual({ name: 'xns-cli', policy: 'xns-cli' });
        for (const { config } of [create, attach]) {
            expect(config.headers.keycloaktoken).toBe('T');
            expect(config.maxRedirects).toBe(0);
        }
        expect(savedAtAttach).toBe(false);
        expect(reply.success).toBe(true);
        expect(readCreds().profiles.default).toEqual(NEW_PROFILE);
    });

    test.each(FAILURES)('policy create answers with %s: the user is deleted and the file is untouched', async (_, answer) => {
        seed(before);

        const { calls, routes, reply } = await run({ routes: { 'POST /policy-create': answer } });

        expect(routes).not.toContain('POST /policy');
        expect(routes.at(-1)).toBe('DELETE /user/xns-cli');
        expect(calls.at(-1).config).toMatchObject({ headers: { keycloaktoken: 'T' }, maxRedirects: 0 });
        expect(reply).toEqual({ success: false, error: expect.stringContaining('that user was deleted') });
        expect(JSON.stringify(reply)).not.toContain(SECRET_TEXT);
        expectNothingSaved();
    });

    test.each(FAILURES)('policy attach answers with %s: the user is deleted and the file is untouched', async (_, answer) => {
        seed(before);

        const { routes, reply } = await run({ routes: { 'POST /policy': answer } });

        expect(routes).toEqual(['POST /user', 'POST /policy-create', 'POST /policy', 'DELETE /user/xns-cli']);
        expect(reply).toEqual({ success: false, error: expect.stringContaining('that user was deleted') });
        expect(JSON.stringify(reply)).not.toContain(SECRET_TEXT);
        expectNothingSaved();
    });

    test('with no credentials file, a failed attach leaves none behind', async () => {
        await run({ routes: { 'POST /policy': { status: 500, data: {} } } });

        expect(fs.existsSync(path.dirname(credsPath))).toBe(false);
    });

    test.each(FAILURES)('the user delete answers with %s: the reply names the user to delete', async (_, answer) => {
        seed(before);

        const { reply } = await run({
            routes: { 'POST /policy': { status: 500, data: {} }, 'DELETE /user/xns-cli': answer },
        });

        expect(reply).toEqual({ success: false, error: expect.stringContaining('Ask the user to delete the user xns-cli') });
        expect(JSON.stringify(reply)).not.toContain(SECRET_TEXT);
        expectNothingSaved();
    });

    test.each([
        ['policy create', { 'POST /policy-create': FAILURES[1][1] }],
        ['policy attach', { 'POST /policy': FAILURES[1][1] }],
        ['user delete', { 'POST /policy': { status: 500, data: {} }, 'DELETE /user/xns-cli': FAILURES[1][1] }],
    ])('the server log holds the reason the Relayer gave when the %s is refused', async (step, routes) => {
        await run({ routes });

        const logged = console.error.mock.calls.flat().find((line) => line.includes(`${step} failed`));
        expect(logged).toContain(SECRET_TEXT);
    });

    test('a policy an earlier run left is attached, and no second one is made', async () => {
        const { calls, routes, reply } = await run({
            routes: { 'POST /policy-create': policyTaken, 'GET /policy/xns-cli': stored('xns-cli', POLICY) },
        });

        expect(routes).toEqual(['POST /user', 'POST /policy-create', 'GET /policy/xns-cli', 'POST /policy']);
        expect(calls[2].config).toMatchObject({ headers: { keycloaktoken: 'T' }, maxRedirects: 0 });
        expect(calls[3].body).toEqual({ name: 'xns-cli', policy: 'xns-cli' });
        expect(reply.success).toBe(true);
    });

    test('a policy of that name with other rules is left alone and the next name is used', async () => {
        const other = { ...POLICY, Statement: [{ ...POLICY.Statement[0], Action: ['s3:*'] }] };
        const { calls, routes, reply } = await run({
            routes: {
                'POST /policy-create': ({ name }) => (name === 'xns-cli' ? policyTaken : { status: 200, data: { success: true } }),
                'GET /policy/xns-cli': stored('xns-cli', other),
            },
        });

        expect(routes).toEqual(['POST /user', 'POST /policy-create', 'GET /policy/xns-cli', 'POST /policy-create', 'POST /policy']);
        expect(calls.at(-1).body).toEqual({ name: 'xns-cli', policy: 'xns-cli-2' });
        expect(reply.success).toBe(true);
    });

    test('stops after ten names that hold other rules, and deletes the user', async () => {
        seed(before);
        const names = ['xns-cli', ...Array.from({ length: 20 }, (_, i) => `xns-cli-${i + 2}`)];
        const { routes, reply } = await run({
            routes: {
                'POST /policy-create': policyTaken,
                ...Object.fromEntries(names.map((n) => [`GET /policy/${n}`, stored(n, {})])),
            },
        });

        expect(routes.filter((r) => r === 'POST /policy-create')).toHaveLength(10);
        expect(routes.at(-1)).toBe('DELETE /user/xns-cli');
        expect(reply.success).toBe(false);
        expectNothingSaved();
    });

    test('a user xns-cli that was already there is neither changed nor deleted', async () => {
        seed(before);

        const { routes, reply } = await run({
            routes: { 'POST /user': { status: 200, data: { success: false, message: 'already exists' } } },
        });

        expect(routes).toEqual(['POST /user']);
        expect(reply.success).toBe(false);
        expect(reply.hint).toContain('delete xns-cli in the Relayer UI');
        expectNothingSaved();
    });
});

test('with no credentials file, writes one default profile and makes it active', async () => {
    const { reply } = await run();

    expect(readCreds()).toEqual({ version: 1, profiles: { default: NEW_PROFILE }, active_profile: 'default' });
    expect(reply).toMatchObject({ success: true, profile: 'default', active_profile: 'default' });
});
