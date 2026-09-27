// Plan payments: an organization's owner picks a plan in the app and pays in
// Razorpay's checkout, into the platform's own Razorpay account (connected in
// the control centre). Against the real Worker and a local stand-in for
// Razorpay's Orders API. What matters most: the plan changes only once
// Razorpay agrees it was paid, and exactly once however many confirmations
// arrive; a lapsed workspace can still reach the screen to pay.
//
//   node --test frontend/tests/billing.integration.test.mjs
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { startDevWorker } from './helpers/devWorker.mjs';

const KEY_ID = 'rzp_test_PLATFORMBILL1';
const KEY_SECRET = 'platform-billing-key-secret';
const WEBHOOK_SECRET = 'platform-billing-webhook';
const USER_PASSWORD = 'member password 123';

let worker, razorpay, admin, owner, staff, org, studioPlan;
const orders = new Map();    // the stand-in's orders: id -> { entity, payments: [] }
let orderSeq = 0;
let paySeq = 0;

function startRazorpay() {
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
            res.setHeader('Content-Type', 'application/json');
            const keyId = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString().split(':')[0];
            if (keyId !== KEY_ID) { res.statusCode = 401; res.end('{"error":{"description":"bad keys"}}'); return; }
            const url = new URL(req.url, 'http://x');
            if (url.pathname === '/v1/orders' && req.method === 'GET') { res.end('{"items":[]}'); return; }
            if (url.pathname === '/v1/orders' && req.method === 'POST') {
                const sent = JSON.parse(body || '{}');
                const entity = { id: `order_T${++orderSeq}abcdef`, amount: sent.amount, currency: sent.currency, receipt: sent.receipt, notes: sent.notes, status: 'created' };
                orders.set(entity.id, { entity, payments: [] });
                res.end(JSON.stringify(entity));
                return;
            }
            const one = /^\/v1\/orders\/(order_[A-Za-z0-9]+)(\/payments)?$/.exec(url.pathname);
            if (one) {
                const o = orders.get(one[1]);
                if (!o) { res.statusCode = 404; res.end('{}'); return; }
                res.end(JSON.stringify(one[2] ? { items: o.payments } : o.entity));
                return;
            }
            const capture = /^\/v1\/payments\/(pay_[A-Za-z0-9]+)\/capture$/.exec(url.pathname);
            if (capture && req.method === 'POST') {
                for (const o of orders.values()) {
                    const p = o.payments.find(x => x.id === capture[1]);
                    if (p) { p.status = 'captured'; o.entity.status = 'paid'; res.end(JSON.stringify(p)); return; }
                }
            }
            res.statusCode = 404; res.end('{}');
        });
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** The customer pays in the stand-in: a UPI payment on the order, captured or only authorised. */
function pay(orderId, { status = 'captured', amount } = {}) {
    const o = orders.get(orderId);
    const payment = {
        id: `pay_T${++paySeq}xyz`, order_id: orderId, amount: amount ?? o.entity.amount, currency: 'INR', status, method: 'upi',
        vpa: 'owner@okbank', email: 'owner@example.com', contact: '+919800000000', fee: 2360, tax: 360,
        created_at: Math.floor(Date.now() / 1000), acquirer_data: { rrn: '123456789012', upi_transaction_id: 'UPI0001' },
    };
    o.payments.push(payment);
    if (status === 'captured') o.entity.status = 'paid';
    else o.entity.status = 'attempted';
    return payment;
}

const sign = (secret, text) => createHmac('sha256', secret).update(text).digest('hex');
const app = (path) => `/api/o/${org.id}${path}`;
const post = (b, path, body = {}) => b.call(path, { method: 'POST', body });

async function webhook(event, eventId) {
    const raw = JSON.stringify(event);
    const res = await fetch(`${worker.origin}/api/v2/webhooks/billing/razorpay`, {
        method: 'POST', body: raw,
        headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sign(WEBHOOK_SECRET, raw), 'x-razorpay-event-id': eventId },
    });
    return res.status;
}

