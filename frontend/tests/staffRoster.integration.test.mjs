// The staff roster against a real local Worker: who can plan and who only
// sees the published week, publishing (blocked by conflicts, then a snapshot
// staff see while the manager keeps planning), days off, leave requests and
// their privacy, job titles, and an organization's plan switching it off.
//
//   node --test frontend/tests/staffRoster.integration.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { sessionTokenFrom, withSessionToken } from './helpers/session.mjs';
import { startDevWorker } from './helpers/devWorker.mjs';

const OWNER = { name: 'Aarav Shah', email: 'owner@example.com', password: 'owner-password-1234' };
const ADMIN_PASSWORD = 'provider-admin-password';
const WEEK = '2026-09-28';

let worker;
let owner;        // admin: manages
let floor;        // custom role: Staff roster "Manage", nothing else
let staff;        // built-in Staff: view
let staffId;
let neha;         // a second Staff member
let nehaId;
let flagship;
let studio;

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

async function person(name, email, roleId) {
    const res = await api(owner, '/auth/users', { method: 'POST', body: { name, email, password: 'staff-password-1234', ...(roleId ? { role: roleId } : {}) } });
    assert.ok(res.status === 200 || res.status === 201, res.text);
    const login = await api(null, '/auth/login', { method: 'POST', body: { email, password: 'staff-password-1234' } });
    assert.equal(login.status, 200, login.text);
    return { token: login.body.token, id: login.body.user.id };
}

const shift = (employeeId, date, start, end, extra = {}) => ({
    kind: 'shift', employeeId, storeId: flagship, date, startMin: start * 60, endMin: end * 60, breakMin: 60, role: 'Cashier', note: '', ...extra,
});
const week = (token) => api(token, `/staff-roster?from=${WEEK}&to=2026-10-04`);

before(async () => {
    const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
    worker = await startDevWorker({ port: 8836, inspectorPort: 9266, adminPassword: ADMIN_PASSWORD, seedLegacy: { sql: schema } });
    assert.equal((await api(null, '/auth/setup', { method: 'POST', body: OWNER })).status, 200);
    owner = (await api(null, '/auth/login', { method: 'POST', body: { email: OWNER.email, password: OWNER.password } })).body.token;
    for (const [name, lat] of [['Flagship', 19.07], ['Studio', 19.08]]) {
        const res = await api(owner, '/attendance/stores', { method: 'POST', body: { name, latitude: lat, longitude: 72.88, gpsRadius: 150 } });
        assert.equal(res.status, 201, res.text);
        if (name === 'Flagship') flagship = res.body.id; else studio = res.body.id;
    }
    const role = await api(owner, '/auth/roles', { method: 'POST', body: { name: 'Floor manager', permissions: { schedule: 'edit' } } });
    floor = (await person('Floor Manager', 'floor@example.com', role.body?.id ?? role.body?.role?.id)).token;
    ({ token: staff, id: staffId } = await person('Priya Mehta', 'priya@example.com'));
    ({ token: neha, id: nehaId } = await person('Neha Patel', 'neha@example.com'));
});

after(async () => { await worker?.stop(); worker?.cleanup(); });

test('managers plan; Staff only read, and only what is published', async () => {
    const m = await week(owner);
    assert.equal(m.status, 200, m.text);
    assert.equal(m.body.canManage, true);
    assert.deepEqual(m.body.stores.map(s => s.name), ['Flagship', 'Studio']);
    assert.ok(m.body.people.some(p => p.id === staffId));
    assert.equal(m.body.weeks[WEEK].status, 'draft');

    const s = await week(staff);
    assert.equal(s.status, 200);
    assert.equal(s.body.canManage, false);
    assert.equal((await api(staff, '/staff-roster/shifts', { method: 'POST', body: { shifts: [shift(staffId, '2026-09-28', 9, 17)] } })).status, 403);
    assert.equal((await api(null, '/staff-roster')).status, 401);

    const made = await api(floor, '/staff-roster/shifts', { method: 'POST', body: { shifts: [shift(staffId, '2026-09-28', 9, 17), shift(staffId, '2026-09-29', 9, 17)] } });
    assert.equal(made.status, 201, made.text);
    assert.equal(made.body.length, 2, 'a custom role with Manage can plan');
    assert.deepEqual((await week(staff)).body.shifts, [], 'nothing shows to staff before publishing');
});

