'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { isDeepStrictEqual } = require('util');
const { z } = require('zod');
const { createHttpClient } = require('../lib/httpClient');
const { createTokenManager } = require('../lib/ensureToken');
const { NO_REDIRECT_TOKEN_CONFIG } = require('../lib/hostAllowlist');

const DEFAULT_UI_PORT = 8888;
const RELAYER_UI_BASE = `http://localhost:${DEFAULT_UI_PORT}`;

// The Relayer user, its policy, and the profile used when `default` already holds keys.
const CLI_NAME = 'xns-cli';

/**
 * DECISION: the key is the account owner's own, so it gets the gateway's ReadWrite actions
 * plus s3:DeleteBucket, on every bucket. The actions are spelled out in a policy of its own
 * because a Relayer already installed may not have a built-in set by that name.
 */
const CLI_POLICY = {
    Version: '2012-10-17',
    Statement: [{
        Effect: 'Allow',
        Action: [
            's3:GetObject',
            's3:GetObjectVersion',
            's3:HeadObject',
            's3:ListBucket',
            's3:ListBucketVersions',
            's3:ListAllMyBuckets',
            's3:GetBucketLocation',
            's3:GetBucketPolicy',
            's3:GetBucketTagging',
            's3:GetBucketVersioning',
            's3:GetObjectTagging',
            's3:GetObjectAttributes',
            's3:ListBucketMultipartUploads',
            's3:ListMultipartUploadParts',
            's3:PutObject',
            's3:DeleteObject',
            's3:CreateMultipartUpload',
            's3:UploadPart',
            's3:CompleteMultipartUpload',
            's3:AbortMultipartUpload',
            's3:PutObjectTagging',
            's3:DeleteObjectTagging',
            's3:CreateBucket',
            's3:DeleteBucket',
        ],
        Resource: ['arn:aws:s3:::*', 'arn:aws:s3:::*/*'],
    }],
};

// How many policy names to try when earlier ones hold other rules.
const MAX_POLICY_NAMES = 10;

const BAD_FILE_ERROR = '~/.xns/credentials exists but could not be read as an XNS credentials file, so it was left as it is. Ask the user to fix it or move it aside, then call setup_cli_credentials again.';

const NOT_SAVED_ERROR = 'The Relayer created the user xns-cli, but its keys could not be saved to ~/.xns/credentials. See the server log for detail. Ask the user to delete the user xns-cli in the Relayer UI and make sure that file can be written, then call setup_cli_credentials again.';

const NO_POLICY_ERROR = 'The Relayer did not give the new user xns-cli its permissions, so that user was deleted and nothing was saved to ~/.xns/credentials. See the server log for detail, then call setup_cli_credentials again.';

const USER_LEFT_ERROR = 'The Relayer created the user xns-cli but did not give it its permissions, and that user could not be deleted. Nothing was saved to ~/.xns/credentials. See the server log for detail. Ask the user to delete the user xns-cli in the Relayer UI, then call setup_cli_credentials again.';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Read the credentials file the xns CLI uses. Absent file: an empty set. A file that is
 * there but is not one the CLI would load throws CREDS_UNREADABLE, because writing over
 * it would drop keys a Relayer shows only once.
 */
function readCredentials(credsPath) {
    let creds;
    try {
        creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') return { version: 1, profiles: {} };
        // JSON.parse quotes the text it failed on, which may be a key: never pass it on.
        throw Object.assign(new Error(`credentials file unreadable (${err.code || 'not JSON'})`), { code: 'CREDS_UNREADABLE' });
    }
    if (!isPlainObject(creds) || creds.version !== 1 || !isPlainObject(creds.profiles)) {
        throw Object.assign(new Error('credentials file is not XNS version 1'), { code: 'CREDS_UNREADABLE' });
    }
    return creds;
}

