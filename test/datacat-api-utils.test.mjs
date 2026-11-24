import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import './setup-browser-globals.mjs';

// dynamic: the setup file's /modules/ loader only applies to imports evaluated after it
const {
    buildDatacatFolderCharactersPath,
    buildDatacatFolderItemPath,
    buildDatacatFoldersPath,
    buildDatacatFollowingPath,
    buildDatacatYoursCharactersPath,
    isDatacatYoursCollectableHit,
    isDatacatYoursSavedHit,
    mapDatacatFollowRow,
    normalizeDatacatFolderId,
    normalizeDatacatFolderPayload,
    buildDatacatFolderReorderPath,
    normalizeDatacatFolderIdList,
} = await import('../client/datacat-api.js');

describe('isDatacatYoursCollectableHit', () => {
    it('hides Yours controls for unextracted or external-only rows', () => {
        assert.equal(isDatacatYoursCollectableHit({
            characterId: '913bce55-0975-4f1c-a8a2-74771c5e51ea',
            primaryContentSourceKind: 'janitor_core',
            isFullyExtractedInDb: false,
            hasPartialExtraction: true,
            isPublicFeedInDb: false,
        }), false);
        assert.equal(isDatacatYoursCollectableHit({
            character_id: '913bce55-0975-4f1c-a8a2-74771c5e51ea',
            _source: 'meilisearch',
        }), false);
    });

    it('shows Yours controls for extracted creator rows and normal public rows', () => {
        assert.equal(isDatacatYoursCollectableHit({
            characterId: '913bce55-0975-4f1c-a8a2-74771c5e51ea',
            isFullyExtractedInDb: true,
        }), true);
        assert.equal(isDatacatYoursCollectableHit({
            character_id: '190fafd9-b5f0-4c24-b532-7fdac0c5a357',
            name: 'Public DataCat row',
        }), true);
    });

    it('shows Yours controls for real recent-public summary rows whether or not they were janny-recovered', () => {
        const summaryRow = {
            characterId: '402d5565-705d-43e1-8bb6-fbdbd77a6765',
            name: 'The Tribal Hunter has captured you for Marriage',
            isPublic: true,
            appearOnPublicFeed: true,
            appear_on_public_feed: true,
            isCollected: false,
            isExtractedByYou: false,
            extractedAt: '2026-06-15T17:49:05.903Z',
            primary_content_source_kind: 'janitor_core',
            is_recovery_placeholder: false,
        };
        assert.equal(isDatacatYoursCollectableHit({ ...summaryRow, has_janny_recovery: false }), true);
        assert.equal(isDatacatYoursCollectableHit({ ...summaryRow, has_janny_recovery: true }), true);
    });
});

describe('isDatacatYoursSavedHit', () => {
    it('detects DataCat Yours saved state from row flags', () => {
        assert.equal(isDatacatYoursSavedHit({ isCollected: true }), true);
        assert.equal(isDatacatYoursSavedHit({ viewer_is_collected: true }), true);
        assert.equal(isDatacatYoursSavedHit({ collected: true }), true);
        assert.equal(isDatacatYoursSavedHit({ name: 'Not saved' }), false);
    });

    it('lets live CL state override stale row flags', () => {
        assert.equal(isDatacatYoursSavedHit({ isCollected: true }, false), false);
        assert.equal(isDatacatYoursSavedHit({ name: 'Saved after click' }, true), true);
    });
});

describe('buildDatacatFollowingPath', () => {
    it('builds the followed-creators list route with defaults', () => {
        assert.equal(
            buildDatacatFollowingPath(),
            '/api/creators/following?sourceKind=janitor&limit=50&offset=0&sortBy=total_chats&sortDir=desc',
        );
    });

    it('honors sourceKind, pagination and sort overrides', () => {
        assert.equal(
            buildDatacatFollowingPath({ sourceKind: 'saucepan', limit: 24, offset: 48, sortBy: 'followed_at', sortDir: 'asc' }),
            '/api/creators/following?sourceKind=saucepan&limit=24&offset=48&sortBy=followed_at&sortDir=asc',
        );
    });
});