async function publishPlan(name, version) {
    const plan = await post(admin, '/admin/plans', { name, isPublic: true });
    assert.equal(plan.status, 201, plan.text);
    const v = await post(admin, `/admin/plans/${plan.body.id}/versions`, { currency: 'INR', limits: {}, ...version });
    assert.equal(v.status, 201, v.text);
    const draft = v.body.versions.find(x => x.status === 'draft');
    assert.equal((await admin.call(`/admin/plans/${plan.body.id}/versions/${draft.id}`, { method: 'PATCH', body: { status: 'published' } })).status, 200);
    assert.equal((await admin.call(`/admin/plans/${plan.body.id}`, { method: 'PATCH', body: { status: 'published' } })).status, 200);
    return { ...plan.body, versionId: draft.id };
}

before(async () => {
    razorpay = await startRazorpay();
    worker = await startDevWorker({ port: 8834, inspectorPort: 9264, vars: { RAZORPAY_API_BASE: `http://127.0.0.1:${razorpay.address().port}` } });
    admin = worker.browser();
    assert.equal((await admin.signIn('admin@example.com', 'provider-admin-password')).status, 200);
    for (const [email, name] of [['owner@example.com', 'Owner'], ['staff@example.com', 'Staff']]) {
        assert.equal((await post(admin, '/admin/users', { email, name, temporaryPassword: USER_PASSWORD })).status, 201);
    }
    org = (await post(admin, '/admin/orgs', { name: 'Paying Studio', businessType: 'studio', ownerEmail: 'owner@example.com' })).body;
    assert.equal((await post(admin, `/admin/orgs/${org.id}/members`, { email: 'staff@example.com', role: 'staff' })).status, 201);
    studioPlan = await publishPlan('Studio', { billingType: 'paid', priceMonthly: 99900, priceAnnual: 999000, limits: { maxMembers: 10 } });
    await publishPlan('Free', { billingType: 'free' });
    owner = worker.browser(); staff = worker.browser();
    assert.equal((await owner.signIn('owner@example.com', USER_PASSWORD)).status, 200);
    assert.equal((await staff.signIn('staff@example.com', USER_PASSWORD)).status, 200);
});

after(async () => { await worker?.stop(); worker?.cleanup(); razorpay?.close(); });

test('before the platform connects Razorpay, the plans show but paying is refused', async () => {
    const res = await owner.call(app('/billing'));
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.payable, false);
    assert.deepEqual(res.body.plans.map(p => p.key), ['studio'], 'only paid public plans are offered');
    const checkout = await post(owner, app('/billing/checkout'), { planKey: 'studio', period: 'monthly' });
    assert.equal(checkout.status, 503);
    assert.equal(checkout.body.code, 'billing_unavailable');
});

test('the control centre connects and verifies the platform account; secrets never come back', async () => {
    let res = await admin.call('/admin/billing/razorpay', { method: 'PUT', body: { keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET } });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.status, 'unverified');
    assert.ok(!res.text.includes(KEY_SECRET) && !res.text.includes(WEBHOOK_SECRET));
    assert.match(res.body.webhookUrl, /\/api\/v2\/webhooks\/billing\/razorpay$/);
    res = await post(admin, '/admin/billing/razorpay/verify');
    assert.equal(res.body.status, 'verified', res.text);
    assert.equal((await owner.call(app('/billing'))).body.payable, true);
    // Only provider admins reach it.
    assert.equal((await owner.call('/admin/billing/razorpay')).status, 403);
});

test('staff cannot see or pay for the plan', async () => {
    assert.equal((await staff.call(app('/billing'))).status, 403);
    assert.equal((await post(staff, app('/billing/checkout'), { planKey: 'studio', period: 'monthly' })).status, 403);
});

let first;

