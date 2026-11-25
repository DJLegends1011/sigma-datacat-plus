// DataCat folder picker - "Add to collection" for the preview modal, drawn as Sigma's own
// Add to Playlist picker (a centred dialog on desktop, a bottom drawer on a phone).
// Pure model helpers here are unit-tested; the DOM component follows in this file.

/**
 * Keep only user-created folders. DataCat mixes reserved/system folders
 * (e.g. the Private Vault) into /api/user-folders; the site's own picker
 * hides them and so do we.
 * @param {Array} folders raw folders from fetchDatacatFolders()
 * @returns {{id: string, title: string}[]}
 */
function normalizedFolderName(folderName) {
    return String(folderName || '').trim() || 'Main';
}

export function formatDatacatFolderSuccess(folderName) {
    return `Saved to "${normalizedFolderName(folderName)}"`;
}

export function formatDatacatFolderRemoval(folderName) {
    return `Removed from "${normalizedFolderName(folderName)}"`;
}

/** DataCat's per-collection sort key. Absent/blank means "unordered", which must not
 *  collapse to 0 the way Number(null) would. */
function normalizeDisplayOrder(value) {
    if (value === null || value === undefined || value === '') return null;
    const order = Number(value);
    return Number.isFinite(order) ? order : null;
}

export function filterPickerFolders(folders) {
    if (!Array.isArray(folders)) return [];
    return folders
        .filter(f => f && !f.isReserved && !f.isPrivateVault && !f.systemKey)
        .map(f => ({ id: String(f.id ?? '').trim(), title: String(f.title ?? ''), displayOrder: normalizeDisplayOrder(f.displayOrder) }))
        .filter(f => f.id);
}

/**
 * Create a single-flight loader for the signed-in account's custom folders.
 * Empty responses are returned to the current caller but are not retained, so
 * a transient empty response cannot leave the picker stuck on Main all session.
 * @param {() => Promise<{ok?: boolean, folders?: Array, error?: string}>} fetchFolders
 * @returns {{load: () => Promise<{id: string, title: string}[]>, invalidate: () => void}}
 */
export function createDatacatFolderLoader(fetchFolders) {
    let cachedFolders = null;
    let inFlight = null;
    let generation = 0;

    return {
        invalidate() {
            generation += 1;
            cachedFolders = null;
            inFlight = null;
        },

        load() {
            if (cachedFolders) return Promise.resolve(cachedFolders);
            if (inFlight) return inFlight;

            const requestGeneration = generation;
            const request = (async () => {
                const res = await fetchFolders();
                if (!res?.ok) throw new Error(res?.error || 'Could not load folders');
                const folders = filterPickerFolders(res.folders);
                if (folders.length > 0 && generation === requestGeneration) {
                    cachedFolders = folders;
                }
                return folders;
            })();
            const trackedRequest = request.finally(() => {
                if (inFlight === trackedRequest) inFlight = null;
            });
            inFlight = trackedRequest;
            return trackedRequest;
        },
    };
}

/**
 * Build the render model from the folder list + membership status.
 * @param {{folders?: Array, collected?: boolean, folderIds?: Array}} opts
 * @returns {{collected: boolean, mainChecked: boolean, rows: {id: string, title: string, checked: boolean}[]}}
 */
export function hasDatacatFolderMembership({ collected = false, folderIds = [] } = {}) {
    return collected === true || (Array.isArray(folderIds) && folderIds.length > 0);
}

export function buildPickerModel({ folders = [], collected = false, folderIds = [] } = {}) {
    const memberIds = new Set((Array.isArray(folderIds) ? folderIds : []).map(v => String(v)));
    return {
        collected: collected === true,
        anySaved: hasDatacatFolderMembership({ collected, folderIds }),
        mainChecked: collected === true && memberIds.size === 0,
        rows: folders.map(f => ({ id: f.id, title: f.title, checked: memberIds.has(String(f.id)) })),
    };
}

/**
 * Order folders the way DataCat does, using the server-side displayOrder it
 * persists per collection. Rows without a usable displayOrder sort last in the
 * order the API returned them.
 * @param {{id: string, title: string, displayOrder: number|null}[]} folders
 * @returns {{id: string, title: string, displayOrder: number|null}[]} new array; input not mutated
 */
export function sortDatacatFoldersByDisplayOrder(folders) {
    if (!Array.isArray(folders) || folders.length === 0) return [];
    return folders
        .map((folder, index) => ({ folder, index, order: normalizeDisplayOrder(folder?.displayOrder) }))
        .sort((a, b) => {
            const aHas = a.order !== null;
            const bHas = b.order !== null;
            if (aHas !== bHas) return aHas ? -1 : 1;
            if (aHas && a.order !== b.order) return a.order - b.order;
            return a.index - b.index;
        })
        .map(entry => entry.folder);
}

