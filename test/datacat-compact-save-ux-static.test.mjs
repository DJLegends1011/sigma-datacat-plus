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
        /<p class="browse-char-meta">[\s\S]{0,700}id="datacatFolderBtn"[\s\S]{0,250}browse-meta-action[\s\S]{0,250}title="Add to collection"[\s\S]{0,250}fa-regular fa-heart/,
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
    assert.match(
        browse,
        /Personal <span[^>]*>\(requires login\)<\/span>:[\s\S]{0,500}id="datacatFilterOnlyYours"[\s\S]{0,180}fa-solid fa-heart[\s\S]{0,120}Collected[\s\S]{0,500}<div class="dropdown-section-title">Library:<\/div>/,
    );
    assert.doesNotMatch(browse, /id="datacatFilterOnlyYours"[^>]*>[\s\S]{0,220}Only DataCat Yours<\/label>/);
});

// CL-only host files (../modules/providers/browse-shared.css and ../app/library-mobile.js)
// do not exist in this extension repo and Sigma core does not define .browse-meta-action.
test.skip('compact metadata actions have shared desktop and mobile treatment (CL host-only)', () => {});
test.skip('mobile overflow omits hidden metadata actions (CL host-only)', () => {});

test('DataCat folder heart skips redundant DOM updates', () => {
    assert.match(browse, /const wasFav = btn\.classList\.contains\('favorited'\)/);
    assert.match(browse, /if \(wasFav === \(saved === true\)\) return/);
});
