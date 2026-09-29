// The original sign-in's cookie session (sessionCookies.ts, worker.ts): cookie
// attributes, no credential in any body, CSRF (trusted origin + token), no
// wildcard CORS, logout and revocation, the one-time exchange of an old
// JavaScript-kept token, and its retirement after LEGACY_BEARER_UNTIL.
//
//   node --test frontend/tests/sessionCookies.integration.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { startDevWorker } from './helpers/devWorker.mjs';
import { sessionTokenFrom } from './helpers/session.mjs';

const OWNER = { name: 'Owner', email: 'owner@example.com', password: 'owner-password-1234' };
const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
let worker, retired;

const cookieFrom = (res, name) => (res.headers.getSetCookie?.() ?? []).find(c => c.startsWith(`${name}=`)) ?? null;
const valueOf = (setCookie) => /^[^=]+=([^;]*)/.exec(setCookie)?.[1] ?? '';
// Sign-in is limited to 5 a minute per address, so the tests spread over a few people.
const PEOPLE = ['p1@example.com', 'p2@example.com', 'p3@example.com', 'p4@example.com'];
const PASSWORD = 'person-password-1234';
const login = (w, email = OWNER.email) => fetch(`${w.origin}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: w.origin },
    body: JSON.stringify({ email, password: email === OWNER.email ? OWNER.password : PASSWORD }),
});

/** A browser's view of one session: its cookies, and the CSRF value it can read. */
async function signedIn(w, email = OWNER.email) {
    const res = await login(w, email);
    const session = valueOf(cookieFrom(res, 'vayu_session'));
    const csrf = valueOf(cookieFrom(res, 'vayu_csrf'));
    return { session, csrf, cookie: `vayu_session=${session}; vayu_csrf=${csrf}` };
}

const renameMe = (w, s, extra = {}) => fetch(`${w.origin}/api/auth/me`, {
    method: 'PUT', body: JSON.stringify({ name: 'Renamed' }),
    headers: { 'Content-Type': 'application/json', Cookie: s.cookie, Origin: w.origin, 'X-CSRF-Token': s.csrf, ...extra },
});

before(async () => {
    worker = await startDevWorker({ port: 8852, inspectorPort: 9282, seedLegacy: { sql: schema } });
    retired = await startDevWorker({ port: 8854, inspectorPort: 9284, seedLegacy: { sql: schema }, vars: { LEGACY_BEARER_UNTIL: '2000-01-01T00:00:00Z' } });
    for (const w of [worker, retired]) {
        await fetch(`${w.origin}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: w.origin }, body: JSON.stringify(OWNER) });
    }
    // More people, made by the owner through the cookie session (with its CSRF token).
    const owner = await signedIn(worker);
    for (const email of PEOPLE) {
        const made = await fetch(`${worker.origin}/api/auth/users`, {
            method: 'POST', body: JSON.stringify({ name: email, email, password: PASSWORD }),
            headers: { 'Content-Type': 'application/json', Cookie: owner.cookie, Origin: worker.origin, 'X-CSRF-Token': owner.csrf },
        });
        assert.ok([200, 201].includes(made.status), await made.text());
    }
});

after(async () => {
    for (const w of [worker, retired]) { await w?.stop(); w?.cleanup(); }
});

test('sign-in sets an HttpOnly, SameSite, host-wide cookie and returns no credential in the body', async () => {
    const res = await login(worker);
    assert.equal(res.status, 200);
    const session = cookieFrom(res, 'vayu_session');
    assert.ok(session, 'session cookie set');
    assert.match(session, /; Path=\/;/);
    assert.match(session, /; HttpOnly/);
    assert.match(session, /; SameSite=Lax/);
    assert.match(session, /; Max-Age=\d+/);
    assert.doesNotMatch(session, /Domain=/i, 'host-only: no parent-domain cookie');
    const csrf = cookieFrom(res, 'vayu_csrf');
    assert.ok(csrf && !/HttpOnly/.test(csrf), 'the CSRF value is readable by the page');
    const text = await res.text();
    assert.ok(!('token' in JSON.parse(text)), 'no token field');
    assert.ok(!text.includes(valueOf(session)), 'the session token appears nowhere in the body');
    // A new sign-in is a new session.
    assert.notEqual(sessionTokenFrom(await login(worker)), valueOf(session));
});

test('the cookie alone signs requests in; a missing or unknown session is refused', async () => {
    const s = await signedIn(worker, PEOPLE[0]);
    assert.equal((await fetch(`${worker.origin}/api/auth/me`, { headers: { Cookie: s.cookie } })).status, 200);
    assert.equal((await fetch(`${worker.origin}/api/auth/me`)).status, 401);
    assert.equal((await fetch(`${worker.origin}/api/auth/me`, { headers: { Cookie: 'vayu_session=' + 'a'.repeat(64) } })).status, 401);
});

