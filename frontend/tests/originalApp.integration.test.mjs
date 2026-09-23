// Connecting the original app's data (Vayu) to an organization, against the
// real Worker: nothing is moved; the organization works on the original
// storage, and the original app's people come in with their own passwords
// and ids, so their history stays theirs. Old installs keep working meanwhile.
//
//   node --test frontend/tests/originalApp.integration.test.mjs
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { startDevWorker } from './helpers/devWorker.mjs';

/** A private test address (sign-in is rate limited per address). */
const testAddress = (n, net = '0') => ['10', net, '0', String(n)].join('.');

const ADMIN_PASSWORD = 'provider-admin-password';
const OWNER_PLATFORM_PASSWORD = 'owner platform password';
const STAFF_OLD_PASSWORD = 'staff old password';

/** The original app's password hash: PBKDF2-SHA256, 100k rounds, "salt.hash" in base64. */
function legacyHash(password) {
    const salt = randomBytes(16);
    return `${salt.toString('base64')}.${pbkdf2Sync(password, salt, 100_000, 32, 'sha256').toString('base64')}`;
}

let worker;
let admin;
let org;

const post = (b, path, body, headers) => b.call(path, { method: 'POST', body, headers });
const app = (path) => `/api/o/${org.id}${path}`;
/** Sign-in is rate limited per address; each person here comes from their own. */
const signIn = (b, email, password, ip) => post(b, '/auth/sign-in/email', { email, password }, { 'cf-connecting-ip': ip });

before(async () => {
    const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
    const now = Date.now();
    worker = await startDevWorker({
        port: 8832, inspectorPort: 9262, adminPassword: ADMIN_PASSWORD,
        seedLegacy: {
            sql: `${schema}\nINSERT INTO artworks (id, custom_id, title, status, price, image_urls, created_at) VALUES ('vayu-art-1', 'V-001', 'Old Banyan', 'Available', 50000, '[]', ${now});`,
            kv: [
                ['auth:user:admin_1700000000000', { id: 'admin_1700000000000', name: 'Vayu Owner', email: 'owner@vayu.example', role: 'admin', createdAt: now - 1000, hashedPassword: legacyHash('owner old password') }],
                ['auth:user:user_1700000000001', { id: 'user_1700000000001', name: 'Vayu Staff', email: 'staff@vayu.example', role: 'user', storeId: 'store-1', createdAt: now, hashedPassword: legacyHash(STAFF_OLD_PASSWORD) }],
                ['auth:email:owner@vayu.example', 'admin_1700000000000'],
                ['auth:email:staff@vayu.example', 'user_1700000000001'],
            ],
        },
    });
    admin = worker.browser();
    assert.equal((await admin.signIn('admin@example.com', ADMIN_PASSWORD)).status, 200);

    // The owner already has a platform account (as the owner of Vayu does),
    // with a different id from their original app id.
    assert.equal((await post(admin, '/admin/users', { email: 'owner@vayu.example', name: 'Vayu Owner', temporaryPassword: OWNER_PLATFORM_PASSWORD })).status, 201);
    const created = await post(admin, '/admin/orgs', { name: 'Vayu', businessType: 'gallery', ownerEmail: 'owner@vayu.example' });
    assert.equal(created.status, 201, created.text);
    org = created.body;
});

after(async () => { await worker?.stop(); worker?.cleanup(); });

test('connecting needs a typed confirmation, and only one organization can have the original data', async () => {
    const unconfirmed = await post(admin, `/admin/orgs/${org.id}/app-storage`, { storage: 'original' });
    assert.equal(unconfirmed.status, 400);
    const ok = await post(admin, `/admin/orgs/${org.id}/app-storage`, { storage: 'original', confirm: org.slug });
    assert.equal(ok.status, 200, ok.text);
    assert.equal((await admin.call(`/admin/orgs/${org.id}`)).body.app_storage, 'original');

    const other = (await post(admin, '/admin/orgs', { name: 'Someone Else', businessType: 'studio', ownerEmail: 'owner@vayu.example' })).body;
    const second = await post(admin, `/admin/orgs/${other.id}/app-storage`, { storage: 'original', confirm: other.slug });
    assert.equal(second.status, 409);
});

test('bringing the people in: a dry run first, then for real, and again changes nothing', async () => {
    const dry = await post(admin, `/admin/orgs/${org.id}/import-original-people`, {});
    assert.equal(dry.status, 200, dry.text);
    assert.equal(dry.body.mode, 'dry_run');
    assert.equal(dry.body.found, 2);
    assert.equal(dry.body.accountsMatched, 1, 'the owner keeps their platform account');
    assert.equal(dry.body.accountsCreated, 1);
    assert.equal((await admin.call(`/admin/orgs/${org.id}`)).body.members.length, 1, 'a dry run writes nothing');

    const run = await post(admin, `/admin/orgs/${org.id}/import-original-people`, { dryRun: false });
    assert.equal(run.status, 200, run.text);
    const members = (await admin.call(`/admin/orgs/${org.id}`)).body.members;
    assert.deepEqual(members.map(m => [m.email, m.role]), [['owner@vayu.example', 'owner'], ['staff@vayu.example', 'staff']]);

    const again = await post(admin, `/admin/orgs/${org.id}/import-original-people`, { dryRun: false });
    assert.equal(again.body.membershipsAdded, 0);
    assert.equal(again.body.alreadyMembers, 2);
});

test('staff sign in with their old password and work on the same data, as themselves', async () => {
    const staff = worker.browser();
    const res = await signIn(staff, 'staff@vayu.example', STAFF_OLD_PASSWORD, testAddress(1, '1'));
    assert.equal(res.status, 200, res.text);

    const me = await staff.call(app('/auth/me'));
    assert.equal(me.status, 200, me.text);
    assert.equal(me.body.id, 'user_1700000000001', 'their original id');
    assert.equal(me.body.storeId, 'store-1', 'and their original record');

    const artworks = await staff.call(app('/artworks'));
    assert.deepEqual(artworks.body.map(a => a.title), ['Old Banyan'], 'the original database, not a new one');
});

test('someone who already had an account keeps it and their original app id', async () => {
    const owner = worker.browser();
    assert.equal((await signIn(owner, 'owner@vayu.example', OWNER_PLATFORM_PASSWORD, testAddress(2, '1'))).status, 200);
    const me = await owner.call(app('/auth/me'));
    assert.equal(me.status, 200, me.text);
    assert.equal(me.body.id, 'admin_1700000000000');
    assert.equal(me.body.role, 'admin');

    const team = await owner.call(app('/auth/team'));
    assert.deepEqual(team.body.map(u => u.id).sort(), ['admin_1700000000000', 'user_1700000000001']);
});

test('old installs keep signing in the original way meanwhile', async () => {
    const res = await fetch(`${worker.origin}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': testAddress(3, '1') },
        body: JSON.stringify({ email: 'staff@vayu.example', password: STAFF_OLD_PASSWORD }),
    });
    assert.equal(res.status, 200);
    const { token } = await res.json();
    const artworks = await fetch(`${worker.origin}/api/artworks`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(artworks.status, 200);
    assert.equal((await artworks.json())[0].title, 'Old Banyan');
});
