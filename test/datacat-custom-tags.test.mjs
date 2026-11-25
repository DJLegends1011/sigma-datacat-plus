import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import './setup-browser-globals.mjs';
const { buildV2FromDatacat } = await import('../client/datacat-api.js');

// DataCat's detail carries the site's tags (objects, emoji-prefixed names) and the creator's own
// custom_tags (strings). Shape from a live detail read on 2026-11-25 (character 8b19436d).
const row = {
    character_id: '8b19436d-60fc-45cf-bc30-3d561adf5d1c',
    name: 'Daniel Devine',
    primary_content_source_kind: 'janitor_core',
    personality: 'body',
    first_message: 'hi',
    tags: [{ id: 1, name: '👨 Male', slug: 'male' }, { id: 46, name: '❤️‍🔥 Smut', slug: 'smut' }],
    custom_tags: ['flirty', 'rich', 'influencer', 'cosplay', 'male'],
    chara_card_v2_json: { data: { description: 'd' } },
};

describe('imported cards keep the creator\'s custom tags', () => {
    it('lists the site tags, then the custom ones, with no duplicate', () => {
        const card = buildV2FromDatacat(row);
        assert.deepEqual(card.data.tags, ['Male', 'Smut', 'flirty', 'rich', 'influencer', 'cosplay']);
    });

    it('decodes HTML-encoded custom tags', () => {
        const card = buildV2FromDatacat({ ...row, tags: [], custom_tags: ['Tom &amp; Jerry', 'it&#39;s'] });
        assert.deepEqual(card.data.tags, ['Tom & Jerry', "it's"]);
    });

    it('a row with no custom_tags still works', () => {
        const card = buildV2FromDatacat({ ...row, custom_tags: undefined });
        assert.deepEqual(card.data.tags, ['Male', 'Smut']);
    });
});
