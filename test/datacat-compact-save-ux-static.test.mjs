import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const browse = await readFile(
    new URL('../client/datacat-browse.js', import.meta.url),
    'utf8',
);
const folderPicker = await readFile(
    new URL('../client/datacat-folder-picker.js', import.meta.url),
    'utf8',
);

test('DataCat exposes one detail-only folder heart inline with creator', () => {
    assert.match(
        browse,
        /<p class="browse-char-meta">[\s\S]{0,700}id="datacatFolderBtn"[\s\S]{0,250}class="datacat-favorite-btn-inline browse-fav-toggle"[\s\S]{0,250}title="Add to collection"[\s\S]{0,250}fa-regular fa-heart/,
    );
    assert.doesNotMatch(browse, /id="datacatYoursBtn"/);
    assert.doesNotMatch(browse, /class="datacat-yours-btn/);
    assert.doesNotMatch(browse, /data-datacat-probe=/);
    assert.doesNotMatch(browse, /renderDatacatYoursCardButton/);
    assert.doesNotMatch(browse, /observeDatacatYoursProbes/);
});

test('DataCat folder heart opens the existing picker', () => {
    assert.match(browse, /on\('datacatFolderBtn', 'click',[\s\S]{0,900}openDatacatFolderPicker\(\{/);
    assert.match(browse, /anchor: btn/);
    assert.doesNotMatch(browse, /on\('datacatYoursBtn', 'click'/);
});

test('DataCat folder state controls regular and solid hearts', () => {
    assert.match(browse, /function setDatacatFolderActionState\(characterId, saved\)/);
    assert.match(browse, /classList\.toggle\('favorited', saved === true\)/);
    assert.match(browse, /fa-solid fa-heart/);
    assert.match(browse, /fa-regular fa-heart/);
    assert.match(browse, /hasDatacatFolderMembership\(result\)/);
    assert.match(browse, /setAnyFolderSaved: \(id, saved\) => setDatacatFolderActionState\(id, saved\)/);
});

test('DataCat folder mutations own one destination notification', () => {
    assert.match(folderPicker, /formatDatacatFolderSuccess\(title\)/);
    assert.match(folderPicker, /formatDatacatFolderRemoval\(title\)/);
    assert.match(folderPicker, /setMainSaved\(characterId, next\)/);
    assert.doesNotMatch(folderPicker, /Created \$\{title\}\./);
    assert.doesNotMatch(folderPicker, /Added \$\{characterName\}/);
    assert.doesNotMatch(folderPicker, /Moved ['"`] \+ characterName/);
    assert.doesNotMatch(folderPicker, /toggleMain/);
});

test('DataCat Features follows maintainer Personal and Library grouping', () => {
    // the rows are a table drawn by Sigma's renderFeatureFilterItems: Personal (Collected) comes before Library
    assert.match(browse, /\{ key: 'personal', title: 'Personal <span[^>]*>\(requires login\)<\/span>:' \},\s*\{ key: 'library', title: 'Library:' \}/);
    assert.match(browse, /\{ key: 'onlyYours', id: 'datacatFilterOnlyYours', section: 'personal', icon: 'fa-heart'[^}]*label: 'Collected' \}/);
    assert.match(browse, /renderFeatureFilterItems\(DATACAT_FILTER_SECTIONS, DATACAT_FEATURE_FILTERS\)/);
    assert.doesNotMatch(browse, /id="datacatFilterOnlyYours"[^>]*>[\s\S]{0,220}Only DataCat Yours<\/label>/);
});

// The heart is shaped like Sigma's own provider hearts (Chub, Botbooru): a site-scoped
// *-favorite-btn-inline beside browse-fav-toggle, which Sigma's phone kebab menu reads. CL's
// .browse-meta-action / .browse-meta-sep (CSS Sigma never had) must not come back.
test('DataCat heart uses the native provider-heart shape, not CL\'s classes', async () => {
    const css = await readFile(new URL('../client/datacat-browse.css', import.meta.url), 'utf8');
    assert.match(css, /\.datacat-favorite-btn-inline\s*\{/);
    assert.match(css, /\.datacat-favorite-btn-inline\.favorited/);
    assert.doesNotMatch(browse + css, /browse-meta-action|browse-meta-sep/);
});

test('DataCat folder heart skips redundant DOM updates', () => {
    assert.match(browse, /const wasFav = btn\.classList\.contains\('favorited'\)/);
    assert.match(browse, /if \(wasFav === \(saved === true\)\) return/);
});
