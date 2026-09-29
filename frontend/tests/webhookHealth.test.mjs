// Organization webhooks: signature checks on the raw body, the previous
// secret during a rotation overlap (and not after), tenant isolation, and
// health that only verified deliveries and reconciliation can move.
// (platform/payments.ts, platform/webhookHealth.ts)
//
//   node --test frontend/tests/webhookHealth.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac, randomBytes } from 'node:crypto';
import { load } from './helpers/load.mjs';
import { fakeD1 } from './helpers/fakeD1.mjs';

const payments = await load('platform/payments.ts');
const health = await load('platform/webhookHealth.ts');

const env = { PAYMENT_SECRETS_KEY: randomBytes(32).toString('base64') };
const actor = { userId: 'admin-1', ip: null };
const sign = (secret, body) => createHmac('sha256', secret).update(body).digest('hex');

function delivery(orgId, secret, event, eventId, { rawOverride } = {}) {
    const body = JSON.stringify(event);
    return new Request(`https://api.example/api/v2/webhooks/razorpay/${orgId}`, {
        method: 'POST', body: rawOverride ?? body,
        headers: { 'x-razorpay-signature': sign(secret, body), 'x-razorpay-event-id': eventId, 'Content-Type': 'application/json' },
    });
}

async function setup(before = null) {
    const db = fakeD1({ before });
    for (const id of ['org-a', 'org-b']) {
        await db.prepare("INSERT INTO organizations (id, slug, name, business_type, created_at, updated_at) VALUES (?, ?, ?, 'studio', 0, 0)").bind(id, id, id).run();
    }
    await payments.connectRazorpay(env, db, 'org-a', { keyId: 'rzp_test_AAAAAAAAAA', keySecret: 'org-a-key-secret-value', webhookSecret: 'org-a-secret-one' }, actor);
    await payments.connectRazorpay(env, db, 'org-b', { keyId: 'rzp_test_BBBBBBBBBB', keySecret: 'org-b-key-secret-value', webhookSecret: 'org-b-secret-one' }, actor);
    return db;
}

const event = { event: 'payment_link.paid', payload: { payment_link: { entity: { id: 'plink_abcdef1' } } } };
const receive = (db, orgId, req) => payments.receiveRazorpayWebhook(env, db, orgId, req);

test('a delivery verifies only against the exact raw body and this organization\'s own secret', async () => {
    const db = await setup();
    assert.equal((await receive(db, 'org-a', delivery('org-a', 'org-a-secret-one', event, 'evt_1'))).status, 200);
    // One byte different from what was signed: refused.
    const tampered = delivery('org-a', 'org-a-secret-one', event, 'evt_2', { rawOverride: JSON.stringify(event) + ' ' });
    assert.equal((await receive(db, 'org-a', tampered)).status, 401);
    // Organization B's (valid) secret on organization A's address: refused. No other tenant's secret is tried.
    assert.equal((await receive(db, 'org-a', delivery('org-a', 'org-b-secret-one', event, 'evt_3'))).status, 401);
    // A duplicate delivery is accepted (so Razorpay stops) and handed back to apply idempotently.
    const dup = await receive(db, 'org-a', delivery('org-a', 'org-a-secret-one', event, 'evt_1'));
    assert.equal(dup.status, 200);
    assert.equal(dup.body.duplicate, true);
});

test('after a secret change the old one verifies retries for 24 hours, then no longer', async () => {
    const db = await setup();
    await payments.connectRazorpay(env, db, 'org-a', { keyId: 'rzp_test_AAAAAAAAAA', keySecret: 'org-a-key-secret-value', webhookSecret: 'org-a-secret-two' }, actor);
    assert.equal((await receive(db, 'org-a', delivery('org-a', 'org-a-secret-two', event, 'evt_new'))).status, 200);
    assert.equal((await receive(db, 'org-a', delivery('org-a', 'org-a-secret-one', event, 'evt_old_retry'))).status, 200, 'a retry signed before the change');
    const row = await db.prepare("SELECT webhook_secret_prev_until FROM org_payment_integrations WHERE org_id = 'org-a'").first();
    assert.ok(Math.abs(row.webhook_secret_prev_until - (Date.now() + payments.WEBHOOK_OVERLAP_MS)) < 5000);
    const h = await db.prepare("SELECT verified_with_previous FROM payment_webhook_health WHERE org_id = 'org-a'").first();
    assert.equal(h.verified_with_previous, 1);
    // The overlap is over: the old secret is refused.
    await db.prepare("UPDATE org_payment_integrations SET webhook_secret_prev_until = ? WHERE org_id = 'org-a'").bind(Date.now() - 1).run();
    assert.equal((await receive(db, 'org-a', delivery('org-a', 'org-a-secret-one', event, 'evt_too_late'))).status, 401);
    // The audit says when the old secret stops working, never the secret itself.
    const audit = await db.prepare("SELECT details FROM platform_audit WHERE action = 'payments.razorpay.replace'").first();
    assert.ok(JSON.parse(audit.details).previousSecretValidUntil > Date.now());
    assert.ok(!audit.details.includes('org-a-secret'));
});

