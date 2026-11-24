import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    buildDataCatHeaders,
    buildDataCatAccountIdentifyHeaders,
    chooseDataCatToken,
    isDataCatCharacterId,
    isDataCatFolderId,
    normalizeDcCredential,
    normalizeDcFolderIdList,
    normalizeOptionalDcCredential,
    sanitizeDataCatUser,
} from '../server/datacat-utils.js';
// Client helper tests (../client/datacat-api.js) were split to test/datacat-api-utils.test.mjs
// because client/datacat-api.js imports browser-absolute /modules/core-api.js.

describe('normalizeDcCredential', () => {
    it('trims strings and rejects invalid values', () => {
        assert.equal(normalizeDcCredential('  abc123  '), 'abc123');
        assert.equal(normalizeDcCredential(''), null);
        assert.equal(normalizeDcCredential('   \t\n  '), null);
        assert.equal(normalizeDcCredential('abc\r\n123'), null);
        assert.equal(normalizeDcCredential(null), null);
        assert.equal(normalizeDcCredential('a'.repeat(4097)), null);
    });
});

describe('normalizeOptionalDcCredential', () => {
    it('omits missing optional credentials and normalizes supplied strings', () => {
        assert.equal(normalizeOptionalDcCredential(undefined), null);
        assert.equal(normalizeOptionalDcCredential(null), null);
        assert.equal(normalizeOptionalDcCredential(''), null);
        assert.equal(normalizeOptionalDcCredential('  device-token  '), 'device-token');
    });
});

describe('chooseDataCatToken', () => {
    it('prefers account token when requested and available', () => {
        assert.deepEqual(
            chooseDataCatToken({ accountToken: 'acct', anonymousToken: 'anon', preferAccount: true }),
            { token: 'acct', source: 'account' },
        );
    });

    it('uses anonymous token when account preference is disabled', () => {
        assert.deepEqual(
            chooseDataCatToken({ accountToken: 'acct', anonymousToken: 'anon', preferAccount: false }),
            { token: 'anon', source: 'anonymous' },
        );
        assert.deepEqual(
            chooseDataCatToken({ accountToken: 'acct', anonymousToken: null, preferAccount: false }),
            { token: null, source: null },
        );
    });

    it('falls back to anonymous token when preferred account token is empty', () => {
        assert.deepEqual(
            chooseDataCatToken({ accountToken: '', anonymousToken: 'anon', preferAccount: true }),
            { token: 'anon', source: 'anonymous' },
        );
    });
});

describe('buildDataCatHeaders', () => {
    it('builds DataCat request headers with optional tokens and json content type', () => {
        assert.deepEqual(buildDataCatHeaders({
            sessionToken: 'session',
            deviceToken: 'device',
            json: true,
        }), {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            Accept: 'application/json',
            Origin: 'https://datacat.run',
            Referer: 'https://datacat.run/',
            'X-Session-Token': 'session',
            'X-Device-Token': 'device',
            'Content-Type': 'application/json',
        });
    });
});

describe('buildDataCatAccountIdentifyHeaders', () => {
    it('builds authenticated identify headers without requiring a device token', () => {
        assert.deepEqual(buildDataCatAccountIdentifyHeaders('  account-token  ', null), {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            Accept: 'application/json',
            Origin: 'https://datacat.run',
            Referer: 'https://datacat.run/',
            'X-Session-Token': 'account-token',
            'Content-Type': 'application/json',
        });
    });

    it('includes a device token when one is available', () => {
        assert.equal(buildDataCatAccountIdentifyHeaders('', 'device'), null);
        assert.equal(buildDataCatAccountIdentifyHeaders('bad\ntoken', 'device'), null);
        assert.deepEqual(buildDataCatAccountIdentifyHeaders('account-token', 'device-token')['X-Device-Token'], 'device-token');
    });
});

describe('sanitizeDataCatUser', () => {
    it('returns only public user fields', () => {
        const sanitized = sanitizeDataCatUser({
            uuid: '  user-123  ',
            email: '  user@example.com  ',
            username: '  datacat  ',
            role: '  admin  ',
            session: 'secret',
            passwordHash: 'hash',
        });

        assert.deepEqual(sanitized, {
            uuid: 'user-123',
            email: 'user@example.com',
            username: 'datacat',
            role: 'admin',
        });
        assert.equal('session' in sanitized, false);
        assert.equal('passwordHash' in sanitized, false);
    });
});

describe('isDataCatCharacterId', () => {
    it('accepts DataCat UUID-like IDs only', () => {
        assert.equal(isDataCatCharacterId('123e4567-e89b-12d3-a456-426614174000'), true);
        assert.equal(isDataCatCharacterId('abc12345'), true);
        assert.equal(isDataCatCharacterId('../bad'), false);
        assert.equal(isDataCatCharacterId('not a uuid'), false);
        assert.equal(isDataCatCharacterId('--------'), false);
        assert.equal(isDataCatCharacterId('abc--123'), false);
    });
});


describe('normalizeDcFolderIdList', () => {
    it('accepts a clean list and coerces to numbers', () => {
        assert.deepEqual(normalizeDcFolderIdList(['2359', 2360]), [2359, 2360]);
    });

    it('rejects the whole list when any id is invalid or repeated', () => {
        assert.equal(normalizeDcFolderIdList(['2359', 'nope']), null);
        assert.equal(normalizeDcFolderIdList(['2359', '0']), null);
        assert.equal(normalizeDcFolderIdList(['2359', '2359']), null);
    });

    it('rejects empty and non-array input', () => {
        assert.equal(normalizeDcFolderIdList([]), null);
        assert.equal(normalizeDcFolderIdList(null), null);
        assert.equal(normalizeDcFolderIdList('2359,2360'), null);
    });
});
