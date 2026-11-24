// DataCat Plus client entry: registers the DataCat Plus provider, overlays, and Settings > Online section.
import datacatProvider, {
    setDatacatProviderSettings,
    datacatValidateSession,
    datacatRestoreAccount,
    datacatLoginAccount,
    datacatValidateAccount,
    datacatLogoutAccount,
    datacatRefreshToken,
    datacatClearSession,
    datacatGetSettingsFolders,
    datacatReorderFolders,
    datacatJanitoraiSetSession,
    datacatJanitoraiLogout,
    datacatJanitoraiSessionStatus,
} from './datacat-provider.js';
import {
    setDatacatBrowseSettings,
    setDatacatAccountLoggedIn,
    closePreviewModal,
    isPreviewOpen,
    clearCreatorFilter,
    isCreatorBannerOpen,
} from './datacat-browse.js';
import {
    openRestoreModal,
    closeRestoreModal,
    isRestoreModalOpen,
    disposeRestoreModal,
} from './datacat-avatar-restore.js';
import { PROVIDER_ID } from './datacat-id.js';

let _settingsAbort = null;

function bindSwitch(container, id, settingKey, settings, defaultVal, signal) {
    const el = container.querySelector(`#${id}`);
    if (!el) return;
    const raw = settings.get(settingKey);
    el.checked = raw === undefined || raw === null || raw === '' ? defaultVal : !!raw;
    el.addEventListener('change', () => {
        settings.set(settingKey, el.checked);
    }, { signal });
}

