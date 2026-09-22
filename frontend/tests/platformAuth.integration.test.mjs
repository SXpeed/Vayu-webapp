// Platform auth (/api/v2) against a real local D1 (workerd via wrangler's
// getPlatformProxy). Fresh temporary database per run; no network.
//
//   node --test frontend/tests/platformAuth.integration.test.mjs
import assert from 'node:assert/strict';
import { createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { getPlatformProxy } from 'wrangler';
import { hashPassword } from 'better-auth/crypto';
import { load } from './helpers/load.mjs';

const frontend = fileURLToPath(new URL('..', import.meta.url));
const ORIGIN = 'https://admin.test';

let platform;
let proxy;
let persistDir;
let db;
let env;

const PASSWORD = 'correct horse battery';

before(async () => {
    platform = await load('platform/routes.ts');
    persistDir = mkdtempSync(join(tmpdir(), 'as-platform-'));
    proxy = await getPlatformProxy({ configPath: join(frontend, 'wrangler.json'), persist: { path: persistDir } });
    db = proxy.env.PLATFORM_DB;
    env = {
        PLATFORM_DB: db,
        BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
        AUTH_ORIGINS: `${ORIGIN},https://app.test`,
    };
    const statements = readFileSync(join(frontend, 'platform/migrations/0001_platform_auth.sql'), 'utf8')
        .replace(/--.*$/gm, '')
        .split(/;\s*(?=\n|$)/)
        .map(s => s.trim())
        .filter(Boolean);
    // Triggers contain inner semicolons; re-join BEGIN…END blocks.
    const merged = [];
    for (const s of statements) {
        const last = merged.at(-1);
        if (last && /BEGIN/i.test(last) && !/END$/i.test(last)) merged[merged.length - 1] = `${last};\n${s}`;
        else merged.push(s);
    }
    for (const statement of merged) await db.prepare(statement).run();

    await createUser('admin-1', 'admin@example.com', await hashPassword(PASSWORD));
    await db.prepare("INSERT INTO provider_admins (user_id, role, status, created_at) VALUES ('admin-1', 'owner', 'active', ?)").bind(Date.now()).run();
    await createUser('user-1', 'staff@example.com', await hashPassword(PASSWORD));
    // A user migrated from the original app keeps its PBKDF2 "salt.hash" password.
    const salt = randomBytes(16);
    const legacy = `${salt.toString('base64')}.${pbkdf2Sync(PASSWORD, salt, 100_000, 32, 'sha256').toString('base64')}`;
    await createUser('legacy-1', 'legacy@example.com', legacy);
});

after(async () => {
    await proxy?.dispose();
    if (persistDir) rmSync(persistDir, { recursive: true, force: true });
});

async function createUser(id, email, passwordHash) {
    const now = new Date().toISOString();
    await db.batch([
        db.prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, twoFactorEnabled) VALUES (?, ?, ?, 1, ?, ?, 0)').bind(id, id, email, now, now),
        db.prepare("INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, 'credential', ?, ?, ?, ?)").bind(`acc-${id}`, id, id, passwordHash, now, now),
    ]);
}

let nextIp = 10;

/** Minimal cookie jar: one per simulated browser, each with its own IP so
 *  the per-IP sign-in rate limit applies per browser. */
