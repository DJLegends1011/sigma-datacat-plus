import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Regressions from the 2026-11-24 native-parity audit (vault: 2026-11-24 DataCat Plus UX audit).
const browse = await readFile(new URL('../client/datacat-browse.js', import.meta.url), 'utf8');
const index = await readFile(new URL('../client/index.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

test('preview import button uses Sigma\'s stamps (isCharPossibleMatch is gone from Sigma)', () => {
    assert.doesNotMatch(browse, /\bisCharPossibleMatch\(/);
    assert.match(browse, /view\.stampPreviewImport\(importBtn, hit\)/);
    assert.match(browse, /view\.trackPreview\(\(\) => \{/);
});

test('possible matches are scored by the view (hitMatchName), not a direct tier call', () => {
    assert.doesNotMatch(browse, /getPossibleMatchTier/);
    assert.match(browse, /return view\.isHitPossibleMatch\(c\)/);
});

test('Features rows run on Sigma\'s feature table and wiring', () => {
    assert.match(browse, /\.\.\.libraryFeatureRows\('datacat', \(\) => view/);
    assert.match(browse, /datacatBrowseView\.wireFeatureFilters\(DATACAT_FEATURE_FILTERS, datacatFeatureState,/);
    assert.match(browse, /countActiveFeatures\(DATACAT_FEATURE_FILTERS, datacatFeatureState\)/);
    assert.match(browse, /super\.applyDefaults\(\{ hideOwned: defaults\.hideOwned, hidePossible: defaults\.hidePossible \}\)/);
    assert.doesNotMatch(browse, /datacatFilter(HideOwned|HidePossible|HideJanitor|HideSaucepan)\s*=/);
});

test('Load More containers are hidden by the attribute updateLoadMoreVisibility toggles', () => {
    // an inline display:none outranks the hidden attribute, so the button could never show
    assert.match(browse, /id="datacatLoadMore" hidden>/);
    assert.match(browse, /id="datacatFollowingLoadMore" hidden>/);
    assert.doesNotMatch(browse, /LoadMore"[^>]*style="display: none;"/);
});

test('provider row keeps core\'s enableWarning; JanitorAI tokens are not client settings', () => {
    assert.match(index, /enableWarning: '/);
    assert.ok(!('datacatJanitoraiToken' in manifest.settings));
    assert.ok(!('datacatJanitoraiRefreshToken' in manifest.settings));
});
