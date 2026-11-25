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
