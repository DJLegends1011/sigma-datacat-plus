import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import './setup-browser-globals.mjs';
const browse = await import('../client/datacat-browse.js');

// Signed out, the block list is the local setting. Row shapes from live DataCat answers (2026-11-25):
// Fresh and creator rows carry tags (objects with emoji names) and customTags (strings); the detail
// carries custom_tags.
const store = {
    datacatBlockedTags: [
        { id: 100517, label: 'Cultivation', slug: 'cultivation' },
        { id: 46, label: 'Smut', slug: 'smut' },
        { id: 900001, label: 'Slice of Life', slug: 'slice-of-life' },
    ],
};
browse.setDatacatBrowseSettings({ get: (k) => store[k], set: (k, v) => { store[k] = v; } });
await new Promise(r => setTimeout(r, 20));

describe('rows carrying a blocked tag', () => {
    it('matches a creator custom tag (customTags / custom_tags), case-insensitively', () => {
        assert.equal(browse.isDatacatRowBlocked({ customTags: ['xianxia', 'Cultivation'] }), true);
        assert.equal(browse.isDatacatRowBlocked({ custom_tags: ['CULTIVATION'] }), true);
    });

    it('matches a site tag by slug or by its emoji-prefixed name', () => {
        assert.equal(browse.isDatacatRowBlocked({ tags: [{ id: 46, name: '❤️‍🔥 Smut', slug: 'smut' }] }), true);
        assert.equal(browse.isDatacatRowBlocked({ tags: [{ name: '🌿 Slice of Life' }] }), true);
        assert.equal(browse.isDatacatRowBlocked({ tagNames: ['slice_of_life'] }), true);
    });

    it('leaves rows without a blocked tag, and rows that carry no tags at all', () => {
        assert.equal(browse.isDatacatRowBlocked({ tags: [{ name: '👨 Male', slug: 'male' }], customTags: ['flirty'] }), false);
        assert.equal(browse.isDatacatRowBlocked({ name: 'summary row without tags' }), false);
        // a substring is not a match
        assert.equal(browse.isDatacatRowBlocked({ customTags: ['smutty'] }), false);
    });
});