test('an owner pays for a month: the plan changes only after Razorpay confirms, and only once', async () => {
    const checkout = await post(owner, app('/billing/checkout'), { planKey: 'studio', period: 'monthly' });
    assert.equal(checkout.status, 201, checkout.text);
    assert.equal(checkout.body.amount, 99900);
    assert.equal(checkout.body.keyId, KEY_ID);
    assert.equal(orders.get(checkout.body.orderId).entity.notes.org_id, org.id);
    // Opening the checkout again reuses the same order.
    assert.equal((await post(owner, app('/billing/checkout'), { planKey: 'studio', period: 'monthly' })).body.orderId, checkout.body.orderId);
    first = checkout.body;

    const payment = pay(first.orderId);
    const result = { id: first.id, razorpay_order_id: first.orderId, razorpay_payment_id: payment.id };
    // A forged signature changes nothing.
    const forged = await post(owner, app('/billing/confirm'), { ...result, razorpay_signature: sign('wrong-secret', `${first.orderId}|${payment.id}`) });
    assert.equal(forged.status, 400);
    assert.equal(forged.body.code, 'signature_invalid');
    assert.equal((await owner.call(app('/plan'))).body.plan, null);

    const confirmed = await post(owner, app('/billing/confirm'), { ...result, razorpay_signature: sign(KEY_SECRET, `${first.orderId}|${payment.id}`) });
    assert.equal(confirmed.status, 200, confirmed.text);
    assert.equal(confirmed.body.applied, true);
    assert.equal(confirmed.body.payment.status, 'paid');
    assert.equal(confirmed.body.payment.paymentId, payment.id);
    assert.equal(confirmed.body.payment.payments[0].vpa, 'owner@okbank');
    assert.equal(confirmed.body.payment.payments[0].rrn, '123456789012');
    assert.equal(confirmed.body.payment.payments[0].fee, undefined, "the organization doesn't see Razorpay's fee");

    const plan = (await owner.call(app('/plan'))).body;
    assert.equal(plan.plan.key, 'studio');
    assert.equal(plan.subscription.status, 'active');
    const days = (plan.subscription.currentPeriodEnd - Date.now()) / 86_400_000;
    assert.ok(days > 27 && days < 32, `a month ahead, got ${days}`);

    // The webhook and a recheck arriving afterwards change nothing more.
    assert.equal(await webhook({ event: 'order.paid', payload: { order: { entity: { id: first.orderId } } } }, 'evt_1'), 200);
    assert.equal(await webhook({ event: 'order.paid', payload: { order: { entity: { id: first.orderId } } } }, 'evt_1'), 200, 'a replay is accepted and ignored');
    const again = await post(owner, app(`/billing/payments/${first.id}/recheck`));
    assert.equal(again.body.applied, false);
    assert.equal((await owner.call(app('/plan'))).body.subscription.currentPeriodEnd, plan.subscription.currentPeriodEnd);
    const audit = await admin.call('/admin/audit?limit=200');
    assert.equal(audit.body.entries.filter(e => e.action === 'billing.payment.applied').length, 1);
});

test('paying for the same plan again adds the period on to the end of the current one (webhook only)', async () => {
    const before = (await owner.call(app('/plan'))).body.subscription.currentPeriodEnd;
    const checkout = (await post(owner, app('/billing/checkout'), { planKey: 'studio', period: 'annual' })).body;
    assert.equal(checkout.amount, 999000);
    pay(checkout.orderId);
    // The browser closed before confirming: the webhook finishes it.
    assert.equal(await webhook({ event: 'payment.captured', payload: { payment: { entity: { order_id: checkout.orderId } } } }, 'evt_2'), 200);
    const after = (await owner.call(app('/plan'))).body.subscription.currentPeriodEnd;
    const added = (after - before) / 86_400_000;
    assert.ok(added >= 365 && added <= 366, `a year on from the old end, got ${added}`);
});

test('a bad webhook signature is refused', async () => {
    const raw = JSON.stringify({ event: 'order.paid' });
    const res = await fetch(`${worker.origin}/api/v2/webhooks/billing/razorpay`, {
        method: 'POST', body: raw, headers: { 'x-razorpay-signature': sign('nope', raw), 'x-razorpay-event-id': 'evt_x' },
    });
    assert.equal(res.status, 401);
});

test('a failed attempt shows as not paid; an authorised payment is captured on recheck', async () => {
    const checkout = (await post(owner, app('/billing/checkout'), { planKey: 'studio', period: 'monthly' })).body;
    const failed = pay(checkout.orderId, { status: 'failed' });
    orders.get(checkout.orderId).payments[0].error_description = 'Payment was declined by the bank';
    let res = await post(owner, app(`/billing/payments/${checkout.id}/recheck`));
    assert.equal(res.body.payment.status, 'attempted');
    assert.equal(res.body.payment.payments[0].id, failed.id);
    assert.equal(res.body.payment.payments[0].errorDescription, 'Payment was declined by the bank');

    pay(checkout.orderId, { status: 'authorized' });
    res = await post(owner, app(`/billing/payments/${checkout.id}/recheck`));
    assert.equal(res.body.payment.status, 'paid', res.text);
    assert.equal(res.body.applied, true);
});

