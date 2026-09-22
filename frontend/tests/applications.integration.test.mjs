// Sign-up → application → review → approval → provisioning, plus the
// control-centre account and administrator functions.
//
//   node --test frontend/tests/applications.integration.test.mjs
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { hashPassword } from 'better-auth/crypto';
import { startPlatform } from './helpers/platform.mjs';

const PASSWORD = 'correct horse battery';
const APP_ORIGIN = 'https://app.test';

let h;
let db;
let admin;
let applicant;
let other;
let applicationId;
let paidVersion;

/** A stand-in for the organization-database namespace: records who was opened. */
function fakeOrgStore() {
    const opened = [];
    return {
        opened,
        idFromName: (name) => name,
        get: (id) => ({ info: async () => { opened.push(id); return { schemaVersion: 2, artworks: 0 }; } }),
    };
}

const post = (b, path, body, opts = {}) => b.call(path, { method: 'POST', body, ...opts });

before(async () => {
    h = await startPlatform({ ADMIN_REQUIRE_2FA: 'off' });
    db = h.db;
    await h.createUser('admin-1', 'admin@example.com', await hashPassword(PASSWORD));
    await db.prepare("INSERT INTO provider_admins (user_id, role, status, created_at) VALUES ('admin-1', 'owner', 'active', ?)").bind(Date.now()).run();
    admin = h.browser();
    assert.equal((await post(admin, '/auth/sign-in/email', { email: 'admin@example.com', password: PASSWORD })).status, 200);

    // Open public sign-up, as the owner would in the panel.
    assert.equal((await admin.call('/admin/settings/login-methods', {
        method: 'PUT', body: { emailPassword: { signIn: true, signUp: true }, google: { signIn: false, signUp: false } },
    })).status, 200);
    // Where "new application" notices go.
    assert.equal((await admin.call('/admin/settings/notifications', { method: 'PUT', body: { providerEmail: 'provider@example.com' } })).status, 200);

    // One public paid plan to apply for.
    const plan = (await post(admin, '/admin/plans', { name: 'Gallery', isPublic: true })).body;
    paidVersion = (await post(admin, `/admin/plans/${plan.id}/versions`, {
        billingType: 'paid', priceMonthly: 199900, priceAnnual: 1999000, limits: { limits: { maxMembers: 10 } },
    })).body.versions[0];
    await admin.call(`/admin/plans/${plan.id}/versions/${paidVersion.id}`, { method: 'PATCH', body: { status: 'published' } });
    await admin.call(`/admin/plans/${plan.id}`, { method: 'PATCH', body: { status: 'published' } });
});

after(async () => { await h?.stop(); });

const details = {
    businessName: 'Blue Door Gallery', businessType: 'gallery', ownerName: 'Asha Rao',
    phone: '+91 98765 43210', addressLine: '12 Park Street', city: 'Kolkata', region: 'WB',
    postalCode: '700016', country: 'IN', timezone: 'Asia/Kolkata', website: 'https://bluedoor.example.com',
    expectedEmployees: 6, expectedStores: 1, requestedPlanKey: 'gallery', billingCycle: 'annual',
};

test('anyone can create an account once sign-up is open', async () => {
    applicant = h.browser(APP_ORIGIN);
    const res = await post(applicant, '/auth/sign-up/email', { name: 'Asha Rao', email: 'asha@example.com', password: PASSWORD });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await applicant.call('/apply')).body.application, null, 'no application yet');
    // A new account opens nothing: it has no organization.
    assert.deepEqual((await applicant.call('/me/orgs')).body.organizations, []);
});

