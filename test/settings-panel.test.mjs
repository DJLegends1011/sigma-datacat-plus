import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import './setup-browser-globals.mjs';
const { settingsMarkup } = await import('../client/settings-panel.js');

const html = settingsMarkup();
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);

test('every id is dcPlus-prefixed and unique', () => {
    assert.ok(ids.length > 20);
    for (const id of ids) assert.match(id, /^dcPlus/, id);
    assert.equal(new Set(ids).size, ids.length);
});

test('no id collides with Sigma\'s built-in DataCat settings section', () => {
    const sigma = process.env.SIGMA_DIR || 'D:/ProjectSigma-main';
    const core = readFileSync(`${sigma}/app/library.html`, 'utf8');
    const coreIds = new Set([...core.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
    for (const id of ids) assert.ok(!coreIds.has(id), id);
});

test('switch input and track are direct children of their label', () => {
    const labels = [...html.matchAll(/<label>([\s\S]*?)<\/label>/g)].map(m => m[1]).filter(s => s.includes('cl-switch'));
    assert.equal(labels.length, 4);
    for (const body of labels) assert.match(body.trim(), /^<input type="checkbox" class="cl-switch-input" id="[^"]+"><span class="cl-switch" aria-hidden="true"><\/span>/);
});

test('no field holds a DataCat token or saved password', () => {
    assert.doesNotMatch(html, /readonly/);
    assert.doesNotMatch(html, /value="/);
});
