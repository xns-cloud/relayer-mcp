'use strict';

/**
 * setup_cli_credentials and a ~/.xns/credentials file that is already there.
 *
 * The xns CLI keeps many named profiles in that file, and a Relayer shows an S3 secret
 * key only once. A profile this tool drops cannot be recovered.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { z } = require('zod');

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

async function run({ onPost } = {}) {
    const posts = [];
    let state = null;
    let tool;
    require('../tools/setupCliCredentials')(
        { registerTool: (name, config, handler) => { tool = { config, handler }; } },
        {
            acquireToken: async () => ({ access_token: 'T', refresh_token: 'r', expires_at: Date.now() + 3600000 }),
            _tokenStateModule: { get: () => state, set: (s) => { state = s; }, clear: () => { state = null; } },
            httpClient: {
                post: async (u) => {
                    posts.push(u);
                    if (onPost) onPost();
                    return { status: 200, data: { access_key: 'AK-new', secret_key: 'SK-new' } };
                },
                get: async () => ({ status: 200, data: {} }),
            },
        }
    );
    const args = z.object(tool.config.inputSchema).parse({ installation_id: 'cc-new' });
    const reply = JSON.parse((await tool.handler(args)).content[0].text);
    return { posts, reply };
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
            onPost: () => seed({ version: 1, profiles: { work: profile('work'), late: profile('late') }, active_profile: 'late' }),
        });

        expect(readCreds()).toEqual({
            version: 1,
            profiles: { work: profile('work'), late: profile('late'), default: NEW_PROFILE },
            active_profile: 'late',
        });
    });

    test.each([
        ['not JSON', '[default]\naws_access_key_id = AKIA\n'],
        ['a JSON array', '[]'],
        ['another version', JSON.stringify({ version: 2, profiles: {}, active_profile: 'default' })],
        ['a profile list', JSON.stringify({ version: 1, profiles: [], active_profile: 'default' })],
        ['no profiles', JSON.stringify({ version: 1, active_profile: 'default' })],
    ])('%s: refused before a user is created, and the file is untouched', async (_, content) => {
        seed(content);

        const { posts, reply } = await run();

        expect(posts).toEqual([]);
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

test('with no credentials file, writes one default profile and makes it active', async () => {
    const { reply } = await run();

    expect(readCreds()).toEqual({ version: 1, profiles: { default: NEW_PROFILE }, active_profile: 'default' });
    expect(reply).toMatchObject({ success: true, profile: 'default', active_profile: 'default' });
});