test('the control centre lists every plan payment with the fee, and can recheck one', async () => {
    const res = await admin.call('/admin/billing/payments');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.payments.length, 3);
    assert.ok(res.body.payments.every(p => p.orgName === 'Paying Studio'));
    const paid = res.body.payments.find(p => p.id === first.id);
    assert.equal(paid.payments[0].fee, 2360);
    assert.equal(res.body.summary.paidCount, 3);
    assert.equal(res.body.summary.testCount, 3);
    assert.equal((await admin.call('/admin/billing/payments?status=paid')).body.payments.length, 3);
    const recheck = await post(admin, `/admin/billing/payments/${first.id}/recheck`);
    assert.equal(recheck.status, 200, recheck.text);
    assert.equal(recheck.body.checked, true);
    assert.equal(recheck.body.applied, false);
});

test('a workspace whose plan needs payment is closed, except for paying', async () => {
    // Moved to a plan that waits for payment: the app is closed to everyone.
    const moved = await post(admin, `/admin/orgs/${org.id}/subscription`, { planVersionId: studioPlan.versionId, status: 'payment_required', reason: 'Test: needs payment' });
    assert.equal(moved.status, 200, moved.text);
    // Whether a plan is active is remembered for up to a minute per isolate.
    let me = await owner.call(app('/auth/me'));
    for (let i = 0; i < 70 && me.status !== 402; i++) { await new Promise(r => setTimeout(r, 1000)); me = await owner.call(app('/auth/me')); }
    assert.equal(me.status, 402);
    assert.equal(me.body.code, 'subscription_inactive');
    assert.equal((await owner.call(app('/plan'))).status, 200, 'the plan screen still opens');
    assert.equal((await owner.call(app('/billing'))).status, 200, 'and so does paying');

    const checkout = (await post(owner, app('/billing/checkout'), { planKey: 'studio', period: 'monthly' })).body;
    const payment = pay(checkout.orderId);
    const confirmed = await post(owner, app('/billing/confirm'), {
        id: checkout.id, razorpay_order_id: checkout.orderId, razorpay_payment_id: payment.id,
        razorpay_signature: sign(KEY_SECRET, `${checkout.orderId}|${payment.id}`),
    });
    assert.equal(confirmed.body.applied, true, confirmed.text);
    assert.equal((await owner.call(app('/auth/me'))).status, 200, 'open again at once after paying');
});

// ── Changing plans for existing customers ─────────────────────────────────

const subscription = async () => (await admin.call(`/admin/orgs/${org.id}/subscription`)).body.subscription;
const planByKey = async (key) => {
    const { plans } = (await admin.call('/admin/plans')).body;
    return (await admin.call(`/admin/plans/${plans.find(p => p.key === key).id}`)).body;
};

test('a new price applies to new customers only; the subscribed organization renews at its old price', async () => {
    const studio = await planByKey('studio');
    const live = studio.versions.find(v => v.status === 'published');
    const res = await post(admin, `/admin/plans/${studio.id}/versions/${live.id}/reprice`, { priceMonthly: 149900, priceAnnual: 1499000 });
    assert.equal(res.status, 200, res.text);
    const newLive = res.body.versions.find(v => v.status === 'published');
    assert.equal(newLive.price_monthly, 149900);
    assert.equal(res.body.versions.find(v => v.id === live.id).status, 'retired');
    // The organization on the old version still sees and pays its own price.
    const own = (await owner.call(app('/billing'))).body.plans.find(p => p.key === 'studio');
    assert.equal(own.current, true);
    assert.equal(own.priceMonthly, 99900);
    // The public price list shows the new price.
    const pub = (await fetch(`${worker.origin}/api/v2/public/plans`).then(r => r.json())).plans.find(p => p.key === 'studio');
    assert.equal(pub.priceMonthly, 149900);
});