test('bad shifts are refused with a reason', async () => {
    const post = (s) => api(owner, '/staff-roster/shifts', { method: 'POST', body: { shifts: [s] } });
    assert.equal((await post(shift(staffId, '2026-09-30', 9, 9))).status, 400);
    assert.equal((await post({ ...shift(staffId, '2026-09-30', 9, 17), storeId: 'nope' })).status, 400);
    assert.equal((await post({ ...shift(staffId, '2026-09-30', 9, 17), employeeId: 'nobody' })).status, 400);
    assert.equal((await post({ ...shift(staffId, '2026-09-30', 9, 17), breakMin: 480 })).status, 400);
    assert.equal((await post({ ...shift(staffId, '2026-09-30', 9, 17), date: '30/09/2026' })).status, 400);
});

test('publishing is blocked by a double booking, then saves what staff see', async () => {
    const both = await api(owner, '/staff-roster/shifts', { method: 'POST', body: { shifts: [
        shift(nehaId, '2026-10-01', 9, 17),
        shift(nehaId, '2026-10-01', 13, 21, { storeId: studio }),
        shift(null, '2026-09-30', 9, 17, { role: 'Store associate' }),
        shift(nehaId, '2026-10-02', 22, 6, { role: 'Stock associate' }), // overnight
    ] } });
    assert.equal(both.status, 201, both.text);
    const blocked = await api(owner, '/staff-roster/publish', { method: 'POST', body: { weekStart: WEEK, notify: true } });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'conflicts');
    assert.equal(blocked.body.shiftIds.length, 2);
    assert.equal((await api(owner, '/staff-roster/publish', { method: 'POST', body: { weekStart: '2026-09-29' } })).status, 400, 'a week starts on Monday');
    assert.equal((await api(staff, '/staff-roster/publish', { method: 'POST', body: { weekStart: WEEK } })).status, 403);

    // Move the Studio evening to the open-shift pool: publishing then works, open shift and all.
    const evening = both.body[1];
    assert.equal((await api(owner, `/staff-roster/shifts/${evening.id}`, { method: 'PUT', body: { ...evening, employeeId: null } })).status, 200);
    const ok = await api(owner, '/staff-roster/publish', { method: 'POST', body: { weekStart: WEEK, notify: true } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.status, 'published');

    const seen = await week(staff);
    assert.equal(seen.body.weeks[WEEK].status, 'published');
    assert.equal(seen.body.shifts.filter(s => s.employeeId === staffId).length, 2, 'staff see the published week');
    assert.equal(seen.body.shifts.filter(s => !s.employeeId).length, 2, 'and the open shifts');

    // Planning goes on; staff keep seeing the published version until it is published again.
    assert.equal((await api(owner, '/staff-roster/shifts', { method: 'POST', body: { shifts: [shift(staffId, '2026-10-03', 10, 18)] } })).status, 201);
    assert.equal((await week(owner)).body.weeks[WEEK].status, 'changed');
    assert.equal((await week(staff)).body.shifts.filter(s => s.employeeId === staffId).length, 2);
    assert.equal((await api(owner, '/staff-roster/publish', { method: 'POST', body: { weekStart: WEEK } })).status, 200);
    assert.equal((await week(staff)).body.shifts.filter(s => s.employeeId === staffId).length, 3);
});

test('days off: never on top of a shift; a new shift replaces one', async () => {
    const off = (date) => ({ kind: 'off', employeeId: staffId, storeId: null, date, startMin: 0, endMin: 0, breakMin: 0, role: '', note: '' });
    assert.equal((await api(owner, '/staff-roster/shifts', { method: 'POST', body: { shifts: [off('2026-09-28')] } })).status, 409, 'she works that day');
    assert.equal((await api(owner, '/staff-roster/shifts', { method: 'POST', body: { shifts: [off('2026-10-04')] } })).status, 201);
    assert.equal((await api(owner, '/staff-roster/shifts', { method: 'POST', body: { shifts: [{ ...off('2026-10-04'), employeeId: null }] } })).status, 400, 'a day off needs a person');
    assert.equal((await api(owner, '/staff-roster/shifts', { method: 'POST', body: { shifts: [shift(staffId, '2026-10-04', 11, 17)] } })).status, 201);
    const day = (await week(owner)).body.shifts.filter(s => s.employeeId === staffId && s.date === '2026-10-04');
    assert.deepEqual(day.map(s => s.kind), ['shift'], 'the day off gave way');
});

