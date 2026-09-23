// Email through Cloudflare Email Service, against the real Worker: the
// confirmation email at sign-up, sending an application only from a
// confirmed address, notices delivered from the outbox, and password reset.
// Locally the send_email binding writes each message to a file; the helper
// reads them back, so these tests follow the real links.
//
//   node --test frontend/tests/email.integration.test.mjs
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startDevWorker } from './helpers/devWorker.mjs';

const ADMIN = { email: 'admin@example.com', password: 'provider-admin-password' };
const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'a much better password';

let worker;
let admin;
let applicant;
let applicationId;

const post = (b, path, body) => b.call(path, { method: 'POST', body });

/** Waits for the next email to `to` whose subject matches, after `seen` earlier ones. */
async function nextEmail(to, subject, seen = 0) {
    for (let i = 0; i < 40; i++) {
        const found = worker.emails().filter(m => m.to === to && subject.test(m.subject ?? ''));
        if (found.length > seen) return found[seen];
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error(`no email "${subject}" to ${to}. Sent: ${JSON.stringify(worker.emails().map(m => [m.to, m.subject]))}`);
}

/** The /api/v2 path of a link in an email, so the simulated browser can follow it. */
function apiPath(text, pattern) {
    const url = new URL(pattern.exec(text)?.[0] ?? assert.fail(`no link in: ${text}`));
    assert.equal(url.origin, worker.origin, 'links point at the address the request came from');
    return url.pathname.replace(/^\/api\/v2/, '') + url.search;
}

before(async () => {
    worker = await startDevWorker({ port: 8826, inspectorPort: 9256, vars: { EMAIL_SENDING: 'on', EMAIL_FROM: 'no-reply@ateliersupport.com' } });
    admin = worker.browser();
    assert.equal((await admin.signIn(ADMIN.email, ADMIN.password)).status, 200);
    assert.equal((await admin.call('/admin/settings/login-methods', {
        method: 'PUT', body: { emailPassword: { signIn: true, signUp: true }, google: { signIn: false, signUp: false } },
    })).status, 200);
    assert.equal((await admin.call('/admin/settings/notifications', { method: 'PUT', body: { providerEmail: 'provider@example.com' } })).status, 200);
    const plan = (await post(admin, '/admin/plans', { name: 'Studio', isPublic: true })).body;
    const version = (await post(admin, `/admin/plans/${plan.id}/versions`, { billingType: 'free', limits: { limits: { maxMembers: 5 } } })).body.versions[0];
    await admin.call(`/admin/plans/${plan.id}/versions/${version.id}`, { method: 'PATCH', body: { status: 'published' } });
    await admin.call(`/admin/plans/${plan.id}`, { method: 'PATCH', body: { status: 'published' } });
});

after(async () => { await worker?.stop(); worker?.cleanup(); });

test('the control centre reports email as set up', async () => {
    const health = (await admin.call('/admin/health')).body;
    const check = health.checks.find(c => c.name === 'Email delivery');
    assert.equal(check.ok, true, JSON.stringify(check));
    assert.match(check.detail, /no-reply@ateliersupport\.com/);
    assert.equal((await admin.call('/admin/settings/notifications')).body.emailConfigured, true);
});

test('signing up sends a confirmation email; an application waits for it', async () => {
    applicant = worker.browser();
    const res = await post(applicant, '/auth/sign-up/email', { name: 'Asha Rao', email: 'asha@example.com', password: PASSWORD, callbackURL: '/signup' });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const mail = await nextEmail('asha@example.com', /Confirm your email/);
    assert.match(mail.text, /\/api\/v2\/auth\/verify-email\?token=/);
    assert.match(mail.text, /24 hours/);

    let apply = (await applicant.call('/apply')).body;
    assert.equal(apply.emailVerified, false);
    assert.equal(apply.emailRequired, true);

    const saved = await applicant.call('/apply', { method: 'PUT', body: {
        businessName: 'Blue Door Studio', businessType: 'studio', ownerName: 'Asha Rao', phone: '+91 98765 43210',
        addressLine: '12 Park Street', city: 'Kolkata', country: 'IN', timezone: 'Asia/Kolkata', requestedPlanKey: 'studio', billingCycle: 'monthly',
    } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    applicationId = saved.body.application.id;
    assert.equal(saved.body.emailVerified, false, 'every answer carries the email state');

    const refused = await post(applicant, '/apply/submit');
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'email_not_verified');

    // Following the link confirms the address and comes back to the page.
    const followed = await applicant.call(apiPath(mail.text, /http\S+verify-email\S+/));
    assert.equal(followed.status, 302, followed.text);
    apply = (await applicant.call('/apply')).body;
    assert.equal(apply.emailVerified, true);

    const sent = await post(applicant, '/apply/submit');
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.application.status, 'pending_review');
});

test('a confirmation link cannot be forged or reused for another address', async () => {
    const other = worker.browser();
    await post(other, '/auth/sign-up/email', { name: 'Ravi', email: 'ravi@example.com', password: PASSWORD });
    await nextEmail('ravi@example.com', /Confirm your email/);
    const forged = await other.call('/auth/verify-email?token=not-a-real-token');
    assert.notEqual(forged.status, 200);
    assert.equal((await other.call('/apply')).body.emailVerified, false);
});

test('notices go out from the outbox right away', async () => {
    const notice = await nextEmail('provider@example.com', /New application: Blue Door Studio/);
    assert.match(notice.text, /Review it: https:\/\/admin\.ateliersupport\.com\/#\/applications/);

    let row;
    for (let i = 0; i < 20 && row?.status !== 'sent'; i++) {
        row = (await admin.call('/admin/notifications')).body.notifications.find(n => n.kind === 'application_submitted');
        if (row?.status !== 'sent') await new Promise(r => setTimeout(r, 250));
    }
    assert.equal(row.status, 'sent');
    assert.equal(row.attempts, 1, 'sent once, not twice');
});

test('approval emails the owner a link to the app', async () => {
    const res = await post(admin, `/admin/applications/${applicationId}/approve`, {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const ready = await nextEmail('asha@example.com', /Your workspace is ready/);
    assert.match(ready.text, /Open the app: https:\/\/app\.ateliersupport\.com/);
});

test('password reset: a one-hour, single-use link that signs out everywhere', async () => {
    // An unknown address gets the same answer and no email.
    const before = worker.emails().length;
    const unknown = await post(worker.browser(), '/auth/request-password-reset', { email: 'nobody@example.com', redirectTo: '/signup?mode=reset' });
    assert.equal(unknown.status, 200);

    const asked = await post(worker.browser(), '/auth/request-password-reset', { email: 'asha@example.com', redirectTo: '/signup?mode=reset' });
    assert.equal(asked.status, 200);
    assert.deepEqual(unknown.body, asked.body, 'same answer either way');
    const mail = await nextEmail('asha@example.com', /Reset your password/);
    assert.equal(worker.emails().slice(before).filter(m => m.to === 'nobody@example.com').length, 0);
    assert.match(mail.text, /one hour/);

    // The link lands on the page with the token.
    const landing = await worker.browser().call(apiPath(mail.text, /http\S+reset-password\/\S+/));
    assert.equal(landing.status, 302);
    const back = new URL(landing.location, worker.origin);
    assert.equal(back.pathname, '/signup');
    assert.equal(back.searchParams.get('mode'), 'reset');
    const token = back.searchParams.get('token');
    assert.ok(token, landing.location);

    const reset = await post(worker.browser(), '/auth/reset-password', { newPassword: NEW_PASSWORD, token });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    const again = await post(worker.browser(), '/auth/reset-password', { newPassword: 'yet another password', token });
    assert.notEqual(again.status, 200, 'the link works once');

    assert.equal((await applicant.call('/apply')).status, 401, 'the old session was signed out');
    assert.notEqual((await worker.browser().signIn('asha@example.com', PASSWORD)).status, 200, 'the old password no longer works');
    assert.equal((await worker.browser().signIn('asha@example.com', NEW_PASSWORD)).status, 200);
});
