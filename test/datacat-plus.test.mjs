import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(here, '..');
const sigmaDir = process.env.SIGMA_DIR || 'D:/ProjectSigma-main';

const lintPath = path.resolve(sigmaDir, 'tools/extension-kit/lint.mjs');
const kitPath = path.resolve(sigmaDir, 'tools/extension-kit/index.mjs');
assert.ok(fs.existsSync(lintPath), `Sigma extension-kit lint.mjs not found at ${lintPath}`);
assert.ok(fs.existsSync(kitPath), `Sigma extension-kit index.mjs not found at ${kitPath}`);

const { lintExtension } = await import(pathToFileURL(lintPath).href);
const { startSigma } = await import(pathToFileURL(kitPath).href);

const realFetch = globalThis.fetch;
const upstreamCalls = [];
let datacatResponder = null;
const supabaseCalls = [];
let supabaseResponder = null;

function jsonResp(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
    });
}

function textResp(body, status = 200, contentType = 'text/html; charset=utf-8', headers = {}) {
    return new Response(body, {
        status,
        headers: { 'Content-Type': contentType, ...headers },
    });
}

let sigma;
let alice;
let bob;

before(async () => {
    globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('.supabase.co/auth/v1/')) {
            supabaseCalls.push({ url, body: init?.body });
            return supabaseResponder ? supabaseResponder(url, init) : jsonResp({ error: 'unstubbed' }, 500);
        }
        if (url.startsWith('https://datacat.run/')) {
            // sameHostFetch hands fetch a Headers instance, so normalise to a plain object with the sent casing
            const sent = new Headers(init?.headers || {});
            const headers = {};
            for (const [k, v] of sent) headers[k.toLowerCase() === 'x-session-token' ? 'X-Session-Token' : k] = v;
            upstreamCalls.push({ url, method: init?.method || 'GET', headers, body: init?.body });
            if (datacatResponder) return datacatResponder(url, init);
            return jsonResp({ error: 'Unstubbed DataCat URL in test' }, 500);
        }
        return realFetch(input, init);
    };

    sigma = await startSigma({
        extensions: [extDir],
        accounts: [
            { handle: 'alice', password: 'Password123!' },
            { handle: 'bob', password: 'Password123!' },
        ],
        prefix: 'datacat-plus-test',
        lint: false,
    });

    alice = await sigma.signIn('alice', 'Password123!');
    bob = await sigma.signIn('bob', 'Password123!');
    assert.equal((await alice.enable('datacat-plus', true)).status, 200);
    assert.equal((await bob.enable('datacat-plus', true)).status, 200);
});

after(() => {
    globalThis.fetch = realFetch;
    sigma?.close();
});

beforeEach(() => {
    upstreamCalls.length = 0;
    datacatResponder = null;
});

test('lintExtension reports no findings', () => {
    assert.deepEqual(lintExtension(extDir), []);
});

test('migration creates x_datacat_plus_sessions with expected columns', () => {
    const cols = sigma.db('alice')
        .prepare("PRAGMA table_info('x_datacat_plus_sessions')")
        .all()
        .map(r => r.name);
    assert.deepEqual(cols, [
        'user_handle',
        'anon_token',
        'device_token',
        'account_token',
        'user_json',
        'updated_at',
    ]);
});

test('GET /dc-session returns JSON and isolates state across accounts', async () => {
    const aliceExt = alice.ext('datacat-plus');
    const bobExt = bob.ext('datacat-plus');

    const initialAlice = await aliceExt('/dc-session');
    assert.equal(initialAlice.status, 200);
    assert.deepEqual(initialAlice.body, { active: false });

    const initialBob = await bobExt('/dc-session');
    assert.equal(initialBob.status, 200);
    assert.deepEqual(initialBob.body, { active: false });

    const setAlice = await aliceExt('/dc-set-token', 'POST', {
        token: 'alice-anon-token',
        deviceToken: 'alice-device-token',
    });
    assert.equal(setAlice.status, 200);
    assert.deepEqual(setAlice.body, { ok: true });

    const afterAlice = await aliceExt('/dc-session');
    assert.deepEqual(afterAlice.body, { active: true });

    // Bob must not see Alice's anonymous or device token
    const afterBob = await bobExt('/dc-session');
    assert.deepEqual(afterBob.body, { active: false });
});

