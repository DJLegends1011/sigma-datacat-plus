// JanitorAI account auth (Supabase GoTrue), moved out of datacat-api.js unchanged so the
// server half can run it too: the token pair is now kept server-side (see server/janitorai-session.js).
// Pure HTTP, no DOM and no Sigma imports, so Node and the page both load it.

// ========================================
// JANITORAI ACCOUNT AUTH (Supabase GoTrue)
// ========================================
// Unlocks page 2+ of the Hampter sorts. JanitorAI auth is Supabase; the
// anon key below is their PUBLIC publishable key (role:anon), shipped in the janitorai
// frontend bundle, safe to embed. Login/refresh hit supabase.co directly (CORS *, and it is
// NOT behind JanitorAI's Cloudflare bot gate), so the whole flow is client-side, no cl-helper.
// Access tokens live ~3h; the refresh token rotates on every use, so callers must persist the
// new one each refresh. Pure HTTP here; the stateful session layer lives in datacat-provider.

const JANITORAI_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jbXp4dHpvbW1wbnhreW5kZGJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjgzNzA3NDAsImV4cCI6MjA0Mzk0Njc0MH0.UfRPni4ga9Lmin8j0JjV5ouuK9bXp8tsqPJ8pMTDDAI';
const JANITORAI_AUTH_BASE = 'https://mcmzxtzommpnxkynddbo.supabase.co/auth/v1';
const JANITORAI_TOKEN_URL = `${JANITORAI_AUTH_BASE}/token`;

function janitoraiAuthHeaders() {
    return { 'apikey': JANITORAI_ANON_KEY, 'Authorization': `Bearer ${JANITORAI_ANON_KEY}`, 'Content-Type': 'application/json' };
}

/** Decode a JanitorAI access-token JWT's claims (email + exp ms). Empty on failure. */
export function decodeJanitoraiClaims(jwt) {
    try {
        const p = JSON.parse(atob(String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        return { email: p.email || '', expMs: (p.exp || 0) * 1000 };
    } catch { return { email: '', expMs: 0 }; }
}

// Direct password login is not usable: JanitorAI gates it behind Cloudflare Turnstile,
// whose sitekey is domain-locked to janitorai.com and cant be solved from CL's origin. So the
// session is seeded from the sb-auth-auth-token cookie (grabbed once from a real browser login,
// where the user already solved Turnstile), and kept alive by the captcha-free refresh grant.

function janitoraiB64decode(s) {
    let t = s.replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    return atob(t);
}

/**
 * Extract the token pair from a pasted JanitorAI session: the sb-auth-auth-token cookie value
 * (base64-<json>), a raw session JSON, or a bare access-token JWT (no refresh; short-lived).
 * @returns {{access_token: string, refresh_token: string}|null}
 */
export function parseJanitoraiSession(raw) {
    if (!raw || typeof raw !== 'string') return null;
    let s = raw.trim();
    if (s.startsWith('base64-')) s = s.slice('base64-'.length);
    let json = null;
    try {
        const dec = janitoraiB64decode(s);
        if (dec.includes('access_token')) json = JSON.parse(dec);
    } catch { /* not base64 json */ }
    if (!json && s.startsWith('{')) {
        try { json = JSON.parse(s); } catch { /* not json */ }
    }
    if (json?.access_token) {
        return { access_token: json.access_token, refresh_token: json.refresh_token || '' };
    }
    const jm = s.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    return jm ? { access_token: jm[0], refresh_token: '' } : null;
}

/**
 * Exchange a (single-use, rotating) refresh token for a fresh pair. `dead` marks a
 * revoked/expired refresh token so the caller can clear the stored session.
 * @returns {Promise<{access_token: string, refresh_token: string, dead?: boolean}>}
 */
export async function janitoraiRefreshGrant(refreshToken) {
    if (!refreshToken) return { access_token: '', refresh_token: '', dead: true };
    let resp;
    try {
        resp = await fetch(`${JANITORAI_TOKEN_URL}?grant_type=refresh_token`, {
            method: 'POST', headers: janitoraiAuthHeaders(), body: JSON.stringify({ refresh_token: refreshToken }),
        });
    } catch (e) {
        return { access_token: '', refresh_token: '', dead: false }; // transient; keep the token for retry
    }
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data?.access_token) {
        const dead = resp.status === 400 || resp.status === 401;
        return { access_token: '', refresh_token: '', dead };
    }
    return { access_token: data.access_token, refresh_token: data.refresh_token || refreshToken };
}

/**
 * Check an access token server-side against the auth service. Kept off Cloudflare on
 * purpose: a hampter probe cant tell a bad token from a blocked preflight.
 * @returns {Promise<{valid: boolean, transient?: boolean}>} transient = auth service unreachable or erroring (429/5xx)
 */
export async function janitoraiVerifyToken(accessToken) {
    if (!accessToken) return { valid: false };
    let resp;
    try {
        resp = await fetch(`${JANITORAI_AUTH_BASE}/user`, {
            headers: { 'apikey': JANITORAI_ANON_KEY, 'Authorization': `Bearer ${accessToken}` },
        });
    } catch {
        return { valid: false, transient: true };
    }
    if (resp.ok) return { valid: true };
    return { valid: false, transient: resp.status === 429 || resp.status >= 500 };
}

