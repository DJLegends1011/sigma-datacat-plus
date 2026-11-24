import module from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Map Sigma absolute browser imports ('/modules/...') to the local Sigma checkout
// (override via SIGMA_DIR env var) so client modules load under Node --test.
const SIGMA_DIR = process.env.SIGMA_DIR || 'D:/ProjectSigma-main';
if (!globalThis.__dcPlusSigmaHookRegistered) {
    globalThis.__dcPlusSigmaHookRegistered = true;
    if (typeof module.registerHooks === 'function') {
        module.registerHooks({
            resolve(specifier, context, nextResolve) {
                if (specifier.startsWith('/modules/')) {
                    const target = path.join(SIGMA_DIR, 'app', specifier);
                    return { url: pathToFileURL(target).href, shortCircuit: true };
                }
                return nextResolve(specifier, context);
            },
        });
    } else if (typeof module.register === 'function') {
        const hookSource = `
            import path from 'node:path';
            import { pathToFileURL } from 'node:url';
            const SIGMA_DIR = ${JSON.stringify(SIGMA_DIR)};
            export async function resolve(specifier, context, nextResolve) {
                if (specifier.startsWith('/modules/')) {
                    const target = path.join(SIGMA_DIR, 'app', specifier);
                    return { url: pathToFileURL(target).href, shortCircuit: true };
                }
                return nextResolve(specifier, context);
            }
        `;
        module.register('data:text/javascript,' + encodeURIComponent(hookSource));
    }
}

// Preloaded via `node --test --import` so modules that touch browser globals at
// import time (e.g. browse-view.js: `window.registerOverlay?.(...)`) can be
// imported by the Node test runner. Pure helpers are what we actually test;
// this shim just lets their module graph load headlessly.
const noop = () => {};
globalThis.window = globalThis.window || globalThis;
if (typeof globalThis.window.matchMedia !== 'function') {
    globalThis.window.matchMedia = () => ({
        matches: false, media: '', addEventListener: noop, removeEventListener: noop,
        addListener: noop, removeListener: noop, onchange: null, dispatchEvent: () => false,
    });
}
globalThis.document = globalThis.document || {
    addEventListener: noop,
    removeEventListener: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => ({ style: {}, classList: { add: noop, remove: noop, toggle: noop }, addEventListener: noop }),
    body: { appendChild: noop },
};
// `navigator` is already a read-only global in modern Node, so only define the
// ones that are actually missing.
function ensureGlobal(name, value) {
    if (name in globalThis && globalThis[name]) return;
    try { globalThis[name] = value; } catch { /* already a getter-only global */ }
}
ensureGlobal('navigator', { userAgent: 'node-test' });
ensureGlobal('localStorage', { getItem: () => null, setItem: noop, removeItem: noop });
