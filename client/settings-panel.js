// Settings > Online > DataCat Plus: CL's DataCat settings section (app/library.html L2898-3071 and
// its handlers in app/library.js L4109-4540, branch codex/datacat-account-sync), ported to a
// provider settings section. Changes from CL, each for a Sigma reason:
// - ids carry a dcPlus prefix: Sigma's built-in DataCat section can be in the same page with CL's ids;
// - checkboxes are Sigma switches (cl-switch-input + cl-switch as direct children of the label);
// - the account password and every DataCat token stay on the server half (per Sigma account):
//   nothing is written to settings or shown, so the anonymous-token field and CL's saved
//   email/password are gone, and Connect Token hands the pasted token straight to /dc-auth-set;
// - the Hampter userscript hint is gone with the CL-only janitor bridge.
import {
    datacatValidateSession,
    datacatRestoreAccount,
    datacatLoginAccount,
    datacatConnectAccountToken,
    datacatLogoutAccount,
    datacatRefreshToken,
    datacatClearSession,
    datacatGetSettingsFolders,
    datacatReorderFolders,
    datacatJanitoraiSetSession,
    datacatJanitoraiLogout,
    datacatJanitoraiSessionStatus,
} from './datacat-provider.js';
import { setDatacatAccountLoggedIn } from './datacat-browse.js';
import { openRestoreModal } from './datacat-avatar-restore.js';

const eyeBtn = (id) => `<button type="button" id="${id}" class="glass-btn icon-only" title="Show/Hide"><i class="fa-solid fa-eye"></i></button>`;
const switchRow = (id, label) => `
    <div class="settings-row">
        <label><input type="checkbox" class="cl-switch-input" id="${id}"><span class="cl-switch" aria-hidden="true"></span> ${label}</label>
    </div>`;

