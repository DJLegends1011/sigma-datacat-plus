import test from 'node:test';
import assert from 'node:assert/strict';
import { readDcBodyCapped } from '../server/datacat-routes.js';

// a body with no content-length, served in 64 KiB chunks; counts how much the reader pulled
function streamed(totalBytes, headers = {}) {
    let sent = 0;
    const chunk = new Uint8Array(64 * 1024);
    const body = new ReadableStream({
        pull(c) {
            if (sent >= totalBytes) return c.close();
            const n = Math.min(chunk.length, totalBytes - sent);
            sent += n;
            c.enqueue(chunk.subarray(0, n));
        },
    });
    return { response: new Response(body, { headers }), pulled: () => sent };
}

test('a body under the cap comes back whole', async () => {
    const { response } = streamed(300 * 1024);
    const { buffer, size } = await readDcBodyCapped(response, 1024 * 1024);
    assert.equal(buffer.length, 300 * 1024);
    assert.equal(size, 300 * 1024);
});

test('an oversized body with no content-length stops at the cap, not at the end', async () => {
    const { response, pulled } = streamed(20 * 1024 * 1024);
    const { buffer, size } = await readDcBodyCapped(response, 1024 * 1024);
    assert.equal(buffer, null);
    assert.ok(size > 1024 * 1024);
    // read at most a couple of chunks past the cap, never the full 20 MiB
    assert.ok(pulled() < 2 * 1024 * 1024, `pulled ${pulled()} bytes`);
});

test('a declared oversize is refused unread', async () => {
    const { response, pulled } = streamed(4 * 1024 * 1024, { 'content-length': String(4 * 1024 * 1024) });
    const { buffer, size } = await readDcBodyCapped(response, 1024 * 1024);
    assert.equal(buffer, null);
    assert.equal(size, 4 * 1024 * 1024);
    assert.ok(pulled() <= 128 * 1024, `pulled ${pulled()} bytes`);
});

test('an empty body is an empty buffer', async () => {
    const { buffer, size } = await readDcBodyCapped(new Response(null), 1024);
    assert.equal(buffer.length, 0);
    assert.equal(size, 0);
});