test('account login persists per-user without leaking accountToken to client or other users', async () => {
    const aliceExt = alice.ext('datacat-plus');
    const bobExt = bob.ext('datacat-plus');

    datacatResponder = (url) => {
        if (url.endsWith('/api/auth/login')) {
            return jsonResp({
                success: true,
                session: { token: 'secret-acct-token-alice' },
                newDeviceToken: 'alice-dev-2',
                user: { uuid: 'u-alice', email: 'alice@example.com', username: 'alice_dc', role: 'user', passwordHash: 'nope' },
            });
        }
        if (url.endsWith('/api/liberator/identify')) {
            return jsonResp({ success: true, deviceToken: 'alice-dev-2' });
        }
        if (url.endsWith('/api/auth/verify')) {
            return jsonResp({
                success: true,
                valid: true,
                user: { uuid: 'u-alice', email: 'alice@example.com', username: 'alice_dc', role: 'user' },
            });
        }
        return jsonResp({ error: 'unexpected' }, 500);
    };

    const login = await aliceExt('/dc-auth-login', 'POST', {
        email: 'alice@example.com',
        password: 'dummy-password',
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.ok, true);
    assert.equal('accountToken' in login.body, false, 'accountToken must never be sent back to client');
    assert.deepEqual(login.body.user, {
        uuid: 'u-alice',
        email: 'alice@example.com',
        username: 'alice_dc',
        role: 'user',
    });

    // Alice status verifies and returns user info without accountToken
    const statusAlice = await aliceExt('/dc-auth-status');
    assert.equal(statusAlice.status, 200);
    assert.equal(statusAlice.body.valid, true);
    assert.equal('accountToken' in statusAlice.body, false);
    assert.equal(statusAlice.body.user.username, 'alice_dc');

    // Bob has no account session
    const statusBob = await bobExt('/dc-auth-status');
    assert.equal(statusBob.status, 200);
    assert.deepEqual(statusBob.body, { valid: false, reason: 'no account token stored', user: null });
});

test('a collection add with ?collect=1 collects first, in one trip from the page (alice is signed in above)', async () => {
    const aliceExt = alice.ext('datacat-plus');
    const charId = '871f7a3c-16b7-4410-9ce1-a10125f610f0';
    let collectStatus = 200;
    let folderStatus = 200;
    datacatResponder = (url, init) => {
        if (url.endsWith('/api/auth/verify')) return jsonResp({ success: true, valid: true, user: { uuid: 'u-alice' } });
        if (url.endsWith(`/api/characters/${charId}/collect`)) {
            return collectStatus === 200 ? jsonResp({ success: true }) : jsonResp({ error: 'collect refused' }, collectStatus);
        }
        if (url.endsWith(`/api/user-folders/12/items/${charId}`)) {
            return folderStatus === 200 ? jsonResp({ success: true }) : jsonResp({ error: 'folder refused' }, folderStatus);
        }
        return jsonResp({ error: 'unexpected ' + url }, 500);
    };
    const steps = () => upstreamCalls
        .filter(c => /\/collect$|\/user-folders\//.test(c.url))
        .map(c => `${c.method} ${c.url.replace('https://datacat.run', '')}`);

    // collect, then the folder: DataCat refuses a folder for a character not collected yet
    upstreamCalls.length = 0;
    const both = await aliceExt(`/dc-folders/12/items/${charId}?collect=1`, 'PUT');
    assert.equal(both.status, 200);
    assert.equal(both.body.ok, true);
    assert.equal(both.body.collected, true);
    assert.deepEqual(steps(), [`POST /api/characters/${charId}/collect`, `PUT /api/user-folders/12/items/${charId}`]);

    // without the flag only the folder is touched
    upstreamCalls.length = 0;
    const plain = await aliceExt(`/dc-folders/12/items/${charId}`, 'PUT');
    assert.equal(plain.status, 200);
    assert.equal('collected' in plain.body, false);
    assert.deepEqual(steps(), [`PUT /api/user-folders/12/items/${charId}`]);

    // a refused collect stops before the folder
    upstreamCalls.length = 0;
    collectStatus = 403;
    const refused = await aliceExt(`/dc-folders/12/items/${charId}?collect=1`, 'PUT');
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /collect/i);
    assert.deepEqual(steps(), [`POST /api/characters/${charId}/collect`]);

    // the collect landed but the folder did not: the answer says so, so the page keeps Main ticked
    upstreamCalls.length = 0;
    collectStatus = 200;
    folderStatus = 500;
    const half = await aliceExt(`/dc-folders/12/items/${charId}?collect=1`, 'PUT');
    assert.equal(half.status, 500);
    assert.equal(half.body.collected, true);

    // the folder call throws after the collect landed: the 502 still says collected
    upstreamCalls.length = 0;
    const before = datacatResponder;
    datacatResponder = (url, init) => {
        if (url.endsWith(`/api/user-folders/12/items/${charId}`)) throw new Error('socket hang up');
        return before(url, init);
    };
    const thrown = await aliceExt(`/dc-folders/12/items/${charId}?collect=1`, 'PUT');
    assert.equal(thrown.status, 502);
    assert.equal(thrown.body.collected, true);
    datacatResponder = before;

    // a removal never collects, even when asked to
    upstreamCalls.length = 0;
    folderStatus = 200;
    const removal = await aliceExt(`/dc-folders/12/items/${charId}?collect=1`, 'DELETE');
    assert.equal(removal.status, 200);
    assert.deepEqual(steps(), [`DELETE /api/user-folders/12/items/${charId}`]);
});

test('/dc-proxy/*splat forwards allowed paths, passes 403 Turnstile through, blocks disallowed paths and off-origin redirects', async () => {
    const aliceExt = alice.ext('datacat-plus');

    // Allowed path -> 200 JSON
    datacatResponder = (url) => {
        if (url.includes('/api/characters/recent-public')) {
            return jsonResp({ success: true, totalCount: 42, characters: [] });
        }
        if (url.includes('/download')) {
            return jsonResp({ error: 'Turnstile verification required' }, 403);
        }
        if (url.includes('/api/tags/faceted')) {
            return textResp('', 302, 'text/plain', { Location: 'https://evil.example/steal' });
        }
        return jsonResp({ error: 'unexpected' }, 500);
    };

    const ok = await aliceExt('/dc-proxy/api/characters/recent-public?limit=1');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.totalCount, 42);
    assert.equal(upstreamCalls[0].headers['X-Session-Token'], 'secret-acct-token-alice');

    // 403 Turnstile passes through cleanly
    const turnstile = await aliceExt('/dc-proxy/api/characters/123e4567-e89b-12d3-a456-426614174000/download');
    assert.equal(turnstile.status, 403);
    assert.deepEqual(turnstile.body, { error: 'Turnstile verification required' });

    // Disallowed path is blocked with 403
    const blocked = await aliceExt('/dc-proxy/api/admin/secret');
    assert.equal(blocked.status, 403);

    // Off-origin redirect is blocked (502, never follows)
    const redir = await aliceExt('/dc-proxy/api/tags/faceted');
    assert.equal(redir.status, 502);
    assert.match(redir.body.error, /DataCat/i);
});