test('leave: ask, keep private, decide, and see what it affects', async () => {
    const asked = await api(neha, '/staff-roster/leaves', { method: 'POST', body: { from: '2026-10-02', to: '2026-10-02', type: 'Personal leave', reason: 'Sister’s engagement' } });
    assert.equal(asked.status, 201, asked.text);
    assert.equal(asked.body.status, 'pending');
    assert.equal((await api(neha, '/staff-roster/leaves', { method: 'POST', body: { employeeId: staffId, from: '2026-10-02', to: '2026-10-02', type: 'Sick leave' } })).status, 403, 'not for someone else');
    assert.equal((await api(neha, '/staff-roster/leaves', { method: 'POST', body: { from: '2026-10-05', to: '2026-10-02', type: 'Sick leave' } })).status, 400);

    // Other staff don't see a pending request at all, nor anyone's reason.
    assert.equal((await week(staff)).body.leaves.some(l => l.id === asked.body.id), false);
    assert.equal((await api(staff, `/staff-roster/leaves/${asked.body.id}`, { method: 'PATCH', body: { status: 'approved' } })).status, 403);

    const approved = await api(owner, `/staff-roster/leaves/${asked.body.id}`, { method: 'PATCH', body: { status: 'approved' } });
    assert.equal(approved.status, 200, approved.text);
    assert.equal(approved.body.decidedByName, OWNER.name);
    assert.equal((await api(owner, `/staff-roster/leaves/${asked.body.id}`, { method: 'PATCH', body: { status: 'declined' } })).status, 409, 'decided once');
    const seen = (await week(staff)).body.leaves.find(l => l.id === asked.body.id);
    assert.equal(seen.reason, '', 'approved leave shows, without its reason');
    assert.equal((await week(neha)).body.leaves.find(l => l.id === asked.body.id).reason, 'Sister’s engagement', 'she sees her own');

    // Neha's overnight shift on 2 Oct now falls in approved leave: the week needs another look, and publishing is blocked.
    assert.equal((await week(owner)).body.weeks[WEEK].status, 'changed');
    assert.equal((await api(owner, '/staff-roster/publish', { method: 'POST', body: { weekStart: WEEK } })).status, 409);

    // A manager can record leave for someone: approved at once.
    const recorded = await api(owner, '/staff-roster/leaves', { method: 'POST', body: { employeeId: staffId, from: '2026-10-12', to: '2026-10-13', type: 'Annual leave' } });
    assert.equal(recorded.body.status, 'approved');

    // Withdrawing: your own pending only.
    const again = await api(staff, '/staff-roster/leaves', { method: 'POST', body: { from: '2026-10-20', to: '2026-10-20', type: 'Other' } });
    assert.equal((await api(neha, `/staff-roster/leaves/${again.body.id}`, { method: 'DELETE' })).status, 403);
    assert.equal((await api(staff, `/staff-roster/leaves/${recorded.body.id}`, { method: 'DELETE' })).status, 403, 'not approved leave');
    assert.equal((await api(staff, `/staff-roster/leaves/${again.body.id}`, { method: 'DELETE' })).status, 200);
});

test('job titles show on the roster for everyone', async () => {
    assert.equal((await api(staff, `/staff-roster/titles/${nehaId}`, { method: 'PUT', body: { title: 'Cashier' } })).status, 403);
    assert.equal((await api(owner, `/staff-roster/titles/${nehaId}`, { method: 'PUT', body: { title: 'Cashier' } })).status, 200);
    assert.equal((await week(staff)).body.people.find(p => p.id === nehaId).title, 'Cashier');
    assert.ok((await week(owner)).body.jobTitles.includes('Cashier'));
});

test('an organization whose plan leaves the staff roster out: closed to everyone', async () => {
    const admin = worker.browser();
    assert.equal((await admin.signIn('admin@example.com', ADMIN_PASSWORD)).status, 200);
    assert.equal((await admin.call('/admin/users', { method: 'POST', body: { email: 'org-owner@example.com', name: 'Org Owner', temporaryPassword: 'member password 123' } })).status, 201);
    const org = (await admin.call('/admin/orgs', { method: 'POST', body: { name: 'Roster Org', businessType: 'studio', ownerEmail: 'org-owner@example.com' } })).body;
    const orgOwner = worker.browser();
    assert.equal((await orgOwner.signIn('org-owner@example.com', 'member password 123')).status, 200);
    const app = path => `/api/o/${org.id}${path}`;
    assert.equal((await orgOwner.call(app('/staff-roster'))).status, 200);
    assert.equal((await admin.call(`/admin/orgs/${org.id}/entitlements`, { method: 'POST', body: { key: 'staffRoster', value: false, reason: 'Not on this plan' } })).status, 200);
    const refused = await orgOwner.call(app('/staff-roster'));
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'module_off');
    assert.deepEqual((await orgOwner.call(app('/auth/me'))).body.sectionsOff, ['schedule']);
});
