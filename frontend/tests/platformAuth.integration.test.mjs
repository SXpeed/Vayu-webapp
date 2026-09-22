// Platform auth (/api/v2) against a real local D1 (workerd via wrangler's
// getPlatformProxy). Fresh temporary database per run; no network.
//
//   node --test frontend/tests/platformAuth.integration.test.mjs
import assert from 'node:assert/strict';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { hashPassword } from 'better-auth/crypto';
import { startPlatform, totp } from './helpers/platform.mjs';

const ORIGIN = 'https://admin.test';
const PASSWORD = 'correct horse battery';

let h;
let platform;
let db;
let env;
let browser;

before(async () => {
    h = await startPlatform();
    ({ platform, db, env, browser } = h);
    await h.createUser('admin-1', 'admin@example.com', await hashPassword(PASSWORD));
    await db.prepare("INSERT INTO provider_admins (user_id, role, status, created_at) VALUES ('admin-1', 'owner', 'active', ?)").bind(Date.now()).run();
    await h.createUser('user-1', 'staff@example.com', await hashPassword(PASSWORD));
    // A user migrated from the original app keeps its PBKDF2 "salt.hash" password.
    const salt = randomBytes(16);
    const legacy = `${salt.toString('base64')}.${pbkdf2Sync(PASSWORD, salt, 100_000, 32, 'sha256').toString('base64')}`;
    await h.createUser('legacy-1', 'legacy@example.com', legacy);
});

after(async () => { await h?.stop(); });

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
