// =============================================================================
// DataCat: token session + extraction + read-only API proxy
// =============================================================================

const DATACAT_BASE = 'https://datacat.run';

let dcSessionToken = null;
let dcDeviceToken = null;
const dcAccountSessions = new Map();
const DC_CLIENT_HEADER = 'x-cl-datacat-client';
const DC_CLIENT_ID_MAX_LENGTH = 128;
const DC_PROXY_REDIRECT_LIMIT = 3;

function dcHeaders(token, options = {}) {
    return buildDataCatHeaders({
        sessionToken: token,
        deviceToken: options.deviceToken || null,
        json: options.json === true,
    });
}

function getDcClientId(req) {
    const rawHeader = req.get?.('X-CL-Datacat-Client') || req.headers?.[DC_CLIENT_HEADER];
    const raw = rawHeader || req.body?.clientSessionId || req.body?.clientId || req.query?.clientSessionId || req.query?.clientId;
    const value = Array.isArray(raw) ? raw[0] : raw;
    return normalizeDcCredential(value, { maxLength: DC_CLIENT_ID_MAX_LENGTH });
}

function requireDcClientId(req, res) {
    const clientId = getDcClientId(req);
    if (!clientId) {
        res.status(400).json({ error: 'DataCat client session id is required' });
        return null;
    }
    return clientId;
}

function getDcAccountSession(req) {
    const clientId = getDcClientId(req);
    return clientId ? dcAccountSessions.get(clientId) || null : null;
}

function setDcAccountSession(clientId, token, user) {
    dcAccountSessions.set(clientId, { token, user: user || null });
}

function clearDcAccountSession(req) {
    const clientId = getDcClientId(req);
    if (clientId) dcAccountSessions.delete(clientId);
}

function getDcActiveToken(req, { preferAccount = true } = {}) {
    const account = getDcAccountSession(req);
    return chooseDataCatToken({
        accountToken: account?.token,
        anonymousToken: dcSessionToken,
        preferAccount,
    });
}

function requireDcAccount(req, res) {
    const clientId = requireDcClientId(req, res);
    if (!clientId) return null;

    const session = dcAccountSessions.get(clientId);
    if (!session?.token) {
        res.status(401).json({ error: 'No DataCat account session configured' });
        return null;
    }
    return session;
}

