// Private viewing rooms against a real local Worker: staff create a room,
// the client opens it with the passcode, sees only what the room shares,
// loads only the room's own photos, and sends an inquiry.
//
//   node --test frontend/tests/viewingRooms.integration.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { startDevWorker } from './helpers/devWorker.mjs';

const OWNER = { name: 'Owner', email: 'owner@example.com', password: 'owner-password-1234' };
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);

let worker;
let owner;
let staffNoCatalogs;
let art;        // in the room, with a photo and a price
let secret;     // an artwork NOT in the room, with its own photo
let room;

async function api(token, path, { method = 'GET', body, form } = {}) {
    const headers = new Headers();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const res = await fetch(`${worker.origin}/api${path}`, { method, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text, headers: res.headers };
}

async function upload(token, name) {
    const form = new FormData();
    form.append('file', new File([PNG], name, { type: 'image/png' }));
    const res = await api(token, '/upload', { method: 'POST', form });
    assert.equal(res.status, 200, res.text);
    return res.body.url;
}

const open = (passcode, token = room.token) => api(null, `/viewing/${token}/open`, { method: 'POST', body: { passcode } });

before(async () => {
    const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
    worker = await startDevWorker({ port: 8820, inspectorPort: 9250, seedLegacy: { sql: schema } });
    assert.equal((await api(null, '/auth/setup', { method: 'POST', body: OWNER })).status, 200);
    owner = (await api(null, '/auth/login', { method: 'POST', body: { email: OWNER.email, password: OWNER.password } })).body.token;

    art = { id: `art_${Date.now()}`, customId: 'VD-001', title: 'Monsoon I', artist: 'R. Rao', medium: 'Oil on canvas', dimensions: '36 x 48 in', status: 'Available', price: 250000, plusGst: true, location: 'Store room B', imageUrls: [await upload(owner, 'monsoon.png')] };
    secret = { id: `art_s_${Date.now()}`, customId: 'VD-999', title: 'Not for this client', status: 'Available', price: 1, imageUrls: [await upload(owner, 'private.png')] };
    for (const a of [art, secret]) assert.equal((await api(owner, '/artworks', { method: 'POST', body: a })).status, 201);

    // A role without the Catalogs permission.
    const role = await api(owner, '/auth/roles', { method: 'POST', body: { name: 'Front desk', permissions: { catalogs: 'none', inquiries: 'edit' } } });
    const roleId = role.body?.id ?? role.body?.role?.id;
    await api(owner, '/auth/users', { method: 'POST', body: { name: 'Desk', email: 'desk@example.com', password: 'staff-password-1234', ...(roleId ? { role: roleId } : {}) } });
    staffNoCatalogs = (await api(null, '/auth/login', { method: 'POST', body: { email: 'desk@example.com', password: 'staff-password-1234' } })).body?.token;
});

after(async () => {
    await worker?.stop();
    worker?.cleanup();
});

test('staff create a room: the passcode is shown once, never stored in the clear', async () => {
    assert.equal((await api(owner, '/viewing-rooms', { method: 'POST', body: { name: 'For Mrs. Mehta', artworkIds: [], expiresInDays: 30 } })).status, 400, 'needs artworks');
    assert.equal((await api(owner, '/viewing-rooms', { method: 'POST', body: { name: 'x', artworkIds: [art.id], expiresInDays: 5 } })).status, 400, 'fixed expiry choices');
    const res = await api(owner, '/viewing-rooms', {
        method: 'POST', body: { name: 'For Mrs. Mehta', clientName: 'Mrs. Mehta', message: 'A few pieces I thought you would like.', artworkIds: [art.id], showPrices: true, expiresInDays: 30 },
    });
    assert.equal(res.status, 201, res.text);
    room = res.body;
    assert.match(room.passcode, /^\d{6}$/);
    assert.match(room.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(room.status, 'active');
    const list = (await api(owner, '/viewing-rooms')).body;
    const listed = list.find(r => r.id === room.id);
    assert.ok(listed);
    for (const hidden of ['passcode', 'passcodeHash', 'passcode_hash', 'grantKey', 'grant_key']) assert.ok(!(hidden in listed), `${hidden} not listed`);
    if (staffNoCatalogs) assert.equal((await api(staffNoCatalogs, '/viewing-rooms')).status, 403, 'needs the Catalogs permission');
    assert.equal((await api(null, '/viewing-rooms')).status, 401);
});

test('the client needs the right passcode and sees only what the room shares', async () => {
    assert.equal((await open('000000')).status === 403 || room.passcode === '000000', true, 'wrong passcode refused');
    assert.equal((await open(room.passcode, 'A'.repeat(43))).status, 404, 'unknown link');
    const res = await open(room.passcode);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.body.room.name, 'For Mrs. Mehta');
    assert.equal(res.body.artworks.length, 1);
    const shown = res.body.artworks[0];
    assert.equal(shown.title, 'Monsoon I');
    assert.equal(shown.price, 250000, 'prices shown for this room');
    assert.equal(shown.availability, 'available');
    for (const internal of ['customId', 'location', 'imageUrls', 'status']) assert.ok(!(internal in shown), `${internal} stays internal`);
    room.pass = res.body.pass;
    room.image = shown.images[0].full;
    room.thumb = shown.images[0].thumb;
});

test('photos load only with a valid pass and only for the room\'s own artworks', async () => {
    const img = await fetch(`${worker.origin}${room.image}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${worker.origin}${room.thumb}`)).status, 200, 'thumbnail falls back to the photo');
    const noPass = room.image.replace(/&p=[^&]+/, '');
    assert.equal((await fetch(`${worker.origin}${noPass}`)).status, 401);
    const forged = room.image.replace(/&p=(\d+)\.[0-9a-f]+/, (_, t) => `&p=${t}.${'0'.repeat(64)}`);
    assert.equal((await fetch(`${worker.origin}${forged}`)).status, 401);
    const otherKey = decodeURIComponent(secret.imageUrls[0].slice('/api/files/'.length));
    const outside = room.image.replace(/k=[^&]+/, `k=${encodeURIComponent(otherKey)}`);
    assert.equal((await fetch(`${worker.origin}${outside}`)).status, 404, 'a photo outside the room is not served');
});