/**
 * Normalize the Yours sub-filter selection against the currently available
 * custom folders. Main is always valid; removed/unknown folder ids fall back
 * to the complete Yours listing.
 * @param {string|number|null|undefined} selection
 * @param {{id: string}[]} folders
 * @returns {string}
 */
export function normalizeDatacatYoursFolderSelection(selection, folders = []) {
    const value = String(selection ?? 'all').trim() || 'all';
    if (value === 'all' || value === 'main') return value;
    return Array.isArray(folders) && folders.some(folder => String(folder?.id) === value)
        ? value
        : 'all';
}

/**
 * Build the account folder-list request for the Yours sub-filter. The complete
 * Yours selection keeps its dedicated endpoint, so this returns null for it.
 * @param {string|number|null|undefined} selection
 * @param {{limit?: number, offset?: number, tagIds?: Array}} common
 * @returns {{limit?: number, offset?: number, tagIds?: Array, folderId?: string}|null}
 */
export function buildDatacatYoursFolderFetchOptions(selection, common = {}) {
    const value = String(selection ?? 'all').trim() || 'all';
    if (value === 'all') return null;
    if (value === 'main') return { ...common, folderId: 'main' };
    return { ...common, folderId: value };
}

import CoreAPI from '/modules/core-api.js';
import {
    fetchDatacatFolders,
    fetchDatacatYoursStatus,
    setDatacatFolderMembership,
    createDatacatFolder,
} from './datacat-api.js';

const { showToast, escapeHtml } = CoreAPI;

// Markup borrows Sigma's Add to Playlist picker (app/modules/playlists.js injectPickerModal):
// cl-modal drawer + pl-picker-* rows + the playlist-picker-modal phone layout, all styled by
// app/modules/playlists.css. Those are core classes with no stability promise: after a Sigma
// update, grep them in app/**/*.css (check-native-ui.mjs does) before shipping.
// The picker sits in Sigma's overlay stack (ctx.ui.addOverlay in index.js), which hands back the
// element id to give it: Escape and a phone's back then close the picker before the preview.
let MODAL_ID = 'datacatFolderPickerModal';

/** index.js passes the id ctx.ui.addOverlay answered, before the picker first opens. */
export function setDatacatFolderPickerModalId(id) {
    if (id && !document.getElementById(MODAL_ID)) MODAL_ID = id;
}

export function isDatacatFolderPickerOpen() {
    return !!document.getElementById(MODAL_ID)?.classList.contains('visible');
}
const MAIN_ID = '__main__';

let _hooks = {
    getMainSaved: () => false,
    setMainSaved: async (_characterId, saved) => ({ ok: true, collected: saved === true }),
    setAnyFolderSaved: () => {},
    // the merged collect + add (one server trip) saved the character to Main as well
    noteMainSaved: () => {},
};
const _folderLoader = createDatacatFolderLoader(fetchDatacatFolders);
let _openEl = null; // the picker's list element while open
let _keyboardFit = null; // the keyboard tracker while the picker is open on a phone
let _openCharId = '';
let _openCharName = '';
let _renderToken = 0;

export function initDatacatFolderPicker(hooks) {
    _hooks = { ..._hooks, ...hooks };
}

export function invalidateDatacatFolderCache() {
    _folderLoader.invalidate();
}

export function preloadDatacatFolderCache() {
    return _folderLoader.load().catch(() => null);
}

function ensureModal() {
    let modal = document.getElementById(MODAL_ID);
    if (modal) return modal;
    document.body.insertAdjacentHTML('beforeend', `
    <div id="${MODAL_ID}" class="cl-modal cl-modal-drawer cl-drawer-partial playlist-picker-modal">
        <div class="cl-modal-content pl-picker-content">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-heart"></i> Add to Collection</h3>
                <span id="datacatFolderPickerCount" class="pl-picker-count"></span>
                <button type="button" id="datacatFolderPickerCloseBtn" class="cl-modal-close" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cl-modal-body cl-modal-body-flush">
                <div class="pl-picker-search-wrap">
                    <i class="fa-solid fa-magnifying-glass pl-picker-search-icon"></i>
                    <input type="search" id="datacatFolderPickerSearch" class="cl-input pl-picker-search" placeholder="Search or create..." maxlength="120" autocomplete="one-time-code">
                </div>
                <div id="datacatFolderPickerList" class="pl-picker-list"></div>
                <div id="datacatFolderPickerEmpty" class="pl-picker-empty" hidden></div>
            </div>
        </div>
    </div>`);
    modal = document.getElementById(MODAL_ID);
    CoreAPI.mountDialogSizing?.(MODAL_ID);
    document.getElementById('datacatFolderPickerCloseBtn').addEventListener('click', closeDatacatFolderPicker);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeDatacatFolderPicker(); });
    document.getElementById('datacatFolderPickerList').addEventListener('click', onListClick);
    const search = document.getElementById('datacatFolderPickerSearch');
    search.addEventListener('input', filterList);
    search.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const createRow = document.querySelector(`#datacatFolderPickerList .pl-create-row`);
        if (createRow && !createRow.hidden) createFromSearch();
    });
    return modal;
}