async function readDcJson(response) {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

async function testDcToken(token) {
    const response = await fetch(`${DATACAT_BASE}/api/characters/recent-public?limit=1&offset=0&summary=1&minTotalTokens=889`, {
        headers: dcHeaders(token, { deviceToken: dcDeviceToken }),
    });
    return response;
}

// Read-only API paths forwarded by /dc-proxy.
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
async function getPublicSessionId(token) {
    try {
        const resp = await fetch(`${DATACAT_BASE}/api/users`, {
            headers: dcHeaders(token, { deviceToken: dcDeviceToken }),
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

async function verifyDcAccountToken(token) {
    const value = normalizeDcCredential(token);
    if (!value) {
        return { valid: false, reason: 'missing token', user: null };
    }

    try {
        const response = await fetch(`${DATACAT_BASE}/api/auth/verify`, {
            method: 'POST',
            headers: buildDataCatHeaders({ sessionToken: value, deviceToken: dcDeviceToken, json: true }),
            body: JSON.stringify({ token: value }),
        });
        const data = await readDcJson(response);

        if (response.ok && data?.success && data?.valid && data?.user) {
            return { valid: true, user: sanitizeDataCatUser(data.user) };
        }

        return {
            valid: false,
            reason: data?.reason || data?.error || `HTTP ${response.status}`,
            user: null,
        };
    } catch (err) {
        return { valid: false, reason: err.message, user: null };
    }
}

async function activateDcAccountSession(token) {
    const headers = buildDataCatAccountIdentifyHeaders(token, dcDeviceToken);
    if (!headers) {
        return { ok: false, reason: 'missing account token' };
    }

    try {
        const response = await fetch(`${DATACAT_BASE}/api/liberator/identify`, {
            method: 'POST',
            headers,
        });
        const data = await readDcJson(response);
        if (response.ok) {
            if (data?.deviceToken || data?.newDeviceToken) {
                dcDeviceToken = data.deviceToken || data.newDeviceToken;
            }
            return { ok: true };
        }
        return {
            ok: false,
            reason: data?.reason || data?.error || `HTTP ${response.status}`,
        };
    } catch (err) {
        return { ok: false, reason: err.message };
    }
}

function buildDcRedirectHeaders(url, token) {
    if (url.protocol === 'https:' && url.hostname === 'datacat.run') {
        return buildDataCatHeaders({ sessionToken: token, deviceToken: dcDeviceToken });
    }
    return {
        'User-Agent': DATACAT_BROWSER_UA,
        'Accept': '*/*',
    };
}

async function fetchDcProxyTarget(targetUrl, token) {
    let currentUrl = targetUrl;
    for (let redirects = 0; redirects <= DC_PROXY_REDIRECT_LIMIT; redirects++) {
        const response = await fetch(currentUrl.toString(), {
            method: 'GET',
            headers: buildDcRedirectHeaders(currentUrl, token),
            redirect: 'manual',
        });

        const isRedirect = response.status >= 300 && response.status < 400;
        const location = response.headers.get('location');
        if (!isRedirect || !location) return response;

        const nextUrl = new URL(location, currentUrl);
        if (!['http:', 'https:'].includes(nextUrl.protocol)) {
            throw new Error('Blocked unsupported DataCat redirect protocol');
        }
        currentUrl = nextUrl;
    }
    throw new Error('Too many DataCat redirects');
}

function registerDataCatRoutes(router) {
    router.post('/dc-init', async (req, res) => {
        const { force } = req.body ?? {};

        // If we already have a token and not forcing refresh, verify it still works
        if (dcSessionToken && !force) {
            try {
                const check = await testDcToken(dcSessionToken);
                if (check.ok) {
                    const result = { ok: true, cached: true, token: dcSessionToken };
                    if (dcDeviceToken) result.deviceToken = dcDeviceToken;
                    return res.json(result);
                }
            } catch { /* fall through to create new */ }
            dcSessionToken = null;
        }

        // Create anonymous session via the Liberator identify endpoint
        const deviceToken = dcDeviceToken || randomUUID();
        try {
            const response = await fetch(`${DATACAT_BASE}/api/liberator/identify`, {
                method: 'POST',
                headers: buildDataCatHeaders({ deviceToken, json: true }),
                body: JSON.stringify({ deviceToken }),
            });

            if (!response.ok) {
                const text = await response.text();
                console.warn(`[cl-helper] DC identify failed: HTTP ${response.status}`);
                return res.json({ ok: false, reason: `identify returned ${response.status}: ${text.slice(0, 200)}` });
            }

            const data = await response.json();
            if (data?.success && data?.sessionToken) {
                dcSessionToken = data.sessionToken;
                dcDeviceToken = data.deviceToken || data.newDeviceToken || deviceToken;
                console.log('[cl-helper] DC anonymous session initialized');
                return res.json({ ok: true, token: dcSessionToken, deviceToken: dcDeviceToken });
            }

            console.warn('[cl-helper] DC identify returned unexpected shape:', JSON.stringify(data).slice(0, 300));
            res.json({ ok: false, reason: 'identify response missing sessionToken' });
        } catch (err) {
            console.error('[cl-helper] DC auto-init error:', err.message);
            res.json({ ok: false, reason: err.message });
        }
    });

    router.post('/dc-set-token', async (req, res) => {
        const { token, deviceToken } = req.body ?? {};

        const value = normalizeDcCredential(token);
        if (!value) {
            return res.status(400).json({ error: 'token string is required' });
        }
        const normalizedDeviceToken = normalizeOptionalDcCredential(deviceToken);

        dcSessionToken = value;
        if (normalizedDeviceToken) dcDeviceToken = normalizedDeviceToken;
        console.log('[cl-helper] DC session token stored');
        const result = { ok: true };
        if (dcDeviceToken) result.deviceToken = dcDeviceToken;
        res.json(result);
    });

    router.post('/dc-clear-token', (_req, res) => {
        dcSessionToken = null;
        console.log('[cl-helper] DC session token cleared');
        res.json({ ok: true });
    });

    router.get('/dc-session', (_req, res) => {
        const result = { active: !!dcSessionToken };
        if (dcDeviceToken) result.deviceToken = dcDeviceToken;
        res.json(result);
    });

    router.get('/dc-status', (_req, res) => {
        const result = { active: !!dcSessionToken };
        if (dcDeviceToken) result.deviceToken = dcDeviceToken;
        res.json(result);
    });

    router.get('/dc-validate', async (_req, res) => {
        if (!dcSessionToken) {
            const result = { valid: false, reason: 'no token stored' };
            if (dcDeviceToken) result.deviceToken = dcDeviceToken;
            return res.json(result);
        }

        try {
            const response = await testDcToken(dcSessionToken);

            if (response.ok) {
                const data = await response.json();
                const count = data?.totalCount || 0;
                console.log(`[cl-helper] DC validate: ${count} total chars available`);
                const result = { valid: true, totalCount: count };
                if (dcDeviceToken) result.deviceToken = dcDeviceToken;
                res.json(result);
            } else {
                const text = await response.text();
                console.warn(`[cl-helper] DC validate failed: HTTP ${response.status}`);
                const result = { valid: false, reason: `HTTP ${response.status}: ${text.slice(0, 200)}` };
                if (dcDeviceToken) result.deviceToken = dcDeviceToken;
                res.json(result);
            }
        } catch (err) {
            console.error('[cl-helper] DC validate error:', err.message);
            const result = { valid: false, reason: err.message };
            if (dcDeviceToken) result.deviceToken = dcDeviceToken;
            res.json(result);
        }
    });

    router.post('/dc-auth-login', async (req, res) => {
        const clientId = requireDcClientId(req, res);
        if (!clientId) return;

        const email = normalizeDcCredential(req.body?.email, { maxLength: 320 });
        const password = normalizeDcCredential(req.body?.password, { maxLength: 512 });
        if (!email || !password) {
            return res.status(400).json({ error: 'email and password are required' });
        }

        const body = { email, password };
        if (dcDeviceToken) body.anonToken = dcDeviceToken;

        try {
            const response = await fetch(`${DATACAT_BASE}/api/auth/login`, {
                method: 'POST',
                headers: buildDataCatHeaders({ sessionToken: dcSessionToken, deviceToken: dcDeviceToken, json: true }),
                body: JSON.stringify(body),
            });
            const data = await readDcJson(response);

            if (data?.success && data?.session?.token) {
                const accountToken = data.session.token;
                if (data.newDeviceToken) dcDeviceToken = data.newDeviceToken;
                const accountUser = sanitizeDataCatUser(data.user || data.session?.user || null);
                setDcAccountSession(clientId, accountToken, accountUser);
                const activation = await activateDcAccountSession(accountToken);
                if (!activation.ok) {
                    console.warn('[cl-helper] DC auth login account activation failed:', activation.reason);
                }
                return res.json({ ok: true, accountToken, deviceToken: dcDeviceToken, user: accountUser });
            }

            const status = response.ok ? 401 : response.status || 401;
            return res.status(status).json({
                error: data?.reason || data?.error || `DataCat login failed with HTTP ${response.status}`,
            });
        } catch (err) {
            console.error('[cl-helper] DC auth login error:', err.message);
            return res.status(502).json({ error: 'Failed to reach DataCat' });
        }
    });

    router.post('/dc-auth-set', async (req, res) => {
        const clientId = requireDcClientId(req, res);
        if (!clientId) return;

        const value = normalizeDcCredential(req.body?.accountToken || req.body?.token);
        if (!value) {
            return res.status(400).json({ error: 'accountToken string is required' });
        }

        const suppliedDeviceToken = req.body?.deviceToken;
        const normalizedDeviceToken = normalizeOptionalDcCredential(suppliedDeviceToken);
        if (normalizedDeviceToken) dcDeviceToken = normalizedDeviceToken;

        const verification = await verifyDcAccountToken(value);
        if (!verification.valid) {
            return res.status(401).json({ valid: false, reason: verification.reason });
        }

        setDcAccountSession(clientId, value, verification.user);
        const activation = await activateDcAccountSession(value);
        if (!activation.ok) {
            console.warn('[cl-helper] DC auth set account activation failed:', activation.reason);
        }
        return res.json({ ok: true, valid: true, user: verification.user, deviceToken: dcDeviceToken });
    });

    router.get('/dc-auth-status', async (req, res) => {
        const clientId = requireDcClientId(req, res);
        if (!clientId) return;

        const session = dcAccountSessions.get(clientId);
        if (!session?.token) {
            return res.json({ valid: false, reason: 'no account token stored', user: null });
        }

        const verification = await verifyDcAccountToken(session.token);
        if (verification.valid) {
            setDcAccountSession(clientId, session.token, verification.user);
            const activation = await activateDcAccountSession(session.token);
            if (!activation.ok) {
                console.warn('[cl-helper] DC auth status account activation failed:', activation.reason);
            }
            return res.json({ valid: true, user: verification.user, deviceToken: dcDeviceToken });
        }

        dcAccountSessions.delete(clientId);
        return res.json({ valid: false, reason: verification.reason, user: null });
    });

    router.post('/dc-auth-logout', async (req, res) => {
        const session = getDcAccountSession(req);
        const token = session?.token;
        clearDcAccountSession(req);

        if (token) {
            try {
                const response = await fetch(`${DATACAT_BASE}/api/auth/logout`, {
                    method: 'POST',
                    headers: buildDataCatHeaders({ sessionToken: token, deviceToken: dcDeviceToken, json: true }),
                    body: JSON.stringify({ token }),
                });
                if (!response.ok) {
                    console.warn(`[cl-helper] DC auth logout failed: HTTP ${response.status}`);
                }
            } catch (err) {
                console.warn('[cl-helper] DC auth logout error:', err.message);
            }
        }

        res.json({ ok: true });
    });

    // POST-only: submit extraction request to DataCat
    router.post('/dc-extract', async (req, res) => {
        const preferAccount = req.body?.useAccount !== false;
        const active = getDcActiveToken(req, { preferAccount });
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
            const activation = await activateDcAccountSession(active.token);
            if (!activation.ok) {
                return res.status(401).json({
                    error: 'Failed to activate DataCat account session',
                    reason: activation.reason,
                });
            }
        }

        // Resolve a public session ID when public feed is requested
        let sessionId = null;
        if (wantPublicFeed) {
            sessionId = await getPublicSessionId(active.token);
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
                    ...buildDataCatHeaders({ sessionToken: active.token, deviceToken: dcDeviceToken, json: true }),
                    'X-Request-Id': requestId,
                },
                body: JSON.stringify(body),
            });

            const data = await response.json();
            res.status(response.status).json(data);
        } catch (err) {
            console.error('[cl-helper] DC extract error:', err.message);
            res.status(502).json({ error: 'Failed to reach DataCat' });
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
            headers: buildDataCatHeaders({ sessionToken: account.token, deviceToken: dcDeviceToken, json }),
        };
        if (body != null) {
            options.body = JSON.stringify(body);
        }
        const response = await fetch(`${DATACAT_BASE}${path}`, options);
        const data = await readDcJson(response);
        return { response, data };
    }

    router.get('/dc-folders', async (req, res) => {
        const account = requireDcAccount(req, res);
        if (!account) return;

        const params = buildDcFoldersSearchParams(req.query);
        const query = params.toString();
        try {
            const { response, data } = await fetchDcAccountEndpoint(account, `/api/user-folders${query ? `?${query}` : ''}`);
            if (response.ok && data?.success) return res.json({ ...data, ok: true });
            return res.status(response.status || 502).json({
                error: data?.reason || data?.error || `DataCat folders failed with HTTP ${response.status}`,
            });
        } catch (err) {
            console.error('[cl-helper] DC folders list error:', err.message);
            return res.status(502).json({ error: 'Failed to reach DataCat' });
        }
    });

    router.post('/dc-folders', async (req, res) => {
        const account = requireDcAccount(req, res);
        if (!account) return;
        const body = normalizeDcFolderPayload(req.body);
        if (!body) return res.status(400).json({ error: 'Valid folder title is required' });

        try {
            const { response, data } = await fetchDcAccountEndpoint(account, '/api/user-folders', { method: 'POST', body, json: true });
            if (response.ok && data?.success) return res.json({ ...data, ok: true });
            return res.status(response.status || 502).json({
                error: data?.reason || data?.error || `DataCat folder create failed with HTTP ${response.status}`,
            });
        } catch (err) {
            console.error('[cl-helper] DC folder create error:', err.message);
            return res.status(502).json({ error: 'Failed to reach DataCat' });
        }
    });

    // Registered ahead of the /:folderId routes so 'reorder' is never read as an id.
    router.put('/dc-folders/reorder', async (req, res) => {
        const account = requireDcAccount(req, res);
        if (!account) return;
        const folderIds = normalizeDcFolderIdList(req.body?.folderIds);
        if (!folderIds) return res.status(400).json({ error: 'A valid folderIds list is required' });

        try {
            const { response, data } = await fetchDcAccountEndpoint(account, '/api/user-folders/reorder', { method: 'PUT', body: { folderIds }, json: true });
            if (response.ok && data?.success) return res.json({ ...data, ok: true });
            return res.status(response.status || 502).json({
                error: data?.reason || data?.error || `DataCat folder reorder failed with HTTP ${response.status}`,
            });
        } catch (err) {
            console.error('[cl-helper] DC folder reorder error:', err.message);
            return res.status(502).json({ error: 'Failed to reach DataCat' });
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
            const { response, data } = await fetchDcAccountEndpoint(account, `/api/user-folders/${encodeURIComponent(String(parseInt(folderId, 10)))}`, { method: 'PATCH', body, json: true });
            if (response.ok && data?.success) return res.json({ ...data, ok: true });
            return res.status(response.status || 502).json({
                error: data?.reason || data?.error || `DataCat folder update failed with HTTP ${response.status}`,
            });
        } catch (err) {
            console.error('[cl-helper] DC folder update error:', err.message);
            return res.status(502).json({ error: 'Failed to reach DataCat' });
        }
    });

    router.delete('/dc-folders/:folderId', async (req, res) => {
        const account = requireDcAccount(req, res);
        if (!account) return;
        const { folderId } = req.params;
        if (!isDataCatFolderId(folderId)) return res.status(400).json({ error: 'Invalid DataCat folder id' });

        try {
            const { response, data } = await fetchDcAccountEndpoint(account, `/api/user-folders/${encodeURIComponent(String(parseInt(folderId, 10)))}`, { method: 'DELETE' });
            if (response.ok && data?.success) return res.json({ ...data, ok: true });
            return res.status(response.status || 502).json({
                error: data?.reason || data?.error || `DataCat folder delete failed with HTTP ${response.status}`,
            });
        } catch (err) {
            console.error('[cl-helper] DC folder delete error:', err.message);
            return res.status(502).json({ error: 'Failed to reach DataCat' });
        }
    });

    async function setDcFolderMembership(req, res, shouldAdd) {
        const account = requireDcAccount(req, res);
        if (!account) return;
        const { folderId, characterId } = req.params;
        if (!isDataCatFolderId(folderId)) return res.status(400).json({ error: 'Invalid DataCat folder id' });
        if (!isDataCatCharacterId(characterId)) return res.status(400).json({ error: 'Invalid DataCat character id' });

        try {
            const path = `/api/user-folders/${encodeURIComponent(String(parseInt(folderId, 10)))}/items/${encodeURIComponent(characterId)}`;
            const { response, data } = await fetchDcAccountEndpoint(account, path, { method: shouldAdd ? 'PUT' : 'DELETE' });
            if (response.ok && data?.success) {
                return res.json({ ...data, ok: true, folderId: parseInt(folderId, 10), characterId });
            }
            return res.status(response.status || 502).json({
                error: data?.reason || data?.error || `DataCat folder membership failed with HTTP ${response.status}`,
            });
        } catch (err) {
            console.error('[cl-helper] DC folder membership error:', err.message);
            return res.status(502).json({ error: 'Failed to reach DataCat' });
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
            const { response, data } = await fetchDcAccountEndpoint(account, `/api/characters${query ? `?${query}` : ''}`);
            if (response.ok && data?.success !== false) return res.json({ ...data, ok: true });
            return res.status(response.status || 502).json({
                error: data?.reason || data?.error || `DataCat folder characters failed with HTTP ${response.status}`,
            });
        } catch (err) {
            console.error('[cl-helper] DC folder characters error:', err.message);
            return res.status(502).json({ error: 'Failed to reach DataCat' });
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
            const response = await fetch(`${DATACAT_BASE}/api/characters/${encodeURIComponent(characterId)}/folders`, {
                method: 'GET',
                headers: buildDataCatHeaders({ sessionToken: account.token, deviceToken: dcDeviceToken }),
            });
            const data = await readDcJson(response);

            if (response.ok && data?.success) {
                return res.json({
                    ok: true,
                    collected: data.collected === true,
                    folderIds: Array.isArray(data.folderIds) ? data.folderIds : [],
                });
            }

            return res.status(response.status || 502).json({
                error: data?.reason || data?.error || `DataCat folders failed with HTTP ${response.status}`,
            });
        } catch (err) {
            console.error('[cl-helper] DC yours status error:', err.message);
            return res.status(502).json({ error: 'Failed to reach DataCat' });
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
            const response = await fetch(`${DATACAT_BASE}/api/characters/${encodeURIComponent(characterId)}/collect`, {
                method: shouldCollect ? 'POST' : 'DELETE',
                headers: buildDataCatHeaders({ sessionToken: account.token, deviceToken: dcDeviceToken, json: true }),
            });
            const data = await readDcJson(response);

            if (response.ok && data?.success) {
                return res.json({ ok: true, collected: shouldCollect });
            }

            return res.status(response.status || 502).json({
                error: data?.reason || data?.error || `DataCat collect failed with HTTP ${response.status}`,
            });
        } catch (err) {
            console.error('[cl-helper] DC yours toggle error:', err.message);
            return res.status(502).json({ error: 'Failed to reach DataCat' });
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
            const response = await fetch(`${DATACAT_BASE}/api/creators/following?${params.toString()}`, {
                method: 'GET',
                headers: buildDataCatHeaders({ sessionToken: account.token, deviceToken: dcDeviceToken }),
            });
            const data = await readDcJson(response);

            if (response.ok && data?.success) {
                return res.json({
                    ok: true,
                    total: Number(data.total) || 0,
                    list: Array.isArray(data.list) ? data.list : [],
                });
            }

            return res.status(response.status || 502).json({
                error: data?.reason || data?.error || `DataCat following failed with HTTP ${response.status}`,
            });
        } catch (err) {
            console.error('[cl-helper] DC following error:', err.message);
            return res.status(502).json({ error: 'Failed to reach DataCat' });
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
            const response = await fetch(`${DATACAT_BASE}/api/creators/${encodeURIComponent(creatorId)}/follow`, {
                method: shouldFollow ? 'POST' : 'DELETE',
                headers: buildDataCatHeaders({ sessionToken: account.token, deviceToken: dcDeviceToken, json: true }),
            });
            const data = await readDcJson(response);

            if (response.ok && data?.success) {
                return res.json({ ok: true, following: data.isFollowing === true });
            }

            return res.status(response.status || 502).json({
                error: data?.reason || data?.error || `DataCat follow failed with HTTP ${response.status}`,
            });
        } catch (err) {
            console.error('[cl-helper] DC follow toggle error:', err.message);
            return res.status(502).json({ error: 'Failed to reach DataCat' });
        }
    }

    router.post('/dc-follow/:creatorId', (req, res) => setDcFollow(req, res, true));
    router.delete('/dc-follow/:creatorId', (req, res) => setDcFollow(req, res, false));

    router.get('/dc-proxy/*', async (req, res) => {
        const active = getDcActiveToken(req, { preferAccount: true });
        if (!active.token) {
            return res.status(401).json({ error: 'No DataCat session token configured' });
        }

        const targetPath = '/' + req.params[0];

        const normalizedPath = new URL(targetPath, DATACAT_BASE).pathname;
        if (!DC_ALLOWED_PATHS.some(re => re.test(normalizedPath))) {
            console.warn(`[cl-helper] DC proxy blocked: ${normalizedPath}`);
            return res.status(403).json({ error: 'Proxy path not allowed' });
        }

        const targetUrl = new URL(targetPath, DATACAT_BASE);
        targetUrl.search = new URL(req.url, 'http://localhost').search;

        if (targetUrl.hostname !== 'datacat.run') {
            return res.status(403).json({ error: 'Proxy target must be datacat.run' });
        }

        try {
            const response = await fetchDcProxyTarget(targetUrl, active.token);

            const contentType = response.headers.get('content-type') || '';
            res.status(response.status);
            res.set('Content-Type', contentType);

            if (contentType.includes('application/json')) {
                res.send(await response.text());
            } else {
                const buffer = Buffer.from(await response.arrayBuffer());
                res.send(buffer);
            }
        } catch (err) {
            console.error('[cl-helper] DC proxy error:', err.message);
            res.status(502).json({ error: 'Failed to reach DataCat' });
        }
    });
}
