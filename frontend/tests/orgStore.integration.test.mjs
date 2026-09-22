// Per-organization databases (Durable Objects) through the real Worker.
//
// Runs `wrangler dev --local`, because Durable Objects need the real runtime.
// Covers isolation between organizations, role limits, status gates and
// concurrent edits.
//
//   node --test frontend/tests/orgStore.integration.test.mjs
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startDevWorker } from './helpers/devWorker.mjs';

const ADMIN_PASSWORD = 'provider-admin-password';
const USER_PASSWORD = 'member-password-1234';

let worker;
let admin;
let ownerA;   // owner of organization A
let staffA;   // staff in organization A
let ownerB;   // owner of organization B, no access to A
let orgA;
let orgB;

before(async () => {
    worker = await startDevWorker({ port: 8810, inspectorPort: 9240, adminPassword: ADMIN_PASSWORD });
    admin = worker.browser();
    assert.equal((await admin.signIn('admin@example.com', ADMIN_PASSWORD)).status, 200);

    const mkUser = async (email, name) => {
        const res = await admin.call('/admin/users', { method: 'POST', body: { email, name, temporaryPassword: USER_PASSWORD } });
        assert.equal(res.status, 201, JSON.stringify(res.body));
    };
    await mkUser('owner-a@example.com', 'Owner A');
    await mkUser('staff-a@example.com', 'Staff A');
    await mkUser('owner-b@example.com', 'Owner B');

    const mkOrg = async (name, type, ownerEmail) => {
        const res = await admin.call('/admin/orgs', { method: 'POST', body: { name, businessType: type, ownerEmail, isDemo: true } });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        return res.body;
    };
    orgA = await mkOrg('Isolation Studio A', 'studio', 'owner-a@example.com');
    orgB = await mkOrg('Isolation Gallery B', 'gallery', 'owner-b@example.com');
    assert.equal((await admin.call(`/admin/orgs/${orgA.id}/members`, { method: 'POST', body: { email: 'staff-a@example.com', role: 'staff' } })).status, 201);

    ownerA = worker.browser();
    staffA = worker.browser();
    ownerB = worker.browser();
    for (const [b, email] of [[ownerA, 'owner-a@example.com'], [staffA, 'staff-a@example.com'], [ownerB, 'owner-b@example.com']]) {
        assert.equal((await b.signIn(email, USER_PASSWORD)).status, 200, email);
    }
});

after(async () => { await worker?.stop(); worker?.cleanup(); });

test('each organization gets its own database, created on first use', async () => {
    const a = await ownerA.call(`/org/${orgA.id}`);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.name, 'Isolation Studio A');
    assert.equal(a.body.role, 'owner');
    assert.ok(a.body.storage.schemaVersion >= 1, 'the organization database is migrated to the current schema');
    assert.equal(a.body.storage.artworks, 0);

    const b = await ownerB.call(`/org/${orgB.id}`);
    assert.equal(b.body.name, 'Isolation Gallery B');
    assert.equal(b.body.storage.artworks, 0);
});

test('my organizations lists only my own memberships', async () => {
    const mine = (await ownerA.call('/me/orgs')).body.organizations;
    assert.deepEqual(mine.map(o => o.id), [orgA.id]);
    assert.equal(mine[0].role, 'owner');
    const theirs = (await ownerB.call('/me/orgs')).body.organizations;
    assert.deepEqual(theirs.map(o => o.id), [orgB.id]);
    assert.equal((await worker.browser().call('/me/orgs')).status, 401, 'signed out sees nothing');
});

let artwork;