test('HTML error pages from DataCat surface DataCat status and <title> without crashing', async () => {
    const aliceExt = alice.ext('datacat-plus');
    datacatResponder = () => textResp('<html><head><title>Just a moment...</title></head><body>Challenge</body></html>', 403);

    const folders = await aliceExt('/dc-folders');
    assert.equal(folders.status, 403);
    assert.match(folders.body.error, /DataCat returned HTTP 403: Just a moment/);
});

test('/dc-proxy answers are sandboxed and size-capped; no route echoes a token', async () => {
    const aliceExt = alice.ext('datacat-plus');
    datacatResponder = (url) => {
        if (url.includes('/api/characters/recent-public')) return textResp('<script>alert(1)</script>', 200);
        // DataCat's real faceted-tags answer is ~9.6 MB (2026-11-24): it must pass; past Sigma's 50 MiB is refused
        if (url.includes('/api/tags/faceted') && url.includes('size=real')) return jsonResp({ big: 'x'.repeat(10 * 1024 * 1024) });
        if (url.includes('/api/tags/faceted')) return jsonResp({ big: 'x'.repeat(51 * 1024 * 1024) });
        return jsonResp({ error: 'unexpected' }, 500);
    };
    const html = await alice.apiRequest('/ext/datacat-plus/dc-proxy/api/characters/recent-public?limit=1');
    assert.equal(html.status, 200);
    assert.equal(html.headers.get('content-security-policy'), 'sandbox');
    const real = await alice.apiRequest('/ext/datacat-plus/dc-proxy/api/tags/faceted?size=real');
    assert.equal(real.status, 200);
    const big = await aliceExt('/dc-proxy/api/tags/faceted');
    assert.equal(big.status, 502);
    assert.match(big.body.error, /byte limit/);
    for (const path of ['/dc-session', '/dc-auth-status', '/dc-status']) {
        const r = await aliceExt(path);
        assert.doesNotMatch(JSON.stringify(r.body ?? ''), /secret-acct-token|alice-anon-token|alice-device-token/);
    }
});