test('a limited-time offer lowers the checkout price and is kept with the payment', async () => {
    const gallery = await publishPlan('Gallery', { billingType: 'paid', priceMonthly: 250000, priceAnnual: 2500000 });
    const set = await admin.call(`/admin/plans/${gallery.id}/offer`, { method: 'PUT', body: { percentOff: 20, label: 'Diwali offer', endsAt: Date.now() + 7 * 86_400_000 } });
    assert.equal(set.status, 200, set.text);
    assert.equal(set.body.offer.percentOff, 20);
    const option = (await owner.call(app('/billing'))).body.plans.find(p => p.key === 'gallery');
    assert.equal(option.offer.priceMonthly, 200000);
    const pub = (await fetch(`${worker.origin}/api/v2/public/plans`).then(r => r.json())).plans.find(p => p.key === 'gallery');
    assert.equal(pub.offer.percentOff, 20);
    const checkout = (await post(owner, app('/billing/checkout'), { planKey: 'gallery', period: 'monthly' })).body;
    assert.equal(checkout.amount, 200000);
    assert.equal(orders.get(checkout.orderId).entity.amount, 200000, 'Razorpay is asked for the offer price');
    const listed = (await owner.call(app('/billing'))).body.payments.find(p => p.id === checkout.id);
    assert.equal(listed.listAmount, 250000);
    assert.equal(listed.discountPercent, 20);
    assert.equal(listed.offerLabel, 'Diwali offer');
    // The organization's own plan doesn't get it on renewal unless the offer says so.
    const studio = await planByKey('studio');
    await admin.call(`/admin/plans/${studio.id}/offer`, { method: 'PUT', body: { percentOff: 10, endsAt: Date.now() + 86_400_000 } });
    assert.equal((await owner.call(app('/billing'))).body.plans.find(p => p.key === 'studio').offer, null);
    await admin.call(`/admin/plans/${studio.id}/offer`, { method: 'PUT', body: { percentOff: 10, endsAt: Date.now() + 86_400_000, includeRenewals: true } });
    assert.equal((await owner.call(app('/billing'))).body.plans.find(p => p.key === 'studio').offer.priceMonthly, 89900);
    assert.equal((await admin.call(`/admin/plans/${studio.id}/offer`, { method: 'DELETE' })).body.offer, null);
});

test('moving an organization to another plan keeps its status and paid-up-to date', async () => {
    const before = await subscription();
    assert.equal(before.status, 'active');
    const gallery = await planByKey('gallery');
    const galleryLive = gallery.versions.find(v => v.status === 'published');
    const moved = await post(admin, `/admin/orgs/${org.id}/subscription`, { planVersionId: galleryLive.id, keepPeriod: true, reason: 'Moved to Gallery' });
    assert.equal(moved.status, 200, moved.text);
    assert.equal(moved.body.plan.key, 'gallery');
    assert.equal(moved.body.subscription.status, 'active', 'not sent back to waiting for payment');
    assert.equal(moved.body.subscription.currentPeriodEnd, before.currentPeriodEnd);
    // And everyone on a version at once, back to Studio's live version.
    const studio = await planByKey('studio');
    const studioLive = studio.versions.find(v => v.status === 'published');
    const all = await post(admin, `/admin/plans/${gallery.id}/versions/${galleryLive.id}/move`, { toVersionId: studioLive.id, reason: 'Gallery withdrawn' });
    assert.equal(all.status, 200, all.text);
    assert.equal(all.body.moved, 1);
    const after = await subscription();
    assert.equal(after.status, 'active');
    assert.equal(after.currentPeriodEnd, before.currentPeriodEnd);
    assert.equal((await admin.call(`/admin/orgs/${org.id}/subscription`)).body.plan.version, studioLive.version);
});

test('extending a plan as goodwill adds days to its paid-up-to date', async () => {
    const before = await subscription();
    const res = await post(admin, `/admin/orgs/${org.id}/subscription/extend`, { days: 10, reason: 'Sorry for the outage' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.subscription.currentPeriodEnd - before.currentPeriodEnd, 10 * 86_400_000);
    assert.equal((await post(admin, `/admin/orgs/${org.id}/subscription/extend`, { days: 10 })).status, 400, 'a reason is required');
});

test('only a plan nobody uses can be deleted', async () => {
    const unused = await post(admin, '/admin/plans', { name: 'Never used' });
    const del = await admin.call(`/admin/plans/${unused.body.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200, del.text);
    assert.equal((await admin.call(`/admin/plans/${unused.body.id}`)).status, 404);
    // Studio has an organization and payments: refused, nothing removed.
    const studio = await planByKey('studio');
    const refused = await admin.call(`/admin/plans/${studio.id}`, { method: 'DELETE' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'plan_in_use');
    assert.match(refused.body.error, /1 organization is on it/);
    assert.equal((await admin.call(`/admin/plans/${studio.id}`)).status, 200);
    // The Free plan was never used: it goes.
    const free = await planByKey('free');
    assert.equal((await admin.call(`/admin/plans/${free.id}`, { method: 'DELETE' })).status, 200);
});
