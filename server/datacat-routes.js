// =============================================================================
// DataCat: token session + extraction + read-only API proxy
// =============================================================================
import { randomUUID } from 'node:crypto';
import {
    buildDataCatAccountIdentifyHeaders,
    buildDataCatHeaders,
    chooseDataCatToken,
    isDataCatCharacterId,
    isDataCatFolderId,
    normalizeDcCredential,
    normalizeDcFolderIdList,
    normalizeOptionalDcCredential,
    sanitizeDataCatUser,
} from './datacat-utils.js';

const DATACAT_BASE = 'https://datacat.run';
export const T_SESSIONS = 'x_datacat_plus_sessions';
const DC_PROXY_REDIRECT_LIMIT = 3;
// Sigma's own DataCat proxy relays through relayUpstream with PROVIDER_RELAY_MAX_BYTES, 50 MiB
// (server/lib/net-guard.js:187, services/shared.js:108). DataCat's /api/tags/faceted alone answered
// 9,610,899 bytes on 2026-11-24, so a smaller cap empties the Tags dropdown.
const DC_PROXY_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Read an upstream body, giving up as soon as it passes `maxBytes` (a missing or wrong
 * content-length can't make the server hold more than the cap).
 * @returns {Promise<{buffer: Buffer|null, size: number}>} buffer is null past the cap; size is what was seen
 */
export async function readDcBodyCapped(response, maxBytes) {
    const declared = Number(response.headers.get('content-length'));
    if (declared > maxBytes) {
        await response.body?.cancel().catch(() => {});
        return { buffer: null, size: declared };
    }
    if (!response.body) return { buffer: Buffer.alloc(0), size: 0 };
    const reader = response.body.getReader();
    const parts = [];
    let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
            await reader.cancel().catch(() => {});
            return { buffer: null, size };
        }
        parts.push(value);
    }
    return { buffer: Buffer.concat(parts, size), size };
}

function dcHeaders(token, options = {}) {
    return buildDataCatHeaders({
        sessionToken: token,
        deviceToken: options.deviceToken || null,
        json: options.json === true,
    });
}

function getUserHandle(req) {
    return String(req.userHandle || 'default');
}

function readDcSession(req) {
    const handle = getUserHandle(req);
    const row = req.db.prepare(
        `SELECT anon_token, device_token, account_token, user_json FROM ${T_SESSIONS} WHERE user_handle = ?`
    ).get(handle);
    if (!row) {
        return { anonToken: null, deviceToken: null, accountToken: null, user: null };
    }
    let user = null;
    if (row.user_json) {
        try {
            user = JSON.parse(row.user_json);
        } catch {
            user = null;
        }
    }
    return {
        anonToken: row.anon_token || null,
        deviceToken: row.device_token || null,
        accountToken: row.account_token || null,
        user,
    };
}

function writeDcSession(req, patch) {
    const handle = getUserHandle(req);
    const current = readDcSession(req);
    const next = {
        anonToken: 'anonToken' in patch ? (patch.anonToken || null) : current.anonToken,
        deviceToken: 'deviceToken' in patch ? (patch.deviceToken || null) : current.deviceToken,
        accountToken: 'accountToken' in patch ? (patch.accountToken || null) : current.accountToken,
        user: 'user' in patch ? (patch.user || null) : current.user,
    };
    req.db.prepare(
        `INSERT INTO ${T_SESSIONS} (user_handle, anon_token, device_token, account_token, user_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_handle) DO UPDATE SET
             anon_token = excluded.anon_token,
             device_token = excluded.device_token,
             account_token = excluded.account_token,
             user_json = excluded.user_json,
             updated_at = excluded.updated_at`
    ).run(
        handle,
        next.anonToken,
        next.deviceToken,
        next.accountToken,
        next.user ? JSON.stringify(next.user) : null,
        Date.now(),
    );
    return next;
}

function getDcActiveToken(session, { preferAccount = true } = {}) {
    return chooseDataCatToken({
        accountToken: session.accountToken,
        anonymousToken: session.anonToken,
        preferAccount,
    });
}

function requireDcAccount(req, res) {
    const session = readDcSession(req);
    if (!session.accountToken) {
        res.status(401).json({ error: 'No DataCat account session configured' });
        return null;
    }
    return { token: session.accountToken, user: session.user };
}

async function readDcResponse(response) {
    const rawText = await response.text().catch(() => '');
    let data = null;
    if (rawText) {
        try {
            data = JSON.parse(rawText);
        } catch {
            data = null;
        }
    }
    return { data, rawText };
}

function extractHtmlTitle(html) {
    if (typeof html !== 'string' || !html) return null;
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!match) return null;
    const title = match[1].replace(/\s+/g, ' ').trim();
    return title ? title.slice(0, 200) : null;
}

function formatDcError(response, data, rawText, fallbackLabel = 'DataCat request') {
    const jsonMsg = data && typeof data === 'object'
        ? (data.reason || data.error || data.message || null)
        : null;
    if (typeof jsonMsg === 'string' && jsonMsg.trim()) {
        return jsonMsg.trim();
    }
    const title = extractHtmlTitle(rawText);
    if (title) {
        return `DataCat returned HTTP ${response.status}: ${title}`;
    }
    const snippet = typeof rawText === 'string' ? rawText.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    if (snippet) {
        return `DataCat returned HTTP ${response.status}: ${snippet}`;
    }
    return `${fallbackLabel} failed with DataCat HTTP ${response.status}`;
}