export default {
    async init(ctx) {
        const { settings, CoreAPI } = ctx;
        const esc = (s) => CoreAPI.escapeHtml(String(s ?? ''));

        setDatacatProviderSettings(settings);
        setDatacatBrowseSettings(settings);

        await ctx.providers.register(datacatProvider, {
            name: 'DataCat Plus',
            extNamespace: PROVIDER_ID,
            searchPrefixes: ['dcplus', 'dcp'],
            excludeTagKey: PROVIDER_ID,
            excludeInputPrefix: PROVIDER_ID,
            hosts: ['datacat.run'],
            icon: 'fa-solid fa-cat',
            iconUrl: 'https://datacat.run/catgif.gif',
            beta: true,
            avatarTap: { imgId: 'datacatCharAvatar' },
        });

        // Register preview, creator banner, and avatar-restore overlays via the Sigma overlay ledger
        ctx.ui.addOverlay({ id: 'preview', close: closePreviewModal, visible: isPreviewOpen });
        ctx.ui.addOverlay({ id: 'creator-banner', close: clearCreatorFilter, visible: isCreatorBannerOpen });
        ctx.ui.addOverlay({ id: 'avatar-restore', close: closeRestoreModal, visible: isRestoreModalOpen });

        // Settings > Online > DataCat Plus section (ported from CL app/library.html)
        ctx.ui.addProviderSettingsSection(PROVIDER_ID, (el) => {
            if (_settingsAbort) _settingsAbort.abort();
            _settingsAbort = new AbortController();
            const { signal } = _settingsAbort;

            el.innerHTML = `
                <div class="settings-group">
                    <div class="settings-group-title"><i class="fa-solid fa-user"></i> DataCat Account</div>
                    <div class="settings-row">
                        <span class="settings-hint">Sign in to sync your Collected list, custom folders, followed creators, and account-backed extractions. Your credentials are sent only to datacat.run via this extension's server half; tokens stay server-side.</span>
                    </div>
                    <div class="settings-row" id="dcPlusAccountStatusRow">
                        <span id="dcPlusAccountStatus" class="settings-hint">Checking account status...</span>
                    </div>
                    <form id="dcPlusLoginForm" class="settings-row" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;" autocomplete="off">
                        <input type="email" id="dcPlusEmailInput" class="glass-input" placeholder="DataCat email" autocomplete="username" style="flex:1;min-width:160px;">
                        <input type="password" id="dcPlusPasswordInput" class="glass-input" placeholder="Password" autocomplete="current-password" style="flex:1;min-width:140px;">
                        <button type="submit" id="dcPlusLoginBtn" class="glass-btn"><i class="fa-solid fa-right-to-bracket"></i> Sign In</button>
                        <button type="button" id="dcPlusLogoutBtn" class="glass-btn" style="display:none;"><i class="fa-solid fa-right-from-bracket"></i> Sign Out</button>
                        <button type="button" id="dcPlusCheckAccountBtn" class="glass-btn"><i class="fa-solid fa-rotate"></i> Check</button>
                    </form>
                </div>

                <div class="settings-group">
                    <div class="settings-group-title"><i class="fa-solid fa-sliders"></i> Sync &amp; Extraction</div>
                    <div class="settings-row">
                        <label class="cl-switch-label">
                            <input type="checkbox" id="dcPlusSyncYours" class="cl-switch-input">
                            <span class="cl-switch"></span>
                            <span>Sync Collected &amp; folders with DataCat account</span>
                        </label>
                    </div>
                    <div class="settings-row">
                        <label class="cl-switch-label">
                            <input type="checkbox" id="dcPlusUseAccountExtract" class="cl-switch-input">
                            <span class="cl-switch"></span>
                            <span>Use DataCat account for character extractions</span>
                        </label>
                    </div>
                    <div class="settings-row">
                        <label class="cl-switch-label">
                            <input type="checkbox" id="dcPlusPublicFeed" class="cl-switch-input">
                            <span class="cl-switch"></span>
                            <span>Share extractions to the DataCat public feed</span>
                        </label>
                    </div>
                    <div class="settings-row">
                        <label class="cl-switch-label">
                            <input type="checkbox" id="dcPlusReextractOnUpdate" class="cl-switch-input">
                            <span class="cl-switch"></span>
                            <span>Re-extract from upstream when checking for character updates</span>
                        </label>
                    </div>
                </div>

                <div class="settings-group">
                    <div class="settings-group-title"><i class="fa-solid fa-folder-tree"></i> Folder Order</div>
                    <div class="settings-row" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                        <button type="button" id="dcPlusLoadFoldersBtn" class="glass-btn"><i class="fa-solid fa-rotate"></i> Load Folders</button>
                        <button type="button" id="dcPlusSaveFolderOrderBtn" class="glass-btn" style="display:none;"><i class="fa-solid fa-floppy-disk"></i> Save Order</button>
                        <span id="dcPlusFolderOrderStatus" class="settings-hint"></span>
                    </div>
                    <div id="dcPlusFolderOrderList" class="settings-row" style="display:flex;flex-direction:column;gap:6px;"></div>
                </div>

                <div class="settings-group">
                    <div class="settings-group-title"><i class="fa-solid fa-key"></i> JanitorAI Session (Optional)</div>
                    <div class="settings-row">
                        <span class="settings-hint">Paste your <code>sb-auth-auth-token</code> cookie to unlock Hampter sort pagination beyond page 1. MeiliSearch sorts need no login.</span>
                    </div>
                    <div class="settings-row" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
                        <input type="password" id="dcPlusJanitorCookieInput" class="glass-input" placeholder="Paste sb-auth-auth-token cookie" autocomplete="off" style="flex:1;min-width:200px;">
                        <button type="button" id="dcPlusJanitorSaveBtn" class="glass-btn">Save</button>
                        <button type="button" id="dcPlusJanitorClearBtn" class="glass-btn">Clear</button>
                    </div>
                    <div class="settings-row">
                        <span id="dcPlusJanitorStatus" class="settings-hint"></span>
                    </div>
                </div>

                <div class="settings-group">
                    <div class="settings-group-title"><i class="fa-solid fa-wrench"></i> Session &amp; Tools</div>
                    <div class="settings-row" style="display:flex;gap:8px;flex-wrap:wrap;">
                        <button type="button" id="dcPlusValidateSessionBtn" class="glass-btn"><i class="fa-solid fa-circle-check"></i> Validate Session</button>
                        <button type="button" id="dcPlusRefreshSessionBtn" class="glass-btn"><i class="fa-solid fa-arrows-rotate"></i> Refresh Session</button>
                        <button type="button" id="dcPlusClearSessionBtn" class="glass-btn"><i class="fa-solid fa-trash"></i> Clear Session</button>
                        <button type="button" id="dcPlusRestoreAvatarsBtn" class="glass-btn"><i class="fa-solid fa-image"></i> Restore Avatars</button>
                    </div>
                    <div class="settings-row">
                        <span id="dcPlusSessionStatus" class="settings-hint"></span>
                    </div>
                </div>
            `;

            // Bind switches
            bindSwitch(el, 'dcPlusSyncYours', 'datacatSyncYours', settings, true, signal);
            bindSwitch(el, 'dcPlusUseAccountExtract', 'datacatUseAccountForExtraction', settings, true, signal);
            bindSwitch(el, 'dcPlusPublicFeed', 'datacatPublicFeed', settings, false, signal);
            bindSwitch(el, 'dcPlusReextractOnUpdate', 'datacatReextractOnUpdate', settings, false, signal);

            // Account status & login
            const statusEl = el.querySelector('#dcPlusAccountStatus');
            const emailEl = el.querySelector('#dcPlusEmailInput');
            const passwordEl = el.querySelector('#dcPlusPasswordInput');
            const loginBtn = el.querySelector('#dcPlusLoginBtn');
            const logoutBtn = el.querySelector('#dcPlusLogoutBtn');
            const checkBtn = el.querySelector('#dcPlusCheckAccountBtn');
            const loginForm = el.querySelector('#dcPlusLoginForm');

            function renderAccountState(res) {
                const loggedIn = !!(res?.ok || res?.valid || res?.loggedIn);
                setDatacatAccountLoggedIn(loggedIn);
                if (loggedIn) {
                    const label = res?.user?.email || res?.user?.username || res?.email || 'Connected';
                    if (statusEl) statusEl.innerHTML = `<i class="fa-solid fa-circle-check" style="color:var(--cl-success, #4caf50);"></i> Signed in as <strong>${esc(label)}</strong>`;
                    if (logoutBtn) logoutBtn.style.display = '';
                } else {
                    const reason = res?.reason || res?.error;
                    if (statusEl) statusEl.textContent = reason ? `Not signed in (${reason})` : 'Not signed in';
                    if (logoutBtn) logoutBtn.style.display = 'none';
                }
            }

            async function refreshAccountStatus() {
                if (statusEl) statusEl.textContent = 'Checking account status...';
                try {
                    const res = await datacatRestoreAccount();
                    renderAccountState(res);
                } catch (e) {
                    renderAccountState({ valid: false, reason: e?.message || 'Check failed' });
                }
            }
            refreshAccountStatus();

            loginForm?.addEventListener('submit', async (e) => {
                e.preventDefault();
                const email = (emailEl?.value || '').trim();
                const password = passwordEl?.value || '';
                if (!email || !password) {
                    CoreAPI.showToast('Enter both email and password.', 'warning');
                    return;
                }
                if (loginBtn) loginBtn.disabled = true;
                try {
                    const res = await datacatLoginAccount(email, password);
                    if (passwordEl) passwordEl.value = '';
                    if (res?.ok) {
                        renderAccountState(res);
                        CoreAPI.showToast('Signed in to DataCat', 'success');
                    } else {
                        renderAccountState({ valid: false, reason: res?.error || 'Sign in failed' });
                        CoreAPI.showToast(res?.error || 'DataCat sign in failed', 'error');
                    }
                } catch (err) {
                    if (passwordEl) passwordEl.value = '';
                    CoreAPI.showToast(`Sign in failed: ${err?.message || err}`, 'error');
                } finally {
                    if (loginBtn) loginBtn.disabled = false;
                }
            }, { signal });

            logoutBtn?.addEventListener('click', async () => {
                logoutBtn.disabled = true;
                try {
                    await datacatLogoutAccount();
                    renderAccountState({ valid: false });
                    CoreAPI.showToast('Signed out of DataCat', 'info');
                } catch (err) {
                    CoreAPI.showToast(`Sign out failed: ${err?.message || err}`, 'error');
                } finally {
                    logoutBtn.disabled = false;
                }
            }, { signal });

            checkBtn?.addEventListener('click', async () => {
                checkBtn.disabled = true;
                try {
                    const res = await datacatValidateAccount();
                    renderAccountState(res);
                } finally {
                    checkBtn.disabled = false;
                }
            }, { signal });

            // Folder order editor
            let folderList = [];
            const loadFoldersBtn = el.querySelector('#dcPlusLoadFoldersBtn');
            const saveOrderBtn = el.querySelector('#dcPlusSaveFolderOrderBtn');
            const folderStatusEl = el.querySelector('#dcPlusFolderOrderStatus');
            const folderListEl = el.querySelector('#dcPlusFolderOrderList');

            function renderFolderOrder() {
                if (!folderListEl) return;
                if (!folderList.length) {
                    folderListEl.innerHTML = '<span class="settings-hint">No custom folders found.</span>';
                    if (saveOrderBtn) saveOrderBtn.style.display = 'none';
                    return;
                }
                if (saveOrderBtn) saveOrderBtn.style.display = '';
                folderListEl.innerHTML = folderList.map((f, idx) => `
                    <div style="display:flex;align-items:center;gap:8px;">
                        <span style="flex:1;">${esc(f.title || 'Untitled folder')}</span>
                        <button type="button" class="glass-btn" data-dc-folder-move="up" data-idx="${idx}" ${idx === 0 ? 'disabled' : ''} title="Move up"><i class="fa-solid fa-arrow-up"></i></button>
                        <button type="button" class="glass-btn" data-dc-folder-move="down" data-idx="${idx}" ${idx === folderList.length - 1 ? 'disabled' : ''} title="Move down"><i class="fa-solid fa-arrow-down"></i></button>
                    </div>
                `).join('');
            }

            folderListEl?.addEventListener('click', (e) => {
                const btn = e.target.closest?.('[data-dc-folder-move]');
                if (!btn) return;
                const idx = Number(btn.dataset.idx);
                const dir = btn.dataset.dcFolderMove;
                const swap = dir === 'up' ? idx - 1 : idx + 1;
                if (swap < 0 || swap >= folderList.length) return;
                [folderList[idx], folderList[swap]] = [folderList[swap], folderList[idx]];
                renderFolderOrder();
            }, { signal });

            loadFoldersBtn?.addEventListener('click', async () => {
                loadFoldersBtn.disabled = true;
                if (folderStatusEl) folderStatusEl.textContent = 'Loading folders...';
                try {
                    const res = await datacatGetSettingsFolders();
                    if (res?.ok) {
                        folderList = res.folders || [];
                        if (folderStatusEl) folderStatusEl.textContent = `${folderList.length} folder(s)`;
                        renderFolderOrder();
                    } else {
                        if (folderStatusEl) folderStatusEl.textContent = res?.error || 'Could not load folders';
                    }
                } catch (err) {
                    if (folderStatusEl) folderStatusEl.textContent = err?.message || 'Failed to load folders';
                } finally {
                    loadFoldersBtn.disabled = false;
                }
            }, { signal });

            saveOrderBtn?.addEventListener('click', async () => {
                saveOrderBtn.disabled = true;
                if (folderStatusEl) folderStatusEl.textContent = 'Saving order...';
                try {
                    const res = await datacatReorderFolders(folderList.map(f => f.id));
                    if (res?.ok) {
                        if (folderStatusEl) folderStatusEl.textContent = 'Saved.';
                        CoreAPI.showToast('Folder order saved', 'success');
                    } else {
                        if (folderStatusEl) folderStatusEl.textContent = res?.error || 'Failed to save order';
                    }
                } catch (err) {
                    if (folderStatusEl) folderStatusEl.textContent = err?.message || 'Failed to save order';
                } finally {
                    saveOrderBtn.disabled = false;
                }
            }, { signal });

            // JanitorAI optional session
            const jaiInput = el.querySelector('#dcPlusJanitorCookieInput');
            const jaiSaveBtn = el.querySelector('#dcPlusJanitorSaveBtn');
            const jaiClearBtn = el.querySelector('#dcPlusJanitorClearBtn');
            const jaiStatusEl = el.querySelector('#dcPlusJanitorStatus');

            function renderJaiStatus() {
                const st = datacatJanitoraiSessionStatus();
                if (!jaiStatusEl) return;
                if (st.loggedIn) {
                    const who = st.email ? ` (${st.email})` : '';
                    jaiStatusEl.textContent = `JanitorAI token saved${who}${st.hasRefresh ? ' · auto-refresh enabled' : ''}`;
                } else {
                    jaiStatusEl.textContent = 'No JanitorAI token saved.';
                }
            }
            renderJaiStatus();

            jaiSaveBtn?.addEventListener('click', async () => {
                const val = (jaiInput?.value || '').trim();
                if (!val) return;
                jaiSaveBtn.disabled = true;
                try {
                    const res = await datacatJanitoraiSetSession(val);
                    if (jaiInput) jaiInput.value = '';
                    if (res?.ok) {
                        CoreAPI.showToast('JanitorAI session saved', 'success');
                    } else {
                        CoreAPI.showToast(res?.error || 'Invalid JanitorAI session', 'error');
                    }
                    renderJaiStatus();
                } finally {
                    jaiSaveBtn.disabled = false;
                }
            }, { signal });

            jaiClearBtn?.addEventListener('click', () => {
                datacatJanitoraiLogout();
                if (jaiInput) jaiInput.value = '';
                renderJaiStatus();
                CoreAPI.showToast('JanitorAI session cleared', 'info');
            }, { signal });

            // Anonymous session & tools
            const sessStatusEl = el.querySelector('#dcPlusSessionStatus');
            el.querySelector('#dcPlusValidateSessionBtn')?.addEventListener('click', async () => {
                const res = await datacatValidateSession();
                if (sessStatusEl) sessStatusEl.textContent = res?.valid ? 'Session is valid.' : `Session invalid (${res?.reason || 'unknown'})`;
            }, { signal });
            el.querySelector('#dcPlusRefreshSessionBtn')?.addEventListener('click', async () => {
                const tok = await datacatRefreshToken();
                if (sessStatusEl) sessStatusEl.textContent = tok ? 'Session refreshed.' : 'Failed to refresh session.';
            }, { signal });
            el.querySelector('#dcPlusClearSessionBtn')?.addEventListener('click', async () => {
                await datacatClearSession();
                if (sessStatusEl) sessStatusEl.textContent = 'Session cleared.';
            }, { signal });
            el.querySelector('#dcPlusRestoreAvatarsBtn')?.addEventListener('click', () => {
                openRestoreModal();
            }, { signal });
        }, { excludeTagsHint: 'Tags entered here are always left out of DataCat Plus results.' });
    },

    dispose() {
        if (_settingsAbort) {
            _settingsAbort.abort();
            _settingsAbort = null;
        }
        closePreviewModal();
        clearCreatorFilter();
        disposeRestoreModal();
        setDatacatProviderSettings(null);
        setDatacatBrowseSettings(null);
        setDatacatAccountLoggedIn(false);
    },
};