/**
 * STOPGAP until Sigma's drawers follow the phone keyboard (reported to Reaper 2026-11-25).
 * library.html sets interactive-widget=overlays-content, so the keyboard covers the page instead of
 * shrinking it, and a cl-modal-drawer stays under it: half the list on first open, the whole drawer
 * after switching apps and back. Only Sigma's mobile search overlay corrects for it, by lifting
 * itself by window.innerHeight - visualViewport.height (library-mobile.js ~1665); this does the same
 * for this one drawer, and re-measures when the page becomes visible again. Public browser APIs only;
 * does nothing on desktop or without visualViewport. Remove once Sigma's drawer does it.
 */
function stopgapFitDrawerAboveKeyboard(modal) {
    const vv = window.visualViewport;
    if (!vv || !modal || !document.documentElement.classList.contains('cl-mobile')) return null;
    const content = modal.querySelector('.cl-modal-content');
    const sync = () => {
        const keyboard = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
        modal.style.bottom = keyboard > 0 ? `${keyboard}px` : '';
        // the drawer's own cap is 75vh of the full screen: keep it inside what the keyboard leaves
        // (Sigma's drawer rule is !important, so the inline cap must be too)
        if (content) {
            if (keyboard > 0) content.style.setProperty('max-height', `${Math.max(160, Math.round(vv.height * 0.9))}px`, 'important');
            else content.style.removeProperty('max-height');
        }
    };
    // after a tab-out Chrome restores the keyboard without a resize the drawer heard: measure again
    const later = () => { sync(); setTimeout(sync, 250); };
    const onVisible = () => { if (document.visibilityState === 'visible') later(); };
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', later);
    modal.addEventListener('focusin', later);
    sync();
    return () => {
        vv.removeEventListener('resize', sync);
        vv.removeEventListener('scroll', sync);
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('focus', later);
        modal.removeEventListener('focusin', later);
        modal.style.bottom = '';
        content?.style.removeProperty('max-height');
    };
}

export function closeDatacatFolderPicker() {
    _keyboardFit?.();
    _keyboardFit = null;
    document.getElementById(MODAL_ID)?.classList.remove('visible');
    _openEl = null;
    _openCharId = '';
    _openCharName = '';
    _renderToken += 1;
}

const checkIcon = (checked) => (checked ? 'fa-solid fa-square-check' : 'fa-regular fa-square');

function rowHtml({ id, title, checked, icon = 'fa-folder' }) {
    return `<div class="pl-picker-row${checked ? ' checked' : ''}" data-folder-id="${escapeHtml(id)}" role="button" tabindex="0">
            <i class="pl-picker-check ${checkIcon(checked)}"></i>
            <i class="pl-picker-icon fa-solid ${icon}"></i>
            <span class="pl-picker-name">${escapeHtml(title)}</span>
        </div>`;
}

function setRowChecked(row, checked) {
    row.classList.toggle('checked', checked);
    const icon = row.querySelector('.pl-picker-check');
    if (icon) icon.className = `pl-picker-check ${checkIcon(checked)}`;
}

// a write in flight: the row's check turns into Sigma's spinner and the row takes no clicks
function setRowBusy(row, busy) {
    row.classList.toggle('busy', busy);
    row.setAttribute('aria-busy', busy ? 'true' : 'false');
    const icon = row.querySelector('.pl-picker-check');
    if (!icon) return;
    icon.className = busy
        ? 'pl-picker-check fa-solid fa-spinner fa-spin'
        : `pl-picker-check ${checkIcon(row.classList.contains('checked'))}`;
}