export function settingsMarkup() {
    return `
    <div class="settings-group">
        <div class="settings-group-title"><i class="fa-solid fa-key"></i> Session</div>
        <div class="settings-row">
            <label>Status:</label>
            <div class="settings-input-group">
                <span id="dcPlusSessionStatus" class="settings-status-badge inactive"><i class="fa-solid fa-circle"></i> Checking...</span>
                <button type="button" id="dcPlusValidateBtn" class="settings-verify-btn" title="Test Connection"><i class="fa-solid fa-check"></i></button>
            </div>
        </div>
        <div class="settings-row">
            <span class="settings-hint">Anonymous DataCat session, used for browsing public characters. It is kept on this Sigma server for your account and persists across sessions.</span>
        </div>
        <div class="settings-row" style="gap: 8px;">
            <button type="button" id="dcPlusRefreshTokenBtn" class="settings-action-btn"><i class="fa-solid fa-rotate"></i> New Token</button>
            <button type="button" id="dcPlusClearTokenBtn" class="settings-action-btn danger"><i class="fa-solid fa-trash-can"></i> Clear Session</button>
        </div>
    </div>
    <div class="settings-group">
        <div class="settings-group-title"><i class="fa-solid fa-user-lock"></i> Account Login</div>
        <div class="settings-row">
            <span class="settings-hint">Sign in with your DataCat email and password to unlock <strong>collection sync</strong>, <strong>account extraction</strong>, and the <strong>Add to collection</strong> button. The password goes once to datacat.run through this Sigma server and is not saved; the account session it gets back is kept on this server for your Sigma account.</span>
        </div>
        <div class="settings-row">
            <span id="dcPlusAccountStatus" class="settings-status-badge inactive"><i class="fa-solid fa-circle"></i> Signed out</span>
        </div>
        <div class="settings-row">
            <label>Email:</label>
            <div class="settings-input-group">
                <input type="email" id="dcPlusAccountEmail" class="glass-input" placeholder="DataCat account email" autocomplete="email" spellcheck="false">
            </div>
        </div>
        <div class="settings-row">
            <label>Password:</label>
            <div class="settings-input-group">
                <input type="password" id="dcPlusAccountPassword" class="glass-input" placeholder="DataCat account password" autocomplete="current-password" data-sensitive="true">
                ${eyeBtn('dcPlusToggleAccountPassword')}
            </div>
        </div>
        <div class="settings-row" style="gap: var(--space-sm);">
            <button type="button" id="dcPlusAccountLoginBtn" class="settings-action-btn primary" disabled><i class="fa-solid fa-right-to-bracket"></i> Sign In</button>
            <button type="button" id="dcPlusAccountLogoutBtn" class="settings-action-btn danger" style="display: none;"><i class="fa-solid fa-right-from-bracket"></i> Log Out</button>
        </div>
        <div class="provider-link-divider" id="dcPlusTokenDivider"><span>or use a session token</span></div>
        <div class="settings-row" id="dcPlusTokenHintRow">
            <span class="settings-hint">Use this if you sign in to DataCat with <strong>Google</strong> (those accounts have no password to give here). Log in at <strong>datacat.run</strong>, open DevTools (F12) &rarr; <strong>Application &rarr; Local Storage &rarr; datacat.run</strong>, and copy the value of the <strong>account_token</strong> key. The session refreshes itself afterwards.</span>
        </div>
        <div class="settings-row" id="dcPlusTokenInputRow">
            <label>Token:</label>
            <div class="settings-input-group">
                <input type="password" id="dcPlusAccountToken" class="glass-input" placeholder="Paste DataCat account token" autocomplete="off" data-sensitive="true">
                ${eyeBtn('dcPlusToggleAccountToken')}
            </div>
        </div>
        <div class="settings-row" style="gap: var(--space-sm);">
            <button type="button" id="dcPlusAccountTokenConnectBtn" class="settings-action-btn primary"><i class="fa-solid fa-link"></i> Connect Token</button>
            <button type="button" id="dcPlusAccountOpenLoginBtn" class="settings-action-btn"><i class="fa-solid fa-up-right-from-square"></i> Open DataCat Login</button>
        </div>
        ${switchRow('dcPlusUseAccountExtraction', 'Use account session for extraction')}
        ${switchRow('dcPlusSyncYours', 'Sync save buttons to DataCat collections')}
    </div>
    <div class="settings-group">
        <div class="settings-group-title"><i class="fa-solid fa-folder-tree"></i> Collection Order</div>
        <div class="settings-row">
            <span class="settings-hint">Reorder how your DataCat collections appear here (collection picker and Collected filter). Changes are saved to your DataCat account, so the site and other devices follow the same order.</span>
        </div>
        <div class="settings-row">
            <button type="button" id="dcPlusFolderOrderLoadBtn" class="settings-action-btn"><i class="fa-solid fa-rotate"></i> Load Folders</button>
        </div>
        <div id="dcPlusFolderOrderStatus" class="settings-row" style="display: none;"></div>
        <div id="dcPlusFolderOrderList" class="settings-row datacat-folder-order-list"></div>
    </div>
    <div class="settings-group">
        <div class="settings-group-title"><i class="fa-solid fa-cloud-arrow-down"></i> Extraction</div>
        ${switchRow('dcPlusPublicFeed', 'Publish extracted characters on DataCat')}
        <div class="settings-row">
            <span class="settings-hint">When enabled, extracted characters appear on the public DataCat feed and are accessible via URL. Disable to keep extractions private (API-only access).</span>
        </div>
        ${switchRow('dcPlusReextractOnUpdate', 'Re-extract characters on update checks')}
        <div class="settings-row">
            <span class="settings-hint">Force DataCat to re-extract character data from JanitorAI before checking for updates. Slower, but ensures comparisons use fresh data instead of a stale cache.</span>
        </div>
    </div>
    <div class="settings-group">
        <div class="settings-group-title"><i class="fa-solid fa-user-lock"></i> JanitorAI Login (Hampter pagination)</div>
        <div class="settings-row">
            <span class="settings-hint">Optional, and separate from the JanitorAI provider's own login. JanitorAI serves only the <strong>first page</strong> of the Hampter sorts without an account. Paste your session cookie to page through more; the session then <strong>refreshes itself</strong> (no repeated pasting). To get it: log in at <strong>janitorai.com</strong>, open DevTools (F12) &rarr; <strong>Application &rarr; Cookies &rarr; janitorai.com</strong>, and copy the value of the <strong>sb-auth-auth-token</strong> cookie. Kept on this Sigma server for your account; the page only borrows a short-lived access token while paging. Tip: paste from a browser you are not actively browsing JanitorAI in, so the two sessions do not rotate each other out.</span>
        </div>
        <div class="settings-row">
            <label>Cookie:</label>
            <div class="settings-input-group">
                <input type="password" id="dcPlusJanitoraiToken" class="glass-input" placeholder="Paste the sb-auth-auth-token cookie value" autocomplete="off" spellcheck="false">
                ${eyeBtn('dcPlusToggleJanitoraiToken')}
            </div>
        </div>
        <div class="settings-row" style="gap: var(--space-sm);">
            <button type="button" id="dcPlusSaveJanitoraiTokenBtn" class="settings-action-btn primary"><i class="fa-solid fa-right-to-bracket"></i> Save Login</button>
            <button type="button" id="dcPlusClearJanitoraiTokenBtn" class="settings-action-btn danger"><i class="fa-solid fa-right-from-bracket"></i> Log Out</button>
        </div>
        <div class="settings-row">
            <span id="dcPlusJanitoraiTokenStatus" class="settings-status-badge inactive"><i class="fa-solid fa-circle"></i> Not logged in</span>
        </div>
    </div>
    <div class="settings-group">
        <div class="settings-group-title"><i class="fa-solid fa-image"></i> Card Maintenance</div>
        <div class="settings-row">
            <button type="button" id="dcPlusRestoreAvatarsBtn" class="settings-action-btn primary"><i class="fa-solid fa-wand-magic-sparkles"></i> Restore Original Avatars</button>
            <span class="settings-hint">Cards imported before mid-July 2026 carry DataCat's downsized 640px card image. This scans your DataCat Plus-linked characters, shows the current and original avatars side by side, and replaces only the ones you approve. Card data is never modified, only the image.</span>
        </div>
    </div>`;
}

