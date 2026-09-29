// The app's payment links and per-organization Razorpay, against a real local
// Worker and a local stand-in for Razorpay's API. Every new link has explicit
// attribution: the original app (no organization) uses only the shared
// account; a workspace uses only its own organization's verified keys (never
// a fallback, never a global setting); each account's webhook touches only
// its own links. Amounts are approved on the server (invoices, overrides) and
// a retried request never makes a second link.
//
//   node --test frontend/tests/appPayments.integration.test.mjs
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { sessionTokenFrom, withSessionToken } from './helpers/session.mjs';
import { startDevWorker } from './helpers/devWorker.mjs';

const SHARED_KEY = 'rzp_test_SHARED00001';
const ORG_KEY = 'rzp_test_ORGACCOUNT01';
const ORG_B_KEY = 'rzp_test_ORGBACCOUNT1';
const WEBHOOK_SECRET = 'org-a-webhook-secret';
const WEBHOOK_SECRET_B = 'org-b-webhook-secret';

let worker, razorpay, admin, appToken, orgA, orgB;
const calls = [];           // what the stand-in Razorpay received
let razorpayDown = false;   // make the stand-in reject keys
let loseNextAnswer = false; // make the link, then answer 500 (as if the answer was lost)
const plinks = new Map();   // the stand-in's payment links: id -> entity
const rzPayments = new Map(); // the stand-in's payments: id -> entity
const rzRefunds = new Map();  // the stand-in's refunds: payment id -> [refund entity]

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
            const refundsOf = /^\/v1\/payments\/(pay_[A-Za-z0-9_]+)\/refunds$/.exec(req.url);
            if (refundsOf) { res.end(JSON.stringify({ entity: 'collection', items: rzRefunds.get(refundsOf[1]) ?? [] })); return; }
            const payment = /^\/v1\/payments\/(pay_[A-Za-z0-9_]+)$/.exec(req.url);
            if (payment) {
                const entity = rzPayments.get(payment[1]);
                if (!entity) { res.statusCode = 404; res.end('{"error":{"description":"not found"}}'); return; }
                res.end(JSON.stringify(entity));
                return;
            }
            if (req.url.startsWith('/v1/payments')) { res.end('{"items":[]}'); return; }
            if (req.url === '/v1/payment_links' && req.method === 'POST') {
                const sent = JSON.parse(body || '{}');
                calls.at(-1).body = sent;
                // Razorpay: a reference_id can be used for one link only.
                if (sent.reference_id && [...plinks.values()].some(l => l.reference_id === sent.reference_id)) {
                    res.statusCode = 400; res.end('{"error":{"description":"payment link creation with reference ID already attempted"}}'); return;
                }
                n += 1;
                const entity = { id: `plink_test_${n}`, short_url: `https://rzp.io/i/test${n}`, status: 'created', expire_by: sent.expire_by ?? 0, payments: [], reference_id: sent.reference_id, amount: sent.amount };
                plinks.set(entity.id, entity);
                if (loseNextAnswer) { loseNextAnswer = false; res.statusCode = 500; res.end('{"error":{"description":"gateway timeout"}}'); return; }
                res.end(JSON.stringify(entity));
                return;
            }
            const byRef = /^\/v1\/payment_links\?reference_id=([^&]+)$/.exec(req.url);
            if (byRef && req.method === 'GET') {
                const ref = decodeURIComponent(byRef[1]);
                res.end(JSON.stringify({ payment_links: [...plinks.values()].filter(l => l.reference_id === ref) }));
                return;
            }
            // One link: read it, cancel it, or change it (Razorpay's real API shapes).
            const one = /^\/v1\/payment_links\/(plink_[A-Za-z0-9_]+)(\/cancel)?$/.exec(req.url);
            if (one) {
                const entity = plinks.get(one[1]);
                if (!entity) { res.statusCode = 404; res.end('{"error":{"description":"not found"}}'); return; }
                if (one[2] && req.method === 'POST') {
                    if (entity.status !== 'created') { res.statusCode = 400; res.end(`{"error":{"description":"Payment link cannot be cancelled in ${entity.status} state"}}`); return; }
                    entity.status = 'cancelled';
                } else if (req.method === 'PATCH') {
                    calls.at(-1).body = JSON.parse(body || '{}');
                    entity.expire_by = calls.at(-1).body.expire_by ?? entity.expire_by;
                }
                res.end(JSON.stringify(entity));
                return;
            }
            res.statusCode = 404; res.end('{}');
        });
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function app(path, { method = 'GET', body, headers = {}, token = appToken } = {}) {
    const res = await fetch(`${worker.origin}/api${path}`, {
        method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body && JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

// Every account here has test keys, so links confirm test mode (local development allows it).
const linkBody = (amount = 2500, extra = {}) => ({ amount, customerName: 'Mrs. Mehta', customerPhone: '+919820000000', mode: 'test', ...extra });
const createLink = (amount = 2500) => app('/payments/link', { method: 'POST', body: linkBody(amount) });
/** A link from organization A's workspace (the provider admin owns both test organizations). */
const orgLink = (org, body, headers = {}) => admin.call(`/api/o/${org.id}/payments/link`, { method: 'POST', body, headers });
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
    appToken = sessionTokenFrom(await fetch(`${worker.origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', password: 'owner-password-1234' }) }));
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

test('the original app (no organization) makes links in the shared account only, recording account and mode', async () => {
    calls.length = 0;
    const res = await createLink();
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.account, 'shared');
    assert.equal(res.body.orgId, null);
    assert.equal(res.body.mode, 'test');
    assert.equal(res.body.currency, 'INR');
    assert.match(res.body.keyIdHint, /^rzp_test_…/);
    assert.equal(calls.at(-1).keyId, SHARED_KEY);
    assert.equal(calls.at(-1).body.amount, 250000, 'rupees from older clients become whole paise');
    assert.ok(calls.at(-1).body.reference_id?.length <= 40);
});

test('a test-mode account needs the test confirmed', async () => {
    calls.length = 0;
    const res = await app('/payments/link', { method: 'POST', body: { ...linkBody(), mode: undefined } });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'test_mode_confirm');
    assert.equal(calls.length, 0, 'Razorpay was not asked');
    const account = await app('/payments/account');
    assert.deepEqual({ ready: account.body.ready, mode: account.body.mode, account: account.body.account }, { ready: true, mode: 'test', account: 'shared' });
    assert.ok(!JSON.stringify(account.body).includes('shared-secret-value'), 'never the key secret');
});

test('the retired global "app account" setting cannot be chosen any more', async () => {
    assert.equal((await admin.call(`${rzp(orgA)}/verify`, { method: 'POST' })).body.status, 'verified');
    const chosen = await admin.call(`${rzp(orgA)}/app`, { method: 'POST' });
    assert.equal(chosen.status, 410);
    assert.equal(chosen.body.code, 'retired');
    // And the original app keeps using the shared account, never organization A's.
    calls.length = 0;
    assert.equal((await createLink()).body.account, 'shared');
    assert.equal(calls.at(-1).keyId, SHARED_KEY);
});

test("a workspace's links use its own verified account; only its webhook marks them paid", async () => {
    calls.length = 0;
    const res = await orgLink(orgA, linkBody());
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.account, orgA.id);
    assert.equal(res.body.orgId, orgA.id);
    assert.equal(calls.at(-1).keyId, ORG_KEY, "organization A's own key id, not the shared one");
    // Organization B isn't verified: its workspace can't make links, and doesn't borrow anyone's.
    calls.length = 0;
    const b = await orgLink(orgB, linkBody());
    assert.equal(b.status, 503);
    assert.equal(b.body.code, 'account_not_ready');
    assert.equal(calls.length, 0);

    const orgLinks = async () => (await admin.call(`/api/o/${orgA.id}/payments/links`)).body;
    // Another organization's (validly signed) event for this link changes nothing.
    assert.equal(await orgWebhook(orgB.id, WEBHOOK_SECRET_B, paidEvent(res.body.id), 'evt_b_1'), 200);
    assert.equal((await orgLinks()).find(l => l.id === res.body.id).status, 'created');
    // A forged signature is refused.
    assert.equal(await orgWebhook(orgA.id, 'wrong-secret', paidEvent(res.body.id), 'evt_forged'), 401);

    assert.equal(await orgWebhook(orgA.id, WEBHOOK_SECRET, paidEvent(res.body.id), 'evt_a_1'), 200);
    const paid = (await orgLinks()).find(l => l.id === res.body.id);
    assert.equal(paid.status, 'paid');
    assert.equal(paid.paymentMethod, 'upi');
    // A retry is harmless, and a late "expired" doesn't un-pay it.
    assert.equal(await orgWebhook(orgA.id, WEBHOOK_SECRET, paidEvent(res.body.id), 'evt_a_1'), 200);
    assert.equal(await orgWebhook(orgA.id, WEBHOOK_SECRET, { event: 'payment_link.expired', payload: { payment_link: { entity: { id: res.body.id } } } }, 'evt_a_2'), 200);
    assert.equal((await orgLinks()).find(l => l.id === res.body.id).status, 'paid');
});

test("an organization's webhook never touches the original app's links", async () => {
    const shared = (await createLink()).body;
    assert.equal(await orgWebhook(orgA.id, WEBHOOK_SECRET, paidEvent(shared.id), 'evt_a_shared'), 200);
    assert.equal((await links()).find(l => l.id === shared.id).status, 'created');
});

test('if the workspace account stops being usable, no link is made (never the shared account instead)', async () => {
    // New keys go back to "unverified".
    await admin.call(rzp(orgA), { method: 'PUT', body: { keyId: ORG_KEY, keySecret: 'replaced-key-secret-value', webhookSecret: '' } });
    calls.length = 0;
    const res = await orgLink(orgA, linkBody());
    assert.equal(res.status, 503);
    assert.equal(calls.length, 0, 'Razorpay was not called with any other keys');
    razorpayDown = true;
    assert.equal((await admin.call(`${rzp(orgA)}/verify`, { method: 'POST' })).body.status, 'failed');
    razorpayDown = false;
    assert.equal((await orgLink(orgA, linkBody())).status, 503);
    assert.equal((await admin.call(`${rzp(orgA)}/verify`, { method: 'POST' })).body.status, 'verified');
});

// ── Amounts and duplicates ──────────────────────────────────────────────────

test('the same request key makes one link, however often it is sent', async () => {
    calls.length = 0;
    const headers = { 'Idempotency-Key': 'double-tap-key-0001' };
    const first = await app('/payments/link', { method: 'POST', body: linkBody(1500), headers });
    const second = await app('/payments/link', { method: 'POST', body: linkBody(1500), headers });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(second.status, 200);
    assert.equal(second.body.id, first.body.id);
    assert.equal(second.body.replayed, true);
    assert.equal(calls.filter(c => c.method === 'POST' && c.path === '/v1/payment_links').length, 1);
    // The same key for a different request is refused.
    const other = await app('/payments/link', { method: 'POST', body: linkBody(1600), headers });
    assert.equal(other.status, 422);
    assert.equal(other.body.code, 'idempotency_key_reused');
});

test('a lost answer from Razorpay: the retry finds the link it made instead of making another', async () => {
    const headers = { 'Idempotency-Key': 'lost-answer-key-0001' };
    loseNextAnswer = true;
    const res = await app('/payments/link', { method: 'POST', body: linkBody(1750), headers });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const made = [...plinks.values()].filter(l => l.amount === 175000);
    assert.equal(made.length, 1, 'exactly one link at Razorpay');
    assert.equal(res.body.id, made[0].id);
});

test('amounts are checked on the server: bad, tiny and tampered amounts are refused', async () => {
    for (const [body, code] of [
        [{ ...linkBody(), amount: 10.001 }, 'invalid_amount'],
        [{ ...linkBody(), amount: undefined, amountPaise: 99 }, 'amount_too_small'],
        [{ ...linkBody(), amount: undefined, amountPaise: -500 }, 'amount_too_small'],
        [{ ...linkBody(), amount: undefined, amountPaise: 12.5 }, 'invalid_amount'],
        [{ ...linkBody(), currency: 'USD' }, 'unsupported_currency'],
    ]) {
        const res = await app('/payments/link', { method: 'POST', body });
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.equal(res.body.code, code);
    }
});

test('against an invoice: the server works out what is outstanding, and overrides need a reason', async () => {
    const invoice = { id: 'inv-test-1', invoiceNumber: 'PI-001', customerName: 'Mrs. Mehta', customerEmail: '', items: [{ artworkId: 'a1', title: 'Study', price: 10000 }], subtotal: 10000, taxRate: 18, total: 11800, date: Date.now(), status: 'Sent' };
    assert.ok([200, 201].includes((await app(`/invoices/${invoice.id}`, { method: 'PUT', body: invoice })).status));
    // Blank amount: what's outstanding (₹11,800).
    const full = await app('/payments/link', { method: 'POST', body: { ...linkBody(), amount: undefined, invoiceId: invoice.id } });
    assert.equal(full.status, 201, JSON.stringify(full.body));
    assert.equal(full.body.amount, 1_180_000);
    assert.equal(full.body.approved.invoiceTotalPaise, 1_180_000);
    // That open link counts: nothing more is outstanding.
    const more = await app('/payments/link', { method: 'POST', body: { ...linkBody(), amount: undefined, invoiceId: invoice.id } });
    assert.equal(more.status, 409);
    assert.equal(more.body.code, 'nothing_outstanding');
    // Asking for more than is outstanding is an override: a reason is required and kept.
    const noReason = await app('/payments/link', { method: 'POST', body: linkBody(500, { invoiceId: invoice.id }) });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.code, 'override_reason_required');
    const withReason = await app('/payments/link', { method: 'POST', body: linkBody(500, { invoiceId: invoice.id, overrideReason: 'Framing added after the invoice' }) });
    assert.equal(withReason.status, 201, JSON.stringify(withReason.body));
    assert.deepEqual(withReason.body.approved.override, { kind: 'above_outstanding', reason: 'Framing added after the invoice' });
    assert.equal(withReason.body.approved.approvedByName, 'Owner');
    // Another business's invoice isn't there: organization A's workspace can't collect against it.
    const cross = await orgLink(orgA, { ...linkBody(), amount: undefined, invoiceId: invoice.id });
    assert.equal(cross.status, 404);
    assert.equal(cross.body.code, 'invoice_not_found');
});

test('staff can make routine links but not overrides', async () => {
    const invoice = { id: 'inv-test-2', invoiceNumber: 'PI-002', customerName: 'Mr. Rao', customerEmail: '', items: [{ artworkId: 'a2', title: 'Print', price: 2000 }], subtotal: 2000, taxRate: 0, total: 2000, date: Date.now(), status: 'Sent' };
    assert.ok([200, 201].includes((await app(`/invoices/${invoice.id}`, { method: 'PUT', body: invoice })).status));
    // Staff (the built-in role) can make payment links but aren't admins.
    const made = await app('/auth/users', { method: 'POST', body: { name: 'Staff One', email: 'staff1@example.com', password: 'staff-password-123' } });
    assert.ok([200, 201].includes(made.status), JSON.stringify(made.body));
    const staffToken = sessionTokenFrom(await fetch(`${worker.origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'staff1@example.com', password: 'staff-password-123' }) }));
    const routine = await app('/payments/link', { method: 'POST', token: staffToken, body: linkBody(1000, { invoiceId: invoice.id }) });
    assert.equal(routine.status, 201, JSON.stringify(routine.body));
    const discount = await app('/payments/link', { method: 'POST', token: staffToken, body: linkBody(500, { invoiceId: invoice.id, settlesInFull: true, overrideReason: 'Staff trying a discount' }) });
    assert.equal(discount.status, 403);
    assert.equal(discount.body.code, 'override_forbidden');
});

