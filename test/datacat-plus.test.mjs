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
        if (url.includes('/api/tags/faceted')) return jsonResp({ big: 'x'.repeat(9 * 1024 * 1024) });
        return jsonResp({ error: 'unexpected' }, 500);
    };
    const html = await alice.apiRequest('/ext/datacat-plus/dc-proxy/api/characters/recent-public?limit=1');
    assert.equal(html.status, 200);
    assert.equal(html.headers.get('content-security-policy'), 'sandbox');
    const big = await aliceExt('/dc-proxy/api/tags/faceted');
    assert.equal(big.status, 502);
    assert.match(big.body.error, /byte limit/);
    for (const path of ['/dc-session', '/dc-auth-status', '/dc-status']) {
        const r = await aliceExt(path);
        assert.doesNotMatch(JSON.stringify(r.body ?? ''), /secret-acct-token|alice-anon-token|alice-device-token/);
    }
});
