// Private files (FILE_AUTH=on) against a real local Worker: a file address
// alone opens nothing; the app's signed-in requests and its file cookie do;
// signing out ends the cookie. Files the app shows keep working.
//
//   node --test frontend/tests/fileAuth.integration.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { startDevWorker } from './helpers/devWorker.mjs';

const OWNER = { name: 'Owner', email: 'owner@example.com', password: 'owner-password-1234' };
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);

let worker, token, cookie, fileUrl;

/** The vayu_files cookie a response sets, as "name=value" (or null). */
function fileCookieFrom(res) {
    const set = (res.headers.getSetCookie?.() ?? []).find(c => c.startsWith('vayu_files='));
    return set ? set.split(';')[0] : null;
}

const get = (url, headers = {}) => fetch(`${worker.origin}${url}`, { headers });

before(async () => {
    const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
    worker = await startDevWorker({ port: 8824, inspectorPort: 9254, seedLegacy: { sql: schema }, vars: { FILE_AUTH: 'on' } });
    await fetch(`${worker.origin}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(OWNER) });
    const login = await fetch(`${worker.origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: OWNER.email, password: OWNER.password }) });
    token = (await login.json()).token;
    cookie = fileCookieFrom(login);
    const form = new FormData();
    form.append('file', new File([PNG], 'artwork.png', { type: 'image/png' }));
    const up = await fetch(`${worker.origin}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    fileUrl = (await up.json()).url;
});

after(async () => {
    await worker?.stop();
    worker?.cleanup();
});

test('signing in hands out a private file cookie', () => {
    assert.match(cookie ?? '', /^vayu_files=[a-f0-9]{64}$/);
});

test('a file address alone opens nothing', async () => {
    const res = await get(fileUrl);
    assert.equal(res.status, 401);
    assert.equal((await get(`${fileUrl}__thumb`)).status, 401, 'thumbnails too');
    assert.equal((await get(fileUrl, { Cookie: `vayu_files=${'0'.repeat(64)}` })).status, 401, 'a made-up cookie');
});

test('the app opens files with its sign-in or its file cookie, privately cached', async () => {
    const withToken = await get(fileUrl, { Authorization: `Bearer ${token}` });
    assert.equal(withToken.status, 200);
    assert.equal(withToken.headers.get('content-type'), 'image/png');
    const withCookie = await get(fileUrl, { Cookie: cookie });
    assert.equal(withCookie.status, 200, 'how <img> tags load photos');
    assert.match(withCookie.headers.get('cache-control'), /^private/, 'never cached for others');
});

test('opening the app again renews a missing cookie, and only then', async () => {
    const without = await get('/api/auth/me', { Authorization: `Bearer ${token}` });
    assert.equal(without.status, 200);
    const renewed = fileCookieFrom(without);
    assert.ok(renewed, 'missing cookie: a new one');
    assert.equal((await get(fileUrl, { Cookie: renewed })).status, 200);
    const withIt = await get('/api/auth/me', { Authorization: `Bearer ${token}`, Cookie: renewed });
    assert.equal(fileCookieFrom(withIt), null, 'a valid cookie is left alone');
});

test('signing out ends the file cookie', async () => {
    const out = await fetch(`${worker.origin}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Cookie: cookie } });
    assert.ok(out.ok);
    assert.match((out.headers.getSetCookie?.() ?? []).join(';'), /vayu_files=;.*Max-Age=0/, 'the browser drops it');
    assert.equal((await get(fileUrl, { Cookie: cookie })).status, 401, 'and a copied cookie stops working');
});
