import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import './setup-browser-globals.mjs';
const { buildV2FromDatacat, buildV2FromDownload, resolveDatacatAvatarUrl, datacatDetailHint, datacatSourceOf } = await import('../client/datacat-api.js');

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

// A card published on DataCat (primary_content_source_kind direct_upload, "DC Published"). Shape from
// the live detail of 6b03b9de (Annerose Vajra), 2026-11-25, trimmed.
const published = {
    character_id: '6b03b9de-c188-4eef-a370-6e9a842db1b8',
    name: 'Annerose Vajra',
    primary_content_source_kind: 'direct_upload',
    creator_id: null,
    creator_name: 'refactored from Kingdom_of_Characters',
    avatar: '/api/media/direct_upload/310a7066-1143-4f2f-b8bc-0e811461e0e7/view?token=abc',
    personality: 'Dominant, lazy, greedy half-demon witch detective',
    description: 'v3.2 changelog',
    scenario: 'Amidahara',
    first_message: '*Third floor*',
    tags: ['Female', 'Witch'],
    custom_tags: [],
    chara_card_v2_json: { data: {
        name: 'Annerose Vajra', description: '# Annerose Vajra full body', personality: 'Dominant, lazy',
        scenario: 'Amidahara', first_mes: '*Third floor*', mes_example: '<START>', system_prompt: 'You are Annerose',
        post_history_instructions: '[Stay canon]', creator_notes: 'v3.2 changelog', creator: 'refactored from Kingdom_of_Characters',
        character_version: '3.2', tags: ['Female', 'Witch'], alternate_greetings: ['*dusk*'],
        character_book: { name: 'Codex', entries: [{ keys: ['Amidahara'], content: 'city' }] },
    } },
};

describe('cards published on DataCat (direct_upload)', () => {
    it('import keeps the uploader\'s own V2 fields, lorebook included', () => {
        const d = buildV2FromDatacat(published).data;
        assert.equal(d.description, '# Annerose Vajra full body');
        assert.equal(d.personality, 'Dominant, lazy');
        assert.equal(d.creator_notes, 'v3.2 changelog');
        assert.equal(d.system_prompt, 'You are Annerose');
        assert.equal(d.post_history_instructions, '[Stay canon]');
        assert.equal(d.character_version, '3.2');
        assert.deepEqual(d.alternate_greetings, ['*dusk*']);
        assert.equal(d.character_book.name, 'Codex');
        assert.deepEqual(d.tags, ['Female', 'Witch']);
        assert.equal(d.extensions['datacat-plus'].sourceKind, 'direct_upload');
        // the download path takes the same card
        assert.equal(buildV2FromDownload({ data: { personality: 'x' } }, published).data.description, '# Annerose Vajra full body');
    });

    it('asks the detail endpoint with its own source, not JanitorAI\'s (which 404s)', () => {
        assert.equal(datacatDetailHint(published), 'direct_upload');
        assert.equal(datacatDetailHint({ primary_content_source_kind: 'jannyai' }), 'janitor');
        assert.equal(datacatDetailHint({ primary_content_source_kind: 'saucepan' }), 'saucepan');
        assert.equal(datacatSourceOf(published), 'datacat');
    });

    it('its avatar is a datacat.run path, not a JanitorAI filename', () => {
        // Sigma's download safety check lives in library.js, which tests don't load: allow public hosts
        globalThis.window.isUrlSafeForDownload ??= () => ({ ok: true });
        assert.equal(resolveDatacatAvatarUrl(published), 'https://datacat.run/api/media/direct_upload/310a7066-1143-4f2f-b8bc-0e811461e0e7/view?token=abc');
        assert.equal(resolveDatacatAvatarUrl({ avatar: 'abc.webp' }), 'https://ella.janitorai.com/bot-avatars/abc.webp');
    });
});
