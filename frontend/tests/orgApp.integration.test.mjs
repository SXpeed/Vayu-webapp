// The app per organization, against the real Worker: /api/o/<id>/* runs the
// app's own routes on that organization's storage, signed in with a platform
// account. What matters most here is isolation: one organization's people
// can never see or reach another's data, files or members.
//
//   node --test frontend/tests/orgApp.integration.test.mjs
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startDevWorker } from './helpers/devWorker.mjs';

/** A private test address (sign-in is rate limited per address). */
const testAddress = (n, net = '0') => ['10', net, '0', String(n)].join('.');

const ADMIN_PASSWORD = 'provider-admin-password';
const USER_PASSWORD = 'member password 123';

let worker;
let admin;
let ownerA;
let staffA;
let ownerB;
let outsider;
let orgA;
let orgB;
let staffMembershipId;
let inviteToken;
let newPerson;
let newPersonId;

const app = (orgId, path) => `/api/o/${orgId}${path}`;
const post = (b, path, body) => b.call(path, { method: 'POST', body });

/** A multipart upload from one simulated browser (the helper only sends JSON). */
async function upload(b, orgId, bytes, name) {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'image/png' }), name);
    const res = await fetch(`${worker.origin}${app(orgId, '/upload')}`, {
        method: 'POST', body: form,
        headers: { Cookie: [...b.jar].map(([k, v]) => `${k}=${v}`).join('; '), Origin: worker.origin },
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

// The smallest valid PNG: sniffed as an image, so it is stored and shown as one.
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

before(async () => {
    worker = await startDevWorker({ port: 8828, inspectorPort: 9258, adminPassword: ADMIN_PASSWORD, vars: {
        FILE_AUTH: 'on', DELTA_SYNC_ENABLED: 'on', REALTIME_ENABLED: 'on', REALTIME_SECRET: 'a-realtime-secret-for-tests-0123456789',
    } });
    admin = worker.browser();
    assert.equal((await admin.signIn('admin@example.com', ADMIN_PASSWORD)).status, 200);

    for (const [email, name] of [['owner-a@example.com', 'Owner A'], ['staff-a@example.com', 'Staff A'], ['owner-b@example.com', 'Owner B'], ['outsider@example.com', 'Outsider']]) {
        const res = await post(admin, '/admin/users', { email, name, temporaryPassword: USER_PASSWORD });
        assert.equal(res.status, 201, JSON.stringify(res.body));
    }
    const mkOrg = async (name, ownerEmail) => {
        const res = await post(admin, '/admin/orgs', { name, businessType: 'studio', ownerEmail });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        return res.body;
    };
    orgA = await mkOrg('Studio A', 'owner-a@example.com');
    orgB = await mkOrg('Gallery B', 'owner-b@example.com');
    // No plan means the free defaults (3 people); this team needs a few more.
    const roomier = await post(admin, `/admin/orgs/${orgA.id}/entitlements`, { key: 'maxMembers', value: 10, reason: 'Test team' });
    assert.equal(roomier.status, 200, JSON.stringify(roomier.body));
    const added = await post(admin, `/admin/orgs/${orgA.id}/members`, { email: 'staff-a@example.com', role: 'staff' });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    staffMembershipId = added.body.members.find(m => m.email === 'staff-a@example.com')?.id;

    ownerA = worker.browser(); staffA = worker.browser(); ownerB = worker.browser(); outsider = worker.browser();
    for (const [b, email] of [[ownerA, 'owner-a@example.com'], [staffA, 'staff-a@example.com'], [ownerB, 'owner-b@example.com'], [outsider, 'outsider@example.com']]) {
        assert.equal((await b.signIn(email, USER_PASSWORD)).status, 200, email);
    }
});

after(async () => { await worker?.stop(); worker?.cleanup(); });

test('a member opens their organization in the app with their platform sign-in', async () => {
    const me = await ownerA.call(app(orgA.id, '/auth/me'));
    assert.equal(me.status, 200, me.text);
    assert.equal(me.body.email, 'owner-a@example.com');
    assert.equal(me.body.role, 'admin', 'owners run the app');
    assert.equal(me.body.permissions.inventory, 'edit');

    const staff = await staffA.call(app(orgA.id, '/auth/me'));
    assert.equal(staff.status, 200, staff.text);
    assert.equal(staff.body.role, 'user', 'staff start with the Staff role');
});

test('one organization never sees another\'s data', async () => {
    const created = await post(ownerA, app(orgA.id, '/artworks'), { id: 'art-a-1', title: 'Monsoon Study', price: 1200 });
    assert.equal(created.status, 201, created.text);

    const inA = await staffA.call(app(orgA.id, '/artworks'));
    assert.equal(inA.status, 200, inA.text);
    assert.deepEqual(inA.body.map(a => a.id), ['art-a-1'], 'a teammate sees it');

    const inB = await ownerB.call(app(orgB.id, '/artworks'));
    assert.equal(inB.status, 200, inB.text);
    assert.deepEqual(inB.body, [], 'the other organization has its own, empty, database');

    // The same id in B is a different record in a different database.
    assert.equal((await post(ownerB, app(orgB.id, '/artworks'), { id: 'art-a-1', title: 'Unrelated' })).status, 201);
    const again = await ownerA.call(app(orgA.id, '/artworks'));
    assert.equal(again.body[0].title, 'Monsoon Study');
});

test('admins see their plan and what they use of it; staff cannot', async () => {
    const res = await ownerA.call(app(orgA.id, '/plan'));
    assert.equal(res.status, 200, res.text);
    const row = key => res.body.usage.find(r => r.key === key);
    assert.ok(row('maxItems').used >= 1, 'the artwork made above counts');
    assert.ok(row('maxMembers').used >= 2, 'owner and staff hold seats');
    assert.equal(row('maxMembers').enforced, true);
    assert.ok('limit' in row('maxItems'), 'each row carries its limit (null = unlimited)');
    assert.equal(row('pdfGenerationsPerMonth').used, null, 'not recorded yet, shown as such');
    assert.equal(row('invoicesPerMonth').period, 'month');
    assert.ok(Array.isArray(res.body.modules) && res.body.modules.includes('Inventory'));
    assert.equal((await staffA.call(app(orgA.id, '/plan'))).status, 403, 'staff do not see the plan');
});

test('the address alone opens nothing: non-members, strangers and made-up ids get the same answer', async () => {
    for (const [who, b] of [['owner of B', ownerB], ['signed-in outsider', outsider]]) {
        const res = await b.call(app(orgA.id, '/artworks'));
        assert.equal(res.status, 404, `${who}: ${res.text}`);
    }
    assert.equal((await ownerA.call(app('00000000-0000-0000-0000-000000000000', '/artworks'))).status, 404);
    assert.equal((await worker.browser().call(app(orgA.id, '/artworks'))).status, 401, 'no sign-in');
    // The original app's routes don't take a platform sign-in at all.
    assert.equal((await ownerA.call('/api/artworks')).status, 401);
});

test('changes must come from our own pages', async () => {
    const res = await ownerA.call(app(orgA.id, '/artworks'), { method: 'POST', body: { id: 'x', title: 'x' }, headers: { Origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
});

test('the team is the organization\'s members, nobody else', async () => {
    const team = await staffA.call(app(orgA.id, '/auth/team'));
    assert.equal(team.status, 200, team.text);
    assert.deepEqual(team.body.map(u => u.email).sort(), ['owner-a@example.com', 'staff-a@example.com']);
    const teamB = await ownerB.call(app(orgB.id, '/auth/team'));
    assert.deepEqual(teamB.body.map(u => u.email), ['owner-b@example.com']);
});

test('files are stored per organization and served only to its members', async () => {
    const up = await upload(ownerA, orgA.id, PNG, 'study.png');
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.ok(up.body.url.startsWith(`/api/o/${orgA.id}/files/`), up.body.url);

    assert.equal((await staffA.call(up.body.url)).status, 200, 'a teammate can open it');
    assert.equal((await ownerB.call(up.body.url)).status, 404, 'another organization cannot');
    // Through B's own address, the same key names nothing: B has its own files.
    const key = up.body.url.slice(`/api/o/${orgA.id}/files/`.length);
    assert.equal((await ownerB.call(app(orgB.id, `/files/${key}`))).status, 404);
    assert.equal((await worker.browser().call(up.body.url)).status, 401, 'no sign-in, no file');
});

test('delta sync and realtime run per organization', async () => {
    // Each organization's change log is its own: B's sync from the start
    // carries B's artwork and never A's.
    const sync = await ownerB.call(app(orgB.id, '/sync?cursor=0'));
    assert.equal(sync.status, 200, sync.text);
    const changes = JSON.stringify(sync.body.changes);
    assert.match(changes, /Unrelated/);
    assert.doesNotMatch(changes, /Monsoon Study/);

    // Realtime tickets name the organization's own hub.
    const hubOf = async (b, orgId) => {
        const res = await post(b, app(orgId, '/realtime/ticket'), {});
        assert.equal(res.status, 200, res.text);
        return JSON.parse(Buffer.from(res.body.ticket.split('.')[1], 'base64url').toString()).wid;
    };
    const [hubA, hubB] = [await hubOf(ownerA, orgA.id), await hubOf(ownerB, orgB.id)];
    assert.equal(hubA, `org-${orgA.id}`);
    assert.equal(hubB, `org-${orgB.id}`);
});

test('admins invite people by email; staff cannot', async () => {
    const refused = await post(staffA, app(orgA.id, '/team/invitations'), { email: 'x@example.com', role: 'user' });
    assert.equal(refused.status, 403);
    const direct = await post(ownerA, app(orgA.id, '/auth/users'), { name: 'X', email: 'x@example.com', password: 'whatever-long', role: 'user' });
    assert.equal(direct.status, 400, 'no creating accounts with passwords from inside a workspace');
    assert.equal(direct.body.code, 'use_invitations');

    const res = await post(ownerA, app(orgA.id, '/team/invitations'), { email: 'New.Person@Example.com', role: 'user' });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.invitation.email, 'new.person@example.com');
    // Email is off in this test, so the admin is given the link to pass on.
    assert.equal(res.body.emailSent, false);
    assert.match(res.body.link, /\/join\/[0-9a-f]{64}$/);
    inviteToken = res.body.link.split('/join/')[1];

    const listed = await ownerA.call(app(orgA.id, '/team/invitations'));
    assert.deepEqual(listed.body.map(i => [i.email, i.status]), [['new.person@example.com', 'pending']]);
});

test('the join page can read an invitation; only its own address can accept it', async () => {
    const info = await worker.browser().call(`/invitations/${inviteToken}`);
    assert.equal(info.status, 200, info.text);
    assert.equal(info.body.orgName, 'Studio A');
    assert.equal(info.body.state, 'open');
    assert.equal(info.body.hasAccount, false);

    const wrong = await post(outsider, `/invitations/${inviteToken}/accept`, {});
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.code, 'wrong_account');
    assert.equal((await worker.browser().call('/invitations/' + '0'.repeat(64))).status, 404, 'made-up token');
});

test('someone new creates their account through the invitation and is in', async () => {
    const created = await post(worker.browser(), `/invitations/${inviteToken}/create-account`, { name: 'New Person', password: 'a new password 1' });
    assert.equal(created.status, 200, created.text);
    assert.equal(created.body.orgId, orgA.id);

    newPerson = worker.browser();
    // Sign-in is rate limited per address; this one comes from another.
    const signIn = await newPerson.call('/auth/sign-in/email', {
        method: 'POST', body: { email: 'new.person@example.com', password: 'a new password 1' }, headers: { 'cf-connecting-ip': testAddress(9, '0') },
    });
    assert.equal(signIn.status, 200, signIn.text);
    const me = await newPerson.call(app(orgA.id, '/auth/me'));
    assert.equal(me.status, 200, me.text);
    assert.equal(me.body.role, 'user');
    newPersonId = me.body.id;

    // Used once: the link can't make another account or be used again.
    const again = await post(worker.browser(), `/invitations/${inviteToken}/create-account`, { name: 'Someone', password: 'another password 1' });
    assert.equal(again.status, 409);
    assert.equal((await worker.browser().call(`/invitations/${inviteToken}`)).body.state, 'used');
});

test('an existing account accepts as admin; an app role change moves the platform role with it', async () => {
    const res = await post(ownerA, app(orgA.id, '/team/invitations'), { email: 'outsider@example.com', role: 'admin' });
    assert.equal(res.status, 201, res.text);
    const token = res.body.link.split('/join/')[1];
    const accepted = await post(outsider, `/invitations/${token}/accept`, {});
    assert.equal(accepted.status, 200, accepted.text);

    const me = await outsider.call(app(orgA.id, '/auth/me'));
    assert.equal(me.body.role, 'admin');
    const roleOf = async (email) => (await admin.call(`/admin/orgs/${orgA.id}`)).body.members.find(m => m.email === email)?.role;
    assert.equal(await roleOf('outsider@example.com'), 'admin');

    const demoted = await ownerA.call(app(orgA.id, `/auth/users/${me.body.id}`), { method: 'PUT', body: { role: 'user' } });
    assert.equal(demoted.status, 200, demoted.text);
    assert.equal(await roleOf('outsider@example.com'), 'staff');
});

test('the owner keeps full access and can\'t be removed', async () => {
    const ownerId = (await ownerA.call(app(orgA.id, '/auth/me'))).body.id;
    const byOther = await outsider.call(app(orgA.id, `/auth/users/${ownerId}`), { method: 'DELETE' });
    assert.equal(byOther.status, 403, 'only admins manage the team');
    // Make the outsider an admin again to try as an admin.
    const outsiderId = (await outsider.call(app(orgA.id, '/auth/me'))).body.id;
    await ownerA.call(app(orgA.id, `/auth/users/${outsiderId}`), { method: 'PUT', body: { role: 'admin' } });
    assert.equal((await outsider.call(app(orgA.id, `/auth/users/${ownerId}`), { method: 'DELETE' })).status, 400);
    assert.equal((await outsider.call(app(orgA.id, `/auth/users/${ownerId}`), { method: 'PUT', body: { role: 'user' } })).status, 400);
});

test('removing someone from the team ends their access', async () => {
    const res = await ownerA.call(app(orgA.id, `/auth/users/${newPersonId}`), { method: 'DELETE' });
    assert.equal(res.status, 200, res.text);
    assert.equal((await newPerson.call(app(orgA.id, '/artworks'))).status, 404);
    const team = await ownerA.call(app(orgA.id, '/auth/team'));
    assert.ok(!team.body.some(u => u.email === 'new.person@example.com'));
});

test('an invitation can be withdrawn; its link stops working', async () => {
    const res = await post(ownerA, app(orgA.id, '/team/invitations'), { email: 'later@example.com', role: 'user' });
    const token = res.body.link.split('/join/')[1];
    assert.equal((await ownerA.call(app(orgA.id, `/team/invitations/${res.body.invitation.id}`), { method: 'DELETE' })).status, 200);
    assert.equal((await worker.browser().call(`/invitations/${token}`)).body.state, 'closed');
    assert.equal((await post(worker.browser(), `/invitations/${token}/create-account`, { name: 'L', password: 'later password 1' })).status, 409);
});

test('removing someone takes effect on their next request', async () => {
    assert.ok(staffMembershipId, 'membership id');
    const res = await admin.call(`/admin/orgs/${orgA.id}/members/${staffMembershipId}`, { method: 'PATCH', body: { status: 'disabled' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await staffA.call(app(orgA.id, '/artworks'))).status, 404);
    const team = await ownerA.call(app(orgA.id, '/auth/team'));
    assert.ok(!team.body.some(u => u.email === 'staff-a@example.com'), 'and they leave the team list');
});

test('a paused organization is closed to its members', async () => {
    const paused = await post(admin, `/admin/orgs/${orgB.id}/status`, { status: 'suspended', reason: 'Testing' });
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    const res = await ownerB.call(app(orgB.id, '/artworks'));
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'org_inactive');
});
