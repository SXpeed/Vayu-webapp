// Rate limits on costly routes, webhook ingress, and not revealing which
// organizations exist (rateLimits.ts, worker.ts, orgApp.ts), against a real
// local Worker. Local rate limits come from wrangler's simulation of the
// Workers Rate Limiting binding (per location and approximate in production).
//
//   node --test frontend/tests/rateLimits.integration.test.mjs
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { sessionTokenFrom, withSessionToken } from './helpers/session.mjs';
import { startDevWorker } from './helpers/devWorker.mjs';
import { load } from './helpers/load.mjs';

const WEBHOOK_SECRET = 'shared-webhook-secret-for-tests';
let worker, ownerToken, staffToken, admin, org;

const login = async (email, password) => sessionTokenFrom(await fetch(`${worker.origin}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
}));
const call = (path, token, init = {}) => fetch(`${worker.origin}/api${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });

before(async () => {
    const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
    worker = await startDevWorker({ port: 8850, inspectorPort: 9280, seedLegacy: { sql: schema }, vars: { RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET } });
    await fetch(`${worker.origin}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', email: 'owner@example.com', password: 'owner-password-1234' }) });
    ownerToken = await login('owner@example.com', 'owner-password-1234');
    await call('/auth/users', ownerToken, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Staff', email: 'staff@example.com', password: 'staff-password-1234' }) });
    staffToken = await login('staff@example.com', 'staff-password-1234');
    admin = worker.browser();
    assert.equal((await admin.signIn('admin@example.com', 'provider-admin-password')).status, 200);
    org = (await admin.call('/admin/orgs', { method: 'POST', body: { name: 'Quiet Studio', businessType: 'studio', ownerEmail: 'admin@example.com' } })).body;
});

after(async () => { await worker?.stop(); worker?.cleanup(); });

test('costly routes are limited per person, with a 429, Retry-After and a code', async () => {
    const statuses = [];
    let limited;
    for (let i = 0; i < 40; i++) {
        const res = await call('/payments/links/refresh', ownerToken, { method: 'POST' });
        statuses.push(res.status);
        if (res.status === 429) { limited = res; break; }
    }
    assert.ok(limited, `expected a 429 within 40 calls, got ${statuses.join(',')}`);
    assert.ok(statuses.filter(s => s === 200).length >= 25, 'normal use is allowed first');
    assert.equal(limited.headers.get('Retry-After'), '60');
    assert.equal((await limited.json()).code, 'rate_limited');
    // Someone else in the same workspace is not held up by it.
    assert.equal((await call('/payments/links/refresh', staffToken, { method: 'POST' })).status, 200);
    // Ordinary reads aren't affected.
    assert.equal((await call('/artworks', ownerToken)).status, 200);
});

test('webhook retries are never blocked by forged deliveries', async () => {
    const event = JSON.stringify({ event: 'payment_link.expired', payload: { payment_link: { entity: { id: 'plink_nothing01' } } } });
    // A burst of forgeries from one address...
    for (let i = 0; i < 40; i++) {
        const res = await fetch(`${worker.origin}/api/payments/webhook`, { method: 'POST', body: event, headers: { 'x-razorpay-signature': 'f'.repeat(64) } });
        assert.equal(res.status, 401);
    }
    // ...and Razorpay's genuine deliveries and retries still get through.
    const signature = createHmac('sha256', WEBHOOK_SECRET).update(event).digest('hex');
    for (let i = 0; i < 5; i++) {
        const res = await fetch(`${worker.origin}/api/payments/webhook`, { method: 'POST', body: event, headers: { 'x-razorpay-signature': signature } });
        assert.equal(res.status, 200);
    }
});

test("organization addresses don't reveal which organizations exist", async () => {
    const anon = async (id) => { const r = await fetch(`${worker.origin}/api/o/${id}/artworks`); return [r.status, await r.text()]; };
    // Signed out: the same answer for a real organization and a made-up one.
    assert.deepEqual(await anon(org.id), await anon('00000000-0000-4000-8000-000000000000'));
    assert.equal((await anon(org.id))[0], 401);
    // Signed in but not a member: the same 404 as no such organization, paused or not.
    const outsider = worker.browser();
    assert.equal((await admin.call('/admin/users', { method: 'POST', body: { email: 'outsider@example.com', name: 'Outsider', temporaryPassword: 'outsider password 1' } })).status, 201);
    assert.equal((await outsider.signIn('outsider@example.com', 'outsider password 1')).status, 200);
    const asOutsider = async (id) => { const r = await outsider.call(`/api/o/${id}/artworks`); return [r.status, r.text]; };
    assert.deepEqual(await asOutsider(org.id), await asOutsider('00000000-0000-4000-8000-000000000000'));
    assert.equal((await admin.call(`/admin/orgs/${org.id}/status`, { method: 'POST', body: { status: 'suspended', reason: 'Testing' } })).status, 200);
    assert.deepEqual(await asOutsider(org.id), await asOutsider('00000000-0000-4000-8000-000000000000'));
});

test('the costly-route table covers payments, uploads, imports, invitations and rooms, and keys are per person and workspace', async () => {
    const r = await load('rateLimits.ts');
    assert.equal(r.costlyGroup('POST', '/payments/link'), 'payment_link');
    assert.equal(r.costlyGroup('POST', '/payments/links/plink_abcdef12/recheck'), 'payment_check');
    assert.equal(r.costlyGroup('POST', '/upload'), 'upload');
    assert.equal(r.costlyGroup('POST', '/contacts/import'), 'import');
    assert.equal(r.costlyGroup('POST', '/team/invitations'), 'invite');
    assert.equal(r.costlyGroup('POST', '/viewing-rooms'), 'room');
    assert.equal(r.costlyGroup('POST', '/billing/checkout'), 'billing');
    assert.equal(r.costlyGroup('GET', '/payments/links'), null, 'reading the list is ordinary');
    assert.equal(r.costlyGroup('GET', '/artworks'), null);
    assert.deepEqual(r.limitKeys('upload', 'u1', 'org-a'), { user: 'upload:u:u1', org: 'upload:o:org-a' });
    assert.notEqual(r.limitKeys('upload', 'u1', 'org-a').org, r.limitKeys('upload', 'u1', 'org-b').org);
    assert.equal(r.limitKeys('upload', 'u1', undefined).org, 'upload:o:original');
});