function showMessage(text, { retry = false } = {}) {
    const list = document.getElementById('datacatFolderPickerList');
    const empty = document.getElementById('datacatFolderPickerEmpty');
    if (list) list.innerHTML = '';
    if (!empty) return;
    empty.hidden = false;
    empty.innerHTML = `${escapeHtml(text)}${retry ? ' <button type="button" class="glass-btn" id="datacatFolderPickerRetry"><i class="fa-solid fa-redo"></i> Retry</button>' : ''}`;
    document.getElementById('datacatFolderPickerRetry')?.addEventListener('click', () => loadAndRender(_openCharId));
}

function renderList(model, characterId) {
    const list = document.getElementById('datacatFolderPickerList');
    const empty = document.getElementById('datacatFolderPickerEmpty');
    if (!list) return;
    if (empty) empty.hidden = true;
    list.dataset.collected = model.collected ? 'true' : 'false';
    list.innerHTML = rowHtml({ id: MAIN_ID, title: 'Main', checked: model.mainChecked, icon: 'fa-star' })
        + model.rows.map(r => rowHtml(r)).join('');
    _hooks.setAnyFolderSaved(characterId, model.anySaved);
    filterList();
}

function filterList() {
    CoreAPI.filterListWithInlineCreate?.({
        searchId: 'datacatFolderPickerSearch',
        listId: 'datacatFolderPickerList',
        rowSel: '.pl-picker-row',
        nameOf: (row) => row.querySelector('.pl-picker-name')?.textContent || '',
        createRowClass: 'pl-create-row',
        createRowHtml: (q) => `<i class="fa-solid fa-plus pl-create-row-icon"></i><span class="pl-create-row-text">Create <strong>${escapeHtml(q)}</strong></span>`,
        onCreate: createFromSearch,
    });
}

async function loadAndRender(characterId) {
    const token = ++_renderToken;
    showMessage('Loading your collections...');
    const empty = document.getElementById('datacatFolderPickerEmpty');
    if (empty) empty.insertAdjacentHTML('afterbegin', '<i class="fa-solid fa-spinner fa-spin"></i> ');
    try {
        const [folders, status] = await Promise.all([
            _folderLoader.load(),
            fetchDatacatYoursStatus(characterId),
        ]);
        if (token !== _renderToken) return; // closed or reopened for another character meanwhile
        renderList(buildPickerModel({
            folders: sortDatacatFoldersByDisplayOrder(folders),
            collected: status?.ok ? status.collected === true : _hooks.getMainSaved(characterId),
            folderIds: status?.ok ? status.folderIds : [],
        }), characterId);
    } catch (err) {
        if (token !== _renderToken) return;
        const msg = /session|auth|account|401/i.test(err.message)
            ? 'Session expired: check Settings > Online > DataCat Plus'
            : err.message;
        showMessage(msg, { retry: true });
    }
}

function listEl() { return document.getElementById('datacatFolderPickerList'); }

function syncMainRowFromFolders(characterId = _openCharId) {
    const list = listEl();
    if (!list) return;
    const customRows = [...list.querySelectorAll(`.pl-picker-row:not([data-folder-id="${MAIN_ID}"])`)];
    const hasCustomFolder = customRows.some(row => row.classList.contains('checked'));
    const collected = list.dataset.collected === 'true';
    const mainRow = list.querySelector(`.pl-picker-row[data-folder-id="${MAIN_ID}"]`);
    if (mainRow && !mainRow.classList.contains('busy')) setRowChecked(mainRow, collected && !hasCustomFolder);
    _hooks.setAnyFolderSaved(characterId, collected || hasCustomFolder);
}

/**
 * Sync the open picker's Main row after an outside change to a character's Main status.
 * No-op unless the picker is open for this character.
 * @param {string|number} characterId
 * @param {boolean} saved
 */
export function syncDatacatFolderPickerMainRow(characterId, saved) {
    if (!_openEl || _openCharId !== String(characterId)) return;
    _openEl.dataset.collected = saved === true ? 'true' : 'false';
    syncMainRowFromFolders();
}

// one collection add: collects the character on the same server trip when it isn't yet
async function addToFolder(folderId, characterId) {
    const list = listEl();
    const collectFirst = !(list?.dataset.collected === 'true' || _hooks.getMainSaved(characterId));
    const res = await setDatacatFolderMembership(folderId, characterId, true, { collect: collectFirst });
    if (collectFirst && res?.collected === true) {
        if (list) list.dataset.collected = 'true';
        _hooks.noteMainSaved(characterId, true);
    }
    if (!res?.ok) throw new Error(res?.error || 'DataCat folder update failed');
}

