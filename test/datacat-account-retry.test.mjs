import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import './setup-browser-globals.mjs';
const {
    setApiRequest,
    setDatacatYoursSaved,
    setDatacatFollow,
    fetchDatacatFollowing,
    fetchDatacatFolders,
    setDatacatFolderMembership,
    createDatacatFolder,
} = await import('../client/datacat-api.js');

// Minimal Response-like stub matching what dcHelperJson consumes:
// `.ok`, `.status`, and `.clone().text()`.
function makeResp(status, bodyObj) {
    const text = bodyObj == null ? '' : JSON.stringify(bodyObj);
    return {
        ok: status >= 200 && status < 300,
        status,
        clone() { return { text: async () => text }; },
        async text() { return text; },
        async json() { return bodyObj; },
    };
}

// Installs a fake apiRequest that records calls and lets each test script the
// responses per path. Returns the recorded calls array.
function installApiRequest(handler) {
    const calls = [];
    setApiRequest(async (path, method = 'GET', data = null, options = null) => {
        calls.push({ path, method, data, options });
        return handler(path, method, calls, data, options);
    });
    return calls;
}

describe('DataCat account-scoped lazy session recovery', () => {
    beforeEach(() => {
        // Sessions and account tokens live server-side per Sigma account; no client token/id getters.
    });

    it('checks /dc-auth-status once and retries after a 401, then succeeds', async () => {
        let restored = false;
        const calls = installApiRequest((path) => {
            if (path.includes('/dc-auth-status')) {
                restored = true;
                return makeResp(200, { ok: true, valid: true, user: { uuid: 'u1' } });
            }
            if (path.includes('/dc-yours/')) {
                return restored
                    ? makeResp(200, { ok: true, collected: true })
                    : makeResp(401, { error: 'No DataCat account session configured' });
            }
            return makeResp(404, { error: 'unexpected path' });
        });

        const result = await setDatacatYoursSaved('abc12345', true);

        assert.equal(result.ok, true);
        assert.equal(result.collected, true);
        // yours(401) -> dc-auth-status(200) -> yours(200)
        assert.equal(calls.length, 3);
        assert.match(calls[0].path, /\/dc-yours\//);
        assert.match(calls[1].path, /\/dc-auth-status/);
        assert.match(calls[2].path, /\/dc-yours\//);
    });

    it('does not retry when /dc-auth-status reports no active account session', async () => {
        const calls = installApiRequest((path) => {
            if (path.includes('/dc-auth-status')) {
                return makeResp(200, { ok: false, valid: false, authenticated: false });
            }
            if (path.includes('/dc-follow/')) {
                return makeResp(401, { error: 'No DataCat account session configured' });
            }
            return makeResp(404, { error: 'unexpected path' });
        });

        const result = await setDatacatFollow('c0ffee00-dead-beef-cafe-000000000000', true);

        assert.equal(result.ok, false);
        assert.equal(result.status, 401);
        // follow(401) -> dc-auth-status(not authenticated) -> no retry.
        assert.equal(calls.length, 2);
        assert.match(calls[0].path, /\/dc-follow\//);
        assert.match(calls[1].path, /\/dc-auth-status/);
    });


    it('checks /dc-auth-status and retries folder list requests after a 401', async () => {
        let restored = false;
        const calls = installApiRequest((path) => {
            if (path.includes('/dc-auth-status')) {
                restored = true;
                return makeResp(200, { ok: true, valid: true });
            }
            if (path.includes('/dc-folders')) {
                return restored
                    ? makeResp(200, { ok: true, folders: [{ id: 12, title: 'Favorites' }] })
                    : makeResp(401, { error: 'No DataCat account session configured' });
            }
            return makeResp(404, { error: 'unexpected path' });
        });

        const result = await fetchDatacatFolders();

        assert.equal(result.ok, true);
        assert.equal(result.folders.length, 1);
        assert.equal(calls.length, 3);
        assert.match(calls[0].path, /\/dc-folders/);
        assert.match(calls[1].path, /\/dc-auth-status/);
        assert.match(calls[2].path, /\/dc-folders/);
    });

    it('calls folder membership routes with PUT and DELETE', async () => {
        const calls = installApiRequest((path) => {
            if (path.includes('/dc-folders/12/items/abc12345')) {
                return makeResp(200, { ok: true, folderId: 12, characterId: 'abc12345' });
            }
            return makeResp(404, { error: 'unexpected path' });
        });

        const added = await setDatacatFolderMembership(12, 'abc12345', true);
        const removed = await setDatacatFolderMembership(12, 'abc12345', false);

        assert.equal(added.ok, true);
        assert.equal(removed.ok, true);
        assert.equal(calls[0].method, 'PUT');
        assert.equal(calls[1].method, 'DELETE');
        assert.match(calls[0].path, /\/dc-folders\/12\/items\/abc12345/);
    });

    it('normalizes create folder request bodies', async () => {
        const calls = installApiRequest((path, method) => {
            if (path.includes('/dc-folders') && method === 'POST') {
                return makeResp(200, { ok: true, folder: { id: 12, title: 'Favorites' } });
            }
            return makeResp(404, { error: 'unexpected path' });
        });

        const result = await createDatacatFolder({ title: '  Favorites  ', description: '  test  ' });

        assert.equal(result.ok, true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].method, 'POST');
        assert.deepEqual(calls[0].data, { title: 'Favorites', description: 'test' });
    });

    it('surfaces the original 401 when recovery itself fails', async () => {
        const calls = installApiRequest((path) => {
            if (path.includes('/dc-auth-status')) {
                return makeResp(401, { valid: false, reason: 'token expired' });
            }
            if (path.includes('/dc-following')) {
                return makeResp(401, { error: 'No DataCat account session configured' });
            }
            return makeResp(404, { error: 'unexpected path' });
        });

        const result = await fetchDatacatFollowing({ sourceKind: 'janitor' });

        assert.equal(result.ok, false);
        assert.equal(result.status, 401);
        // following(401) -> dc-auth-status(401, fails) -> no retry
        assert.equal(calls.length, 2);
        assert.match(calls[0].path, /\/dc-following/);
        assert.match(calls[1].path, /\/dc-auth-status/);
    });
});
