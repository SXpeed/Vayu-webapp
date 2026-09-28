// The Roster against a real local Worker: who can browse it and who can
// curate it (by role, including custom roles), sections with their order and
// versions, personal favourites, the admin's restore of a removed section,
// and an organization's plan switching the Roster off for everyone.
//
//   node --test frontend/tests/roster.integration.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { startDevWorker } from './helpers/devWorker.mjs';

const OWNER = { name: 'Owner', email: 'owner@example.com', password: 'owner-password-1234' };
const ADMIN_PASSWORD = 'provider-admin-password';
const USER_PASSWORD = 'member password 123';

let worker;
let owner;      // admin
let curator;    // custom role: Roster edit, nothing else
let browser;    // custom role: Roster view only
let blind;      // custom role: no Roster (and nothing else)
let staff;      // built-in Staff: browses by default
const arts = [];
let section;

async function api(token, path, { method = 'GET', body } = {}) {
    const headers = new Headers();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const res = await fetch(`${worker.origin}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text };
}

async function person(name, email, roleId) {
    const res = await api(owner, '/auth/users', { method: 'POST', body: { name, email, password: 'staff-password-1234', ...(roleId ? { role: roleId } : {}) } });
    assert.ok(res.status === 200 || res.status === 201, res.text);
    const login = await api(null, '/auth/login', { method: 'POST', body: { email, password: 'staff-password-1234' } });
    assert.equal(login.status, 200, login.text);
    return login.body.token;
}

async function role(name, permissions) {
    const res = await api(owner, '/auth/roles', { method: 'POST', body: { name, permissions } });
    assert.ok(res.status === 200 || res.status === 201, res.text);
    return res.body?.id ?? res.body?.role?.id;
}

before(async () => {
    const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
    worker = await startDevWorker({ port: 8832, inspectorPort: 9262, adminPassword: ADMIN_PASSWORD, seedLegacy: { sql: schema } });
    assert.equal((await api(null, '/auth/setup', { method: 'POST', body: OWNER })).status, 200);
    owner = (await api(null, '/auth/login', { method: 'POST', body: { email: OWNER.email, password: OWNER.password } })).body.token;

    for (const [i, title] of ['Wall Art', 'Banana', 'Coconut', 'Coconut bunch'].entries()) {
        const art = { id: `art_r${i}`, customId: `JG-00${i}`, title, status: i === 3 ? 'Sold' : 'Available', price: 10000 * (i + 1), imageUrls: [] };
        assert.equal((await api(owner, '/artworks', { method: 'POST', body: art })).status, 201);
        arts.push(art);
    }

    curator = await person('Curator', 'curator@example.com', await role('Roster curator', { roster: 'edit' }));
    browser = await person('Browser', 'browser@example.com', await role('Roster viewer', { roster: 'view' }));
    blind = await person('Blind', 'blind@example.com', await role('Nothing', {}));
    staff = await person('Staff', 'staff@example.com');
});

after(async () => { await worker?.stop(); worker?.cleanup(); });

test('the Roster is a section roles grant: Staff browse by default, custom roles as set', async () => {
    const roles = (await api(owner, '/auth/roles')).body;
    assert.equal(roles.find(r => r.id === 'user').permissions.roster, 'view', 'Staff browse, curating is by role');
    assert.equal((await api(curator, '/auth/me')).body.permissions.roster, 'edit');
    assert.equal((await api(browser, '/auth/me')).body.permissions.roster, 'view');
    assert.equal((await api(blind, '/auth/me')).body.permissions.roster, 'none');

    const empty = await api(owner, '/roster');
    assert.equal(empty.status, 200, empty.text);
    assert.deepEqual(empty.body.sections, []);
    assert.equal(empty.body.canEdit, true);
    assert.equal((await api(browser, '/roster')).body.canEdit, false);
    assert.equal((await api(staff, '/roster')).status, 200);
    assert.equal((await api(blind, '/roster')).status, 403);
    assert.equal((await api(null, '/roster')).status, 401);
});

test('browsing the Roster is enough to see the pieces it shows', async () => {
    const seen = await api(browser, '/artworks');
    assert.equal(seen.status, 200, 'a Roster-only role reads artworks');
    assert.equal(seen.body.length, arts.length);
    assert.equal((await api(browser, '/artworks', { method: 'POST', body: { id: 'x', title: 'x' } })).status, 403, 'but cannot add to the inventory');
    assert.equal((await api(blind, '/artworks')).status, 403);
});

test('only curators create, change, arrange and remove sections', async () => {
    const body = { name: 'Jenjum Gadi collection', description: 'Hand-chased brass', artworkIds: [arts[0].id, 'art_missing', arts[1].id], priceDisplay: 'request', backdrop: 'studio' };
    assert.equal((await api(browser, '/roster/sections', { method: 'POST', body })).status, 403);
    assert.equal((await api(staff, '/roster/sections', { method: 'POST', body })).status, 403, 'Staff do not curate by default');
    assert.equal((await api(curator, '/roster/sections', { method: 'POST', body: { ...body, name: '  ' } })).status, 400);

    const made = await api(curator, '/roster/sections', { method: 'POST', body });
    assert.equal(made.status, 201, made.text);
    section = made.body;
    assert.deepEqual(section.artworkIds, [arts[0].id, arts[1].id], 'pieces that do not exist are dropped, order kept');
    assert.equal(section.version, 1);
    assert.equal(section.updatedByName, 'Curator');

    const bad = await api(curator, `/roster/sections/${section.id}`, { method: 'PUT', body: { ...body, priceDisplay: 'nonsense', backdrop: 'neon', version: 1 } });
    assert.equal(bad.status, 200, bad.text);
    assert.equal(bad.body.priceDisplay, 'request', 'unknown choices fall back');
    assert.equal(bad.body.backdrop, 'studio');
    assert.equal(bad.body.version, 2);

    // Someone else's save in between: the stale one is refused, not merged.
    const stale = await api(owner, `/roster/sections/${section.id}`, { method: 'PUT', body: { ...body, name: 'Overwrite', version: 1 } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'stale');
    assert.equal(stale.body.section.version, 2);
    const fresh = await api(owner, `/roster/sections/${section.id}`, { method: 'PUT', body: { ...body, artworkIds: [arts[1].id, arts[0].id, arts[3].id], hideSold: true, priceDisplay: 'price', version: 2 } });
    assert.equal(fresh.status, 200, fresh.text);
    assert.deepEqual(fresh.body.artworkIds, [arts[1].id, arts[0].id, arts[3].id]);
    assert.equal(fresh.body.hideSold, true);
    assert.equal(fresh.body.priceDisplay, 'price');
    section = fresh.body;

    const second = await api(curator, '/roster/sections', { method: 'POST', body: { name: 'New this month', artworkIds: [arts[2].id] } });
    assert.equal(second.status, 201);
    assert.deepEqual((await api(browser, '/roster')).body.sections.map(s => s.name), ['Jenjum Gadi collection', 'New this month']);

    assert.equal((await api(browser, '/roster/order', { method: 'PUT', body: { ids: [second.body.id, section.id] } })).status, 403);
    assert.equal((await api(curator, '/roster/order', { method: 'PUT', body: { ids: [second.body.id] } })).status, 409, 'every section, no more, no less');
    const ordered = await api(curator, '/roster/order', { method: 'PUT', body: { ids: [second.body.id, section.id] } });
    assert.equal(ordered.status, 200, ordered.text);
    assert.deepEqual((await api(staff, '/roster')).body.sections.map(s => s.name), ['New this month', 'Jenjum Gadi collection']);

    assert.equal((await api(browser, `/roster/sections/${second.body.id}`, { method: 'DELETE' })).status, 403);
    assert.equal((await api(curator, `/roster/sections/${second.body.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await api(curator, `/roster/sections/${second.body.id}`, { method: 'DELETE' })).status, 404);

    // Filed for the admin, who can put it back.
    const archived = (await api(owner, '/deleted-items')).body.find(d => d.entity === 'roster_section' && d.entityId === second.body.id);
    assert.ok(archived, 'archived like every delete');
    const restored = await api(owner, `/deleted-items/${archived.id}/restore`, { method: 'POST' });
    assert.equal(restored.status, 200, restored.text);
    const back = (await api(browser, '/roster')).body.sections.find(s => s.id === second.body.id);
    assert.equal(back?.name, 'New this month');
    assert.deepEqual(back.artworkIds, [arts[2].id]);
});

