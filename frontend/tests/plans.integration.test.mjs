// Plans, versions, subscriptions, entitlements and seat limits.
//
//   node --test frontend/tests/plans.integration.test.mjs
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { hashPassword } from 'better-auth/crypto';
import { startPlatform } from './helpers/platform.mjs';

const PASSWORD = 'correct horse battery';

let h;
let db;
let admin;
let org;
let planId;
let starterVersion;

const post = (path, body) => admin.call(path, { method: 'POST', body });
const patch = (path, body) => admin.call(path, { method: 'PATCH', body });

before(async () => {
    h = await startPlatform({ ADMIN_REQUIRE_2FA: 'off' });
    db = h.db;
    await h.createUser('admin-1', 'admin@example.com', await hashPassword(PASSWORD));
    await db.prepare("INSERT INTO provider_admins (user_id, role, status, created_at) VALUES ('admin-1', 'owner', 'active', ?)").bind(Date.now()).run();
    admin = h.browser();
    assert.equal((await admin.call('/auth/sign-in/email', { method: 'POST', body: { email: 'admin@example.com', password: PASSWORD } })).status, 200);

    for (const email of ['owner@example.com', 'one@example.com', 'two@example.com', 'three@example.com']) {
        await post('/admin/users', { email, name: email, temporaryPassword: PASSWORD });
    }
    org = (await post('/admin/orgs', { name: 'Plan Test Gallery', businessType: 'gallery', ownerEmail: 'owner@example.com' })).body;
});

after(async () => { await h?.stop(); });

test('a plan is created as a draft and only shows publicly once published', async () => {
    let res = await post('/admin/plans', { name: 'Starter', description: 'For a single artist', isPublic: true });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    planId = res.body.id;
    assert.equal(res.body.key, 'starter');
    assert.equal(res.body.status, 'draft');
    assert.deepEqual((await admin.call('/public/plans')).body.plans, [], 'a draft plan is not public');

    res = await post(`/admin/plans/${planId}/versions`, {
        billingType: 'paid', currency: 'INR', priceMonthly: 99900, priceAnnual: 999000, trialDays: 14,
        limits: { maxMembers: 2, maxStores: 1, maxItems: 100, storageMb: 512, exports: false },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    starterVersion = res.body.versions[0];
    assert.equal(starterVersion.status, 'draft');

    // Publishing the plan needs a published version first.
    assert.equal((await patch(`/admin/plans/${planId}`, { status: 'published' })).body.code, 'no_published_version');
    assert.equal((await patch(`/admin/plans/${planId}/versions/${starterVersion.id}`, { status: 'published' })).status, 200);
    assert.equal((await patch(`/admin/plans/${planId}`, { status: 'published' })).status, 200);

    const publicList = (await admin.call('/public/plans')).body.plans;
    assert.equal(publicList.length, 1);
    assert.equal(publicList[0].key, 'starter');
    assert.equal(publicList[0].priceMonthly, 99900);
    assert.equal(publicList[0].highlights.maxMembers, 2);
    assert.equal(publicList[0].id, undefined, 'internal ids stay private');
    assert.equal(publicList[0].notes, undefined);
});

test('a published version cannot be edited, in the API or the database', async () => {
    const res = await patch(`/admin/plans/${planId}/versions/${starterVersion.id}`, { limits: { maxMembers: 99 } });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'version_published');
    await assert.rejects(
        db.prepare("UPDATE plan_versions SET limits = '{\"maxMembers\":99}' WHERE id = ?").bind(starterVersion.id).run(),
        /cannot be changed/,
    );
});

test('assigning a paid plan waits for payment; a waiver activates it', async () => {
    let res = await post(`/admin/orgs/${org.id}/subscription`, { planVersionId: starterVersion.id });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.subscription.status, 'payment_required');
    assert.equal(res.body.plan.key, 'starter');
    assert.equal(res.body.limits.maxMembers, 2);

    res = await post(`/admin/orgs/${org.id}/subscription`, { planVersionId: starterVersion.id, waivePayment: true, reason: 'Founding customer' });
    assert.equal(res.body.subscription.status, 'active');
    assert.equal(res.body.subscription.paymentWaived, true);
    const audit = await db.prepare("SELECT details FROM platform_audit WHERE action = 'subscription.update' ORDER BY at DESC LIMIT 1").first();
    assert.match(JSON.parse(audit.details).reason, /Founding customer/);
});

