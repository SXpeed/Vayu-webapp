// Moving the original single-business app into its own organization.
//
// Runs the real Worker (Durable Objects), seeds the legacy shared database and
// legacy KV users, then checks the dry run, the import, and that a retry
// changes nothing.
//
//   node --test frontend/tests/legacyImport.integration.test.mjs
import assert from 'node:assert/strict';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startDevWorker } from './helpers/devWorker.mjs';

const ADMIN_PASSWORD = 'provider-admin-password';
const LEGACY_PASSWORD = 'legacy-user-password';

let worker;
let admin;
let orgVayu;
let orgOther;

/** The legacy app's PBKDF2 format: base64(salt).base64(hash). */
function legacyHash(password) {
    const salt = randomBytes(16);
    return `${salt.toString('base64')}.${pbkdf2Sync(password, salt, 100_000, 32, 'sha256').toString('base64')}`;
}

before(async () => {
    // Seeds the legacy shared database and KV exactly as the current app has
    // them, before the Worker starts.
    worker = await startDevWorker({ port: 8812, inspectorPort: 9242, adminPassword: ADMIN_PASSWORD, seedLegacy: {
        sql: [
            `CREATE TABLE IF NOT EXISTS artworks (id TEXT PRIMARY KEY, custom_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
               artist TEXT DEFAULT '', artwork_year TEXT DEFAULT '', description_title TEXT DEFAULT '', description TEXT DEFAULT '',
               dimensions TEXT DEFAULT '', medium TEXT DEFAULT '', status TEXT DEFAULT 'Available', location TEXT DEFAULT '',
               price REAL DEFAULT 0, plus_gst INTEGER DEFAULT 0, image_urls TEXT DEFAULT '[]', created_at INTEGER NOT NULL)`,
            `CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', description TEXT DEFAULT '',
               artwork_ids TEXT DEFAULT '[]', cover_image_url TEXT DEFAULT '', created_at INTEGER NOT NULL)`,
            `CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, invoice_number TEXT NOT NULL DEFAULT '', customer_name TEXT NOT NULL DEFAULT '',
               status TEXT NOT NULL DEFAULT 'Draft', date INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}',
               created_by TEXT, created_by_name TEXT, updated_at INTEGER NOT NULL DEFAULT 0)`,
            `INSERT OR REPLACE INTO artworks (id, custom_id, title, artist, price, status, image_urls, created_at)
               VALUES ('art-1', 'VD-001', 'Monsoon I', 'R. Sahni', 42000, 'Available', '["/api/files/uploads/u1/a.jpg"]', 1700000000000),
                      ('art-2', 'VD-002', 'Monsoon II', 'R. Sahni', 51000, 'Sold', '[]', 1700000100000)`,
            `INSERT OR REPLACE INTO collections (id, name, artwork_ids, created_at)
               VALUES ('col-1', 'Monsoon Collection', '["art-1","art-2"]', 1700000200000)`,
            `INSERT OR REPLACE INTO invoices (id, invoice_number, customer_name, status, date, data, updated_at)
               VALUES ('inv-1', 'INV-001', 'A Buyer', 'Paid', 1700000300000, '{"total":51000}', 1700000300000)`,
        ],
        kv: [
            ['auth:user:legacy-admin', { id: 'legacy-admin', name: 'Vayu Admin', email: 'vayu.admin@example.com', role: 'admin', password: legacyHash(LEGACY_PASSWORD) }],
            ['auth:user:legacy-staff', { id: 'legacy-staff', name: 'Vayu Staff', email: 'vayu.staff@example.com', role: 'user', password: legacyHash(LEGACY_PASSWORD) }],
        ],
    } });

    admin = worker.browser();
    assert.equal((await admin.signIn('admin@example.com', ADMIN_PASSWORD)).status, 200);
    const mk = async (name, type, ownerEmail) => {
        await admin.call('/admin/users', { method: 'POST', body: { email: ownerEmail, name, temporaryPassword: 'owner-password-123' } });
        const res = await admin.call('/admin/orgs', { method: 'POST', body: { name, businessType: type, ownerEmail } });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        return res.body;
    };
    orgVayu = await mk('Vayu Design', 'gallery', 'vayu.owner@example.com');
    orgOther = await mk('Someone Else', 'studio', 'other.owner@example.com');
});

after(async () => { await worker?.stop(); worker?.cleanup(); });

const importInto = (org, body) => admin.call(`/admin/orgs/${org.id}/import-legacy`, { method: 'POST', body });

