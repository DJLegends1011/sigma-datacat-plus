#!/usr/bin/env node
// check-native-ui.mjs: the gate that stops stale Character Library (CL) UI from shipping in a Sigma extension.
//
// 1. Every class the extension puts in markup must be native or its own: a class selector in Sigma's
//    CSS (<SIGMA_DIR>/app/**/*.css, selectors only, never comments or a text grep of app/), a class
//    Sigma's own markup uses (app/**/*.js: structure and JS hooks such as `browse-meta-identity`), or a
//    selector in the extension's own CSS. Anything else renders as stock HTML (CL's `chub-timeline-*`).
// 2. A denylist of stale CL patterns fails even when some CSS happens to match them.
//
// No grep is used (Termux's grep is ugrep, which ignores --include), so it runs the same on every device.
//
// CLI:  node check-native-ui.mjs <extension-dir> [--sigma D:/ProjectSigma-main]   (exit 1 on any problem)
// Test: copy this file to <ext>/test/check-native-ui.mjs and add test/native-ui.test.mjs:
//         import { test } from 'node:test'; import assert from 'node:assert/strict';
//         import { checkNativeUi } from './check-native-ui.mjs';
//         test('UI uses Sigma\'s own classes, no stale CL', () => {
//             assert.deepEqual(checkNativeUi(new URL('..', import.meta.url)).problems, []);
//         });
// Escape hatch for a class that is a JS hook with no styling on purpose: list it in
// <ext>/.sigma-ui-allow (one class per line, `# why` comments allowed). Reviewers check every entry.
//
// Blind spots (read these by hand in review): classes set as `className = cond ? 'a' : 'b'` or via
// `setAttribute('class', ...)`, a denylisted call split across lines, and behaviour (NSFW reload, card
// trickle), which only the side-by-side check catches. It reads all of app/ on every call (~6 s on a
// phone), so call it once per test file, not once per test.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_DIRS = new Set(['node_modules', '.git', 'test', 'tests', 'docs', 'vendor', 'dist']);

// Stale CL patterns: [regex, what to use instead].
export const DENYLIST = [
    [/closeAllTopbarDropdowns\(\s*\)/, "closeAllTopbarDropdowns('<ownDropdownId>'): with no id the button reopens its own popup and can't close it"],
    [/\bchub-view-toggle\b/, 'renderViewToggle(...) from browse-view.js (cl-seg)'],
    [/\bchub-timeline-[\w-]+/, 'browse-timeline-* (browse-shared.css)'],
    [/(?<![\w-])action-btn(?![\w-])/, 'cl-btn cl-btn-primary|secondary|warning (Sigma has no .action-btn)'],
    [/<option[^>]*>\s*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'data-icon="fa-solid fa-..." on the option, no emoji label'],
];

function walk(dir, exts, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), exts, out); }
        else if (exts.some(x => e.name.endsWith(x))) out.push(path.join(dir, e.name));
    }
    return out;
}

// Class names that appear in CSS selectors (comments, strings, url() and declaration bodies removed).
export function cssClasses(cssText, into = new Set()) {
    const text = cssText.replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/url\([^)]*\)/g, ' ')
        // strings stay on one line: a stray apostrophe (`// don't` in a sheet) must not swallow the rest of the file
        .replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, '""');
    let selector = '';
    for (const ch of text) {
        if (ch === '{') {
            for (const m of selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) into.add(m[1]);
            selector = '';
        } else if (ch === '}' || ch === ';') selector = '';
        else selector += ch;
    }
    return into;
}

// Class names the extension puts in markup: class="..." / className = ... / classList.*('...').
export function markupClasses(src) {
    const found = [];
    const add = (str, line) => {
        // drop template interpolations whole, then keep only plain class tokens
        for (const tok of str.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) {
            // a token cut by an interpolation (`pl-${n}` -> `pl-`) is a class family, not a class
            if (/^-?[_a-zA-Z][\w-]*$/.test(tok) && !tok.endsWith('-')) found.push({ cls: tok, line });
        }
    };
    const lineOf = (i) => src.slice(0, i).split('\n').length;
    for (const m of src.matchAll(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) add(m[1] ?? m[2], lineOf(m.index));
    for (const m of src.matchAll(/\bclassName\s*[+]?=\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g)) add(m[1] ?? m[2] ?? m[3], lineOf(m.index));
    for (const m of src.matchAll(/classList\.(?:add|remove|toggle|replace)\(([^)]*)\)/g)) {
        for (const s of m[1].matchAll(/'([^']*)'|"([^"]*)"/g)) add(s[1] ?? s[2], lineOf(m.index));
    }
    return found;
}

const IGNORE = (c) => c === 'fa' || c.startsWith('fa-') || c === 'hidden' || c === 'active';

export function checkNativeUi(extDir, { sigmaDir = process.env.SIGMA_DIR || 'D:/ProjectSigma-main' } = {}) {
    extDir = extDir instanceof URL ? fileURLToPath(extDir) : extDir;
    const appDir = path.join(sigmaDir, 'app');
    if (!fs.existsSync(appDir)) throw new Error(`Sigma app folder not found at ${appDir}; set SIGMA_DIR`);
    const known = new Set();
    for (const f of walk(appDir, ['.css'])) cssClasses(fs.readFileSync(f, 'utf8'), known);
    for (const f of walk(appDir, ['.js'])) for (const { cls } of markupClasses(fs.readFileSync(f, 'utf8'))) known.add(cls);
    for (const f of walk(extDir, ['.css'])) cssClasses(fs.readFileSync(f, 'utf8'), known);
    const allowFile = path.join(extDir, '.sigma-ui-allow');
    const allow = new Set(fs.existsSync(allowFile)
        ? fs.readFileSync(allowFile, 'utf8').split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean) : []);

    const problems = [];
    for (const f of walk(extDir, ['.js', '.mjs', '.html', '.css'])) {
        const src = fs.readFileSync(f, 'utf8');
        const rel = path.relative(extDir, f).replace(/\\/g, '/');
        src.split('\n').forEach((line, i) => {
            for (const [re, fix] of DENYLIST) {
                const m = line.match(re);
                if (m) problems.push(`${rel}:${i + 1} stale CL "${m[0].trim()}" -> use ${fix}`);
            }
        });
        if (f.endsWith('.css')) continue;
        const seen = new Set();
        for (const { cls, line } of markupClasses(src)) {
            if (known.has(cls) || allow.has(cls) || IGNORE(cls) || seen.has(cls)) continue;
            seen.add(cls);
            problems.push(`${rel}:${line} class "${cls}" is not in Sigma's CSS or markup, nor this extension's CSS -> renders as stock HTML; use Sigma's class, or list it in .sigma-ui-allow if it is only a JS hook`);
        }
    }
    return { problems, knownClassCount: known.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const si = args.indexOf('--sigma');
    const sigmaDir = si >= 0 ? args.splice(si, 2)[1] : undefined;
    if (!args[0]) { console.error('usage: node check-native-ui.mjs <extension-dir> [--sigma <ProjectSigma dir>]'); process.exit(2); }
    const { problems, knownClassCount } = checkNativeUi(path.resolve(args[0]), sigmaDir ? { sigmaDir } : {});
    for (const p of problems) console.log(p);
    console.log(`${problems.length} problem(s); ${knownClassCount} classes known from Sigma + extension`);
    process.exit(problems.length ? 1 : 0);
}