test('seat limits are enforced, and two people cannot take the last seat', async () => {
    // The plan allows 2; the owner already holds one.
    let res = await post(`/admin/orgs/${org.id}/members`, { email: 'one@example.com', role: 'staff' });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    res = await post(`/admin/orgs/${org.id}/members`, { email: 'two@example.com', role: 'staff' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'seat_limit');
    assert.match(res.body.error, /allows 2 members/);

    // Free a seat, then race two additions for it.
    const members = (await admin.call(`/admin/orgs/${org.id}`)).body.members;
    const one = members.find(m => m.email === 'one@example.com');
    assert.equal((await patch(`/admin/orgs/${org.id}/members/${one.id}`, { status: 'disabled' })).status, 200);

    const [a, b] = await Promise.all([
        post(`/admin/orgs/${org.id}/members`, { email: 'two@example.com', role: 'staff' }),
        post(`/admin/orgs/${org.id}/members`, { email: 'three@example.com', role: 'staff' }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409], `got ${JSON.stringify([a.body, b.body])}`);
    const seats = (await admin.call(`/admin/orgs/${org.id}/subscription`)).body.seats;
    assert.equal(seats.used, 2);
    assert.equal(seats.limit, 2);

    // Re-enabling someone also needs a free seat.
    const res2 = await patch(`/admin/orgs/${org.id}/members/${one.id}`, { status: 'active' });
    assert.equal(res2.status, 409);
    assert.equal(res2.body.code, 'seat_limit');
});

test('an override raises the limit for one organization, with a reason, and expires', async () => {
    let res = await post(`/admin/orgs/${org.id}/entitlements`, { key: 'maxMembers', value: 5, reason: 'Migration period' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.limits.maxMembers, 5);
    assert.equal((await admin.call(`/admin/orgs/${org.id}/subscription`)).body.seats.limit, 5);

    const members = (await admin.call(`/admin/orgs/${org.id}`)).body.members;
    const one = members.find(m => m.email === 'one@example.com');
    assert.equal((await patch(`/admin/orgs/${org.id}/members/${one.id}`, { status: 'active' })).status, 200, 'now there is room');

    assert.equal((await post(`/admin/orgs/${org.id}/entitlements`, { key: 'nonsense', value: 5, reason: 'x' })).body.code, 'invalid');
    assert.equal((await post(`/admin/orgs/${org.id}/entitlements`, { key: 'maxMembers', value: 5 })).body.code, 'invalid', 'a reason is required');

    // An expired override stops counting.
    await db.prepare('UPDATE entitlement_overrides SET expires_at = ? WHERE org_id = ? AND key = ?')
        .bind(Date.now() - 1000, org.id, 'maxMembers').run();
    assert.equal((await admin.call(`/admin/orgs/${org.id}/subscription`)).body.limits.maxMembers, 2);

    res = await admin.call(`/admin/orgs/${org.id}/entitlements/maxMembers`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(res.body.overrides.maxMembers, undefined);
});

test('a downgrade keeps every member and only blocks new ones', async () => {
    const smaller = (await post(`/admin/plans/${planId}/versions`, {
        billingType: 'free', limits: { maxMembers: 1, maxItems: 10 },
    })).body.versions.find(v => v.status === 'draft');
    await patch(`/admin/plans/${planId}/versions/${smaller.id}`, { status: 'published' });

    const membersBefore = (await admin.call(`/admin/orgs/${org.id}`)).body.members.length;
    const res = await post(`/admin/orgs/${org.id}/subscription`, { planVersionId: smaller.id });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.subscription.status, 'active', 'a free plan activates on assignment');
    assert.equal(res.body.limits.maxMembers, 1);

    const after = (await admin.call(`/admin/orgs/${org.id}`)).body.members;
    assert.equal(after.length, membersBefore, 'nobody was removed by the downgrade');
    const seats = (await admin.call(`/admin/orgs/${org.id}/subscription`)).body.seats;
    assert.equal(seats.overLimit, true);
    assert.equal(seats.remaining, 0);

    const add = await post(`/admin/orgs/${org.id}/members`, { email: 'admin@example.com', role: 'staff' });
    assert.equal(add.status, 409);
    assert.equal(add.body.code, 'seat_limit');
});

test('a trial starts its clock, can be extended, and expiry shows up', async () => {
    const trialVersion = (await post(`/admin/plans/${planId}/versions`, {
        billingType: 'trial', trialDays: 14, limits: { maxMembers: 10 },
    })).body.versions.find(v => v.status === 'draft');
    await patch(`/admin/plans/${planId}/versions/${trialVersion.id}`, { status: 'published' });

    let res = await post(`/admin/orgs/${org.id}/subscription`, { planVersionId: trialVersion.id });
    assert.equal(res.body.subscription.status, 'trialing');
    const ends = res.body.subscription.trialEndsAt;
    assert.ok(ends > Date.now() + 13 * 86_400_000 && ends < Date.now() + 15 * 86_400_000);

    res = await post(`/admin/orgs/${org.id}/subscription/extend-trial`, { days: 7, reason: 'Still evaluating' });
    assert.ok(res.body.subscription.trialEndsAt >= ends + 7 * 86_400_000 - 1000);

    await db.prepare('UPDATE subscriptions SET trial_ends_at = ? WHERE org_id = ?').bind(Date.now() - 1000, org.id).run();
    res = await admin.call(`/admin/orgs/${org.id}/subscription`);
    assert.equal(res.body.subscription.status, 'trial_expired');
    assert.equal(res.body.active, false);
});

test('an organization with no plan gets conservative defaults', async () => {
    const fresh = (await post('/admin/orgs', { name: 'No Plan Studio', businessType: 'studio', ownerEmail: 'owner@example.com' })).body;
    const res = await admin.call(`/admin/orgs/${fresh.id}/subscription`);
    assert.equal(res.body.plan, null);
    assert.equal(res.body.subscription.status, 'none');
    assert.equal(res.body.limits.maxMembers, 3);
    assert.equal(res.body.limits.exports, false);
});