/**
 * Wire the section. Listeners go on `root` (a fresh child of the host's reused element) or
 * carry `signal`, so a re-render or dispose drops them.
 */
export function bindSettings(root, { settings, CoreAPI, signal }) {
    const $ = (id) => root.querySelector(`#${id}`);
    const esc = (s) => CoreAPI.escapeHtml(String(s ?? ''));
    const on = (el, type, fn) => el?.addEventListener(type, fn, { signal });
    const badge = (el, active, html) => {
        if (!el) return;
        el.className = `settings-status-badge ${active ? 'active' : 'inactive'}`;
        el.innerHTML = html;
    };

    // switches: CL's defaults (sync + account extraction on unless turned off, the other two opt-in)
    const bindSwitch = (id, key, onUnlessFalse) => {
        const el = $(id);
        if (!el) return;
        const v = settings.get(key);
        el.checked = onUnlessFalse ? v !== false : v === true;
        on(el, 'change', () => settings.set(key, el.checked));
    };
    bindSwitch('dcPlusUseAccountExtraction', 'datacatUseAccountForExtraction', true);
    bindSwitch('dcPlusSyncYours', 'datacatSyncYours', true);
    bindSwitch('dcPlusPublicFeed', 'datacatPublicFeed', false);
    bindSwitch('dcPlusReextractOnUpdate', 'datacatReextractOnUpdate', false);

    const bindEye = (btnId, inputId) => {
        const btn = $(btnId); const input = $(inputId);
        on(btn, 'click', () => {
            const isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';
            btn.innerHTML = `<i class="fa-solid fa-eye${isPassword ? '-slash' : ''}"></i>`;
        });
    };
    bindEye('dcPlusToggleAccountPassword', 'dcPlusAccountPassword');
    bindEye('dcPlusToggleAccountToken', 'dcPlusAccountToken');
    bindEye('dcPlusToggleJanitoraiToken', 'dcPlusJanitoraiToken');

    // ── anonymous session ──
    const sessionStatus = $('dcPlusSessionStatus');
    async function updateSessionStatus() {
        try {
            const result = await datacatValidateSession();
            badge(sessionStatus, !!result?.valid, `<i class="fa-solid fa-circle"></i> ${result?.valid ? 'Active' : 'Inactive'}`);
        } catch {
            badge(sessionStatus, false, '<i class="fa-solid fa-circle"></i> Inactive');
        }
    }
    updateSessionStatus();

    const validateBtn = $('dcPlusValidateBtn');
    on(validateBtn, 'click', async (e) => {
        e.preventDefault();
        validateBtn.classList.remove('success', 'error');
        validateBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        validateBtn.disabled = true;
        try {
            const result = await datacatValidateSession();
            if (result?.valid) {
                CoreAPI.showToast('DataCat session is valid!', 'success');
                validateBtn.classList.add('success');
                validateBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
            } else {
                CoreAPI.showToast(`Session invalid: ${result?.reason || 'Unknown'}`, 'error');
                validateBtn.classList.add('error');
                validateBtn.innerHTML = '<i class="fa-solid fa-times"></i>';
            }
            updateSessionStatus();
        } catch (err) {
            CoreAPI.showToast(`Validation error: ${err.message}`, 'error');
            validateBtn.classList.add('error');
            validateBtn.innerHTML = '<i class="fa-solid fa-exclamation"></i>';
        } finally {
            validateBtn.disabled = false;
            setTimeout(() => {
                validateBtn.classList.remove('success', 'error');
                validateBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
            }, 3000);
        }
    });

    const refreshBtn = $('dcPlusRefreshTokenBtn');
    on(refreshBtn, 'click', async () => {
        refreshBtn.disabled = true;
        refreshBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Requesting...';
        try {
            const ok = await datacatRefreshToken();
            if (ok) CoreAPI.showToast('New DataCat token obtained!', 'success');
            else CoreAPI.showToast('Failed to obtain new token', 'error');
            updateSessionStatus();
        } catch (err) {
            CoreAPI.showToast(`Refresh error: ${err.message}`, 'error');
        } finally {
            refreshBtn.disabled = false;
            refreshBtn.innerHTML = '<i class="fa-solid fa-rotate"></i> New Token';
        }
    });

    on($('dcPlusClearTokenBtn'), 'click', async () => {
        try {
            await datacatClearSession();
            CoreAPI.showToast('DataCat session cleared', 'info');
            updateSessionStatus();
        } catch (err) {
            CoreAPI.showToast(`Clear error: ${err.message}`, 'error');
        }
    });

    // ── account ──
    const accountStatus = $('dcPlusAccountStatus');
    const emailInput = $('dcPlusAccountEmail');
    const passwordInput = $('dcPlusAccountPassword');
    const tokenInput = $('dcPlusAccountToken');
    const loginBtn = $('dcPlusAccountLoginBtn');
    const logoutBtn = $('dcPlusAccountLogoutBtn');
    const connectBtn = $('dcPlusAccountTokenConnectBtn');
    const openLoginBtn = $('dcPlusAccountOpenLoginBtn');
    // the sign-in and token rows hide while signed in, as in CL
    const signedOutOnly = [loginBtn, connectBtn, openLoginBtn];

    function updateLoginBtnState() {
        if (!loginBtn) return;
        loginBtn.disabled = !(emailInput?.value || '').trim() || !(passwordInput?.value || '');
    }
    on(emailInput, 'input', updateLoginBtnState);
    on(passwordInput, 'input', updateLoginBtnState);

    function renderAccountStatus(result = null) {
        const valid = !!(result && (result.valid === true || result.ok === true));
        setDatacatAccountLoggedIn(valid);
        if (valid) {
            const user = result.user || null;
            const label = user?.username || user?.email || 'Signed in';
            badge(accountStatus, true, `<i class="fa-solid fa-circle"></i> ${esc(label)}`);
            signedOutOnly.forEach(b => { if (b) b.style.display = 'none'; });
            if (logoutBtn) logoutBtn.style.display = '';
            return;
        }
        badge(accountStatus, false, `<i class="fa-solid fa-circle"></i> ${result?.error ? 'Error' : 'Signed out'}`);
        signedOutOnly.forEach(b => { if (b) b.style.display = ''; });
        if (logoutBtn) logoutBtn.style.display = 'none';
        updateLoginBtnState();
    }

    async function updateAccountStatus() {
        badge(accountStatus, false, '<i class="fa-solid fa-spinner fa-spin"></i> Checking...');
        try {
            renderAccountStatus(await datacatRestoreAccount());
        } catch (err) {
            console.warn('[DataCat Plus] account status check failed:', err);
            renderAccountStatus({ valid: false, error: err?.message || 'status check failed' });
        }
    }
    updateAccountStatus();

    on(loginBtn, 'click', async () => {
        const email = (emailInput?.value || '').trim();
        const password = passwordInput?.value || '';
        if (!email || !password) {
            CoreAPI.showToast('Enter your DataCat email and password', 'warning');
            return;
        }
        loginBtn.disabled = true;
        loginBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Signing in...';
        try {
            const result = await datacatLoginAccount(email, password);
            if (!result?.ok) throw new Error(result?.error || result?.reason || 'Login failed');
            CoreAPI.showToast('DataCat account connected', 'success');
            renderAccountStatus({ valid: true, user: result.user });
        } catch (err) {
            CoreAPI.showToast(`DataCat login failed: ${err.message}`, 'error');
            renderAccountStatus({ valid: false });
        } finally {
            if (passwordInput) passwordInput.value = '';
            loginBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Sign In';
            updateLoginBtnState();
        }
    });

    on(connectBtn, 'click', async () => {
        const token = (tokenInput?.value || '').trim();
        if (!token) {
            CoreAPI.showToast('Paste a DataCat account session token first', 'warning');
            return;
        }
        connectBtn.disabled = true;
        connectBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Connecting...';
        try {
            const result = await datacatConnectAccountToken(token);
            if (!result?.ok && !result?.valid) throw new Error(result?.error || result?.reason || 'Token validation failed');
            if (tokenInput) tokenInput.value = '';
            CoreAPI.showToast('DataCat account token connected', 'success');
            renderAccountStatus({ valid: true, user: result.user });
        } catch (err) {
            CoreAPI.showToast(`DataCat token connect failed: ${err.message}`, 'error');
            renderAccountStatus({ valid: false, error: err.message });
        } finally {
            connectBtn.disabled = false;
            connectBtn.innerHTML = '<i class="fa-solid fa-link"></i> Connect Token';
        }
    });

    on(openLoginBtn, 'click', () => window.open('https://datacat.run/login', '_blank', 'noopener,noreferrer'));

    on(logoutBtn, 'click', async () => {
        try { await datacatLogoutAccount(); } catch { /* the server forgets the session either way */ }
        if (emailInput) emailInput.value = '';
        if (passwordInput) passwordInput.value = '';
        if (tokenInput) tokenInput.value = '';
        CoreAPI.showToast('DataCat account disconnected', 'info');
        renderAccountStatus({ valid: false });
    });

    // ── collection order: DataCat owns displayOrder, so a move writes straight through,
    // applied optimistically and rolled back if the account rejects it (CL behaviour) ──
    const orderLoadBtn = $('dcPlusFolderOrderLoadBtn');
    const orderStatus = $('dcPlusFolderOrderStatus');
    const orderList = $('dcPlusFolderOrderList');
    let folders = [];
    let saving = false;

    function showOrderStatus(message) {
        if (!orderStatus) return;
        orderStatus.textContent = message || '';
        orderStatus.style.display = message ? '' : 'none';
    }

    function renderOrderList() {
        if (!orderList) return;
        const last = folders.length - 1;
        orderList.innerHTML = folders.map((f, i) => `
            <div class="datacat-folder-order-row" data-folder-id="${esc(f.id)}">
                <span class="datacat-folder-order-title">${esc(f.title)}</span>
                <button type="button" data-move="-1" data-idx="${i}" ${i === 0 ? 'disabled' : ''} title="Move up"><i class="fa-solid fa-chevron-up"></i></button>
                <button type="button" data-move="1" data-idx="${i}" ${i === last ? 'disabled' : ''} title="Move down"><i class="fa-solid fa-chevron-down"></i></button>
            </div>`).join('');
    }

    on(orderList, 'click', async (e) => {
        const btn = e.target.closest?.('button[data-move]');
        if (!btn || saving) return;
        const index = Number(btn.dataset.idx);
        const target = index + Number(btn.dataset.move);
        if (target < 0 || target >= folders.length) return;
        const previous = [...folders];
        [folders[index], folders[target]] = [folders[target], folders[index]];
        renderOrderList();
        saving = true;
        showOrderStatus('Saving order to DataCat...');
        try {
            const res = await datacatReorderFolders(folders.map(f => f.id));
            if (!res?.ok) throw new Error(res?.error || 'Could not save folder order');
            showOrderStatus(null);
        } catch (err) {
            folders = previous;
            renderOrderList();
            showOrderStatus(err.message || 'Could not save folder order');
        } finally {
            saving = false;
        }
    });

    on(orderLoadBtn, 'click', async () => {
        orderLoadBtn.disabled = true;
        showOrderStatus('Loading folders...');
        try {
            const res = await datacatGetSettingsFolders();
            if (!res?.ok) {
                const errText = res?.error || 'Could not load folders';
                showOrderStatus(/account|session|auth/i.test(errText) ? 'Sign in to DataCat first' : errText);
                folders = [];
            } else {
                folders = Array.isArray(res.folders) ? res.folders : [];
                showOrderStatus(folders.length ? null : 'No custom folders on this account.');
            }
            renderOrderList();
        } catch (err) {
            showOrderStatus(err.message || 'Could not load folders');
        } finally {
            orderLoadBtn.disabled = false;
        }
    });

    // ── JanitorAI session (Hampter pagination) ──
    const jaiInput = $('dcPlusJanitoraiToken');
    const jaiStatus = $('dcPlusJanitoraiTokenStatus');
    async function renderJaiStatus() {
        const st = await datacatJanitoraiSessionStatus();
        if (st.loggedIn) badge(jaiStatus, true, `<i class="fa-solid fa-circle"></i> Logged in${st.email ? ` as ${esc(st.email)}` : ''}`);
        else badge(jaiStatus, false, '<i class="fa-solid fa-circle"></i> Not logged in');
    }
    renderJaiStatus();

    const jaiSaveBtn = $('dcPlusSaveJanitoraiTokenBtn');
    on(jaiSaveBtn, 'click', async () => {
        const val = (jaiInput?.value || '').trim();
        if (!val) {
            CoreAPI.showToast('Paste the sb-auth-auth-token cookie value first', 'warning');
            return;
        }
        jaiSaveBtn.disabled = true;
        try {
            const res = await datacatJanitoraiSetSession(val);
            if (jaiInput) jaiInput.value = '';
            if (res?.ok) CoreAPI.showToast('JanitorAI session saved', 'success');
            else CoreAPI.showToast(res?.error || 'Invalid JanitorAI session', 'error');
            renderJaiStatus();
        } finally {
            jaiSaveBtn.disabled = false;
        }
    });

    on($('dcPlusClearJanitoraiTokenBtn'), 'click', async () => {
        await datacatJanitoraiLogout();
        if (jaiInput) jaiInput.value = '';
        renderJaiStatus();
        CoreAPI.showToast('JanitorAI session cleared', 'info');
    });

    on($('dcPlusRestoreAvatarsBtn'), 'click', () => openRestoreModal());
}