test('"I\'m interested" becomes an inquiry for the room\'s artworks only', async () => {
    assert.equal((await api(null, `/viewing/${room.token}/interest`, { method: 'POST', body: { pass: room.pass, name: 'Mrs. Mehta', artworkIds: [art.id] } })).status, 400, 'needs a phone or email');
    assert.equal((await api(null, `/viewing/${room.token}/interest`, { method: 'POST', body: { pass: 'nope', name: 'x', phone: '1', artworkIds: [art.id] } })).status, 401);
    assert.equal((await api(null, `/viewing/${room.token}/interest`, { method: 'POST', body: { pass: room.pass, name: 'x', phone: '1', artworkIds: [secret.id] } })).status, 400, 'only the room\'s artworks');
    const res = await api(null, `/viewing/${room.token}/interest`, {
        method: 'POST', body: { pass: room.pass, name: 'Mrs. Mehta', phone: '+91 98200 00000', message: 'Could I see it in person?', artworkIds: [art.id, secret.id] },
    });
    assert.equal(res.status, 201, res.text);
    const inquiry = (await api(owner, '/inquiries')).body.find(i => i.customerName === 'Mrs. Mehta');
    assert.ok(inquiry, 'the inquiry is in the app');
    assert.equal(inquiry.source, 'Private room');
    assert.deepEqual(inquiry.artworkIds, [art.id], 'artworks outside the room are dropped');
    assert.match(inquiry.notes, /For Mrs\. Mehta/);
    assert.match(inquiry.notes, /see it in person/);
    const listed = (await api(owner, '/viewing-rooms')).body.find(r => r.id === room.id);
    assert.equal(listed.inquiryCount, 1);
    assert.ok(listed.viewCount >= 1);
});

test('a new passcode cancels old passes; switching off or expiring closes the room', async () => {
    const renewed = await api(owner, `/viewing-rooms/${room.id}`, { method: 'PATCH', body: { newPasscode: true } });
    assert.equal(renewed.status, 200, renewed.text);
    assert.match(renewed.body.passcode, /^\d{6}$/);
    assert.equal((await fetch(`${worker.origin}${room.image}`)).status, 401, 'the old pass no longer works');
    assert.equal((await open(room.passcode)).status === 403 || room.passcode === renewed.body.passcode, true, 'the old passcode no longer works');

    const off = await api(owner, `/viewing-rooms/${room.id}`, { method: 'PATCH', body: { isActive: false } });
    assert.equal(off.body.status, 'off');
    assert.equal((await open(renewed.body.passcode)).status, 404, 'a switched-off room is gone for the client');

    const on = await api(owner, `/viewing-rooms/${room.id}`, { method: 'PATCH', body: { isActive: true, expiresInDays: 7 } });
    assert.equal(on.body.status, 'active');
    const reopened = await open(renewed.body.passcode);
    assert.equal(reopened.status, 200);

    // A page reload re-opens with the pass it holds: no passcode, no rate limit.
    for (let i = 0; i < 8; i++) {
        assert.equal((await api(null, `/viewing/${room.token}/open`, { method: 'POST', body: { pass: reopened.body.pass } })).status, 200, `reload ${i}`);
    }
    assert.equal((await api(null, `/viewing/${room.token}/open`, { method: 'POST', body: { pass: 'forged' } })).status, 401);

    assert.equal((await api(owner, `/viewing-rooms/${room.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await api(null, `/viewing/${room.token}/open`, { method: 'POST', body: { pass: reopened.body.pass } })).status, 404, 'a deleted room is gone');
});

test('passcode guessing is rate limited', async () => {
    const res = await api(owner, '/viewing-rooms', { method: 'POST', body: { name: 'Guess me', artworkIds: [art.id], expiresInDays: 7 } });
    const statuses = [];
    for (let i = 0; i < 7; i++) statuses.push((await open(res.body.passcode === '111111' ? '222222' : '111111', res.body.token)).status);
    assert.ok(statuses.includes(429), `expected a 429 among ${statuses}`);
});