test('CSRF: cookie-signed changes need a trusted origin and the CSRF token', async () => {
    const s = await signedIn(worker, PEOPLE[1]);
    assert.equal((await renameMe(worker, s)).status, 200);
    const noToken = await renameMe(worker, s, { 'X-CSRF-Token': '' });
    assert.equal(noToken.status, 403);
    assert.equal((await noToken.json()).code, 'csrf_token');
    assert.equal((await renameMe(worker, s, { 'X-CSRF-Token': 'f'.repeat(64) })).status, 403, 'a guessed token');
    const otherSite = await renameMe(worker, s, { Origin: 'https://evil.example' });
    assert.equal(otherSite.status, 403);
    assert.equal((await otherSite.json()).code, 'csrf_origin');
    // No Origin at all: only a browser saying "same-origin" is trusted.
    const noOrigin = { 'Content-Type': 'application/json', Cookie: s.cookie, 'X-CSRF-Token': s.csrf };
    assert.equal((await fetch(`${worker.origin}/api/auth/me`, { method: 'PUT', body: '{"name":"x"}', headers: { ...noOrigin, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await fetch(`${worker.origin}/api/auth/me`, { method: 'PUT', body: '{"name":"Person Two"}', headers: { ...noOrigin, 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
    // Reads don't need the token.
    assert.equal((await fetch(`${worker.origin}/api/artworks`, { headers: { Cookie: s.cookie } })).status, 200);
});

test('no wildcard or reflected CORS on the API', async () => {
    const pre = await fetch(`${worker.origin}/api/auth/me`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'PUT' } });
    assert.equal(pre.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal(pre.headers.get('Access-Control-Allow-Credentials'), null);
    const get = await fetch(`${worker.origin}/api/auth/status`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(get.headers.get('Access-Control-Allow-Origin'), null);
});

test('logout ends the session on the server and clears both cookies with the same attributes', async () => {
    const s = await signedIn(worker, PEOPLE[2]);
    const out = await fetch(`${worker.origin}/api/auth/logout`, { method: 'POST', headers: { Cookie: s.cookie, Origin: worker.origin, 'X-CSRF-Token': s.csrf } });
    assert.equal(out.status, 200);
    const cleared = cookieFrom(out, 'vayu_session');
    assert.match(cleared, /^vayu_session=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0/);
    assert.match(cookieFrom(out, 'vayu_csrf'), /Max-Age=0/);
    // Replaying the old cookie: revoked.
    assert.equal((await fetch(`${worker.origin}/api/auth/me`, { headers: { Cookie: s.cookie } })).status, 401);
});

test('an old JavaScript-kept token is exchanged once for a cookie session, and stops working', async () => {
    const old = sessionTokenFrom(await login(worker, PEOPLE[3])); // stands in for a token saved by the old app
    assert.equal((await fetch(`${worker.origin}/api/auth/me`, { headers: { Authorization: `Bearer ${old}` } })).status, 200, 'still accepted before the cutoff');
    const swap = await fetch(`${worker.origin}/api/auth/session`, { method: 'POST', headers: { Authorization: `Bearer ${old}`, Origin: worker.origin } });
    assert.equal(swap.status, 200, await swap.clone().text());
    const fresh = sessionTokenFrom(swap);
    assert.ok(fresh && fresh !== old, 'a new session, not the old token in a cookie');
    assert.ok(!(await swap.text()).includes(fresh));
    assert.equal((await fetch(`${worker.origin}/api/auth/me`, { headers: { Authorization: `Bearer ${old}` } })).status, 401, 'the old token is revoked');
    assert.equal((await fetch(`${worker.origin}/api/auth/me`, { headers: { Cookie: `vayu_session=${fresh}` } })).status, 200);
    // Exchanging it again does nothing.
    assert.equal((await fetch(`${worker.origin}/api/auth/session`, { method: 'POST', headers: { Authorization: `Bearer ${old}`, Origin: worker.origin } })).status, 401);
});

test('after LEGACY_BEARER_UNTIL, old tokens are refused everywhere, including the exchange; cookies still work', async () => {
    const token = sessionTokenFrom(await login(retired));
    assert.equal((await fetch(`${retired.origin}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
    const swap = await fetch(`${retired.origin}/api/auth/session`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: retired.origin } });
    assert.equal(swap.status, 401);
    assert.equal((await swap.json()).code, 'legacy_token_retired');
    assert.equal((await fetch(`${retired.origin}/api/auth/me`, { headers: { Cookie: `vayu_session=${token}` } })).status, 200);
});

test('workspace (platform) requests that change things need a trusted origin too', async () => {
    const admin = worker.browser();
    assert.equal((await admin.signIn('admin@example.com', 'provider-admin-password')).status, 200);
    const org = (await admin.call('/admin/orgs', { method: 'POST', body: { name: 'Origin Studio', businessType: 'studio', ownerEmail: 'admin@example.com' } })).body;
    const cookies = [...admin.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const body = JSON.stringify({ id: 'art-1', title: 'Study', price: 100, status: 'Available', imageUrls: [] });
    const post = (headers) => fetch(`${worker.origin}/api/o/${org.id}/artworks`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', Cookie: cookies, ...headers } });
    assert.equal((await post({})).status, 403, 'no Origin and no Sec-Fetch-Site: refused (it used to pass)');
    assert.equal((await post({ Origin: 'https://evil.example' })).status, 403);
    assert.notEqual((await post({ Origin: worker.origin })).status, 403);
});