test('a dry run reports what would move and writes nothing', async () => {
    const res = await importInto(orgVayu, { ownerEmail: 'vayu.admin@example.com' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const report = res.body;
    assert.equal(report.mode, 'dry_run');
    assert.equal(report.users.found, 2);
    assert.equal(report.users.created, 2);
    assert.equal(report.users.owner, 'vayu.admin@example.com');
    assert.equal(report.tables.artworks.source, 2);
    assert.equal(report.tables.artworks.inserted, 0);
    assert.equal(report.tables.collections.source, 1);
    assert.equal(report.tables.invoices.source, 1);

    // Nothing was created anywhere.
    const org = (await admin.call(`/admin/orgs/${orgVayu.id}`)).body;
    assert.equal(org.members.length, 1, 'still only the owner created at setup');
    assert.deepEqual((await admin.call(`/admin/orgs/${orgVayu.id}/import-legacy`)).body.imports, []);
});

test('the import moves users, memberships and business rows, keeping ids', async () => {
    const res = await importInto(orgVayu, { ownerEmail: 'vayu.admin@example.com', dryRun: false });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.mode, 'run');
    assert.equal(res.body.tables.artworks.inserted, 2);
    assert.equal(res.body.tables.collections.inserted, 1);
    assert.equal(res.body.tables.invoices.inserted, 1);

    const org = (await admin.call(`/admin/orgs/${orgVayu.id}`)).body;
    const byEmail = Object.fromEntries(org.members.map(m => [m.email, m.role]));
    // The organization already had an owner, so the legacy admin comes in as admin.
    assert.equal(byEmail['vayu.admin@example.com'], 'admin');
    assert.equal(byEmail['vayu.staff@example.com'], 'staff');

    // The imported people can sign in with their existing passwords.
    const staff = worker.browser();
    assert.equal((await staff.signIn('vayu.staff@example.com', LEGACY_PASSWORD)).status, 200);
    const artworks = (await staff.call(`/org/${orgVayu.id}/artworks`)).body.artworks;
    assert.deepEqual(artworks.map(a => a.id).sort(), ['art-1', 'art-2'], 'ids are preserved');
    const monsoon = artworks.find(a => a.id === 'art-1');
    assert.equal(monsoon.customId, 'VD-001');
    assert.equal(monsoon.price, 42000);
    assert.equal(monsoon.createdAt, 1700000000000, 'timestamps are preserved');
    assert.deepEqual(monsoon.imageUrls, ['/api/files/uploads/u1/a.jpg']);
    assert.equal(artworks.find(a => a.id === 'art-2').status, 'Sold');

    const record = (await admin.call(`/admin/orgs/${orgVayu.id}/import-legacy`)).body.imports[0];
    assert.equal(record.status, 'done');
    assert.equal(record.mode, 'run');
});

test('running it again changes nothing (safe to retry)', async () => {
    const res = await importInto(orgVayu, { ownerEmail: 'vayu.admin@example.com', dryRun: false });
    assert.equal(res.body.tables.artworks.inserted, 0);
    assert.equal(res.body.tables.artworks.alreadyThere, 2);
    assert.equal(res.body.users.created, 0);
    assert.equal(res.body.users.matchedExisting, 2);
    assert.equal(res.body.users.memberships, 0);

    const org = (await admin.call(`/admin/orgs/${orgVayu.id}`)).body;
    assert.equal(org.members.length, 3, 'no duplicate memberships');
    const staff = worker.browser();
    await staff.signIn('vayu.staff@example.com', LEGACY_PASSWORD);
    assert.equal((await staff.call(`/org/${orgVayu.id}/artworks`)).body.artworks.length, 2, 'no duplicate artworks');
});

test('imported data belongs to that organization alone', async () => {
    const other = worker.browser();
    await other.signIn('other.owner@example.com', 'owner-password-123');
    assert.equal((await other.call(`/org/${orgOther.id}/artworks`)).body.artworks.length, 0);
    assert.equal((await other.call(`/org/${orgVayu.id}/artworks`)).status, 403);

    // An imported member of Vayu cannot reach the other organization either.
    const staff = worker.browser();
    await staff.signIn('vayu.staff@example.com', LEGACY_PASSWORD);
    assert.equal((await staff.call(`/org/${orgOther.id}/artworks`)).status, 403);
});

test('the original database is left untouched', async () => {
    // Read after the Worker stops, so nothing else holds the database file.
    await worker.stop();
    const rows = worker.queryLegacy('SELECT COUNT(*) AS n FROM artworks');
    assert.equal(rows[0].n, 2, 'the app keeps working from its own database during and after the move');
});