test('forged deliveries are counted for telemetry but never touch health', async () => {
    const db = await setup();
    for (let i = 0; i < 5; i++) await receive(db, 'org-a', delivery('org-a', 'guessed-secret', event, `evt_forged_${i}`));
    await receive(db, 'no-such-org', delivery('no-such-org', 'x', event, 'evt_nowhere'));
    const h = await health.webhookHealth(db, 'org-a');
    assert.equal(h.state, 'no_events', 'still just "no events yet", not "failing"');
    assert.equal(h.verifiedCount, 0);
    assert.equal(h.rejected24h, 5);
    const scopes = (await db.prepare('SELECT scope FROM webhook_rejections').all()).results.map(r => r.scope).sort();
    assert.deepEqual(scopes, ['org:org-a', 'org:unknown'], 'an unknown address never creates its own rows');
});

test('health: verified deliveries, processing failures, and payments the webhook missed', async () => {
    const db = await setup();
    assert.equal((await health.webhookHealth(db, 'org-a')).state, 'no_events');
    await receive(db, 'org-a', delivery('org-a', 'org-a-secret-one', event, 'evt_ok'));
    await health.recordProcessed(db, 'org-a');
    assert.equal((await health.webhookHealth(db, 'org-a')).state, 'healthy');
    // A verified delivery that couldn't be applied.
    await health.recordProcessingFailure(db, 'org-a', new Error('KV unavailable: token=abc'));
    const failing = await health.webhookHealth(db, 'org-a');
    assert.equal(failing.state, 'attention');
    assert.equal(failing.processingFailures, 1);
    assert.ok(!failing.lastProcessingError.includes('='), 'error text is sanitized');
    // Applied again: back to healthy.
    await new Promise(r => setTimeout(r, 5));
    await receive(db, 'org-a', delivery('org-a', 'org-a-secret-one', event, 'evt_ok2'));
    await health.recordProcessed(db, 'org-a');
    assert.equal((await health.webhookHealth(db, 'org-a')).state, 'healthy');
    // Reconciliation finds a payment no webhook delivered: attention.
    await new Promise(r => setTimeout(r, 5));
    await health.recordReconcile(db, 'org-a', { checked: 3, missed: 1, failures: 0, error: null });
    const missed = await health.webhookHealth(db, 'org-a');
    assert.equal(missed.state, 'attention');
    assert.equal(missed.missedByWebhook, 1);
    // Organization B is untouched by all of this.
    assert.equal((await health.webhookHealth(db, 'org-b')).state, 'no_events');
});

test('before migrations 0010/0011, webhooks still work and health reads as not recorded', async () => {
    const db = await setup('0010');
    assert.equal((await receive(db, 'org-a', delivery('org-a', 'org-a-secret-one', event, 'evt_old_db'))).status, 200);
    assert.equal((await receive(db, 'org-a', delivery('org-a', 'wrong', event, 'evt_old_db2'))).status, 401);
    assert.equal((await health.webhookHealth(db, 'org-a')).state, 'unknown');
    // Replacing the secret works too (no overlap column yet: the old one simply stops).
    await payments.connectRazorpay(env, db, 'org-a', { keyId: 'rzp_test_AAAAAAAAAA', keySecret: 'org-a-key-secret-value', webhookSecret: 'org-a-secret-two' }, actor);
    assert.equal((await receive(db, 'org-a', delivery('org-a', 'org-a-secret-two', event, 'evt_old_db3'))).status, 200);
});

test('the verdict never calls "no recent webhook" a failure', () => {
    assert.equal(health.healthVerdict(null).state, 'no_events');
    const quietButFine = { last_verified_at: Date.now() - 90 * 86_400_000, verified_count: 4, verified_with_previous: 0, processing_failures: 0, last_processing_error: null, last_processing_error_at: null, last_processed_ok_at: Date.now() - 90 * 86_400_000 };
    assert.equal(health.healthVerdict(quietButFine).state, 'healthy');
});
