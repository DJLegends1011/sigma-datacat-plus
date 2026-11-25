import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Regressions for the 2026-11-25 revamp (vault: 2026-11-24 DataCat Plus UX audit, "Revamp").
// Each swaps a hand-rolled CL control for Sigma's own; these keep the CL versions from coming back.
const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
const browse = await read('../client/datacat-browse.js');
const picker = await read('../client/datacat-folder-picker.js');
const settings = await read('../client/settings-panel.js');
const api = await read('../client/datacat-api.js');
const css = await read('../client/datacat-browse.css');

test('A: settings inputs carry no glass-input (Sigma\'s settings inputs have no class) and no inline gaps', () => {
    assert.doesNotMatch(settings, /class="glass-input"/);
    assert.doesNotMatch(settings, /class="settings-row" style="gap/);
    assert.match(settings, /class="settings-row u-gap-sm"/);
    // the status pill centres in its row instead of stretching to the check button's height
    assert.match(css, /details\[data-provider="datacat-plus"\] \.settings-input-group > \.settings-status-badge \{ align-self: center; \}/);
});

test('B: the Add to Collection picker is Sigma\'s playlist picker shape, not CL\'s popover', () => {
    assert.match(picker, /class="cl-modal cl-modal-drawer cl-drawer-partial playlist-picker-modal"/);
    assert.match(picker, /class="pl-picker-row/);
    assert.match(picker, /CoreAPI\.filterListWithInlineCreate/);
    assert.match(picker, /CoreAPI\.mountDialogSizing/);
    assert.doesNotMatch(picker + css, /datacat-folder-row|datacat-folder-picker-backdrop|datacat-folder-create-input|positionPicker/);
});

test('B: the Collected filter bar is Sigma\'s filter banner with a way out', () => {
    assert.match(browse, /<div id="datacatYoursFolderBar" class="browse-author-banner hidden">/);
    assert.match(browse, /id="datacatYoursFolderClearBtn" class="glass-btn icon-only"/);
    assert.doesNotMatch(browse + css, /datacat-yours-folder-(bar|label)/);
});

test('collection order is Sigma\'s drag list (provider-order-*, wireDragReorder) and loads itself', () => {
    assert.match(settings, /class="provider-order-item"/);
    assert.match(settings, /fa-grip-vertical drag-handle/);
    assert.match(settings, /CoreAPI\.wireDragReorder\?\.\(orderList, \{ item: '\.provider-order-item', handle: '\.drag-handle'/);
    assert.doesNotMatch(settings + css, /dcPlusFolderOrderLoadBtn|datacat-folder-order-row|data-move=/);
});

test('D: a collection add collects on the same server trip and shows a spinner, not an optimistic tick', () => {
    assert.match(api, /const query = member && collect \? '\?collect=1' : ''/);
    assert.match(picker, /setDatacatFolderMembership\(folderId, characterId, true, \{ collect: collectFirst \}\)/);
    assert.match(picker, /fa-spinner fa-spin/);
    assert.doesNotMatch(picker, /\/\/ optimistic/);
    // the merged call never runs the separate save-to-Main first
    assert.doesNotMatch(picker, /ensureCollected/);
});

test('C: the preview lists the creator\'s custom tags after DataCat\'s, as Sigma\'s JanitorAI preview does', () => {
    assert.match(browse, /resolveTagNames\(\[\.\.\.\(character\.tags \|\| \[\]\), \.\.\.\(character\.custom_tags \|\| \[\]\)\]\)/);
});

// review of 8a01369 (F1, F2, F4)
const index = await read('../client/index.js');

test('the picker is in Sigma\'s overlay stack, so Escape and back close it before the preview', () => {
    assert.match(index, /setDatacatFolderPickerModalId\(ctx\.ui\.addOverlay\(\{ id: 'folder-picker', close: closeDatacatFolderPicker, visible: isDatacatFolderPickerOpen \}\)\)/);
    assert.doesNotMatch(picker, /_escHandler|document\.addEventListener\('keydown'/);
});

test('a drop during a save is saved afterwards; a refusal rolls back to the confirmed order', () => {
    assert.match(settings, /if \(saving\) \{ pendingSave = true; return; \}/);
    assert.match(settings, /folders = \[\.\.\.savedOrder\]/);
});

test('a picker write that lands after a reopen does not sync the new list', () => {
    assert.match(picker, /if \(token === _renderToken\) syncMainRowFromFolders\(characterId\)/);
});

// tag blocking (DataCat's own block list)
test('the Tags rows are Sigma\'s tri-state buttons; CL\'s include-only cycleTagState is gone', () => {
    assert.match(browse, /\$\{tagStateButtonHtml\(tagState\(tag\.id\)\)\}/);
    // deferred past the click, or Sigma's outside-click check closes the dropdown (the clicked icon is detached)
    assert.match(browse, /setTimeout\(\(\) => updateTagStateButton\(stateBtn, next\), 0\)/);
    assert.doesNotMatch(browse, /function cycleTagState|cycleTagState\(/);
});

test('blocked tags reach DataCat on the feeds that take them, and hide the rest by name', () => {
    assert.match(api, /path \+= `&blockedTagIds=\$\{blocked\.join\(','\)\}`/);
    assert.match(browse, /blockedTagIds: blockedTagIdList\(\),\n\s+search: datacatSearchQuery/);
    assert.match(browse, /tagIds: \[\.\.\.datacatActiveTagIds\],\n\s+blockedTagIds: blockedTagIdList\(\),/);
    assert.match(browse, /fetchFacetedTags\(\{ activeTagIds: \[\.\.\.datacatActiveTagIds\], blockedTagIds: blockedTagIdList\(\) \}\)/);
    assert.equal((browse.match(/filter\(c => !isDatacatRowBlocked\(c\)\)/g) || []).length, 2);
});

test('a pending blocked-tags save is dropped on sign-out or switch-off', () => {
    assert.match(browse, /if \(!datacatAccountLoggedIn \|\| !_settings \|\| forAccount !== datacatBlockedSyncToken\) return;/);
    assert.match(browse, /if \(!settings\) \{ clearTimeout\(datacatBlockedSaveTimer\)/);
});

test('phone: the picker drawer is lifted above the keyboard (stopgap) and undone on close', () => {
    assert.match(picker, /function stopgapFitDrawerAboveKeyboard\(modal\)/);
    assert.match(picker, /window\.innerHeight - vv\.height - vv\.offsetTop/);
    assert.match(picker, /addEventListener\('visibilitychange', onVisible\)/);
    assert.match(picker, /_keyboardFit = stopgapFitDrawerAboveKeyboard\(modal\)/);
    assert.match(picker, /_keyboardFit\?\.\(\);\n\s+_keyboardFit = null;/);
});

test('dispose closes the picker (and its keyboard listeners)', async () => {
    const ix = await read('../client/index.js');
    assert.match(ix, /dispose\(\) \{[\s\S]*?closeDatacatFolderPicker\(\);[\s\S]*?\n    \},/);
});

test('the picker header has no character name (it is always one card, the preview already shows it)', () => {
    assert.doesNotMatch(picker, /datacatFolderPickerCount|pl-picker-count/);
});