// ── Delete and validity ────────────────────────────────────────────────────

const DAY = 86_400_000;
const payAt = (id, entity) => Object.assign(plinks.get(id), entity);

test('a new link can be given a validity, sent to Razorpay as expire_by', async () => {
    calls.length = 0;
    const expiresAt = Date.now() + 3 * DAY;
    const res = await app('/payments/link', { method: 'POST', body: { amount: 1200, customerName: 'Mr. Rao', mode: 'test', expiresAt } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(calls.at(-1).body.expire_by, Math.floor(expiresAt / 1000));
    assert.equal(Math.floor(res.body.expiresAt / 1000), Math.floor(expiresAt / 1000));
    // Too soon, or longer than six months, is refused before Razorpay is called.
    calls.length = 0;
    assert.equal((await app('/payments/link', { method: 'POST', body: { amount: 1200, customerName: 'Mr. Rao', mode: 'test', expiresAt: Date.now() + 5 * 60_000 } })).status, 400);
    assert.equal((await app('/payments/link', { method: 'POST', body: { amount: 1200, customerName: 'Mr. Rao', mode: 'test', expiresAt: Date.now() + 200 * DAY } })).status, 400);
    assert.equal(calls.length, 0);
});

test("an unpaid link's validity can be changed, within Razorpay's limits", async () => {
    const link = (await createLink()).body;
    const until = Date.now() + 10 * DAY;
    calls.length = 0;
    const res = await app(`/payments/links/${link.id}`, { method: 'PATCH', body: { expiresAt: until } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(calls.at(-1).method, 'PATCH');
    assert.equal(calls.at(-1).body.expire_by, Math.floor(until / 1000));
    assert.equal(calls.at(-1).keyId, SHARED_KEY, "the link's own account");
    assert.equal(Math.floor((await links()).find(l => l.id === link.id).expiresAt / 1000), Math.floor(until / 1000));
    assert.equal((await app(`/payments/links/${link.id}`, { method: 'PATCH', body: { expiresAt: Date.now() + 60_000 } })).status, 400);
});

test('deleting an unpaid link cancels it at Razorpay first, then removes it', async () => {
    const link = (await createLink()).body;
    calls.length = 0;
    const res = await app(`/payments/links/${link.id}`, { method: 'DELETE' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(calls.some(c => c.method === 'POST' && c.path === `/v1/payment_links/${link.id}/cancel` && c.keyId === SHARED_KEY));
    assert.equal(plinks.get(link.id).status, 'cancelled', 'the customer can no longer pay it');
    assert.equal((await links()).some(l => l.id === link.id), false);
    assert.equal((await app(`/payments/links/${link.id}`, { method: 'DELETE' })).status, 404);
});

test('a link paid just before it was deleted is kept, and shows as paid', async () => {
    const link = (await createLink()).body;
    payAt(link.id, { status: 'paid', payments: [{ payment_id: 'pay_late', method: 'card', status: 'captured', created_at: Math.floor(Date.now() / 1000) }] });
    const res = await app(`/payments/links/${link.id}`, { method: 'DELETE' });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    const kept = (await links()).find(l => l.id === link.id);
    assert.equal(kept?.status, 'paid');
    assert.equal(kept.paymentId, 'pay_late');
    // A paid link can then be removed from the list; Razorpay isn't asked to cancel it.
    calls.length = 0;
    assert.equal((await app(`/payments/links/${link.id}`, { method: 'DELETE' })).status, 200);
    assert.equal(calls.filter(c => c.path.endsWith('/cancel')).length, 0);
    assert.equal((await links()).some(l => l.id === link.id), false);
});

test('without a webhook, the app picks up a payment by asking Razorpay (refresh), and the list itself changes nothing', async () => {
    const link = (await createLink()).body;
    // Paid at Razorpay; no webhook arrives (the shared account has none set).
    payAt(link.id, { status: 'paid', payments: [{ payment_id: 'pay_quiet', method: 'upi', status: 'captured', created_at: Math.floor(Date.now() / 1000) }] });
    calls.length = 0;
    await links();
    assert.equal(calls.length, 0, 'reading the list never calls Razorpay or changes a record');
    assert.equal((await links()).find(l => l.id === link.id).status, 'created');
    const refreshed = await app('/payments/links/refresh', { method: 'POST' });
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    const seen = (await links()).find(l => l.id === link.id);
    assert.equal(seen?.status, 'paid');
    assert.equal(seen.paymentId, 'pay_quiet');
    assert.equal(seen.paymentMethod, 'upi');
});

test('a link past its expiry shows as expired', async () => {
    const link = (await createLink()).body;
    payAt(link.id, { status: 'expired' });
    // A fresh link is due for a check at once.
    await app('/payments/links/refresh', { method: 'POST' });
    assert.equal((await links()).find(l => l.id === link.id)?.status, 'expired');
});

test('payment details: references, time, method and what the customer entered, fetched from Razorpay', async () => {
    const link = (await createLink()).body;
    const paidAtSec = Math.floor(Date.now() / 1000) - 600;
    rzPayments.set('pay_rich01', {
        id: 'pay_rich01', entity: 'payment', amount: 250000, currency: 'INR', status: 'captured', method: 'upi',
        vpa: 'mehta@okhdfc', email: 'mehta@example.com', contact: '+919820000000', created_at: paidAtSec,
        fee: 5900, tax: 900, acquirer_data: { rrn: '425612345678', upi_transaction_id: 'HDFC00012345' },
    });
    // A failed attempt first, then the successful one.
    rzPayments.set('pay_fail01', { id: 'pay_fail01', amount: 250000, currency: 'INR', status: 'failed', method: 'card', created_at: paidAtSec - 300, card: { network: 'Visa', last4: '4242', type: 'credit', name: 'R Mehta' }, error_description: 'Payment was declined by the bank.' });
    payAt(link.id, { status: 'paid', payments: [{ payment_id: 'pay_fail01', status: 'failed' }, { payment_id: 'pay_rich01', status: 'captured' }] });

    // Opening the details only shows Razorpay's view; "Recheck" (POST) records it.
    const peek = await app(`/payments/links/${link.id}/details`);
    assert.equal(peek.body.link.status, 'paid');
    assert.equal((await links()).find(l => l.id === link.id).status, 'created', 'a GET changes nothing');
    const res = await app(`/payments/links/${link.id}/recheck`, { method: 'POST' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.checked, true);
    assert.equal(res.body.link.status, 'paid', 'recheck confirms the payment');
    const ok = res.body.link.payments.find(p => p.id === 'pay_rich01');
    assert.equal(ok.vpa, 'mehta@okhdfc');
    assert.equal(ok.email, 'mehta@example.com');
    assert.equal(ok.contact, '+919820000000');
    assert.equal(ok.rrn, '425612345678');
    assert.equal(ok.upiTransactionId, 'HDFC00012345');
    assert.equal(ok.fee, 5900);
    assert.equal(ok.createdAt, paidAtSec * 1000);
    const failed = res.body.link.payments.find(p => p.id === 'pay_fail01');
    assert.equal(failed.card.last4, '4242');
    assert.match(failed.errorDescription, /declined/);
    // Kept on the record: the time and transaction are the real ones.
    const listed = (await links()).find(l => l.id === link.id);
    assert.equal(listed.paymentId, 'pay_rich01');
    assert.equal(listed.paidAt, paidAtSec * 1000);
    assert.equal(listed.paymentMethod, 'upi');
    assert.equal(listed.payments.length, 2);
    assert.equal((await app('/payments/links/plink_nosuch01/details')).status, 404);
});

// ── Refunds, totals and reconciliation ───────────────────────────────────────

const ORG_B_LIVE_KEY = 'rzp_live_ORGBACCOUNT1';
const refundEvent = (type, refundId, paymentId, amount, status) => ({
    event: type,
    payload: {
        refund: { entity: { id: refundId, entity: 'refund', amount, currency: 'INR', payment_id: paymentId, status, created_at: Math.floor(Date.now() / 1000) } },
        payment: { entity: { id: paymentId, amount_refunded: amount, refund_status: 'partial' } },
    },
});
const orgBLinks = async () => (await admin.call(`/api/o/${orgB.id}/payments/links`)).body;
let liveLink;

test('refunds: pending, processed, duplicates, out of order, several partial ones, and failed ones', async () => {
    // Organization B switches to LIVE keys, so its figures count.
    await admin.call(rzp(orgB), { method: 'PUT', body: { keyId: ORG_B_LIVE_KEY, keySecret: 'studio-b-live-key-secret', webhookSecret: '' } });
    assert.equal((await admin.call(`${rzp(orgB)}/verify`, { method: 'POST' })).body.status, 'verified');
    const made = await orgLink(orgB, { amount: 2500, customerName: 'Mrs. Iyer' });
    assert.equal(made.status, 201, made.text);
    assert.equal(made.body.mode, 'live');
    liveLink = made.body;
    const pay = `pay_${liveLink.id}`;
    assert.equal(await orgWebhook(orgB.id, WEBHOOK_SECRET_B, paidEvent(liveLink.id), 'evt_b_paid'), 200);

    const refundState = async () => { const l = (await orgBLinks()).find(x => x.id === liveLink.id); return [l.refundedPaise ?? 0, l.refundPendingPaise ?? 0]; };
    // refund.created is not a completed refund.
    assert.equal(await orgWebhook(orgB.id, WEBHOOK_SECRET_B, refundEvent('refund.created', 'rfnd_one00001', pay, 50000, 'pending'), 'evt_r1'), 200);
    assert.deepEqual(await refundState(), [0, 50000]);
    assert.equal(await orgWebhook(orgB.id, WEBHOOK_SECRET_B, refundEvent('refund.processed', 'rfnd_one00001', pay, 50000, 'processed'), 'evt_r2'), 200);
    assert.deepEqual(await refundState(), [50000, 0]);
    // The same event again, and a late refund.created: nothing moves backwards or doubles.
    assert.equal(await orgWebhook(orgB.id, WEBHOOK_SECRET_B, refundEvent('refund.processed', 'rfnd_one00001', pay, 50000, 'processed'), 'evt_r2'), 200);
    assert.equal(await orgWebhook(orgB.id, WEBHOOK_SECRET_B, refundEvent('refund.created', 'rfnd_one00001', pay, 50000, 'pending'), 'evt_r1_late'), 200);
    assert.deepEqual(await refundState(), [50000, 0]);
    // A second partial refund, and one that failed.
    assert.equal(await orgWebhook(orgB.id, WEBHOOK_SECRET_B, refundEvent('refund.processed', 'rfnd_two00002', pay, 30000, 'processed'), 'evt_r3'), 200);
    assert.equal(await orgWebhook(orgB.id, WEBHOOK_SECRET_B, refundEvent('refund.failed', 'rfnd_three003', pay, 20000, 'failed'), 'evt_r4'), 200);
    assert.deepEqual(await refundState(), [80000, 0]);
    // Another organization's (validly signed) refund event for this payment changes nothing.
    assert.equal(await orgWebhook(orgA.id, WEBHOOK_SECRET, refundEvent('refund.processed', 'rfnd_four0004', pay, 90000, 'processed'), 'evt_a_r'), 200);
    assert.deepEqual(await refundState(), [80000, 0]);
});

test('totals: collected, refunded and net for live links only; test links are left out', async () => {
    const summary = await admin.call(`/api/o/${orgB.id}/payments/summary`);
    assert.equal(summary.status, 200, summary.text);
    assert.deepEqual(summary.body.live, { paidCount: 1, collectedPaise: 250000, refundedPaise: 80000, pendingRefundPaise: 0, netPaise: 170000 });
    // Organization A's links are all test mode: none of its money counts.
    const a = await admin.call(`/api/o/${orgA.id}/payments/summary`);
    assert.equal(a.body.live.collectedPaise, 0);
    assert.ok(a.body.excluded.testLinks >= 1);
});

test('a refund no webhook delivered is found by reconciliation', async () => {
    const pay = `pay_${liveLink.id}`;
    rzRefunds.set(pay, [
        { id: 'rfnd_one00001', amount: 50000, currency: 'INR', payment_id: pay, status: 'processed', created_at: 1 },
        { id: 'rfnd_quiet005', amount: 10000, currency: 'INR', payment_id: pay, status: 'processed', created_at: 2 },
    ]);
    const refreshed = await admin.call(`/api/o/${orgB.id}/payments/links/refresh`, { method: 'POST' });
    assert.equal(refreshed.status, 200, refreshed.text);
    const l = (await orgBLinks()).find(x => x.id === liveLink.id);
    assert.equal(l.refundedPaise, 90000);
    assert.equal((await admin.call(`/api/o/${orgB.id}/payments/summary`)).body.live.netPaise, 160000);
});

test('the scheduled job picks up a payment with nobody on the Payments screen', async () => {
    const link = (await createLink(900)).body;
    payAt(link.id, { status: 'paid', payments: [{ payment_id: 'pay_cron0001', method: 'card', status: 'captured', created_at: Math.floor(Date.now() / 1000) }] });
    const res = await fetch(`${worker.origin}/__scheduled?cron=*/10+*+*+*+*`);
    assert.equal(res.status, 200);
    let seen;
    for (let i = 0; i < 20 && seen?.status !== 'paid'; i++) {
        await new Promise(r => setTimeout(r, 250));
        seen = (await links()).find(l => l.id === link.id);
    }
    assert.equal(seen?.status, 'paid');
    assert.equal(seen.paymentId, 'pay_cron0001');
});

test("webhook health: a refund the webhook missed needs attention, until verified deliveries arrive again", async () => {
    let b = (await admin.call(rzp(orgB))).body;
    // Reconciliation just found a refund (rfnd_quiet005) no webhook delivered.
    assert.equal(b.webhookHealth.state, 'attention');
    assert.ok(b.webhookHealth.missedByWebhook >= 1);
    assert.ok(b.webhookHealth.verifiedCount >= 5);
    // Forged deliveries don't change the verdict either way.
    assert.equal(await orgWebhook(orgB.id, 'forged-secret', paidEvent(liveLink.id), 'evt_forged_b'), 401);
    assert.equal((await admin.call(rzp(orgB))).body.webhookHealth.rejected24h, 1);
    // A verified delivery arrives again: healthy.
    assert.equal(await orgWebhook(orgB.id, WEBHOOK_SECRET_B, refundEvent('refund.processed', 'rfnd_quiet005', `pay_${liveLink.id}`, 10000, 'processed'), 'evt_r5'), 200);
    b = (await admin.call(rzp(orgB))).body;
    assert.equal(b.webhookHealth.state, 'healthy');
    assert.equal((await orgBLinks()).find(x => x.id === liveLink.id).refundedPaise, 90000, 'the late webhook for an already-found refund adds nothing');
});