async function testDcToken(token, deviceToken) {
    const response = await fetch(`${DATACAT_BASE}/api/characters/recent-public?limit=1&offset=0&summary=1&minTotalTokens=889`, {
        headers: dcHeaders(token, { deviceToken }),
    });
    return response;
}

// Read-only API paths forwarded by /dc-proxy.
// DataCat's list queries take at most 50 blockedTagIds
export const DC_BLOCKED_TAGS_MAX = 50;

/**
 * A blocked-tag list in DataCat's shape ({ id, label, slug }, ids positive integers, no repeats).
 * @returns {Array<{id: number, label: string, slug: string|null}>|null} null when it isn't a list or is too long
 */
export function normalizeDcBlockedTags(list) {
    if (!Array.isArray(list)) return null;
    const seen = new Set();
    const out = [];
    for (const t of list) {
        const id = parseInt(String(t && typeof t === 'object' ? t.id : t), 10);
        if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
        seen.add(id);
        const label = String((t && typeof t === 'object' && (t.label || t.name)) || '').trim().slice(0, 120);
        const slug = String((t && typeof t === 'object' && t.slug) || '').trim().slice(0, 120);
        out.push({ id, label: label || `Tag #${id}`, slug: slug || null });
    }
    return out.length > DC_BLOCKED_TAGS_MAX ? null : out;
}

const DC_ALLOWED_PATHS = [
    /^\/api\/characters$/,
    /^\/api\/characters\/fresh\b/,
    /^\/api\/characters\/recent-public\b/,
    /^\/api\/characters\/[a-f0-9-]+$/,
    /^\/api\/characters\/[a-f0-9-]+\/download\b/,
    /^\/api\/creators\/[a-f0-9-]+$/,
    /^\/api\/creators\/[a-f0-9-]+\/characters\b/,
    /^\/api\/tags\/faceted\b/,
    /^\/api\/extraction\/status-projection$/,
];

