// Payment-link amount rules (paymentLinkPolicy.ts): integer paise, bounds,
// invoice totals and what's outstanding, overrides, idempotency references,
// and the order link statuses may move in.
//
//   node --test frontend/tests/paymentLinkPolicy.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers/load.mjs';

const p = await load('paymentLinkPolicy.ts');

test('amounts: whole paise, or rupees with at most two decimals', () => {
    assert.deepEqual(p.requestedPaise({ amountPaise: 250000 }), { paise: 250000 });
    assert.deepEqual(p.requestedPaise({ amount: 2500 }), { paise: 250000 });
    assert.deepEqual(p.requestedPaise({ amount: 1999.99 }), { paise: 199999 });
    assert.deepEqual(p.requestedPaise({ amount: 0.29 }), { paise: 29 }, 'float noise (0.29 * 100 = 28.999…) still converts exactly');
    assert.deepEqual(p.requestedPaise({}), { paise: null });
    for (const bad of [{ amountPaise: 100.5 }, { amountPaise: '100' }, { amountPaise: Number.MAX_SAFE_INTEGER + 2 }, { amount: 10.001 }, { amount: 'abc' }, { amount: Number.NaN }, { amount: Infinity }]) {
        const r = p.requestedPaise(bad);
        assert.equal(r.paise, null, JSON.stringify(bad));
        assert.equal(r.problem?.code, 'invalid_amount');
    }
});

test('bounds: at least ₹1, at most the configured or hard ceiling; zero and negatives refused', () => {
    const max = p.maxPaise(undefined);
    assert.equal(max, p.HARD_MAX_PAISE);
    assert.equal(p.maxPaise('5000000'), 5_000_000);
    assert.equal(p.maxPaise('not a number'), p.HARD_MAX_PAISE);
    assert.equal(p.maxPaise('50'), p.HARD_MAX_PAISE, 'a ceiling below ₹1 is ignored');
    assert.equal(p.amountProblem(100, max), null);
    assert.equal(p.amountProblem(99, max).code, 'amount_too_small');
    assert.equal(p.amountProblem(0, max).code, 'amount_too_small');
    assert.equal(p.amountProblem(-500, max).code, 'amount_too_small');
    assert.equal(p.amountProblem(5_000_001, 5_000_000).code, 'amount_too_large');
    assert.equal(p.amountProblem(p.HARD_MAX_PAISE + 1, max).code, 'amount_too_large');
});

test('invoice totals are recomputed from items and tax, rounding to the paisa', () => {
    // ₹1,000.10 + ₹333.33 = ₹1,333.43; 18% tax = ₹240.0174 → ₹240.02; total ₹1,573.45
    const inv = { items: [{ price: 1000.1 }, { price: 333.33 }], taxRate: 18, total: 1573.45 };
    assert.deepEqual(p.invoiceTotals(inv), { itemsPaise: 133343, taxRate: 18, taxPaise: 24002, totalPaise: 157345 });
    assert.ok(p.invoiceTotals({ ...inv, total: 1573.4449999 }), 'a hair of float error is accepted');
    assert.equal(p.invoiceTotals({ ...inv, total: 1000 }), null, 'a total that disagrees with the items is refused');
    assert.equal(p.invoiceTotals({ ...inv, items: [] }), null);
    assert.equal(p.invoiceTotals({ ...inv, items: [{ price: -5 }] }), null);
    assert.equal(p.invoiceTotals({ ...inv, taxRate: 400 }), null);
    assert.deepEqual(p.invoiceTotals({ items: [{ price: 500 }], total: 500 }), { itemsPaise: 50000, taxRate: 0, taxPaise: 0, totalPaise: 50000 });
});