// a JWT with the given claims (signature is not checked by the code under test)
const jwt = (claims) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

test('JanitorAI login lives server-side: stored per account, refreshed there, refresh token never sent', async () => {
    const aliceExt = alice.ext('datacat-plus');
    const bobExt = bob.ext('datacat-plus');
    const soon = Math.floor(Date.now() / 1000) + 30; // inside the 2 min margin
    const later = Math.floor(Date.now() / 1000) + 3 * 3600;
    const stale = jwt({ email: 'a@example.com', exp: soon });
    const fresh = jwt({ email: 'a@example.com', exp: later });
    supabaseCalls.length = 0;
    supabaseResponder = (url, init) => {
        const body = JSON.parse(init.body);
        if (url.includes('grant_type=refresh_token') && body.refresh_token === 'rt-1') return jsonResp({ access_token: fresh, refresh_token: 'rt-2' });
        if (url.includes('grant_type=refresh_token') && body.refresh_token === 'rt-2') return jsonResp({ access_token: fresh, refresh_token: 'rt-3' });
        return jsonResp({ error: 'invalid_grant' }, 400);
    };
    const cookie = 'base64-' + Buffer.from(JSON.stringify({ access_token: stale, refresh_token: 'rt-1' })).toString('base64');
    const set = await aliceExt('/jai-session', 'POST', { pasted: cookie });
    assert.equal(set.body.ok, true);
    assert.equal(set.body.email, 'a@example.com');
    assert.doesNotMatch(JSON.stringify(set.body), /rt-\d/);

    const row = sigma.db('alice').prepare("SELECT access_token, refresh_token FROM x_datacat_plus_jai WHERE user_handle = 'alice'").get();
    assert.equal(row.refresh_token, 'rt-2', 'the pasted refresh token was rotated and the new one kept');

    const st = await aliceExt('/jai-status');
    assert.equal(st.body.loggedIn, true);
    assert.doesNotMatch(JSON.stringify(st.body), /rt-\d|eyJ/);
    assert.deepEqual((await bobExt('/jai-status')).body, { loggedIn: false });

    const tok = await aliceExt('/jai-token');
    assert.equal(tok.body.token, fresh);
    assert.deepEqual(Object.keys(tok.body), ['token']);
    assert.equal((await bobExt('/jai-token')).body.token, '');

    const forced = await aliceExt('/jai-token?force=1');
    assert.equal(forced.body.token, fresh);
    assert.equal(sigma.db('alice').prepare("SELECT refresh_token FROM x_datacat_plus_jai WHERE user_handle = 'alice'").get().refresh_token, 'rt-3');

    assert.equal((await aliceExt('/jai-session', 'DELETE')).body.ok, true);
    assert.deepEqual((await aliceExt('/jai-status')).body, { loggedIn: false });
});

test('the JanitorAI settings keys no longer hold the login', () => {
    const src = fs.readFileSync(path.join(extDir, 'client/datacat-provider.js'), 'utf8');
    assert.doesNotMatch(src, /setDcSetting\('datacatJanitorai(Refresh)?Token', (?!'')/);
});