function browser(origin = ORIGIN, ip = `203.0.113.${nextIp++}`) {
    const jar = new Map();
    return {
        async call(path, { method = 'GET', body, headers = {}, envOverride = {} } = {}) {
            const h = new Headers(headers);
            if (jar.size) h.set('Cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
            if (body !== undefined) h.set('Content-Type', 'application/json');
            if (method !== 'GET' && !h.has('Origin')) h.set('Origin', origin);
            h.set('cf-connecting-ip', ip);
            const req = new Request(`${origin}/api/v2${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
            const res = await platform.handlePlatformRequest(req, { ...env, ...envOverride });
            for (const c of res.headers.getSetCookie?.() ?? []) {
                const [pair] = c.split(';');
                const i = pair.indexOf('=');
                const name = pair.slice(0, i);
                const value = pair.slice(i + 1);
                if (value === '' || /max-age=0/i.test(c)) jar.delete(name); else jar.set(name, value);
            }
            const text = await res.text();
            let json = null;
            try { json = JSON.parse(text); } catch { /* not JSON */ }
            return { status: res.status, body: json, headers: res.headers };
        },
        jar,
    };
}

function totp(secretBase32, time = Date.now()) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const ch of secretBase32.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
    const key = Buffer.from(bits.match(/.{8}/g).map(b => parseInt(b, 2)));
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(time / 30_000)));
    const mac = createHmac('sha1', key).update(counter).digest();
    const offset = mac[mac.length - 1] & 0xf;
    const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
    return String(code).padStart(6, '0');
}

async function signIn(b, email, password = PASSWORD) {
    return b.call('/auth/sign-in/email', { method: 'POST', body: { email, password } });
}

test('fails closed without a platform database or on an unknown origin', async () => {
    const req = new Request(`${ORIGIN}/api/v2/public/login-methods`);
    assert.equal((await platform.handlePlatformRequest(req, { ...env, PLATFORM_DB: undefined })).status, 503);
    assert.equal((await platform.handlePlatformRequest(req, { ...env, BETTER_AUTH_SECRET: 'short' })).status, 503);
    const evil = new Request('https://evil.test/api/v2/public/login-methods');
    assert.equal((await platform.handlePlatformRequest(evil, env)).status, 403);
    assert.equal(await platform.handlePlatformRequest(new Request(`${ORIGIN}/api/artworks`), env), null, 'non-v2 paths are not handled');
});

test('default login methods: local sign-in on, sign-up off, Google off', async () => {
    const res = await browser().call('/public/login-methods');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { emailPassword: { signIn: true, signUp: false }, google: { signIn: false, signUp: false } });
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('public sign-up is refused while switched off', async () => {
    const res = await browser().call('/auth/sign-up/email', { method: 'POST', body: { email: 'new@example.com', password: PASSWORD, name: 'New' } });
    assert.notEqual(res.status, 200);
    const row = await db.prepare('SELECT 1 FROM "user" WHERE email = ?').bind('new@example.com').first();
    assert.equal(row, null);
});

test('email sign-in works, including a migrated PBKDF2 password; wrong password fails', async () => {
    assert.equal((await signIn(browser(), 'staff@example.com')).status, 200);
    assert.equal((await signIn(browser(), 'legacy@example.com')).status, 200);
    assert.equal((await signIn(browser(), 'legacy@example.com', 'wrong password!!')).status, 401);
});

test('sign-in from an untrusted Origin is rejected (CSRF)', async () => {
    const b = browser();
    const res = await b.call('/auth/sign-in/email', { method: 'POST', body: { email: 'staff@example.com', password: PASSWORD }, headers: { Origin: 'https://evil.test' } });
    assert.equal(res.status, 403);
});

test('sign-in attempts are rate limited per IP', async () => {
    const b = browser();
    const statuses = [];
    for (let i = 0; i < 7; i++) statuses.push((await signIn(b, 'nobody@example.com', 'wrong password!!')).status);
    assert.ok(statuses.slice(0, 5).every(s => s === 401), statuses.join(','));
    assert.equal(statuses.at(-1), 429);
    // Another IP is unaffected.
    assert.equal((await signIn(browser(), 'staff@example.com')).status, 200);
});

test('admin API: anonymous 401, ordinary user 403, admin without 2FA 403 2fa_required', async () => {
    assert.equal((await browser().call('/admin/me')).status, 401);

    const staff = browser();
    await signIn(staff, 'staff@example.com');
    const denied = await staff.call('/admin/me');
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'not_provider_admin');

    const admin = browser();
    await signIn(admin, 'admin@example.com');
    const no2fa = await admin.call('/admin/me');
    assert.equal(no2fa.status, 403);
    assert.equal(no2fa.body.code, '2fa_required');
});

test('admin API is only served on ADMIN_HOST when set', async () => {
    const admin = browser('https://app.test');
    await signIn(admin, 'admin@example.com');
    const res = await admin.call('/admin/me', { envOverride: { ADMIN_HOST: 'admin.test', ADMIN_REQUIRE_2FA: 'off' } });
    assert.equal(res.status, 404);
});

let adminBrowser;

test('admin enrolls TOTP 2FA, then signs in with password + code', async () => {
    const b = browser();
    assert.equal((await signIn(b, 'admin@example.com')).status, 200);
    const enable = await b.call('/auth/two-factor/enable', { method: 'POST', body: { password: PASSWORD } });
    assert.equal(enable.status, 200, JSON.stringify(enable.body));
    const secret = new URL(enable.body.totpURI).searchParams.get('secret');
    assert.ok(secret);
    const verify = await b.call('/auth/two-factor/verify-totp', { method: 'POST', body: { code: totp(secret) } });
    assert.equal(verify.status, 200, JSON.stringify(verify.body));

    // A fresh sign-in now stops at the second factor.
    adminBrowser = browser();
    const first = await signIn(adminBrowser, 'admin@example.com');
    assert.equal(first.status, 200);
    assert.equal(first.body.twoFactorRedirect, true);
    assert.equal((await adminBrowser.call('/admin/me')).status, 401, 'no session before the second factor');
    const second = await adminBrowser.call('/auth/two-factor/verify-totp', { method: 'POST', body: { code: totp(secret) } });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const me = await adminBrowser.call('/admin/me');
    assert.equal(me.status, 200);
    assert.deepEqual(me.body, { userId: 'admin-1', email: 'admin@example.com', role: 'owner' });
});

test('login-method changes are validated against lockout and audited', async () => {
    const current = await adminBrowser.call('/admin/settings/login-methods');
    assert.equal(current.status, 200);
    assert.equal(current.body.googleConfigured, false);
    assert.equal(current.body.googleRedirectUri, `${ORIGIN}/api/v2/auth/callback/google`);

    const put = (body, envOverride) => adminBrowser.call('/admin/settings/login-methods', { method: 'PUT', body, envOverride });

    let res = await put({ emailPassword: { signIn: true, signUp: false }, google: { signIn: true, signUp: false } });
    assert.equal(res.body.code, 'google_not_configured');
    res = await put({ emailPassword: { signIn: false, signUp: false }, google: { signIn: false, signUp: false } });
    assert.equal(res.body.code, 'no_sign_in_method');
    const withGoogle = { GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'test-secret' };
    res = await put({ emailPassword: { signIn: false, signUp: false }, google: { signIn: true, signUp: false } }, withGoogle);
    assert.equal(res.body.code, 'actor_lockout', 'cannot turn off passwords without a linked Google account');
    res = await put({ emailPassword: { signIn: true }, google: {} });
    assert.equal(res.body.code, 'invalid');

    res = await put({ emailPassword: { signIn: true, signUp: true }, google: { signIn: false, signUp: false } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual((await browser().call('/public/login-methods')).body.emailPassword, { signIn: true, signUp: true });

    const audit = await adminBrowser.call('/admin/audit');
    const entry = audit.body.entries.find(e => e.action === 'settings.login_methods.update');
    assert.ok(entry);
    assert.equal(entry.actor_email, 'admin@example.com');
    assert.deepEqual(JSON.parse(entry.details).after.emailPassword, { signIn: true, signUp: true });

    // Restore the default for later tests.
    res = await put({ emailPassword: { signIn: true, signUp: false }, google: { signIn: false, signUp: false } });
    assert.equal(res.status, 200);
});

test('Google sign-in stays unavailable until configured and switched on', async () => {
    const off = await browser().call('/auth/sign-in/social', { method: 'POST', body: { provider: 'google', callbackURL: '/admin' } });
    assert.notEqual(off.status, 200);
    // Credentials alone are not enough; the switch is still off.
    const creds = { GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'test-secret' };
    const stillOff = await browser().call('/auth/sign-in/social', { method: 'POST', body: { provider: 'google', callbackURL: '/admin' }, envOverride: creds });
    assert.notEqual(stillOff.status, 200);
    assert.deepEqual((await browser().call('/public/login-methods', { envOverride: creds })).body.google, { signIn: false, signUp: false });
});

test('platform audit is append-only', async () => {
    await db.prepare("INSERT INTO platform_audit (id, at, actor_kind, action) VALUES ('audit-probe', ?, 'system', 'test.probe')").bind(Date.now()).run();
    await assert.rejects(db.prepare("UPDATE platform_audit SET action = 'tampered'").run(), /append-only/);
    await assert.rejects(db.prepare('DELETE FROM platform_audit').run(), /cannot be deleted/);
});

test('stale sessions must sign in again before changing login methods', async () => {
    await db.prepare("UPDATE session SET createdAt = ? WHERE userId = 'admin-1'").bind(new Date(Date.now() - 2 * 3_600_000).toISOString()).run();
    const res = await adminBrowser.call('/admin/settings/login-methods', {
        method: 'PUT', body: { emailPassword: { signIn: true, signUp: false }, google: { signIn: false, signUp: false } },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'reauth_required');
});