// Resolve a usable public session ID for the extraction endpoint.
async function getPublicSessionId(token, deviceToken) {
    try {
        const resp = await fetch(`${DATACAT_BASE}/api/users`, {
            headers: dcHeaders(token, { deviceToken }),
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        const publicUser = (data.users || []).find(u => u.isPublic);
        if (!publicUser?.sessions) return null;
        // Pick a non-background, logged_in session
        const session = publicUser.sessions.find(
            s => s.purpose !== 'BACKGROUND_SCRAPER' && s.status === 'logged_in'
        );
        return session?.id || null;
    } catch {
        return null;
    }
}

async function verifyDcAccountToken(token, deviceToken) {
    const value = normalizeDcCredential(token);
    if (!value) {
        return { valid: false, reason: 'missing token', user: null };
    }

    try {
        const response = await fetch(`${DATACAT_BASE}/api/auth/verify`, {
            method: 'POST',
            headers: buildDataCatHeaders({ sessionToken: value, deviceToken, json: true }),
            body: JSON.stringify({ token: value }),
        });
        const { data, rawText } = await readDcResponse(response);

        if (response.ok && data?.success && data?.valid && data?.user) {
            return { valid: true, user: sanitizeDataCatUser(data.user) };
        }

        return {
            valid: false,
            reason: formatDcError(response, data, rawText, 'DataCat auth verify'),
            user: null,
        };
    } catch (err) {
        return { valid: false, reason: err.message, user: null };
    }
}

async function activateDcAccountSession(token, deviceToken) {
    const headers = buildDataCatAccountIdentifyHeaders(token, deviceToken);
    if (!headers) {
        return { ok: false, reason: 'missing account token' };
    }

    try {
        const response = await fetch(`${DATACAT_BASE}/api/liberator/identify`, {
            method: 'POST',
            headers,
        });
        const { data, rawText } = await readDcResponse(response);
        if (response.ok) {
            const nextDeviceToken = data?.deviceToken || data?.newDeviceToken || null;
            return { ok: true, deviceToken: nextDeviceToken };
        }
        return {
            ok: false,
            reason: formatDcError(response, data, rawText, 'DataCat identify'),
        };
    } catch (err) {
        return { ok: false, reason: err.message };
    }
}

function guardDcProxyTargetFallback(req, res) {
    const rawSplat = req.params?.splat;
    const splat = Array.isArray(rawSplat) ? rawSplat.join('/') : String(rawSplat || '');
    const targetPath = '/' + splat.replace(/^\/+/, '');

    let targetUrl;
    try {
        targetUrl = new URL(targetPath, DATACAT_BASE);
        targetUrl.search = new URL(req.url, 'http://localhost').search;
    } catch {
        res.status(400).json({ error: 'Invalid DataCat proxy path' });
        return null;
    }

    if (targetUrl.origin !== DATACAT_BASE) {
        res.status(403).json({ error: 'Proxy target must be datacat.run' });
        return null;
    }

    if (!DC_ALLOWED_PATHS.some(re => re.test(targetUrl.pathname))) {
        console.warn(`[datacat-plus] DC proxy blocked: ${targetUrl.pathname}`);
        res.status(403).json({ error: 'Proxy path not allowed' });
        return null;
    }
    return targetUrl;
}

async function fetchDcProxyTarget(targetUrl, token, deviceToken, ctx) {
    const init = {
        method: 'GET',
        headers: buildDataCatHeaders({ sessionToken: token, deviceToken }),
    };
    if (ctx?.helpers?.sameHostFetch) {
        return ctx.helpers.sameHostFetch(targetUrl, init, { maxRedirects: DC_PROXY_REDIRECT_LIMIT });
    }
    let currentUrl = targetUrl;
    for (let redirects = 0; redirects <= DC_PROXY_REDIRECT_LIMIT; redirects++) {
        const response = await fetch(currentUrl.toString(), {
            ...init,
            redirect: 'manual',
        });

        const isRedirect = response.status >= 300 && response.status < 400;
        const location = response.headers.get('location');
        if (!isRedirect || !location) return response;

        const nextUrl = new URL(location, currentUrl);
        if (nextUrl.origin !== DATACAT_BASE) {
            throw new Error('Blocked off-origin DataCat redirect');
        }
        currentUrl = nextUrl;
    }
    throw new Error('Too many DataCat redirects');
}

export function registerDataCatRoutes(router, ctx = null) {
    router.post('/dc-init', async (req, res) => {
        const { force } = req.body ?? {};
        const session = readDcSession(req);

        // If we already have a token and not forcing refresh, verify it still works
        if (session.anonToken && !force) {
            try {
                const check = await testDcToken(session.anonToken, session.deviceToken);
                if (check.ok) {
                    const result = { ok: true, cached: true, token: true };
                    return res.json(result);
                }
            } catch { /* fall through to create new */ }
            writeDcSession(req, { anonToken: null });
        }

        // Create anonymous session via the Liberator identify endpoint
        const deviceToken = session.deviceToken || randomUUID();
        try {
            const response = await fetch(`${DATACAT_BASE}/api/liberator/identify`, {
                method: 'POST',
                headers: buildDataCatHeaders({ deviceToken, json: true }),
                body: JSON.stringify({ deviceToken }),
            });
            const { data, rawText } = await readDcResponse(response);

            if (!response.ok) {
                console.warn(`[datacat-plus] DC identify failed: HTTP ${response.status}`);
                return res.json({ ok: false, reason: formatDcError(response, data, rawText, 'DataCat identify') });
            }

            if (data?.success && data?.sessionToken) {
                const saved = writeDcSession(req, {
                    anonToken: data.sessionToken,
                    deviceToken: data.deviceToken || data.newDeviceToken || deviceToken,
                });
                console.log('[datacat-plus] DC anonymous session initialized');
                // token: true, never the token itself: sessions stay server-side (the client only checks it is truthy)
                return res.json({ ok: true, token: true });
            }

            console.warn('[datacat-plus] DC identify returned unexpected shape:', JSON.stringify(data).slice(0, 300));
            res.json({ ok: false, reason: 'DataCat identify response missing sessionToken' });
        } catch (err) {
            console.error('[datacat-plus] DC auto-init error:', err.message);
            res.json({ ok: false, reason: `Failed to reach DataCat: ${err.message}` });
        }
    });

    router.post('/dc-set-token', async (req, res) => {
        const { token, deviceToken } = req.body ?? {};

        const value = normalizeDcCredential(token);
        if (!value) {
            return res.status(400).json({ error: 'token string is required' });
        }
        const normalizedDeviceToken = normalizeOptionalDcCredential(deviceToken);

        const patch = { anonToken: value };
        if (normalizedDeviceToken) patch.deviceToken = normalizedDeviceToken;
        const saved = writeDcSession(req, patch);
        console.log('[datacat-plus] DC session token stored');
        const result = { ok: true };
        res.json(result);
    });

    router.post('/dc-clear-token', (req, res) => {
        writeDcSession(req, { anonToken: null });
        console.log('[datacat-plus] DC session token cleared');
        res.json({ ok: true });
    });

    router.get('/dc-session', (req, res) => {
        const session = readDcSession(req);
        const result = { active: !!session.anonToken };
        res.json(result);
    });

    router.get('/dc-status', (req, res) => {
        const session = readDcSession(req);
        const result = { active: !!session.anonToken };
        res.json(result);
    });

    router.get('/dc-validate', async (req, res) => {
        const session = readDcSession(req);
        if (!session.anonToken) {
            const result = { valid: false, reason: 'no token stored' };
            return res.json(result);
        }

        try {
            const response = await testDcToken(session.anonToken, session.deviceToken);
            const { data, rawText } = await readDcResponse(response);

            if (response.ok) {
                const count = data?.totalCount || 0;
                console.log(`[datacat-plus] DC validate: ${count} total chars available`);
                const result = { valid: true, totalCount: count };
                res.json(result);
            } else {
                console.warn(`[datacat-plus] DC validate failed: HTTP ${response.status}`);
                const result = { valid: false, reason: formatDcError(response, data, rawText, 'DataCat validate') };
                res.json(result);
            }
        } catch (err) {
            console.error('[datacat-plus] DC validate error:', err.message);
            const result = { valid: false, reason: `Failed to reach DataCat: ${err.message}` };
            res.json(result);
        }
    });

    router.post('/dc-auth-login', async (req, res) => {
        const session = readDcSession(req);

        const email = normalizeDcCredential(req.body?.email, { maxLength: 320 });
        const password = normalizeDcCredential(req.body?.password, { maxLength: 512 });
        if (!email || !password) {
            return res.status(400).json({ error: 'email and password are required' });
        }

        const body = { email, password };
        if (session.deviceToken) body.anonToken = session.deviceToken;

        try {
            const response = await fetch(`${DATACAT_BASE}/api/auth/login`, {
                method: 'POST',
                headers: buildDataCatHeaders({ sessionToken: session.anonToken, deviceToken: session.deviceToken, json: true }),
                body: JSON.stringify(body),
            });
            const { data, rawText } = await readDcResponse(response);

            if (data?.success && data?.session?.token) {
                const accountToken = data.session.token;
                let deviceToken = data.newDeviceToken || session.deviceToken;
                const accountUser = sanitizeDataCatUser(data.user || data.session?.user || null);
                const activation = await activateDcAccountSession(accountToken, deviceToken);
                if (activation.ok && activation.deviceToken) {
                    deviceToken = activation.deviceToken;
                } else if (!activation.ok) {
                    console.warn('[datacat-plus] DC auth login account activation failed:', activation.reason);
                }
                const saved = writeDcSession(req, { accountToken, user: accountUser, deviceToken });
                return res.json({ ok: true, user: accountUser });
            }

            const status = response.ok ? 401 : response.status || 401;
            return res.status(status).json({
                error: formatDcError(response, data, rawText, 'DataCat login'),
            });
        } catch (err) {
            console.error('[datacat-plus] DC auth login error:', err.message);
            return res.status(502).json({ error: `Failed to reach DataCat: ${err.message}` });
        }
    });

    router.post('/dc-auth-set', async (req, res) => {
        const session = readDcSession(req);

        const value = normalizeDcCredential(req.body?.accountToken || req.body?.token);
        if (!value) {
            return res.status(400).json({ error: 'accountToken string is required' });
        }

        const suppliedDeviceToken = req.body?.deviceToken;
        const normalizedDeviceToken = normalizeOptionalDcCredential(suppliedDeviceToken);
        let deviceToken = normalizedDeviceToken || session.deviceToken;

        const verification = await verifyDcAccountToken(value, deviceToken);
        if (!verification.valid) {
            return res.status(401).json({ valid: false, reason: verification.reason });
        }

        const activation = await activateDcAccountSession(value, deviceToken);
        if (activation.ok && activation.deviceToken) {
            deviceToken = activation.deviceToken;
        } else if (!activation.ok) {
            console.warn('[datacat-plus] DC auth set account activation failed:', activation.reason);
        }
        const saved = writeDcSession(req, { accountToken: value, user: verification.user, deviceToken });
        return res.json({ ok: true, valid: true, user: verification.user });
    });

    router.get('/dc-auth-status', async (req, res) => {
        const session = readDcSession(req);
        if (!session.accountToken) {
            return res.json({ valid: false, reason: 'no account token stored', user: null });
        }

        const verification = await verifyDcAccountToken(session.accountToken, session.deviceToken);
        if (verification.valid) {
            let deviceToken = session.deviceToken;
            const activation = await activateDcAccountSession(session.accountToken, deviceToken);
            if (activation.ok && activation.deviceToken) {
                deviceToken = activation.deviceToken;
            } else if (!activation.ok) {
                console.warn('[datacat-plus] DC auth status account activation failed:', activation.reason);
            }
            const saved = writeDcSession(req, { user: verification.user, deviceToken });
            return res.json({ valid: true, user: verification.user });
        }

        writeDcSession(req, { accountToken: null, user: null });
        return res.json({ valid: false, reason: verification.reason, user: null });
    });

    router.post('/dc-auth-logout', async (req, res) => {
        const session = readDcSession(req);
        const token = session.accountToken;
        writeDcSession(req, { accountToken: null, user: null });

        if (token) {
            try {
                const response = await fetch(`${DATACAT_BASE}/api/auth/logout`, {
                    method: 'POST',
                    headers: buildDataCatHeaders({ sessionToken: token, deviceToken: session.deviceToken, json: true }),
                    body: JSON.stringify({ token }),
                });
                if (!response.ok) {
                    console.warn(`[datacat-plus] DC auth logout failed: HTTP ${response.status}`);
                }
            } catch (err) {
                console.warn('[datacat-plus] DC auth logout error:', err.message);
            }
        }

        res.json({ ok: true });
    });

    // POST-only: submit extraction request to DataCat
    router.post('/dc-extract', async (req, res) => {
        let session = readDcSession(req);
        const preferAccount = req.body?.useAccount !== false;
        const active = getDcActiveToken(session, { preferAccount });
        if (!active.token) {
            return res.status(401).json({ error: 'No DataCat session token configured' });
        }

        const { url } = req.body ?? {};
        if (!url || typeof url !== 'string') {
            return res.status(400).json({ error: 'url string is required' });
        }
        if (url.length > 512) {
            return res.status(400).json({ error: 'URL too long' });
        }

        // Allow JanitorAI character URLs and Saucepan companion URLs
        let extractionKind = null;
        try {
            const parsed = new URL(url);
            const isJanitor = /^(www\.)?janitorai\.com$/i.test(parsed.hostname) || /^(www\.)?jannyai\.com$/i.test(parsed.hostname);
            const isSaucepan = /^(www\.)?saucepan\.ai$/i.test(parsed.hostname);
            if (!isJanitor && !isSaucepan) {
                return res.status(400).json({ error: 'Only JanitorAI or Saucepan character URLs are supported' });
            }
            if (isJanitor && !/^\/characters\/[a-f0-9-]{8,64}(_[\w-]+)?\/?$/i.test(parsed.pathname)) {
                return res.status(400).json({ error: 'Invalid character URL path' });
            }
            if (isSaucepan && !/^\/companion\/[a-f0-9-]{8,64}\/?$/i.test(parsed.pathname)) {
                return res.status(400).json({ error: 'Invalid character URL path' });
            }
            extractionKind = isSaucepan ? 'saucepan' : 'janitor';
        } catch {
            return res.status(400).json({ error: 'Invalid URL' });
        }

        const requestId = randomUUID();
        const wantPublicFeed = req.body.publicFeed !== false;
        const alwaysReextract = req.body.alwaysReextract === true;

        if (active.source === 'account') {
            const activation = await activateDcAccountSession(active.token, session.deviceToken);
            if (!activation.ok) {
                return res.status(401).json({
                    error: 'Failed to activate DataCat account session',
                    reason: activation.reason,
                });
            }
            if (activation.deviceToken) {
                session = writeDcSession(req, { deviceToken: activation.deviceToken });
            }
        }

        // Resolve a public session ID when public feed is requested
        let sessionId = null;
        if (wantPublicFeed) {
            sessionId = await getPublicSessionId(active.token, session.deviceToken);
        }

        try {
            let endpoint, body;
            if (extractionKind === 'saucepan') {
                endpoint = `${DATACAT_BASE}/api/saucepan-extract/run`;
                body = {
                    companion: url,
                    sourceKind: 'one_off',
                    sourceRef: requestId,
                    includeSearch: true,
                    extractHidden: false,
                    idempotencyKey: requestId,
                    alwaysReextract,
                };
            } else {
                endpoint = `${DATACAT_BASE}/api/character/smart-extract-v2`;
                body = {
                    url,
                    openLoginIfNoSession: true,
                    sessionId,
                    appearOnPublicFeed: wantPublicFeed && !!sessionId,
                    publicFeedVisibilityIntent: wantPublicFeed && !!sessionId,
                    useSeparateWorkerServer: true,
                    inlinePostExtractCreatorProfile: true,
                    idempotencyKey: requestId,
                    extractSourceMode: 'core_plus_janny',
                    alwaysReextract,
                };
            }

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    ...buildDataCatHeaders({ sessionToken: active.token, deviceToken: session.deviceToken, json: true }),
                    'X-Request-Id': requestId,
                },
                body: JSON.stringify(body),
            });

            const { data, rawText } = await readDcResponse(response);
            if (data !== null) {
                return res.status(response.status).json(data);
            }
            res.status(response.status).json({ error: formatDcError(response, null, rawText, 'DataCat extract') });
        } catch (err) {
            console.error('[datacat-plus] DC extract error:', err.message);
            res.status(502).json({ error: `Failed to reach DataCat: ${err.message}` });
        }
    });

    function getDcQueryStringValue(query, key) {
        const value = query?.[key];
        if (Array.isArray(value)) return value[0];
        return value;
    }

    function appendDcIntegerParam(params, key, value, { min = 0, max = 1000000 } = {}) {
        const raw = getDcQueryStringValue({ [key]: value }, key);
        if (raw === undefined || raw === null || raw === '') return;
        const parsed = parseInt(String(raw), 10);
        if (!Number.isFinite(parsed)) return;
        params.set(key, String(Math.min(max, Math.max(min, parsed))));
    }

    function normalizeDcIntegerList(value) {
        const raw = Array.isArray(value) ? value.join(',') : String(value ?? '');
        return raw
            .split(',')
            .map(part => parseInt(String(part).trim(), 10))
            .filter(id => Number.isFinite(id) && id > 0);
    }

    function appendDcIntegerListParam(params, key, value) {
        const ids = normalizeDcIntegerList(value);
        if (ids.length > 0) params.set(key, ids.join(','));
    }

    function normalizeDcFolderPayload(body = {}) {
        if (!body || typeof body !== 'object') return null;
        const title = String(body.title ?? '').trim().replace(/\s+/g, ' ');
        if (!title || title.length > 120) return null;
        const description = String(body.description ?? '').trim();
        if (description.length > 500) return null;
        return { title, description };
    }

    function normalizeDcFolderQueryId(value) {
        const raw = getDcQueryStringValue({ folderId: value }, 'folderId');
        if (raw === undefined || raw === null || raw === '') return null;
        return isDataCatFolderId(raw) ? String(parseInt(String(raw), 10)) : false;
    }

    function buildDcFoldersSearchParams(query = {}) {
        const params = new URLSearchParams();
        appendDcIntegerParam(params, 'minTotalTokens', getDcQueryStringValue(query, 'minTotalTokens'));
        appendDcIntegerListParam(params, 'activeTagIds', getDcQueryStringValue(query, 'activeTagIds'));
        appendDcIntegerListParam(params, 'blockedTagIds', getDcQueryStringValue(query, 'blockedTagIds'));
        return params;
    }

    function buildDcFolderCharactersSearchParams(query = {}) {
        const params = new URLSearchParams();
        appendDcIntegerParam(params, 'limit', getDcQueryStringValue(query, 'limit'), { min: 1, max: 200 });
        appendDcIntegerParam(params, 'offset', getDcQueryStringValue(query, 'offset'), { min: 0, max: 1000000 });
        appendDcIntegerParam(params, 'minTotalTokens', getDcQueryStringValue(query, 'minTotalTokens'));
        appendDcIntegerListParam(params, 'tagIds', getDcQueryStringValue(query, 'tagIds'));
        appendDcIntegerListParam(params, 'blockedTagIds', getDcQueryStringValue(query, 'blockedTagIds'));

        const mainOnly = String(getDcQueryStringValue(query, 'mainOnly') || '').trim() === '1';
        if (mainOnly) {
            params.set('mainOnly', '1');
        } else {
            const folderId = normalizeDcFolderQueryId(getDcQueryStringValue(query, 'folderId'));
            if (folderId === false) return null;
            if (folderId) params.set('folderId', folderId);
        }

        const search = String(getDcQueryStringValue(query, 'search') || '').trim();
        if (search) params.set('search', search.slice(0, 200));
        const sort = String(getDcQueryStringValue(query, 'sort') || 'added').trim();
        if (sort) params.set('sort', sort.slice(0, 80));
        return params;
    }

    async function fetchDcAccountEndpoint(account, path, { method = 'GET', body = null, json = false } = {}) {
        const options = {
            method,
            headers: buildDataCatHeaders({ sessionToken: account.token, deviceToken: account.deviceToken, json }),
        };
        if (body != null) {
            options.body = JSON.stringify(body);
        }
        const response = await fetch(`${DATACAT_BASE}${path}`, options);
        const { data, rawText } = await readDcResponse(response);
        return { response, data, rawText };
    }

    router.get('/dc-folders', async (req, res) => {
        const account = requireDcAccount(req, res);
        if (!account) return;

        const params = buildDcFoldersSearchParams(req.query);
        const query = params.toString();
        try {
            const { response, data, rawText } = await fetchDcAccountEndpoint(account, `/api/user-folders${query ? `?${query}` : ''}`);
            if (response.ok && data?.success) return res.json({ ...data, ok: true });
            return res.status(response.status || 502).json({
                error: formatDcError(response, data, rawText, 'DataCat folders'),
            });
        } catch (err) {
            console.error('[datacat-plus] DC folders list error:', err.message);
            return res.status(502).json({ error: `Failed to reach DataCat: ${err.message}` });
        }
    });

    router.post('/dc-folders', async (req, res) => {
        const account = requireDcAccount(req, res);
        if (!account) return;
        const body = normalizeDcFolderPayload(req.body);
        if (!body) return res.status(400).json({ error: 'Valid folder title is required' });

        try {
            const { response, data, rawText } = await fetchDcAccountEndpoint(account, '/api/user-folders', { method: 'POST', body, json: true });
            if (response.ok && data?.success) return res.json({ ...data, ok: true });
            return res.status(response.status || 502).json({
                error: formatDcError(response, data, rawText, 'DataCat folder create'),
            });
        } catch (err) {
            console.error('[datacat-plus] DC folder create error:', err.message);
            return res.status(502).json({ error: `Failed to reach DataCat: ${err.message}` });
        }
    });

    // ── Blocked tags: the account's own list (DataCat's site keeps it in
    // /api/user-preferences/character-filters as { tags, creators, hiding }). A PUT there replaces
    // the whole object, so a tag change reads it first and sends the other two parts back untouched.
    router.get('/dc-blocked-tags', async (req, res) => {
        const account = requireDcAccount(req, res);
        if (!account) return;
        try {
            const { response, data, rawText } = await fetchDcAccountEndpoint(account, '/api/user-preferences/character-filters');
            if (response.ok && data?.success) {
                return res.json({ ok: true, configured: data.configured?.tags === true, tags: normalizeDcBlockedTags(data.tags) || [] });
            }
            return res.status(response.status || 502).json({ error: formatDcError(response, data, rawText, 'DataCat blocked tags') });
        } catch (err) {
            console.error('[datacat-plus] DC blocked tags read error:', err.message);
            return res.status(502).json({ error: `Failed to reach DataCat: ${err.message}` });
        }
    });

    router.put('/dc-blocked-tags', async (req, res) => {
        const account = requireDcAccount(req, res);
        if (!account) return;
        const tags = normalizeDcBlockedTags(req.body?.tags);
        if (!tags) return res.status(400).json({ error: `A list of at most ${DC_BLOCKED_TAGS_MAX} tags is required` });
        try {
            const current = await fetchDcAccountEndpoint(account, '/api/user-preferences/character-filters');
            if (!(current.response.ok && current.data?.success)) {
                return res.status(current.response.status || 502).json({
                    error: formatDcError(current.response, current.data, current.rawText, 'DataCat filter preferences'),
                });
            }
            const keep = current.data;
            // a session DataCat no longer treats as signed in: writing now would send creators/hiding empty
            if (keep.authenticated === false) return res.status(401).json({ error: 'DataCat account session expired: sign in again' });
            const body = {
                tags,
                ...(Array.isArray(keep.creators) ? { creators: keep.creators } : {}),
                ...(keep.hiding && typeof keep.hiding === 'object' ? { hiding: keep.hiding } : {}),
            };
            const { response, data, rawText } = await fetchDcAccountEndpoint(account, '/api/user-preferences/character-filters', { method: 'PUT', body, json: true });
            if (response.ok && data?.success) return res.json({ ok: true, tags });
            return res.status(response.status || 502).json({ error: formatDcError(response, data, rawText, 'DataCat blocked tags save') });
        } catch (err) {
            console.error('[datacat-plus] DC blocked tags save error:', err.message);
            return res.status(502).json({ error: `Failed to reach DataCat: ${err.message}` });
        }
    });

    // Registered ahead of the /:folderId routes so 'reorder' is never read as an id.
    router.put('/dc-folders/reorder', async (req, res) => {
        const account = requireDcAccount(req, res);
        if (!account) return;
        const folderIds = normalizeDcFolderIdList(req.body?.folderIds);
        if (!folderIds) return res.status(400).json({ error: 'A valid folderIds list is required' });

        try {
            const { response, data, rawText } = await fetchDcAccountEndpoint(account, '/api/user-folders/reorder', { method: 'PUT', body: { folderIds }, json: true });
            if (response.ok && data?.success) return res.json({ ...data, ok: true });
            return res.status(response.status || 502).json({
                error: formatDcError(response, data, rawText, 'DataCat folder reorder'),
            });
        } catch (err) {
            console.error('[datacat-plus] DC folder reorder error:', err.message);
            return res.status(502).json({ error: `Failed to reach DataCat: ${err.message}` });
        }
    });

    router.patch('/dc-folders/:folderId', async (req, res) => {
        const account = requireDcAccount(req, res);
        if (!account) return;
        const { folderId } = req.params;
        if (!isDataCatFolderId(folderId)) return res.status(400).json({ error: 'Invalid DataCat folder id' });
        const body = normalizeDcFolderPayload(req.body);
        if (!body) return res.status(400).json({ error: 'Valid folder title is required' });

        try {
            const { response, data, rawText } = await fetchDcAccountEndpoint(account, `/api/user-folders/${encodeURIComponent(String(parseInt(folderId, 10)))}`, { method: 'PATCH', body, json: true });
            if (response.ok && data?.success) return res.json({ ...data, ok: true });
            return res.status(response.status || 502).json({
                error: formatDcError(response, data, rawText, 'DataCat folder update'),
            });
        } catch (err) {
            console.error('[datacat-plus] DC folder update error:', err.message);
            return res.status(502).json({ error: `Failed to reach DataCat: ${err.message}` });
        }
    });

    router.delete('/dc-folders/:folderId', async (req, res) => {
        const account = requireDcAccount(req, res);
        if (!account) return;
        const { folderId } = req.params;
        if (!isDataCatFolderId(folderId)) return res.status(400).json({ error: 'Invalid DataCat folder id' });

        try {
            const { response, data, rawText } = await fetchDcAccountEndpoint(account, `/api/user-folders/${encodeURIComponent(String(parseInt(folderId, 10)))}`, { method: 'DELETE' });
            if (response.ok && data?.success) return res.json({ ...data, ok: true });
            return res.status(response.status || 502).json({
                error: formatDcError(response, data, rawText, 'DataCat folder delete'),
            });
        } catch (err) {
            console.error('[datacat-plus] DC folder delete error:', err.message);
            return res.status(502).json({ error: `Failed to reach DataCat: ${err.message}` });
        }
    });

    async function setDcFolderMembership(req, res, shouldAdd) {
        const account = requireDcAccount(req, res);
        if (!account) return;
        const { folderId, characterId } = req.params;
        if (!isDataCatFolderId(folderId)) return res.status(400).json({ error: 'Invalid DataCat folder id' });
        if (!isDataCatCharacterId(characterId)) return res.status(400).json({ error: 'Invalid DataCat character id' });

        // DataCat refuses a folder for a character not collected yet; ?collect=1 collects it first,
        // so the page waits on one trip instead of two
        const collectFirst = shouldAdd && String(req.query?.collect || '') === '1';
        let collected = false;
        try {
            if (collectFirst) {
                const c = await fetchDcAccountEndpoint(
                    account,
                    `/api/characters/${encodeURIComponent(characterId)}/collect`,
                    { method: 'POST', json: true },
                );
                if (!(c.response.ok && c.data?.success)) {
                    return res.status(c.response.status || 502).json({
                        error: formatDcError(c.response, c.data, c.rawText, 'DataCat collect'),
                    });
                }
                collected = true;
            }
            const path = `/api/user-folders/${encodeURIComponent(String(parseInt(folderId, 10)))}/items/${encodeURIComponent(characterId)}`;
            const { response, data, rawText } = await fetchDcAccountEndpoint(account, path, { method: shouldAdd ? 'PUT' : 'DELETE' });
            if (response.ok && data?.success) {
                return res.json({ ...data, ok: true, folderId: parseInt(folderId, 10), characterId, ...(collectFirst ? { collected } : {}) });
            }
            // the collect landed even though the folder step did not: say so, so the page keeps Main ticked
            return res.status(response.status || 502).json({
                error: formatDcError(response, data, rawText, 'DataCat folder membership'),
                ...(collected ? { collected: true } : {}),
            });
        } catch (err) {
            console.error('[datacat-plus] DC folder membership error:', err.message);
            // a collect that landed before the folder call threw still counts: the page keeps Main ticked
            return res.status(502).json({ error: `Failed to reach DataCat: ${err.message}`, ...(collected ? { collected: true } : {}) });
        }
    }

    router.put('/dc-folders/:folderId/items/:characterId', (req, res) => setDcFolderMembership(req, res, true));
    router.delete('/dc-folders/:folderId/items/:characterId', (req, res) => setDcFolderMembership(req, res, false));

    router.get('/dc-folder-characters', async (req, res) => {
        const account = requireDcAccount(req, res);
        if (!account) return;
        const params = buildDcFolderCharactersSearchParams(req.query);
        if (!params) return res.status(400).json({ error: 'Invalid DataCat folder id' });
        const query = params.toString();

        try {
            const { response, data, rawText } = await fetchDcAccountEndpoint(account, `/api/characters${query ? `?${query}` : ''}`);
            if (response.ok && data?.success !== false) return res.json({ ...data, ok: true });
            return res.status(response.status || 502).json({
                error: formatDcError(response, data, rawText, 'DataCat folder characters'),
            });
        } catch (err) {
            console.error('[datacat-plus] DC folder characters error:', err.message);
            return res.status(502).json({ error: `Failed to reach DataCat: ${err.message}` });
        }
    });
    router.get('/dc-yours/:characterId/status', async (req, res) => {
        const account = requireDcAccount(req, res);
        if (!account) return;

        const { characterId } = req.params;
        if (!isDataCatCharacterId(characterId)) {
            return res.status(400).json({ error: 'Invalid DataCat character id' });
        }

        try {
            const { response, data, rawText } = await fetchDcAccountEndpoint(account, `/api/characters/${encodeURIComponent(characterId)}/folders`);

            if (response.ok && data?.success) {
                return res.json({
                    ok: true,
                    collected: data.collected === true,
                    folderIds: Array.isArray(data.folderIds) ? data.folderIds : [],
                });
            }

            return res.status(response.status || 502).json({
                error: formatDcError(response, data, rawText, 'DataCat folders'),
            });
        } catch (err) {
            console.error('[datacat-plus] DC yours status error:', err.message);
            return res.status(502).json({ error: `Failed to reach DataCat: ${err.message}` });
        }
    });

    async function setDcCollected(req, res, shouldCollect) {
        const account = requireDcAccount(req, res);
        if (!account) return;

        const { characterId } = req.params;
        if (!isDataCatCharacterId(characterId)) {
            return res.status(400).json({ error: 'Invalid DataCat character id' });
        }

        try {
            const { response, data, rawText } = await fetchDcAccountEndpoint(
                account,
                `/api/characters/${encodeURIComponent(characterId)}/collect`,
                { method: shouldCollect ? 'POST' : 'DELETE', json: true },
            );

            if (response.ok && data?.success) {
                return res.json({ ok: true, collected: shouldCollect });
            }

            return res.status(response.status || 502).json({
                error: formatDcError(response, data, rawText, 'DataCat collect'),
            });
        } catch (err) {
            console.error('[datacat-plus] DC yours toggle error:', err.message);
            return res.status(502).json({ error: `Failed to reach DataCat: ${err.message}` });
        }
    }

    router.post('/dc-yours/:characterId', (req, res) => setDcCollected(req, res, true));
    router.delete('/dc-yours/:characterId', (req, res) => setDcCollected(req, res, false));

    // Account-backed Following: mirror the site's /api/creators/following list
    // and the per-creator follow toggle so CL's Following syncs across devices.
    router.get('/dc-following', async (req, res) => {
        const account = requireDcAccount(req, res);
        if (!account) return;

        const params = new URLSearchParams();
        params.set('sourceKind', req.query.sourceKind === 'saucepan' ? 'saucepan' : 'janitor');
        params.set('limit', String(Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50))));
        params.set('offset', String(Math.max(0, parseInt(req.query.offset, 10) || 0)));
        params.set('sortBy', String(req.query.sortBy || 'total_chats'));
        params.set('sortDir', String(req.query.sortDir || 'desc'));

        try {
            const { response, data, rawText } = await fetchDcAccountEndpoint(account, `/api/creators/following?${params.toString()}`);

            if (response.ok && data?.success) {
                return res.json({
                    ok: true,
                    total: Number(data.total) || 0,
                    list: Array.isArray(data.list) ? data.list : [],
                });
            }

            return res.status(response.status || 502).json({
                error: formatDcError(response, data, rawText, 'DataCat following'),
            });
        } catch (err) {
            console.error('[datacat-plus] DC following error:', err.message);
            return res.status(502).json({ error: `Failed to reach DataCat: ${err.message}` });
        }
    });

    async function setDcFollow(req, res, shouldFollow) {
        const account = requireDcAccount(req, res);
        if (!account) return;

        const { creatorId } = req.params;
        if (!isDataCatCharacterId(creatorId)) {
            return res.status(400).json({ error: 'Invalid DataCat creator id' });
        }

        try {
            const { response, data, rawText } = await fetchDcAccountEndpoint(
                account,
                `/api/creators/${encodeURIComponent(creatorId)}/follow`,
                { method: shouldFollow ? 'POST' : 'DELETE', json: true },
            );

            if (response.ok && data?.success) {
                return res.json({ ok: true, following: data.isFollowing === true });
            }

            return res.status(response.status || 502).json({
                error: formatDcError(response, data, rawText, 'DataCat follow'),
            });
        } catch (err) {
            console.error('[datacat-plus] DC follow toggle error:', err.message);
            return res.status(502).json({ error: `Failed to reach DataCat: ${err.message}` });
        }
    }

    router.post('/dc-follow/:creatorId', (req, res) => setDcFollow(req, res, true));
    router.delete('/dc-follow/:creatorId', (req, res) => setDcFollow(req, res, false));

    router.get('/dc-proxy/*splat', async (req, res) => {
        const session = readDcSession(req);
        const active = getDcActiveToken(session, { preferAccount: true });
        if (!active.token) {
            return res.status(401).json({ error: 'No DataCat session token configured' });
        }

        const targetUrl = ctx?.helpers?.guardProxyTarget
            ? ctx.helpers.guardProxyTarget(req, res, {
                base: DATACAT_BASE,
                allowedPaths: DC_ALLOWED_PATHS,
                hosts: 'datacat.run',
                label: 'DataCat',
            })
            : guardDcProxyTargetFallback(req, res);
        if (!targetUrl) return;

        try {
            const response = await fetchDcProxyTarget(targetUrl, active.token, session.deviceToken, ctx);

            const contentType = response.headers.get('content-type') || '';
            // capped, and sandboxed so an upstream HTML/SVG answer never runs same-origin in Sigma
            const { buffer, size } = await readDcBodyCapped(response, DC_PROXY_MAX_BYTES);
            if (!buffer) {
                return res.status(502).json({ error: `DataCat answered ${size} bytes, over the ${DC_PROXY_MAX_BYTES} byte limit` });
            }
            res.status(response.status);
            res.set('Content-Security-Policy', 'sandbox');
            res.set('X-Content-Type-Options', 'nosniff');
            if (contentType) res.set('Content-Type', contentType);
            res.send(buffer);
        } catch (err) {
            console.error('[datacat-plus] DC proxy error:', err.message);
            res.status(502).json({ error: `Failed to reach DataCat: ${err.message}` });
        }
    });
}