/**
 * DECISION: a profile that holds a secret key is never replaced, `default` included. The
 * new keys go to `default` when it is absent or keyless (`xns register` writes it keyless),
 * otherwise to the first free xns-cli, xns-cli-2, ... name.
 */
function pickProfileName(profiles) {
    if (!Object.hasOwn(profiles, 'default') || !profiles.default?.secret_access_key) return 'default';
    let name = CLI_NAME;
    for (let n = 2; Object.hasOwn(profiles, name); n += 1) name = `${CLI_NAME}-${n}`;
    return name;
}

/**
 * Replace the file in one step, so a failed write cannot cut short the profiles in it.
 * The temporary file is this write's own: the xns CLI or a second server may be saving at
 * the same moment, and must not take it. 'wx' creates it fresh, which makes mode 0600 hold
 * whatever the old file's mode was.
 */
function writeCredentials(credsPath, creds) {
    fs.mkdirSync(path.dirname(credsPath), { recursive: true, mode: 0o700 });
    const tmp = `${credsPath}.${crypto.randomUUID()}.tmp`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(creds, null, 2), { mode: 0o600, flag: 'wx' });
        fs.renameSync(tmp, credsPath);
    } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw err;
    }
}

// For the server log only: the Relayer UI answers a gateway refusal as HTTP 200 and a message.
const describeAnswer = ({ status, data }) => `HTTP ${status}${data?.message ? `: ${data.message}` : ''}`;

/**
 * Create the policy and return its name. The gateway refuses a name that is taken and keeps
 * the rules stored under it, and deleting a user leaves its policy behind, so an earlier run
 * may have made this one. DECISION: a policy with these same rules is used as it is; one with
 * other rules is somebody else's, so it is neither used nor changed and the next name is tried.
 */
async function createCliPolicy(http, mcBase, config) {
    for (let n = 1; n <= MAX_POLICY_NAMES; n += 1) {
        const name = n === 1 ? CLI_NAME : `${CLI_NAME}-${n}`;
        const created = await http.post(
            `${mcBase}/policy-create`,
            { name, type: 'json', json: JSON.stringify(CLI_POLICY) },
            config
        );
        if (created.status === 200 && created.data?.success === true) return name;

        const existing = await http.get(`${mcBase}/policy/${name}`, config);
        if (existing.status !== 200 || !isPlainObject(existing.data?.policy_json)) {
            throw new Error(`policy create failed (${describeAnswer(created)}); reading ${name}: ${describeAnswer(existing)}`);
        }
        if (isDeepStrictEqual(existing.data.policy_json, CLI_POLICY)) return name;
    }
    throw new Error(`policy create failed: ${MAX_POLICY_NAMES} names are taken`);
}

async function attachCliPolicy(http, mcBase, policy, config) {
    const answer = await http.post(`${mcBase}/policy`, { name: CLI_NAME, policy }, config);
    if (answer.status !== 200 || answer.data?.status !== 'attached') {
        throw new Error(`policy attach failed (${describeAnswer(answer)})`);
    }
}

/** Delete the user this run made. Returns whether the Relayer says it is gone. */
async function deleteCliUser(http, mcBase, config) {
    try {
        const answer = await http.del(`${mcBase}/user/${CLI_NAME}`, config);
        if (answer.status === 200 && answer.data?.status === 'deleted') return true;
        console.error(`[setup_cli_credentials] user delete failed (${describeAnswer(answer)})`);
    } catch (err) {
        console.error(`[setup_cli_credentials] user delete failed: ${err && err.message ? err.message : String(err)}`);
    }
    return false;
}

/**
 * Tool 11: setup_cli_credentials
 *
 * After check_claim_status reaches STATE_3, the user has a provisioned Relayer
 * but no CLI credentials. This tool:
 *   1. Creates an IAM user "xns-cli" via the Relayer UI MC proxy
 *   2. Receives the one-time {access_key, secret_key} response
 *   3. Creates a policy and attaches it to the user: the gateway denies every request
 *      from a user that has none. If that fails, the user is deleted again
 *   4. Adds the keys to ~/.xns/credentials as one profile (mode 0600),
 *      keeping every profile already there
 *
 * The sign-in token comes from the server's own token manager, the same one
 * get_host_tags and configure_vpd use (one browser sign-in per session); the
 * caller never passes a token.
 */
