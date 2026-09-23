// The app's payment links and per-organization Razorpay, against a real local
// Worker and a local stand-in for Razorpay's API: links use the shared account
// until the control centre points the app at an organization, then only that
// organization's own verified keys (never a fallback), and that organization's
// webhook marks the links paid.
//
//   node --test frontend/tests/appPayments.integration.test.mjs
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { startDevWorker } from './helpers/devWorker.mjs';

const SHARED_KEY = 'rzp_test_SHARED00001';
const ORG_KEY = 'rzp_test_ORGACCOUNT01';
const ORG_B_KEY = 'rzp_test_ORGBACCOUNT1';
const WEBHOOK_SECRET = 'org-a-webhook-secret';
const WEBHOOK_SECRET_B = 'org-b-webhook-secret';

let worker, razorpay, admin, appToken, orgA, orgB;
const calls = [];           // what the stand-in Razorpay received
let razorpayDown = false;   // make the stand-in reject keys

/** A local stand-in for api.razorpay.com: records which key id called it. */
function startRazorpay() {
    let n = 0;
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
            const keyId = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString().split(':')[0];
            calls.push({ method: req.method, path: req.url, keyId });
            res.setHeader('Content-Type', 'application/json');
            if (razorpayDown) { res.statusCode = 401; res.end('{"error":{"description":"bad keys"}}'); return; }
            if (req.url.startsWith('/v1/payments')) { res.end('{"items":[]}'); return; }
            if (req.url === '/v1/payment_links' && req.method === 'POST') {
                n += 1;
                res.end(JSON.stringify({ id: `plink_test_${n}`, short_url: `https://rzp.io/i/test${n}`, status: 'created' }));
                return;
            }
            res.statusCode = 404; res.end('{}');
        });
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function app(path, { method = 'GET', body } = {}) {
    const res = await fetch(`${worker.origin}/api${path}`, {
        method, headers: { Authorization: `Bearer ${appToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body && JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

const createLink = (amount = 2500) => app('/payments/link', { method: 'POST', body: { amount, customerName: 'Mrs. Mehta', customerPhone: '+919820000000' } });
const links = async () => (await app('/payments/links')).body;

async function orgWebhook(orgId, secret, event, eventId) {
    const raw = JSON.stringify(event);
    const signature = createHmac('sha256', secret).update(raw).digest('hex');
    const res = await fetch(`${worker.origin}/api/v2/webhooks/razorpay/${orgId}`, {
        method: 'POST', body: raw,
        headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signature, 'x-razorpay-event-id': eventId },
    });
    return res.status;
}

const paidEvent = (plinkId) => ({
    event: 'payment_link.paid',
    payload: {
        payment_link: { entity: { id: plinkId, amount: 250000, status: 'paid' } },
        payment: { entity: { id: `pay_${plinkId}`, method: 'upi' } },
    },
});

before(async () => {
    razorpay = await startRazorpay();
    const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
    worker = await startDevWorker({
        port: 8822, inspectorPort: 9252, seedLegacy: { sql: schema },
        vars: { RAZORPAY_API_BASE: `http://127.0.0.1:${razorpay.address().port}`, RAZORPAY_KEY_ID: SHARED_KEY, RAZORPAY_KEY_SECRET: 'shared-secret-value' },
    });
    // The app's own admin (bearer token), and the control centre's (cookies).
    await fetch(`${worker.origin}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', email: 'owner@example.com', password: 'owner-password-1234' }) });
    appToken = (await (await fetch(`${worker.origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', password: 'owner-password-1234' }) })).json()).token;
    admin = worker.browser();
    assert.equal((await admin.signIn('admin@example.com', 'provider-admin-password')).status, 200);
    for (const [name, key, secret] of [['Vayu Design', ORG_KEY, WEBHOOK_SECRET], ['Studio B', ORG_B_KEY, WEBHOOK_SECRET_B]]) {
        const org = await admin.call('/admin/orgs', { method: 'POST', body: { name, businessType: 'gallery', ownerEmail: 'admin@example.com' } });
        assert.equal(org.status, 201, org.text);
        const connected = await admin.call(`/admin/orgs/${org.body.id}/payments/razorpay`, { method: 'PUT', body: { keyId: key, keySecret: `${name}-key-secret-value`, webhookSecret: secret } });
        assert.equal(connected.status, 200, connected.text);
        if (name === 'Vayu Design') orgA = org.body; else orgB = org.body;
    }
});

after(async () => {
    await worker?.stop();
    worker?.cleanup();
    razorpay?.close();
});

const rzp = (org) => `/admin/orgs/${org.id}/payments/razorpay`;

test('with no organization chosen, links use the shared account', async () => {
    calls.length = 0;
    const res = await createLink();
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.account, 'shared');
    assert.equal(calls.at(-1).keyId, SHARED_KEY);
});

test('an organization can be chosen only once its keys are verified', async () => {
    const early = await admin.call(`${rzp(orgA)}/app`, { method: 'POST' });
    assert.equal(early.status, 409);
    assert.equal(early.body.code, 'razorpay_not_verified');
    assert.equal((await admin.call(`${rzp(orgA)}/verify`, { method: 'POST' })).body.status, 'verified');
    const chosen = await admin.call(`${rzp(orgA)}/app`, { method: 'POST' });
    assert.equal(chosen.status, 200, chosen.text);
    assert.equal(chosen.body.usedByApp, true);
    assert.equal((await admin.call(rzp(orgB))).body.usedByApp, false, 'only one organization at a time');
});

test("then links are created in that organization's own account, and its webhook marks them paid", async () => {
    calls.length = 0;
    const res = await createLink();
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.account, orgA.id);
    assert.equal(calls.at(-1).keyId, ORG_KEY, "Vayu's own key id, not the shared one");

    // Another organization's (validly signed) event for this link changes nothing.
    assert.equal(await orgWebhook(orgB.id, WEBHOOK_SECRET_B, paidEvent(res.body.id), 'evt_b_1'), 200);
    assert.equal((await links()).find(l => l.id === res.body.id).status, 'created');
    // A forged signature is refused.
    assert.equal(await orgWebhook(orgA.id, 'wrong-secret', paidEvent(res.body.id), 'evt_forged'), 401);

    assert.equal(await orgWebhook(orgA.id, WEBHOOK_SECRET, paidEvent(res.body.id), 'evt_a_1'), 200);
    const paid = (await links()).find(l => l.id === res.body.id);
    assert.equal(paid.status, 'paid');
    assert.equal(paid.paymentMethod, 'upi');
    // A retry is harmless.
    assert.equal(await orgWebhook(orgA.id, WEBHOOK_SECRET, paidEvent(res.body.id), 'evt_a_1'), 200);
    assert.equal((await links()).find(l => l.id === res.body.id).status, 'paid');
});

test('if the chosen account stops being usable, no link is made (never the shared account instead)', async () => {
    // New keys go back to "unverified".
    await admin.call(rzp(orgA), { method: 'PUT', body: { keyId: ORG_KEY, keySecret: 'replaced-key-secret-value', webhookSecret: '' } });
    calls.length = 0;
    const res = await createLink();
    assert.equal(res.status, 503);
    assert.match(res.body.error, /isn't ready/);
    assert.equal(calls.length, 0, 'Razorpay was not called with any other keys');

    // Keys Razorpay rejects stay unusable too.
    razorpayDown = true;
    assert.equal((await admin.call(`${rzp(orgA)}/verify`, { method: 'POST' })).body.status, 'failed');
    razorpayDown = false;
    assert.equal((await createLink()).status, 503);
});

test('disconnecting the chosen account puts the app back on the shared account', async () => {
    assert.equal((await admin.call(rzp(orgA), { method: 'DELETE' })).status, 200);
    const res = await createLink();
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.account, 'shared');
    const audit = await admin.call('/admin/audit');
    assert.ok(JSON.stringify(audit.body).includes('payments.app_account.set'), 'choosing the account is audited');
});
