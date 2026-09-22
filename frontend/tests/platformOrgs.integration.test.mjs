// Organizations, memberships and each organization's own Razorpay account,
// through the provider control-panel API against a real local D1.
//
//   node --test frontend/tests/platformOrgs.integration.test.mjs
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { hashPassword } from 'better-auth/crypto';
import { startPlatform } from './helpers/platform.mjs';
import { load } from './helpers/load.mjs';

const PASSWORD = 'correct horse battery';
const PAYMENT_SECRETS_KEY = randomBytes(32).toString('base64');
const KEY_SECRET = 'SuperSecretRazorpayKey123';
const WEBHOOK_SECRET = 'whsec-org-a-1234';

let h;
let db;
let admin;
let orgA;
let orgB;

before(async () => {
    // 2FA enforcement is covered in platformAuth tests; here admins skip it.
    h = await startPlatform({ ADMIN_REQUIRE_2FA: 'off', PAYMENT_SECRETS_KEY });
    db = h.db;
    await h.createUser('admin-1', 'admin@example.com', await hashPassword(PASSWORD));
    await db.prepare("INSERT INTO provider_admins (user_id, role, status, created_at) VALUES ('admin-1', 'owner', 'active', ?)").bind(Date.now()).run();
    admin = h.browser();
    assert.equal((await admin.call('/auth/sign-in/email', { method: 'POST', body: { email: 'admin@example.com', password: PASSWORD } })).status, 200);
});

after(async () => { await h?.stop(); });

const post = (b, path, body) => b.call(path, { method: 'POST', body });

test('provider admin creates accounts and organizations, each with its owner', async () => {
    for (const [email, name] of [['owner-a@example.com', 'Owner A'], ['owner-b@example.com', 'Owner B'], ['staff-a@example.com', 'Staff A']]) {
        const res = await post(admin, '/admin/users', { email, name, temporaryPassword: PASSWORD });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(res.body.password, undefined);
    }
    assert.equal((await post(admin, '/admin/users', { email: 'owner-a@example.com', name: 'Again', temporaryPassword: PASSWORD })).body.code, 'email_taken');

    let res = await post(admin, '/admin/orgs', { name: 'Demo Studio A', businessType: 'studio', ownerEmail: 'owner-a@example.com', isDemo: true });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    orgA = res.body;
    assert.equal(orgA.slug, 'demo-studio-a');
    assert.deepEqual(orgA.members.map(m => [m.email, m.role, m.status]), [['owner-a@example.com', 'owner', 'active']]);

    res = await post(admin, '/admin/orgs', { name: 'Demo Gallery B', businessType: 'gallery', ownerEmail: 'owner-b@example.com', isDemo: true });
    orgB = res.body;

    assert.equal((await post(admin, '/admin/orgs', { name: 'Demo Studio A', businessType: 'studio', ownerEmail: 'owner-a@example.com' })).body.code, 'slug_taken', 'no duplicate org on a repeated click');
    assert.equal((await post(admin, '/admin/orgs', { name: 'X', businessType: 'studio', ownerEmail: 'nobody@example.com' })).body.code, 'owner_not_found');
    assert.equal((await post(admin, '/admin/orgs', { name: 'X', businessType: 'spaceship', ownerEmail: 'owner-a@example.com' })).body.code, 'invalid');
    const count = await db.prepare('SELECT COUNT(*) AS n FROM organizations').first();
    assert.equal(count.n, 2);
});

test('organization list shows owner, member count and search', async () => {
    const all = (await admin.call('/admin/orgs')).body.organizations;
    assert.equal(all.length, 2);
    const a = all.find(o => o.id === orgA.id);
    assert.equal(a.owner_email, 'owner-a@example.com');
    assert.equal(a.active_members, 1);
    const found = (await admin.call('/admin/orgs?q=gallery')).body.organizations;
    assert.deepEqual(found.map(o => o.id), [orgB.id]);
});