module.exports = function registerSetupCliCredentials(server, options = {}) {
    const http = options.httpClient || createHttpClient(options);
    const relayerUiBase = (options.relayerUiBase || RELAYER_UI_BASE).replace(/\/+$/, '');
    const tokenMgr = createTokenManager(options);

    server.registerTool(
        'setup_cli_credentials',
        {
            title: 'Set up CLI credentials',
            description: 'Provision S3 IAM credentials for the XNS CLI. Creates an IAM user in the Relayer that can read, write and delete in every bucket, and saves its keys in ~/.xns/credentials, where `xns ls` and the other S3 verbs read them. Profiles in that file that hold keys are kept: if its default profile is one of them, the new keys go in a new profile, and the reply names it and the command that uses it. Call once after check_claim_status reaches STATE_3.',
            inputSchema: {
                installation_id: z.string().optional().default('').describe('Installation ID from check_claim_status STATE_3 result — used as cost_center_id in credentials'),
                ui_port: z.number().int().min(1).max(65535).optional().default(DEFAULT_UI_PORT).describe('Relayer UI port, if install_relayer was run with a ui_port other than 8888. Only the port is chosen; the host is always this machine.'),
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                openWorldHint: true,
            },
        },
        async ({ installation_id, ui_port = DEFAULT_UI_PORT }) => {
            // DECISION: the server's own sign-in token is never sent to a caller-chosen
            // host. The request goes only to the server-owned Relayer UI base, the same
            // base get_host_tags uses; the tool takes no URL input. The caller picks
            // only the UI port, never the host.
            let keysIssued = false;
            try {
                const uiUrl = new URL(relayerUiBase);
                uiUrl.port = String(ui_port);
                const mcBase = `${uiUrl.toString().replace(/\/+$/, '')}/api/v1/mc`;
                const credsPath = path.join(os.homedir(), '.xns', 'credentials');
                let token = await tokenMgr.ensureToken();

                // Checked before the user is created: the Relayer shows the secret key
                // once, so a file that cannot take it has to stop the tool here.
                readCredentials(credsPath);

                const tokenConfig = () => ({ headers: { keycloaktoken: token }, ...NO_REDIRECT_TOKEN_CONFIG });
                const createUser = () => http.post(`${mcBase}/user`, { user: CLI_NAME }, tokenConfig());

                // Step 1: create IAM user "xns-cli" via MC proxy
                let { status, data } = await createUser();

                // A rejected token gets one re-auth and retry.
                if (status === 401) {
                    token = await tokenMgr.reauth();
                    ({ status, data } = await createUser());
                }

                if (status !== 200) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: `Relayer returned HTTP ${status}`,
                                detail: data,
                            }),
                        }],
                    };
                }

                const ak = data.access_key || data.AccessKey || '';
                const sk = data.secret_key || data.SecretKey || '';

                if (!ak || !sk) {
                    const msg = data.message || data.Message || data.error || data.Error || 'no credentials in response';
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: `Relayer: ${msg}`,
                                hint: 'CLI credentials may already exist in one of the profiles in ~/.xns/credentials. Run `xns ls`, or `xns --profile <name> ls` for a profile that is not active — if it works, those credentials are valid. If it is denied, the user xns-cli may have no permissions: ask the user to delete xns-cli in the Relayer UI, then call setup_cli_credentials again.',
                            }),
                        }],
                    };
                }

                // Step 2: give the user its permissions. Nothing is saved unless this works.
                try {
                    const policy = await createCliPolicy(http, mcBase, tokenConfig());
                    await attachCliPolicy(http, mcBase, policy, tokenConfig());
                } catch (err) {
                    console.error(`[setup_cli_credentials] ${err && err.message ? err.message : String(err)}`);
                    const deleted = await deleteCliUser(http, mcBase, tokenConfig());
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({ success: false, error: deleted ? NO_POLICY_ERROR : USER_LEFT_ERROR }),
                        }],
                    };
                }

                keysIssued = true;

                // Step 3: derive S3 endpoint (same host, port 9000).
                // Parse rather than regex-replace: the old `.replace(/:(\d+)(\/|$)/, ...)`
                // only rewrote an EXISTING :port slot, so a portless URL kept 80/443, a
                // query or fragment survived into the persisted endpoint, and a ':digits'
                // sequence in the PATH could be rewritten instead of the port (MR !33).
                const s3Url = new URL(relayerUiBase);
                s3Url.port = '9000';
                s3Url.username = '';
                s3Url.password = '';
                s3Url.search = '';
                s3Url.hash = '';
                const s3Endpoint = s3Url.toString().replace(/\/$/, '');

                // Step 4: add the profile to ~/.xns/credentials (mode 0600).
                // Read again: another program may have saved a profile in the meantime.
                const creds = readCredentials(credsPath);
                const profileName = pickProfileName(creds.profiles);
                creds.profiles[profileName] = {
                    endpoint: s3Endpoint,
                    access_key_id: ak,
                    secret_access_key: sk,
                    cost_center_id: installation_id,
                    // Deliberately empty. The 5-key schema requires the key to be
                    // PRESENT, but the xns CLI never reads its value — the only
                    // reference in that codebase is `_ = p.MuseToken` in
                    // validateProfile, whose comment states "muse_token may be
                    // empty", and its round-trip test asserts the field IS empty.
                    // Writing the JWT here bought nothing and cost real exposure:
                    // it expires in minutes so the copy goes stale, there is no
                    // refresh token to renew it, and until expiry a read of this
                    // file grants Muse-API reach well beyond S3. The access and
                    // secret keys below do belong here — S3 request signing needs
                    // them in plaintext, same as ~/.aws/credentials.
                    muse_token: '',
                };
                // DECISION: the active profile stays the user's. Moving it would point
                // every later `xns` command at another Relayer. The CLI refuses a file
                // whose active_profile names no profile, so only that case is set.
                if (typeof creds.active_profile !== 'string' || !Object.hasOwn(creds.profiles, creds.active_profile)) {
                    creds.active_profile = profileName;
                }
                writeCredentials(credsPath, creds);

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: true,
                            message: creds.active_profile === profileName
                                ? 'CLI credentials written to ~/.xns/credentials. The user can now run `xns ls` to list their storage.'
                                : `CLI credentials written to ~/.xns/credentials as the profile ${profileName}. Profiles that already hold keys are unchanged, and plain \`xns\` commands still use ${creds.active_profile}. The user can now run \`xns --profile ${profileName} ls\` to list the storage on this Relayer.`,
                            profile: profileName,
                            active_profile: creds.active_profile,
                            s3_endpoint: s3Endpoint,
                        }),
                    }],
                };
            } catch (err) {
                // Caught error text stays in the server log. The sign-in link message
                // is the one exception: this server builds it from fixed text and the
                // link, and the person needs it to sign in.
                let error = 'Setting up CLI credentials failed. See the server log for detail, then call setup_cli_credentials again.';
                if (err && err.code === 'SIGNIN_LINK') {
                    error = err.message;
                } else {
                    console.error(`[setup_cli_credentials] ${err && err.message ? err.message : String(err)}`);
                    // Calling again would not help once the user exists: the Relayer
                    // refuses a second xns-cli and does not show the first one's key again.
                    if (keysIssued) error = NOT_SAVED_ERROR;
                    else if (err && err.code === 'CREDS_UNREADABLE') error = BAD_FILE_ERROR;
                }
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({ success: false, error }),
                    }],
                };
            }
        }
    );
};
