// Changing the email an account signs in with, against the real Worker:
// yourself (a link to the current address to approve, then one to the new
// address to confirm), or a provider admin for someone who lost the old
// mailbox. Both addresses are told, the change is audited, and the app's own
// copy of the address follows. Administrators' accounts are owner-only.
//
//   node --test frontend/tests/accountEmail.integration.test.mjs
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startDevWorker } from './helpers/devWorker.mjs';

const ADMIN = { email: 'admin@example.com', password: 'provider-admin-password' };
const PASSWORD = 'correct horse battery';

let worker;
let admin;
let org;

const post = (b, path, body) => b.call(path, { method: 'POST', body });
/** Sign-in is rate limited per address: each one here comes from its own private test address. */
let nextAddress = 1;
const signIn = (b, email, password) => b.call('/auth/sign-in/email', {
    method: 'POST', body: { email, password }, headers: { 'cf-connecting-ip': ['10', '7', '0', String(nextAddress++)].join('.') },
});

/** Waits for the next email to `to` whose subject matches, after `seen` earlier ones. */
async function nextEmail(to, subject, seen = 0) {
    for (let i = 0; i < 40; i++) {
        const found = worker.emails().filter(m => m.to === to && subject.test(m.subject ?? ''));
        if (found.length > seen) return found[seen];
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error(`no email "${subject}" to ${to}. Sent: ${JSON.stringify(worker.emails().map(m => [m.to, m.subject]))}`);
}

/** The /api/v2 path of the confirmation link in an email. */
function linkPath(text) {
    const url = new URL(/https?:\/\/\S+\/api\/v2\/auth\/verify-email\?token=[^\s)"]+/.exec(text)?.[0] ?? assert.fail(`no link in: ${text}`));
    return url.pathname.replace(/^\/api\/v2/, '') + url.search;
}

const sent = (to, subject) => worker.emails().filter(m => m.to === to && subject.test(m.subject ?? '')).length;

before(async () => {
    worker = await startDevWorker({ vars: { EMAIL_SENDING: 'on', EMAIL_FROM: 'no-reply@ateliersupport.com' } });
    admin = worker.browser();
    assert.equal((await admin.signIn(ADMIN.email, ADMIN.password)).status, 200);
    assert.equal((await admin.call('/admin/settings/login-methods', {
        method: 'PUT', body: { emailPassword: { signIn: true, signUp: true }, google: { signIn: false, signUp: false } },
    })).status, 200);
    assert.equal((await post(admin, '/admin/users', { email: 'owner@example.com', name: 'Owner', temporaryPassword: PASSWORD })).status, 201);
    const created = await post(admin, '/admin/orgs', { name: 'Blue Door', businessType: 'studio', ownerEmail: 'owner@example.com' });
    assert.equal(created.status, 201, created.text);
    org = created.body;
});

after(async () => { await worker?.stop(); worker?.cleanup(); });

test('a confirmed address: approve from the old address, confirm the new one, then it is changed everywhere', async () => {
    const mira = worker.browser();
    assert.equal((await post(mira, '/auth/sign-up/email', { name: 'Mira', email: 'mira@example.com', password: PASSWORD, callbackURL: '/' })).status, 200);
    assert.equal((await mira.call(linkPath((await nextEmail('mira@example.com', /Confirm your email/)).text))).status, 302);

    const asked = await post(mira, '/auth/change-email', { newEmail: 'Mira.New@Example.com', callbackURL: '/?account=email' });
    assert.equal(asked.status, 200, asked.text);
    assert.equal(sent('mira.new@example.com', /./), 0, 'nothing goes to the new address before the old one approves');

    const approve = await nextEmail('mira@example.com', /Approve your email change/);
    assert.match(approve.text, /mira\.new@example\.com/);
    const approved = await mira.call(linkPath(approve.text));
    assert.equal(approved.status, 302);
    assert.equal((await mira.call('/auth/get-session')).body.user.email, 'mira@example.com', 'approving alone changes nothing');

    const confirm = await nextEmail('mira.new@example.com', /Confirm your new email address/);
    assert.match(confirm.text, /instead of mira@example\.com/);
    const done = await mira.call(linkPath(confirm.text));
    assert.equal(done.status, 302);
    assert.match(done.location, /\?account=email$/);

    const session = (await mira.call('/auth/get-session')).body;
    assert.equal(session.user.email, 'mira.new@example.com');
    assert.equal(session.user.emailVerified, true);

    // Both addresses hear about it; the old one can say it wasn't them.
    assert.match((await nextEmail('mira@example.com', /sign-in email was changed/)).text, /mira\.new@example\.com/);
    await nextEmail('mira.new@example.com', /sign-in email is now this address/);

    assert.equal((await signIn(worker.browser(), 'mira@example.com', PASSWORD)).status, 401);
    assert.equal((await signIn(worker.browser(), 'mira.new@example.com', PASSWORD)).status, 200, 'same password');

    const audit = (await admin.call('/admin/audit')).body.entries.find(e => e.action === 'user.email.change');
    assert.deepEqual(JSON.parse(audit.details), { from: 'mira@example.com', to: 'mira.new@example.com' });
    assert.equal(audit.actor_kind, 'user');
});

test('an unconfirmed address skips the approval: one link, to the new address', async () => {
    assert.equal((await post(admin, '/admin/users', { email: 'ravi@example.com', name: 'Ravi', temporaryPassword: PASSWORD })).status, 201);
    const ravi = worker.browser();
    assert.equal((await signIn(ravi, 'ravi@example.com', PASSWORD)).status, 200);
    assert.equal((await post(ravi, '/auth/change-email', { newEmail: 'ravi@studio.example', callbackURL: '/?account=email' })).status, 200);
    assert.equal(sent('ravi@example.com', /Approve/), 0);
    await ravi.call(linkPath((await nextEmail('ravi@studio.example', /Confirm your new email address/)).text));
    assert.equal((await ravi.call('/auth/get-session')).body.user.email, 'ravi@studio.example');
});

test('an address someone else has: the same answer, and nothing is sent (no way to probe for accounts)', async () => {
    const mira = worker.browser();
    assert.equal((await signIn(mira, 'mira.new@example.com', PASSWORD)).status, 200);
    const before = worker.emails().length;
    const res = await post(mira, '/auth/change-email', { newEmail: 'ravi@studio.example' });
    assert.equal(res.status, 200);
    await new Promise(r => setTimeout(r, 1000));
    assert.equal(worker.emails().length, before);
    assert.equal((await mira.call('/auth/get-session')).body.user.email, 'mira.new@example.com');
});

test('the app\'s copy of the address follows the account', async () => {
    // The owner opens the app, changes email, and opens it again.
    const owner = worker.browser();
    assert.equal((await signIn(owner, 'owner@example.com', PASSWORD)).status, 200);
    assert.equal((await owner.call(`/api/o/${org.id}/auth/me`)).body.email, 'owner@example.com');

    assert.equal((await post(owner, '/auth/change-email', { newEmail: 'owner@bluedoor.example' })).status, 200);
    await owner.call(linkPath((await nextEmail('owner@bluedoor.example', /Confirm your new email address/)).text));

    const me = await owner.call(`/api/o/${org.id}/auth/me`);
    assert.equal(me.status, 200, me.text);
    assert.equal(me.body.email, 'owner@bluedoor.example');
    const team = (await owner.call(`/api/o/${org.id}/auth/team`)).body;
    assert.deepEqual(team.map(u => u.email), ['owner@bluedoor.example']);
});

test('a provider admin changes someone\'s email: signed out everywhere, both addresses told, unconfirmed until used', async () => {
    const ravi = worker.browser();
    assert.equal((await signIn(ravi, 'ravi@studio.example', PASSWORD)).status, 200);
    const id = (await ravi.call('/auth/get-session')).body.user.id;

    assert.equal((await post(admin, `/admin/accounts/${id}/email`, { email: 'not an email' })).status, 400);
    assert.equal((await post(admin, `/admin/accounts/${id}/email`, { email: 'mira.new@example.com' })).body.code, 'email_taken');

    const res = await post(admin, `/admin/accounts/${id}/email`, { email: 'Ravi.K@Studio.example' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.email, 'ravi.k@studio.example');
    assert.equal((await ravi.call('/auth/get-session')).body, null, 'signed out everywhere');
    const detail = (await admin.call(`/admin/accounts/${id}`)).body.user;
    assert.equal(detail.email, 'ravi.k@studio.example');
    assert.equal(detail.email_verified, 0);
    assert.match((await nextEmail('ravi@studio.example', /sign-in email was changed/)).text, /support team/);
    await nextEmail('ravi.k@studio.example', /sign-in email is now this address/);
    assert.equal((await signIn(worker.browser(), 'ravi.k@studio.example', PASSWORD)).status, 200);

    const self = await post(admin, `/admin/accounts/${(await admin.call('/auth/get-session')).body.user.id}/email`, { email: 'me@example.com' });
    assert.equal(self.body.code, 'self', 'your own email changes from your Profile, with both links');
});

test('another administrator\'s account: only an owner can change its email, password, sign-ins or status', async () => {
    // A support admin.
    assert.equal((await post(admin, '/admin/users', { email: 'support@example.com', name: 'Support', temporaryPassword: PASSWORD })).status, 201);
    assert.equal((await post(admin, '/admin/admins', { email: 'support@example.com', role: 'support' })).status, 200);
    const support = worker.browser();
    assert.equal((await signIn(support, 'support@example.com', PASSWORD)).status, 200);
    const ownerId = (await admin.call('/auth/get-session')).body.user.id;

    for (const [path, body] of [
        ['email', { email: 'taken-over@example.com' }],
        ['reset-password', { temporaryPassword: 'a takeover password' }],
        ['revoke-sessions', {}],
        ['status', { status: 'disabled', reason: 'takeover' }],
    ]) {
        const res = await post(support, `/admin/accounts/${ownerId}/${path}`, body);
        assert.equal(res.status, 403, `${path}: ${res.text}`);
        assert.equal(res.body.code, 'owner_only');
    }
    // Ordinary accounts are still theirs to help with.
    const raviId = (await admin.call('/admin/accounts?q=ravi.k')).body.accounts[0].id;
    assert.equal((await post(support, `/admin/accounts/${raviId}/revoke-sessions`, {})).status, 200);
});