describe('mapDatacatFollowRow', () => {
    it('maps a janitor follow row to the CL followed-creator shape', () => {
        assert.deepEqual(
            mapDatacatFollowRow({ creatorId: 'a161e947-e372-4565-8657-04a7cda5c385', sourceKind: 'janitor', userName: 'ExTermi' }),
            { id: 'a161e947-e372-4565-8657-04a7cda5c385', name: 'ExTermi', source: 'datacat' },
        );
    });

    it('maps a saucepan follow row to the saucepan source', () => {
        assert.deepEqual(
            mapDatacatFollowRow({ creatorId: 'c0ffee00-dead-beef-cafe-000000000000', sourceKind: 'saucepan', userName: 'chefhandle' }),
            { id: 'c0ffee00-dead-beef-cafe-000000000000', name: 'chefhandle', source: 'saucepan' },
        );
    });

    it('falls back to creatorId for the name and rejects rows without an id', () => {
        assert.deepEqual(
            mapDatacatFollowRow({ creatorId: 'a161e947-e372-4565-8657-04a7cda5c385', sourceKind: 'janitor' }),
            { id: 'a161e947-e372-4565-8657-04a7cda5c385', name: 'a161e947-e372-4565-8657-04a7cda5c385', source: 'datacat' },
        );
        assert.equal(mapDatacatFollowRow({ userName: 'no id' }), null);
        assert.equal(mapDatacatFollowRow(null), null);
    });
});

describe('buildDatacatYoursCharactersPath', () => {
    it('builds the DataCat Yours list route with pagination, token filter, tags, and added sort', () => {
        assert.equal(
            buildDatacatYoursCharactersPath({
                limit: 80,
                offset: 160,
                minTotalTokens: 889,
                tagIds: [5, 9],
            }),
            '/api/characters?limit=80&offset=160&minTotalTokens=889&tagIds=5%2C9&sort=added',
        );
    });
});

describe('DataCat folder helpers', () => {
    it('normalizes folder identifiers, including the Main sentinel', () => {
        assert.equal(normalizeDatacatFolderId('main'), 'main');
        assert.equal(normalizeDatacatFolderId(-1), 'main');
        assert.equal(normalizeDatacatFolderId(12), 12);
        assert.equal(normalizeDatacatFolderId(' 12 '), 12);
        assert.equal(normalizeDatacatFolderId('all'), null);
        assert.equal(normalizeDatacatFolderId('bad'), null);
    });

    it('builds the folder list route with allow-listed filters', () => {
        assert.equal(
            buildDatacatFoldersPath({
                minTotalTokens: 889,
                activeTagIds: [5, 'bad', 7],
                blockedTagIds: [9],
            }),
            '/dc-folders?minTotalTokens=889&activeTagIds=5%2C7&blockedTagIds=9',
        );
    });

    it('builds folder character list routes for Main and custom folders', () => {
        assert.equal(
            buildDatacatFolderCharactersPath({ folderId: 'main', limit: 20, offset: 40 }),
            '/dc-folder-characters?limit=20&offset=40&minTotalTokens=889&mainOnly=1&sort=added',
        );
        assert.equal(
            buildDatacatFolderCharactersPath({ folderId: 12, search: 'maid bot', sort: 'chat_count', tagIds: [1, 2], blockedTagIds: [3] }),
            '/dc-folder-characters?limit=80&offset=0&minTotalTokens=889&tagIds=1%2C2&blockedTagIds=3&folderId=12&search=maid+bot&sort=chat_count',
        );
    });

    it('builds folder item routes with sanitized ids', () => {
        assert.equal(
            buildDatacatFolderItemPath(12, ' abc12345 '),
            '/dc-folders/12/items/abc12345',
        );
        assert.equal(buildDatacatFolderItemPath('main', 'abc12345'), null);
        assert.equal(buildDatacatFolderItemPath(12, '../bad'), null);
    });

    it('normalizes folder create/update payloads', () => {
        assert.deepEqual(
            normalizeDatacatFolderPayload({ title: '  Favorites  ', description: '  test folder  ' }),
            { title: 'Favorites', description: 'test folder' },
        );
        assert.equal(normalizeDatacatFolderPayload({ title: '   ' }), null);
        assert.equal(normalizeDatacatFolderPayload({ title: 'x'.repeat(121) }), null);
    });
});

describe('DataCat folder reorder', () => {
    it('normalizes a folder id list to positive integers', () => {
        assert.deepEqual(normalizeDatacatFolderIdList(['2359', 2360, '3883']), [2359, 2360, 3883]);
    });

    it('rejects lists containing anything that is not a real folder id', () => {
        assert.equal(normalizeDatacatFolderIdList(['2359', 'abc']), null);
        assert.equal(normalizeDatacatFolderIdList(['2359', '-1']), null);
        assert.equal(normalizeDatacatFolderIdList(['2359', '0']), null);
        assert.equal(normalizeDatacatFolderIdList(['2359', 'main']), null);
    });

    it('rejects empty, duplicate and non-array input', () => {
        assert.equal(normalizeDatacatFolderIdList([]), null);
        assert.equal(normalizeDatacatFolderIdList(null), null);
        assert.equal(normalizeDatacatFolderIdList('2359,2360'), null);
        assert.equal(normalizeDatacatFolderIdList(['2359', '2359']), null);
    });

    it('builds the reorder route', () => {
        assert.equal(buildDatacatFolderReorderPath(), '/dc-folders/reorder');
    });
});