test('members: add, no duplicates, and ids from another organization are not found', async () => {
    let res = await post(admin, `/admin/orgs/${orgA.id}/members`, { email: 'staff-a@example.com', role: 'staff' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal((await post(admin, `/admin/orgs/${orgA.id}/members`, { email: 'staff-a@example.com', role: 'admin' })).body.code, 'already_member');
    assert.equal((await post(admin, `/admin/orgs/${orgA.id}/members`, { email: 'staff-a@example.com', role: 'superuser' })).body.code, 'invalid');

    // The same person can also belong to organization B (identity ≠ membership).
    assert.equal((await post(admin, `/admin/orgs/${orgB.id}/members`, { email: 'staff-a@example.com', role: 'manager' })).status, 201);

    const staffInA = res.body.members.find(m => m.email === 'staff-a@example.com');
    const viaB = await admin.call(`/admin/orgs/${orgB.id}/members/${staffInA.id}`, { method: 'PATCH', body: { status: 'disabled' } });
    assert.equal(viaB.status, 404, "org A's membership id is not reachable through org B");
    const still = await db.prepare('SELECT status FROM memberships WHERE id = ?').bind(staffInA.id).first();
    assert.equal(still.status, 'active');
});

test('the last active owner cannot be demoted, disabled or deleted', async () => {
    const owner = (await admin.call(`/admin/orgs/${orgA.id}`)).body.members.find(m => m.role === 'owner');
    let res = await admin.call(`/admin/orgs/${orgA.id}/members/${owner.id}`, { method: 'PATCH', body: { role: 'admin' } });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'last_owner');
    res = await admin.call(`/admin/orgs/${orgA.id}/members/${owner.id}`, { method: 'PATCH', body: { status: 'disabled' } });
    assert.equal(res.body.code, 'last_owner');
    // The database refuses it too, whatever code path tries.
    await assert.rejects(db.prepare("UPDATE memberships SET role = 'staff' WHERE id = ?").bind(owner.id).run(), /at least one active owner/);
    await assert.rejects(db.prepare('DELETE FROM memberships WHERE id = ?').bind(owner.id).run(), /at least one active owner/);

    // With a second owner in place, the first can step down.
    const staff = (await admin.call(`/admin/orgs/${orgA.id}`)).body.members.find(m => m.email === 'staff-a@example.com');
    assert.equal((await admin.call(`/admin/orgs/${orgA.id}/members/${staff.id}`, { method: 'PATCH', body: { role: 'owner' } })).status, 200);
    res = await admin.call(`/admin/orgs/${orgA.id}/members/${owner.id}`, { method: 'PATCH', body: { role: 'admin' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // Restore for later tests.
    await admin.call(`/admin/orgs/${orgA.id}/members/${owner.id}`, { method: 'PATCH', body: { role: 'owner' } });
    await admin.call(`/admin/orgs/${orgA.id}/members/${staff.id}`, { method: 'PATCH', body: { role: 'staff' } });
});

test('organization owners are not provider admins: the admin API refuses them', async () => {
    const owner = h.browser();
    await owner.call('/auth/sign-in/email', { method: 'POST', body: { email: 'owner-a@example.com', password: PASSWORD } });
    for (const [path, method] of [['/admin/orgs', 'GET'], [`/admin/orgs/${orgB.id}`, 'GET'], [`/admin/orgs/${orgA.id}/payments/razorpay`, 'GET']]) {
        const res = await owner.call(path, { method });
        assert.equal(res.status, 403, path);
        assert.equal(res.body.code, 'not_provider_admin');
    }
});

test('suspending needs a reason and is audited', async () => {
    assert.equal((await post(admin, `/admin/orgs/${orgB.id}/status`, { status: 'suspended' })).body.code, 'invalid');
    const res = await post(admin, `/admin/orgs/${orgB.id}/status`, { status: 'suspended', reason: 'Test suspension' });
    assert.equal(res.body.status, 'suspended');
    const entry = await db.prepare("SELECT details FROM platform_audit WHERE action = 'org.status.suspended' AND org_id = ?").bind(orgB.id).first();
    assert.equal(JSON.parse(entry.details).reason, 'Test suspension');
    await post(admin, `/admin/orgs/${orgB.id}/status`, { status: 'active', reason: 'Test over' });
});

const rzpPath = (org) => `/admin/orgs/${org.id}/payments/razorpay`;

test('Razorpay: refused without the encryption key; keys are validated', async () => {
    const res = await admin.call(rzpPath(orgA), { method: 'PUT', body: { keyId: 'rzp_test_ABCDEFGH1234', keySecret: KEY_SECRET }, envOverride: { PAYMENT_SECRETS_KEY: undefined } });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'secrets_unavailable');
    assert.equal((await admin.call(rzpPath(orgA), { method: 'PUT', body: { keyId: 'pk_live_nope', keySecret: KEY_SECRET } })).body.code, 'invalid');
    assert.equal((await admin.call(rzpPath(orgA), { method: 'PUT', body: { keyId: 'rzp_test_ABCDEFGH1234', keySecret: 'short' } })).body.code, 'invalid');
});

test('Razorpay: connect stores secrets encrypted and bound to the organization; APIs never return them', async () => {
    let res = await admin.call(rzpPath(orgA), { method: 'PUT', body: { keyId: 'rzp_test_ABCDEFGH1234', keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.connected, true);
    assert.equal(res.body.mode, 'test');
    assert.equal(res.body.status, 'unverified');
    assert.equal(res.body.webhookUrl, `https://admin.test/api/v2/webhooks/razorpay/${orgA.id}`);
    assert.ok(!res.text.includes(KEY_SECRET) && !res.text.includes(WEBHOOK_SECRET), 'no secret in the response');

    const get = await admin.call(rzpPath(orgA));
    assert.ok(!get.text.includes(KEY_SECRET) && !get.text.includes('rzp_test_ABCDEFGH1234'), 'only a masked key id is shown');
    const list = await admin.call('/admin/orgs');
    assert.ok(!list.text.includes(KEY_SECRET));
    assert.equal(list.body.organizations.find(o => o.id === orgA.id).razorpay_status, 'unverified');
    assert.equal((await admin.call(rzpPath(orgB))).body.connected, false, "org B does not see org A's account");

    const row = await db.prepare('SELECT key_secret_enc, webhook_secret_enc FROM org_payment_integrations WHERE org_id = ?').bind(orgA.id).first();
    assert.ok(!row.key_secret_enc.includes(KEY_SECRET));
    const secrets = await load('platform/secrets.ts');
    const env = { PAYMENT_SECRETS_KEY };
    assert.equal(await secrets.decryptSecret(env, `${orgA.id}|razorpay|key_secret`, row.key_secret_enc), KEY_SECRET);
    await assert.rejects(secrets.decryptSecret(env, `${orgB.id}|razorpay|key_secret`, row.key_secret_enc), 'a ciphertext moved to another org does not decrypt');

    const audit = await db.prepare("SELECT details FROM platform_audit WHERE action = 'payments.razorpay.connect' AND org_id = ?").bind(orgA.id).first();
    assert.ok(!audit.details.includes(KEY_SECRET));
});

test('Razorpay: replacing keys with a blank webhook secret keeps the stored one', async () => {
    const res = await admin.call(rzpPath(orgA), { method: 'PUT', body: { keyId: 'rzp_live_ZYXWVUTS9876', keySecret: `${KEY_SECRET}-live` } });
    assert.equal(res.body.mode, 'live');
    assert.equal(res.body.hasWebhookSecret, true);
});

test('Razorpay: verify calls Razorpay with only this organization\'s keys', async () => {
    const realFetch = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        if (!url.startsWith('https://api.razorpay.com/')) return realFetch(input, init);
        seen.push({ url, auth: new Headers(init?.headers).get('Authorization') });
        return new Response('{"items":[]}', { status: seen.length === 1 ? 200 : 401 });
    };
    try {
        let res = await post(admin, `${rzpPath(orgA)}/verify`, {});
        assert.deepEqual(res.body, { status: 'verified', error: null });
        assert.equal(seen[0].auth, `Basic ${Buffer.from(`rzp_live_ZYXWVUTS9876:${KEY_SECRET}-live`).toString('base64')}`);
        res = await post(admin, `${rzpPath(orgA)}/verify`, {});
        assert.equal(res.body.status, 'failed');
        assert.match(res.body.error, /rejected/);
        assert.equal((await post(admin, `${rzpPath(orgB)}/verify`, {})).body.code, 'not_connected');
    } finally {
        globalThis.fetch = realFetch;
    }
});

function webhook(orgId, body, { secret = WEBHOOK_SECRET, eventId = 'evt_1', signature } = {}) {
    const raw = JSON.stringify(body);
    const sig = signature ?? createHmac('sha256', secret).update(raw).digest('hex');
    return h.platform.handlePlatformRequest(new Request(`https://app.test/api/v2/webhooks/razorpay/${orgId}`, {
        method: 'POST',
        headers: { 'x-razorpay-signature': sig, 'x-razorpay-event-id': eventId, 'Content-Type': 'application/json' },
        body: raw,
    }), h.env);
}

test('Razorpay webhooks: verified per organization, stored once, replays are no-ops', async () => {
    const event = { event: 'payment_link.paid', payload: { payment_link: { entity: { id: 'plink_1' } } } };
    let res = await webhook(orgA.id, event);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, duplicate: false });
    res = await webhook(orgA.id, event);
    assert.deepEqual(await res.json(), { ok: true, duplicate: true }, 'a retried delivery is acknowledged but not stored twice');
    const stored = await db.prepare('SELECT COUNT(*) AS n, MAX(event_type) AS t FROM payment_webhook_events WHERE org_id = ?').bind(orgA.id).first();
    assert.deepEqual([stored.n, stored.t], [1, 'payment_link.paid']);

    assert.equal((await webhook(orgA.id, event, { eventId: 'evt_2', signature: 'deadbeef' })).status, 401, 'bad signature');
    assert.equal((await webhook(orgA.id, { ...event, tampered: true }, { eventId: 'evt_3', signature: createHmac('sha256', WEBHOOK_SECRET).update(JSON.stringify(event)).digest('hex') })).status, 401, 'body changed after signing');
    assert.equal((await webhook(orgB.id, event, { eventId: 'evt_4' })).status, 401, "org A's signed event is refused at org B's address");
    assert.equal((await webhook('no-such-org', event, { eventId: 'evt_5' })).status, 401, 'unknown org looks the same as a bad signature');
    assert.equal((await webhook(orgA.id, event, { eventId: '' })).status, 401, 'event id required');
    const total = await db.prepare('SELECT COUNT(*) AS n FROM payment_webhook_events').first();
    assert.equal(total.n, 1);
});

test('Razorpay: changing or removing keys needs a recent sign-in; disconnect is audited', async () => {
    await db.prepare("UPDATE session SET createdAt = ? WHERE userId = 'admin-1'").bind(new Date(Date.now() - 2 * 3_600_000).toISOString()).run();
    let res = await admin.call(rzpPath(orgA), { method: 'DELETE' });
    assert.equal(res.body.code, 'reauth_required');
    res = await admin.call(rzpPath(orgA), { method: 'PUT', body: { keyId: 'rzp_test_ABCDEFGH1234', keySecret: KEY_SECRET } });
    assert.equal(res.body.code, 'reauth_required');

    const fresh = h.browser();
    await fresh.call('/auth/sign-in/email', { method: 'POST', body: { email: 'admin@example.com', password: PASSWORD } });
    res = await fresh.call(rzpPath(orgA), { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(res.body.connected, false);
    assert.ok(await db.prepare("SELECT 1 FROM platform_audit WHERE action = 'payments.razorpay.disconnect' AND org_id = ?").bind(orgA.id).first());
    assert.equal((await webhook(orgA.id, { event: 'x' }, { eventId: 'evt_9' })).status, 401, 'webhooks stop once disconnected');
});
