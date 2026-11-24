// The JanitorAI login for the Hampter sorts, kept on the server per Sigma account.
// CL stored the access + rotating refresh token pair in the browser's settings; here the pair lives
// in x_datacat_plus_jai and never leaves the server whole. The page asks /jai-token for a current
// access token when it pages a Hampter sort (that fetch runs in the browser, which holds JanitorAI's
// Cloudflare pass); the refresh token is used and rotated only here.
import {
    decodeJanitoraiClaims,
    parseJanitoraiSession,
    janitoraiRefreshGrant,
    janitoraiVerifyToken,
} from '../client/janitorai-auth.js';

export const T_JAI = 'x_datacat_plus_jai';
const REFRESH_MARGIN_MS = 120000;

export const jaiMigration = `CREATE TABLE IF NOT EXISTS ${T_JAI} (
        user_handle TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        updated_at INTEGER NOT NULL
    )`;

const handleOf = (req) => String(req.userHandle || 'default');

function readPair(req) {
    return req.db.prepare(`SELECT access_token, refresh_token FROM ${T_JAI} WHERE user_handle = ?`).get(handleOf(req)) || null;
}

function writePair(req, accessToken, refreshToken) {
    req.db.prepare(
        `INSERT INTO ${T_JAI} (user_handle, access_token, refresh_token, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_handle) DO UPDATE SET access_token = excluded.access_token,
             refresh_token = excluded.refresh_token, updated_at = excluded.updated_at`
    ).run(handleOf(req), accessToken, refreshToken || '', Date.now());
}

function clearPair(req) {
    req.db.prepare(`DELETE FROM ${T_JAI} WHERE user_handle = ?`).run(handleOf(req));
}

// One refresh at a time per account: the refresh token is single-use, so two parallel Hampter
// loads must share the rotation instead of racing it.
const inFlight = new Map();

async function refresh(req) {
    const key = handleOf(req);
    if (inFlight.has(key)) return inFlight.get(key);
    const run = (async () => {
        const pair = readPair(req);
        const res = await janitoraiRefreshGrant(pair?.refresh_token || '');
        if (res.access_token) {
            writePair(req, res.access_token, res.refresh_token);
            return res.access_token;
        }
        // only a definitively dead refresh token logs the account out; a network blip keeps it
        if (res.dead) clearPair(req);
        return '';
    })();
    inFlight.set(key, run);
    try { return await run; } finally { inFlight.delete(key); }
}

export function registerJanitoraiRoutes(router) {
    router.get('/jai-status', (req, res) => {
        const pair = readPair(req);
        if (!pair) return res.json({ loggedIn: false });
        const { email, expMs } = decodeJanitoraiClaims(pair.access_token);
        res.json({ loggedIn: true, email, expMs, hasRefresh: !!pair.refresh_token });
    });

    // a current access token for the page's Hampter fetch; '' when logged out or the refresh failed
    router.get('/jai-token', async (req, res) => {
        const pair = readPair(req);
        if (!pair) return res.json({ token: '' });
        const force = req.query?.force === '1';
        const { expMs } = decodeJanitoraiClaims(pair.access_token);
        if (!force && expMs && expMs - Date.now() > REFRESH_MARGIN_MS) return res.json({ token: pair.access_token });
        res.json({ token: (await refresh(req)) || '' });
    });

    // seed from a pasted sb-auth-auth-token cookie (or session JSON / bare JWT); CL's
    // datacatJanitoraiSetSession logic, run here so the pair is stored server-side
    router.post('/jai-session', async (req, res) => {
        const pasted = typeof req.body?.pasted === 'string' ? req.body.pasted.slice(0, 16384) : '';
        const pair = parseJanitoraiSession(pasted);
        if (!pair) return res.json({ ok: false, error: 'Could not find a session in that value. Copy the whole sb-auth-auth-token cookie.' });
        const { email, expMs } = decodeJanitoraiClaims(pair.access_token);
        let token = pair.access_token;
        if ((!expMs || expMs - Date.now() < REFRESH_MARGIN_MS) && pair.refresh_token) {
            const r = await janitoraiRefreshGrant(pair.refresh_token);
            if (!r.access_token) {
                return res.json({ ok: false, error: r.dead
                    ? 'That session is expired or invalid. Copy a fresh cookie after logging in again.'
                    : 'Could not reach the JanitorAI auth service. Try again in a moment.' });
            }
            token = r.access_token;
            pair.refresh_token = r.refresh_token;
        } else {
            const v = await janitoraiVerifyToken(token);
            if (!v.valid) {
                return res.json({ ok: false, error: v.transient
                    ? 'Could not reach the JanitorAI auth service. Try again in a moment.'
                    : 'That session is expired or invalid. Copy a fresh cookie after logging in again.' });
            }
        }
        writePair(req, token, pair.refresh_token);
        res.json({ ok: true, email: decodeJanitoraiClaims(token).email || email, hasRefresh: !!pair.refresh_token });
    });

    router.delete('/jai-session', (req, res) => {
        clearPair(req);
        res.json({ ok: true });
    });
}