test("what's outstanding counts paid and still-payable links of the same mode, never other invoices", () => {
    const links = [
        { invoiceId: 'inv-1', amount: 40000, status: 'paid', mode: 'live' },
        { invoiceId: 'inv-1', amount: 20000, status: 'created', mode: 'live' },
        { invoiceId: 'inv-1', amount: 10000, status: 'expired', mode: 'live' },
        { invoiceId: 'inv-1', amount: 10000, status: 'cancelled' },
        { invoiceId: 'inv-1', amount: 99999, status: 'paid', mode: 'test' },
        { invoiceId: 'inv-2', amount: 50000, status: 'paid', mode: 'live' },
    ];
    assert.equal(p.outstandingPaise(100000, 'inv-1', links), 40000);
    assert.equal(p.outstandingPaise(50000, 'inv-1', links), 0, 'never negative');
    // A test link counts only against other tests.
    assert.equal(p.outstandingPaise(100000, 'inv-1', links, 'test'), 1);
});

test('overrides: an instalment is routine; more than outstanding, or settling for less, is not', () => {
    assert.equal(p.overrideNeeded(30000, 40000, false), null);
    assert.equal(p.overrideNeeded(40000, 40000, true), null);
    assert.equal(p.overrideNeeded(40001, 40000, false), 'above_outstanding');
    assert.equal(p.overrideNeeded(36000, 40000, true), 'settles_for_less');
    assert.equal(p.overrideReason('  agreed   discount  '), 'agreed discount');
    assert.equal(p.overrideReason('ok'), null);
    assert.equal(p.overrideReason('x'.repeat(301)), null);
    assert.equal(p.overrideReason(42), null);
});

test('idempotency: keys are checked, references are stable per request and fit Razorpay (≤ 40)', async () => {
    assert.equal(p.idempotencyKey('0f3b2c1a-1111-4aaa-9bbb-123456789abc'), '0f3b2c1a-1111-4aaa-9bbb-123456789abc');
    for (const bad of [null, '', 'short', 'has space in it', 'x'.repeat(101), 'semi;colon-key']) assert.equal(p.idempotencyKey(bad), null);
    const a = await p.referenceIdFor('shared|user-1', 'key-000001');
    assert.equal(a, await p.referenceIdFor('shared|user-1', 'key-000001'));
    assert.notEqual(a, await p.referenceIdFor('shared|user-2', 'key-000001'), 'another person reusing a key gets another reference');
    assert.ok(a.length <= 40 && /^vy_[0-9a-f]+$/.test(a));
    const f1 = await p.requestFingerprint({ amountPaise: 100, customer: { name: 'A' } });
    assert.equal(f1, await p.requestFingerprint({ customer: { name: 'A' }, amountPaise: 100 }), 'key order does not matter');
    assert.notEqual(f1, await p.requestFingerprint({ amountPaise: 101, customer: { name: 'A' } }));
});

test('link status only moves forward, whatever order events arrive in', () => {
    assert.equal(p.nextLinkStatus(undefined, 'paid'), 'paid');
    assert.equal(p.nextLinkStatus('created', 'partially_paid'), 'partially_paid');
    assert.equal(p.nextLinkStatus('paid', 'expired'), 'paid', 'a late "expired" never un-pays a link');
    assert.equal(p.nextLinkStatus('paid', 'partially_paid'), 'paid');
    assert.equal(p.nextLinkStatus('expired', 'paid'), 'paid');
    assert.equal(p.nextLinkStatus('partially_paid', 'created'), 'partially_paid');
});

test('test mode: refused in production unless allowed, and even then only when confirmed; live refuses "test"', () => {
    const live = { mode: 'live', testAllowed: false };
    const testBlocked = { mode: 'test', testAllowed: false };   // production, no permission
    const testAllowed = { mode: 'test', testAllowed: true };    // allowed (or local development)
    assert.equal(p.testModeRefusal(live, undefined), null);
    assert.equal(p.testModeRefusal(live, 'test').code, 'mode_mismatch');
    assert.equal(p.testModeRefusal(testBlocked, 'test').code, 'test_mode_blocked');
    assert.equal(p.testModeRefusal(testBlocked, undefined).code, 'test_mode_blocked');
    assert.equal(p.testModeRefusal(testAllowed, undefined).code, 'test_mode_confirm');
    assert.equal(p.testModeRefusal(testAllowed, 'test'), null);
});