async function toggleRow(row) {
    const characterId = _openCharId;
    const token = _renderToken;
    const list = listEl();
    if (!row || !list || row.classList.contains('busy') || !characterId) return;
    const folderId = row.dataset.folderId;
    const next = !row.classList.contains('checked');
    const title = row.querySelector('.pl-picker-name')?.textContent || 'collection';
    setRowBusy(row, true);
    try {
        if (folderId === MAIN_ID) {
            const customRows = [...list.querySelectorAll(`.pl-picker-row.checked:not([data-folder-id="${MAIN_ID}"])`)];
            if (customRows.length > 0) {
                // ticking Main while it sits in collections moves it back to plain Main
                for (const customRow of customRows) {
                    const res = await setDatacatFolderMembership(customRow.dataset.folderId, characterId, false);
                    if (!res?.ok) throw new Error(res?.error || 'DataCat folder update failed');
                    setRowChecked(customRow, false);
                }
                list.dataset.collected = 'true';
                setRowChecked(row, true);
                showToast(formatDatacatFolderSuccess('Main'), 'success');
            } else {
                const result = await _hooks.setMainSaved(characterId, next);
                if (!result?.ok) throw new Error(result?.error || 'DataCat Main update failed');
                list.dataset.collected = result.collected === true ? 'true' : 'false';
                setRowChecked(row, result.collected === true);
                // removals are 'info', additions 'success', as Sigma's providers type them
                showToast(
                    result.collected === true ? formatDatacatFolderSuccess('Main') : formatDatacatFolderRemoval('Main'),
                    result.collected === true ? 'success' : 'info',
                );
            }
        } else if (next) {
            await addToFolder(folderId, characterId);
            setRowChecked(row, true);
            showToast(formatDatacatFolderSuccess(title), 'success');
        } else {
            const res = await setDatacatFolderMembership(folderId, characterId, false);
            if (!res?.ok) throw new Error(res?.error || 'DataCat folder update failed');
            setRowChecked(row, false);
            showToast(formatDatacatFolderRemoval(title), 'info');
        }
    } catch (err) {
        showToast(`DataCat collection update failed: ${err.message}`, 'error');
    } finally {
        setRowBusy(row, false);
        // closed, or reopened for another character, while DataCat answered: that list isn't this one
        if (token === _renderToken) syncMainRowFromFolders(characterId);
    }
}

function onListClick(e) {
    if (e.target.closest('.pl-create-row')) return; // its own handler
    toggleRow(e.target.closest('.pl-picker-row'));
}

async function createFromSearch() {
    const characterId = _openCharId;
    const search = document.getElementById('datacatFolderPickerSearch');
    const title = (search?.value || '').trim();
    const createRow = document.querySelector('#datacatFolderPickerList .pl-create-row');
    if (!title || !characterId || createRow?.classList.contains('busy')) return;
    createRow?.classList.add('busy');
    createRow?.querySelector('.pl-create-row-icon')?.classList.replace('fa-plus', 'fa-spinner');
    createRow?.querySelector('.pl-create-row-icon')?.classList.add('fa-spin');
    try {
        const res = await createDatacatFolder({ title });
        if (!res?.ok) throw new Error(res?.error || 'DataCat collection create failed');
        invalidateDatacatFolderCache();
        const newId = res.folder?.id != null ? String(res.folder.id) : null;
        if (!newId) throw new Error('DataCat did not return the new collection id');
        await addToFolder(newId, characterId);
        showToast(formatDatacatFolderSuccess(title), 'success');
        if (search) search.value = '';
        if (_openCharId === characterId) await loadAndRender(characterId);
    } catch (err) {
        showToast(`DataCat collection create failed: ${err.message}`, 'error');
        createRow?.classList.remove('busy');
        createRow?.querySelector('.pl-create-row-icon')?.classList.remove('fa-spinner', 'fa-spin');
        createRow?.querySelector('.pl-create-row-icon')?.classList.add('fa-plus');
    }
}

/**
 * Open the picker for a character (a second press for the same character closes it).
 * `anchor` is kept for the caller's signature; the picker is Sigma's dialog/drawer, not a popover.
 */
export async function openDatacatFolderPicker({ anchor, characterId, characterName }) {
    const id = String(characterId || '').trim();
    if (!id) return;
    if (_openEl && _openCharId === id) { closeDatacatFolderPicker(); return; }
    closeDatacatFolderPicker();
    void anchor;

    const modal = ensureModal();
    _openCharId = id;
    _openCharName = String(characterName || 'character');
    _openEl = listEl();
    document.getElementById('datacatFolderPickerCount').textContent = _openCharName;
    const search = document.getElementById('datacatFolderPickerSearch');
    if (search) search.value = '';
    modal.classList.add('visible');
    _keyboardFit = stopgapFitDrawerAboveKeyboard(modal);
    await loadAndRender(id);
}