test('the application saves and resumes, and refuses bad input', async () => {
    let res = await applicant.call('/apply', { method: 'PUT', body: { businessName: 'Blue Door Gallery', businessType: 'gallery' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    applicationId = res.body.application.id;
    assert.equal(res.body.application.status, 'draft');

    // A later save updates the same draft.
    res = await applicant.call('/apply', { method: 'PUT', body: { ownerName: 'Asha Rao' } });
    assert.equal(res.body.application.id, applicationId);
    assert.equal(res.body.application.businessName, 'Blue Door Gallery', 'earlier fields are kept');

    for (const bad of [{ businessType: 'spaceship' }, { country: 'India' }, { website: 'bluedoor' }, { expectedEmployees: -2 }, { phone: 'call me' }]) {
        assert.equal((await applicant.call('/apply', { method: 'PUT', body: bad })).body.code, 'invalid', JSON.stringify(bad));
    }

    // Submitting with gaps is refused and says what is missing.
    res = await post(applicant, '/apply/submit', {});
    assert.equal(res.body.code, 'incomplete');
    assert.match(res.body.error, /phone/);
});

test('submitting puts it in the queue once, however often it is clicked', async () => {
    await applicant.call('/apply', { method: 'PUT', body: details });
    const [a, b] = await Promise.all([post(applicant, '/apply/submit', {}), post(applicant, '/apply/submit', {})]);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200);
    assert.equal(a.body.application.status, 'pending_review');

    const notices = await db.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE kind = 'application_submitted'").first();
    assert.equal(notices.n, 1, 'one notice to the provider, not two');
    const queue = (await admin.call('/admin/applications?status=pending_review')).body;
    assert.deepEqual(queue.applications.map(x => x.id), [applicationId]);
    assert.equal(queue.applications[0].email, 'asha@example.com');

    // A second application while this one is open is not possible.
    const dup = await db.prepare("INSERT INTO applications (id, user_id, review_status, created_at, updated_at) SELECT 'x', user_id, 'draft', 0, 0 FROM applications WHERE id = ?").bind(applicationId).run().catch(e => e);
    assert.match(String(dup.message ?? dup), /UNIQUE/);
});

test('an applicant sees only their own application', async () => {
    other = h.browser(APP_ORIGIN);
    await post(other, '/auth/sign-up/email', { name: 'Other Person', email: 'other@example.com', password: PASSWORD });
    const res = await other.call('/apply');
    assert.equal(res.body.application, null, "Asha's application is not visible to anyone else");
    assert.equal((await h.browser(APP_ORIGIN).call('/apply')).status, 401);
    // Applicants cannot reach the review queue.
    assert.equal((await applicant.call('/admin/applications')).status, 403);
});

test('the provider can ask for more information; the applicant answers and resubmits', async () => {
    let res = await post(admin, `/admin/applications/${applicationId}/request-info`, { message: 'Please add your GST number.' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.application.status, 'needs_information');

    const mine = (await applicant.call('/apply')).body;
    assert.equal(mine.application.status, 'needs_information');
    assert.equal(mine.application.providerMessage, 'Please add your GST number.');
    assert.ok(mine.events.some(e => e.action === 'information_requested'));

    await applicant.call('/apply', { method: 'PUT', body: { taxId: '19ABCDE1234F1Z5' } });
    res = await post(applicant, '/apply/submit', {});
    assert.equal(res.body.application.status, 'pending_review');
    assert.ok(res.body.events.some(e => e.action === 'resubmitted'));
});

test('the provider can change the plan, with a reason on record', async () => {
    const res = await post(admin, `/admin/applications/${applicationId}/change-plan`, { planKey: 'gallery', reason: 'Confirmed on the phone' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.events.some(e => e.action === 'plan_changed' && /Confirmed on the phone/.test(e.message)));
});

test('approval that cannot finish provisioning fails visibly and creates nothing twice', async () => {
    // No organization-database binding: provisioning cannot complete.
    let res = await post(admin, `/admin/applications/${applicationId}/approve`, {}, { envOverride: { ORG_STORE: undefined } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.application.status, 'provisioning_failed');
    assert.match(res.body.application.provisioningError, /ORG_STORE/);

    // Retrying without fixing it: still failed, still one organization.
    res = await post(admin, `/admin/applications/${applicationId}/approve`, {}, { envOverride: { ORG_STORE: undefined } });
    assert.equal(res.body.application.status, 'provisioning_failed');
    const orgs = await db.prepare('SELECT COUNT(*) AS n FROM organizations WHERE id = ?').bind(applicationId).first();
    const members = await db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?').bind(applicationId).first();
    const subs = await db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE org_id = ?').bind(applicationId).first();
    assert.deepEqual([orgs.n, members.n, subs.n], [1, 1, 1]);

    // Applicants never see the internal error text.
    const mine = (await applicant.call('/apply')).body;
    assert.equal(mine.application.status, 'provisioning_failed');
    assert.ok(!mine.events.some(e => e.action === 'provisioning_failed'), 'internal failures are not shown to the applicant');
});

test('retrying approval once storage works finishes it: paid plans wait for payment', async () => {
    const store = fakeOrgStore();
    const res = await post(admin, `/admin/applications/${applicationId}/approve`, {}, { envOverride: { ORG_STORE: store } });
    assert.equal(res.body.application.status, 'payment_required', 'approved and provisioned, but not paid');
    assert.equal(res.body.application.orgId, applicationId);
    assert.deepEqual(store.opened, [applicationId], "the organization's own database was created");

    // Approving yet again changes nothing.
    const again = await post(admin, `/admin/applications/${applicationId}/approve`, {}, { envOverride: { ORG_STORE: store } });
    assert.equal(again.body.application.status, 'payment_required');
    assert.deepEqual(store.opened, [applicationId], 'no second provisioning');
    const notices = await db.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE kind = 'workspace_ready'").first();
    assert.equal(notices.n, 1);

    // The applicant is now the owner of exactly that organization.
    const orgs = (await applicant.call('/me/orgs')).body.organizations;
    assert.deepEqual(orgs.map(o => [o.name, o.role]), [['Blue Door Gallery', 'owner']]);
    assert.equal((await other.call('/me/orgs')).body.organizations.length, 0);
});

test('an approval with a documented billing exception activates immediately', async () => {
    await other.call('/apply', { method: 'PUT', body: { ...details, businessName: 'Second Studio', businessType: 'studio' } });
    const submitted = (await post(other, '/apply/submit', {})).body.application;
    assert.equal((await post(admin, `/admin/applications/${submitted.id}/approve`, { waivePayment: true })).body.code, 'invalid', 'an exception needs a reason');
    const res = await post(admin, `/admin/applications/${submitted.id}/approve`, { waivePayment: true, reason: 'Pilot customer, free for 3 months' }, { envOverride: { ORG_STORE: fakeOrgStore() } });
    assert.equal(res.body.application.status, 'active');
    assert.match(res.body.application.billingExceptionReason, /Pilot customer/);
});

test('rejection needs a reason, and the applicant sees it', async () => {
    const third = h.browser(APP_ORIGIN);
    await post(third, '/auth/sign-up/email', { name: 'Third', email: 'third@example.com', password: PASSWORD });
    await third.call('/apply', { method: 'PUT', body: { ...details, businessName: 'Not A Fit' } });
    const app = (await post(third, '/apply/submit', {})).body.application;
    assert.equal((await post(admin, `/admin/applications/${app.id}/reject`, {})).body.code, 'invalid');
    await post(admin, `/admin/applications/${app.id}/reject`, { reason: 'We only serve galleries and studios for now.' });
    const mine = (await third.call('/apply')).body.application;
    assert.equal(mine.status, 'rejected');
    assert.match(mine.providerMessage, /only serve/);
    assert.equal((await post(admin, `/admin/applications/${app.id}/approve`, {})).body.code, 'not_pending', 'a rejected application cannot be approved');
});

test('disabling an account ends its sessions and stops new sign-ins', async () => {
    const accounts = (await admin.call('/admin/accounts?q=other@')).body.accounts;
    const target = accounts[0];
    assert.equal(target.email, 'other@example.com');
    assert.ok(target.active_sessions >= 1);

    let res = await post(admin, `/admin/accounts/${target.id}/status`, { status: 'disabled' });
    assert.equal(res.body.code, 'invalid', 'a reason is required');
    res = await post(admin, `/admin/accounts/${target.id}/status`, { status: 'disabled', reason: 'Test' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await other.call('/apply')).status, 401, 'the live session is gone');
    const again = await post(h.browser(APP_ORIGIN), '/auth/sign-in/email', { email: 'other@example.com', password: PASSWORD });
    assert.equal(again.status, 403, 'a disabled account cannot sign in');

    await post(admin, `/admin/accounts/${target.id}/status`, { status: 'active' });
    assert.equal((await post(h.browser(APP_ORIGIN), '/auth/sign-in/email', { email: 'other@example.com', password: PASSWORD })).status, 200);
    assert.equal((await post(admin, '/admin/accounts/admin-1/status', { status: 'disabled', reason: 'x' })).body.code, 'self');
});

test('a password reset replaces the old password and signs out everywhere', async () => {
    const target = (await admin.call('/admin/accounts?q=asha@')).body.accounts[0];
    const res = await post(admin, `/admin/accounts/${target.id}/reset-password`, { temporaryPassword: 'brand-new-temp-pass' });
    assert.equal(res.status, 200);
    assert.equal((await applicant.call('/apply')).status, 401);
    assert.equal((await post(h.browser(APP_ORIGIN), '/auth/sign-in/email', { email: 'asha@example.com', password: PASSWORD })).status, 401);
    assert.equal((await post(h.browser(APP_ORIGIN), '/auth/sign-in/email', { email: 'asha@example.com', password: 'brand-new-temp-pass' })).status, 200);
    const detail = (await admin.call(`/admin/accounts/${target.id}`)).body;
    assert.ok(!JSON.stringify(detail).includes('brand-new-temp-pass'), 'no password in any response');
    assert.ok(!JSON.stringify(detail).match(/"token"/), 'no session token in any response');
});

test('only platform owners manage administrators, and the last owner stays', async () => {
    let res = await post(admin, '/admin/admins', { email: 'third@example.com', role: 'support' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.admins.some(a => a.email === 'third@example.com' && a.role === 'support'));

    // A support admin cannot add administrators.
    const support = h.browser();
    await post(support, '/auth/sign-in/email', { email: 'third@example.com', password: PASSWORD });
    assert.equal((await post(support, '/admin/admins', { email: 'asha@example.com', role: 'owner' })).body.code, 'owner_only');

    assert.equal((await admin.call('/admin/admins/admin-1', { method: 'PATCH', body: { role: 'admin' } })).body.code, 'self');
});

test('the overview and system health report state without secrets', async () => {
    const o = (await admin.call('/admin/overview')).body;
    assert.equal(o.applications.approved, 2);
    assert.equal(o.applications.rejected, 1);
    assert.ok(o.totals.users >= 4);

    const health = await admin.call('/admin/health');
    assert.equal(health.status, 200);
    assert.ok(health.body.checks.some(c => c.name === 'Two-factor for admins' && c.ok === false), 'reports 2FA is off here');
    assert.ok(health.body.migrations.length === 0 || health.body.migrations.includes('0005_applications.sql'));
    assert.ok(!health.text.includes(h.env.BETTER_AUTH_SECRET), 'the secret itself is never shown');

    const outbox = (await admin.call('/admin/notifications')).body;
    assert.ok(outbox.counts.pending >= 3, 'notices wait for an email provider');
});
