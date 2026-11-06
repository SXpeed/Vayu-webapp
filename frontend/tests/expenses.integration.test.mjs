// Expenses against a real local Worker: each person records and lists their
// own, the checks on what is saved, and privacy (nobody else, an admin
// included, can read, change or delete someone's expenses).
//
//   node --test frontend/tests/expenses.integration.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { withSessionToken } from './helpers/session.mjs';
import { startDevWorker } from './helpers/devWorker.mjs';
import { load } from './helpers/load.mjs';

const OWNER = { name: 'Aarav Shah', email: 'owner@example.com', password: 'owner-password-1234' };
const rules = await load('expenseRules.ts');

let worker;
let owner;
let staff;
let neha;

async function api(token, path, { method = 'GET', body } = {}) {
    const headers = new Headers();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const res = await fetch(`${worker.origin}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: withSessionToken(json, res), text };
}

async function person(name, email) {
    const res = await api(owner, '/auth/users', { method: 'POST', body: { name, email, password: 'staff-password-1234' } });
    assert.ok(res.status === 200 || res.status === 201, res.text);
    const login = await api(null, '/auth/login', { method: 'POST', body: { email, password: 'staff-password-1234' } });
    assert.equal(login.status, 200, login.text);
    return login.body.token;
}

const taxi = { date: '2026-10-14', amountPaise: 45050, category: 'Travel', note: 'Taxi to the framer', receipts: ['/api/files/receipt-1.jpg'] };

before(async () => {
    const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
    worker = await startDevWorker({ adminPassword: 'provider-admin-password', seedLegacy: { sql: schema } });
    assert.equal((await api(null, '/auth/setup', { method: 'POST', body: OWNER })).status, 200);
    owner = (await api(null, '/auth/login', { method: 'POST', body: { email: OWNER.email, password: OWNER.password } })).body.token;
    staff = await person('Priya Mehta', 'priya@example.com');
    neha = await person('Neha Patel', 'neha@example.com');
});

after(async () => { await worker?.stop(); worker?.cleanup(); });

test('the checks on an expense', () => {
    assert.deepEqual(rules.parseExpense(taxi), taxi);
    assert.equal(rules.parseExpense({ ...taxi, note: '  trimmed  ' }).note, 'trimmed');
    assert.deepEqual(rules.parseExpense({ ...taxi, receipts: undefined }).receipts, []);
    for (const bad of [
        { date: '2026-02-30' }, { date: '14/10/2026' }, { amountPaise: 0 }, { amountPaise: -100 }, { amountPaise: 12.5 }, { amountPaise: Number.NaN },
        { amountPaise: '45050' }, { category: 'Holiday' }, { note: 'x'.repeat(501) },
        { receipts: ['https://evil.example/x.jpg'] }, { receipts: Array(7).fill('/api/files/r.jpg') },
    ]) assert.ok('problem' in rules.parseExpense({ ...taxi, ...bad }), JSON.stringify(bad));
    assert.ok('problem' in rules.parseExpense(null));
});

test('you record, list, change and delete your own expenses', async () => {
    assert.equal((await api(null, '/expenses?month=2026-10-01')).status, 401);
    const made = await api(staff, '/expenses', { method: 'POST', body: taxi });
    assert.equal(made.status, 201, made.text);
    assert.equal(made.body.amountPaise, 45050);
    await api(staff, '/expenses', { method: 'POST', body: { ...taxi, date: '2026-10-20', category: 'Food', receipts: [] } });
    await api(staff, '/expenses', { method: 'POST', body: { ...taxi, date: '2026-11-02' } });

    const oct = await api(staff, '/expenses?month=2026-10-01');
    assert.equal(oct.status, 200, oct.text);
    assert.deepEqual(oct.body.expenses.map(e => e.date), ['2026-10-20', '2026-10-14']); // newest first, November left out
    assert.deepEqual(oct.body.expenses[1].receipts, taxi.receipts);
    assert.equal((await api(staff, '/expenses?month=2026-10')).status, 400);
    assert.equal((await api(staff, '/expenses', { method: 'POST', body: { ...taxi, amountPaise: 0 } })).status, 400);

    const changed = await api(staff, `/expenses/${made.body.id}`, { method: 'PUT', body: { ...taxi, amountPaise: 50000 } });
    assert.equal(changed.status, 200, changed.text);
    assert.equal(changed.body.amountPaise, 50000);
    assert.equal((await api(staff, `/expenses/${made.body.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await api(staff, `/expenses/${made.body.id}`, { method: 'DELETE' })).status, 404);
    assert.equal((await api(staff, '/expenses?month=2026-10-01')).body.expenses.length, 1);
});

test('nobody else sees or touches your expenses, admins included', async () => {
    const mine = (await api(neha, '/expenses', { method: 'POST', body: { ...taxi, note: 'Neha only' } })).body;
    for (const other of [owner, staff]) {
        assert.ok(!(await api(other, '/expenses?month=2026-10-01')).body.expenses.some(e => e.id === mine.id));
        assert.equal((await api(other, `/expenses/${mine.id}`, { method: 'PUT', body: taxi })).status, 404);
        assert.equal((await api(other, `/expenses/${mine.id}`, { method: 'DELETE' })).status, 404);
    }
    const still = (await api(neha, '/expenses?month=2026-10-01')).body.expenses;
    assert.deepEqual(still.map(e => [e.id, e.note]), [[mine.id, 'Neha only']]);
});