test('business data stays inside its own organization', async () => {
    const created = await ownerA.call(`/org/${orgA.id}/artworks`, {
        method: 'POST', body: { title: 'Golden Hour', artist: 'A. Painter', price: 85000, status: 'Available' },
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    artwork = created.body;
    assert.equal(artwork.title, 'Golden Hour');
    assert.equal(artwork.version, 1);

    assert.equal((await ownerA.call(`/org/${orgA.id}/artworks`)).body.artworks.length, 1);
    assert.equal((await ownerB.call(`/org/${orgB.id}/artworks`)).body.artworks.length, 0, "organization B's database is its own");

    // Organization B's owner reaching into A: refused, whatever id is used.
    for (const path of [`/org/${orgA.id}`, `/org/${orgA.id}/artworks`, `/org/${orgA.id}/artworks/${artwork.id}`]) {
        const res = await ownerB.call(path);
        assert.equal(res.status, 403, path);
        assert.equal(res.body.code, 'no_access');
    }
    assert.equal((await ownerB.call(`/org/${orgA.id}/artworks`, { method: 'POST', body: { title: 'Sneaky' } })).status, 403);
    assert.equal((await ownerA.call(`/org/${orgA.id}/artworks`)).body.artworks.length, 1, 'nothing was written');

    // An organization that does not exist looks exactly like one you cannot see.
    const unknown = await ownerA.call('/org/00000000-0000-0000-0000-000000000000/artworks');
    assert.equal(unknown.status, 403);
    assert.equal(unknown.body.code, 'no_access');
});

test('roles are enforced on the server: staff may edit, not delete', async () => {
    const res = await staffA.call(`/org/${orgA.id}/artworks`, { method: 'POST', body: { title: 'Staff piece', price: 1000 } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const del = await staffA.call(`/org/${orgA.id}/artworks/${res.body.id}`, { method: 'DELETE' });
    assert.equal(del.status, 403);
    assert.equal(del.body.code, 'forbidden');
    assert.equal((await ownerA.call(`/org/${orgA.id}/artworks/${res.body.id}`, { method: 'DELETE' })).body.deleted, true);
    assert.equal((await staffA.call(`/org/${orgA.id}/audit`)).status, 403, 'staff cannot read the business audit log');
});

test('a stale save is refused instead of overwriting a colleague', async () => {
    const first = await ownerA.call(`/org/${orgA.id}/artworks/${artwork.id}`, {
        method: 'PUT', body: { ...artwork, title: 'Golden Hour (framed)', version: artwork.version },
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.version, 2);

    const stale = await staffA.call(`/org/${orgA.id}/artworks/${artwork.id}`, {
        method: 'PUT', body: { ...artwork, title: 'Overwritten', version: artwork.version },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'conflict');
    assert.equal((await ownerA.call(`/org/${orgA.id}/artworks/${artwork.id}`)).body.title, 'Golden Hour (framed)');
});

test('two people selling the same artwork: one succeeds, one is told', async () => {
    const sell = (who) => who.call(`/org/${orgA.id}/artworks/${artwork.id}/status`, {
        method: 'POST', body: { expected: 'Available', status: 'Sold' },
    });
    const [one, two] = await Promise.all([sell(ownerA), sell(staffA)]);
    const statuses = [one.status, two.status].sort();
    assert.deepEqual(statuses, [200, 409], `got ${JSON.stringify([one.body, two.body])}`);
    const loser = one.status === 409 ? one : two;
    assert.equal(loser.body.code, 'conflict');
    assert.match(loser.body.error, /already marked Sold/);
    assert.equal((await ownerA.call(`/org/${orgA.id}/artworks/${artwork.id}`)).body.status, 'Sold');
});

test('the business audit log records who did what, inside the organization', async () => {
    const entries = (await ownerA.call(`/org/${orgA.id}/audit`)).body.entries;
    const actions = entries.map(e => e.action);
    assert.ok(actions.includes('artwork.create') && actions.includes('artwork.status'), actions.join(','));
    assert.equal((await ownerB.call(`/org/${orgB.id}/audit`)).body.entries.length, 0, "organization B has its own audit log");
});

test('suspending an organization closes its data; reactivating restores it', async () => {
    assert.equal((await admin.call(`/admin/orgs/${orgA.id}/status`, { method: 'POST', body: { status: 'suspended', reason: 'Isolation test' } })).status, 200);
    const res = await ownerA.call(`/org/${orgA.id}/artworks`);
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'org_suspended');
    assert.equal((await admin.call(`/admin/orgs/${orgA.id}/status`, { method: 'POST', body: { status: 'active', reason: 'Done' } })).status, 200);
    assert.equal((await ownerA.call(`/org/${orgA.id}/artworks`)).status, 200);
});

test('a disabled member loses access while their session is still valid', async () => {
    const members = (await admin.call(`/admin/orgs/${orgA.id}`)).body.members;
    const staff = members.find(m => m.email === 'staff-a@example.com');
    assert.equal((await admin.call(`/admin/orgs/${orgA.id}/members/${staff.id}`, { method: 'PATCH', body: { status: 'disabled' } })).status, 200);
    const res = await staffA.call(`/org/${orgA.id}/artworks`);
    assert.equal(res.status, 403, 'the running session is re-checked on every request');
    assert.equal(res.body.code, 'no_access');
    assert.deepEqual((await staffA.call('/me/orgs')).body.organizations, []);
});

test('plan limits stop new records without touching existing ones', async () => {
    // A plan that allows a single inventory item.
    const plan = (await admin.call('/admin/plans', { method: 'POST', body: { name: 'Tiny' } })).body;
    const version = (await admin.call(`/admin/plans/${plan.id}/versions`, {
        method: 'POST', body: { billingType: 'free', limits: { limits: { maxItems: 1, maxMembers: 10 } } },
    })).body.versions[0];
    await admin.call(`/admin/plans/${plan.id}/versions/${version.id}`, { method: 'PATCH', body: { status: 'published' } });
    assert.equal((await admin.call(`/admin/orgs/${orgB.id}/subscription`, { method: 'POST', body: { planVersionId: version.id } })).status, 200);

    const first = await ownerB.call(`/org/${orgB.id}/artworks`, { method: 'POST', body: { title: 'Only one' } });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const second = await ownerB.call(`/org/${orgB.id}/artworks`, { method: 'POST', body: { title: 'One too many' } });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'limit_reached');
    assert.match(second.body.error, /allows 1 inventory items/);

    // What is already stored stays readable and editable.
    const list = (await ownerB.call(`/org/${orgB.id}/artworks`)).body.artworks;
    assert.equal(list.length, 1);
    const edit = await ownerB.call(`/org/${orgB.id}/artworks/${list[0].id}`, {
        method: 'PUT', body: { ...list[0], title: 'Still editable', version: list[0].version },
    });
    assert.equal(edit.status, 200, 'a plan limit never freezes existing records');

    // Organization A is on no plan and is unaffected by B's limit.
    assert.equal((await ownerA.call(`/org/${orgA.id}/artworks`, { method: 'POST', body: { title: 'Unaffected' } })).status, 200);
});