test('favourites are personal, and browsing is enough to keep them', async () => {
    assert.equal((await api(browser, `/roster/favorites/${arts[0].id}`, { method: 'PUT' })).status, 200);
    assert.equal((await api(browser, `/roster/favorites/${arts[2].id}`, { method: 'PUT' })).status, 200);
    assert.equal((await api(browser, `/roster/favorites/${arts[2].id}`, { method: 'PUT' })).status, 200, 'twice is fine');
    assert.equal((await api(browser, '/roster/favorites/art_missing', { method: 'PUT' })).status, 404);
    assert.equal((await api(blind, `/roster/favorites/${arts[0].id}`, { method: 'PUT' })).status, 403);

    assert.deepEqual((await api(browser, '/roster')).body.favorites.sort(), [arts[0].id, arts[2].id].sort());
    assert.deepEqual((await api(curator, '/roster')).body.favorites, [], 'nobody else sees them');

    assert.equal((await api(browser, `/roster/favorites/${arts[2].id}`, { method: 'DELETE' })).status, 200);
    assert.deepEqual((await api(browser, '/roster')).body.favorites, [arts[0].id]);
});

test('an organization whose plan leaves the Roster out: closed to everyone, admins included', async () => {
    const admin = worker.browser();
    assert.equal((await admin.signIn('admin@example.com', ADMIN_PASSWORD)).status, 200);
    assert.equal((await admin.call('/admin/users', { method: 'POST', body: { email: 'org-owner@example.com', name: 'Org Owner', temporaryPassword: USER_PASSWORD } })).status, 201);
    const org = (await admin.call('/admin/orgs', { method: 'POST', body: { name: 'Roster Studio', businessType: 'studio', ownerEmail: 'org-owner@example.com' } })).body;
    const orgOwner = worker.browser();
    assert.equal((await orgOwner.signIn('org-owner@example.com', USER_PASSWORD)).status, 200);
    const app = path => `/api/o/${org.id}${path}`;

    // Plans include the Roster by default.
    const on = await orgOwner.call(app('/roster'));
    assert.equal(on.status, 200, on.text);
    assert.deepEqual((await orgOwner.call(app('/auth/me'))).body.sectionsOff, []);
    const plan = await orgOwner.call(app('/plan'));
    assert.ok(plan.body.modules.includes('Showcase'), 'listed on the plan');

    const off = await admin.call(`/admin/orgs/${org.id}/entitlements`, { method: 'POST', body: { key: 'roster', value: false, reason: 'Not on this plan' } });
    assert.equal(off.status, 200, off.text);
    assert.equal(off.body.limits.modules.roster, false);

    const refused = await orgOwner.call(app('/roster'));
    assert.equal(refused.status, 403, 'refused even to the owner');
    assert.equal(refused.body.code, 'module_off');
    const me = (await orgOwner.call(app('/auth/me'))).body;
    assert.deepEqual(me.sectionsOff, ['roster'], 'the app hides it');
    assert.equal(me.permissions.roster, 'none');
    assert.equal(me.permissions.inventory, 'edit', 'nothing else changes');

    // Back to what the plan says.
    const removed = await admin.call(`/admin/orgs/${org.id}/entitlements/roster`, { method: 'DELETE' });
    assert.equal(removed.status, 200, removed.text);
    assert.equal(removed.body.limits.modules.roster, true, 'the default comes back: an override never changes the defaults');
    const again = await orgOwner.call(app('/roster'));
    assert.equal(again.status, 200, again.text);
});
