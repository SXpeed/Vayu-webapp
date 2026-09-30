// The sales ledger against a real local Worker: who can see and who can
// record, selling an inventory piece (it turns Sold; a second sale is refused),
// retried uploads, snapshots that outlive a deleted piece, deleting a sale
// (the piece is available again, the number is never reused), editing, and
// the summary maths.
//
//   node --test frontend/tests/sales.integration.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { sessionTokenFrom, withSessionToken } from './helpers/session.mjs';
import { startDevWorker } from './helpers/devWorker.mjs';

const OWNER = { name: 'Aarav Shah', email: 'owner@example.com', password: 'owner-password-1234' };
const DAY = '2026-09-15';

// The table as it first shipped (before tags and photos), so every run also
// checks that a live workspace's table gains the new columns on first use.
const SALES_TABLE_V1 = `CREATE TABLE sales (
    id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, sale_number TEXT NOT NULL, artwork_id TEXT,
    item_title TEXT NOT NULL DEFAULT '', item_price REAL NOT NULL DEFAULT 0, contact_id TEXT,
    buyer_name TEXT NOT NULL DEFAULT '', buyer_phone TEXT NOT NULL DEFAULT '', sale_date TEXT NOT NULL,
    recorded_at INTEGER NOT NULL, amount REAL NOT NULL DEFAULT 0, payment_mode TEXT NOT NULL,
    reference_no TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', created_by TEXT,
    created_by_name TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL, updated_by TEXT,
    deleted_at INTEGER, deleted_by TEXT, deleted_by_name TEXT NOT NULL DEFAULT ''
);
INSERT INTO sales (id, seq, sale_number, item_title, buyer_name, sale_date, recorded_at, amount, payment_mode, updated_at)
VALUES ('sale_from_before_tags', 1, 'SAL-001', 'Recorded before tags', 'Early buyer', '2026-06-10', 1, 100, 'Cash', 1);`;
const MONTH = { from: '2026-09-01', to: '2026-09-30' };

let worker;
let owner;     // admin
let accounts;  // custom role: Sales "Record", nothing else
let staff;     // built-in Staff: Sales "View"
let outsider;  // custom role without Sales

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
    return login.body.token;
}

async function role(name, permissions) {
    const res = await api(owner, '/auth/roles', { method: 'POST', body: { name, permissions } });
    assert.equal(res.status, 201, res.text);
    return res.body.id;
}

let artSeq = 0;
async function artwork(title, price, status = 'Available') {
    const id = `art_test_${++artSeq}`;
    const res = await api(owner, '/artworks', { method: 'POST', body: { id, customId: `VS-${artSeq}`, title, price, status, imageUrls: [`/api/files/${id}.jpg`], createdAt: Date.now() } });
    assert.equal(res.status, 201, res.text);
    return id;
}

const statusOf = async (id) => (await api(owner, '/artworks')).body.find(a => a.id === id)?.status;
const month = (token = owner) => api(token, `/sales?from=${MONTH.from}&to=${MONTH.to}`);
const sale = (extra = {}) => ({
    artworkId: null, itemTitle: '', itemPrice: 0, contactId: null, buyerName: 'Meera Kapoor', buyerPhone: '98200 11111',
    saleDate: DAY, amount: 50_000, paymentMode: 'UPI', referenceNo: '', notes: '', ...extra,
});

before(async () => {
    const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
    worker = await startDevWorker({ seedLegacy: { sql: `${schema}
${SALES_TABLE_V1}` } });
    assert.equal((await api(null, '/auth/setup', { method: 'POST', body: OWNER })).status, 200);
    owner = (await api(null, '/auth/login', { method: 'POST', body: { email: OWNER.email, password: OWNER.password } })).body.token;
    accounts = await person('Accounts', 'accounts@example.com', await role('Accounts', { sales: 'edit' }));
    staff = await person('Priya Mehta', 'priya@example.com');
    outsider = await person('Stock Keeper', 'stock@example.com', await role('Stock', { inventory: 'edit' }));
});

after(async () => { await worker?.stop(); worker?.cleanup(); });

test('Record can record; Staff only see; no Sales permission, no sales', async () => {
    const art = await artwork('Monsoon Study', 120_000);
    assert.equal((await api(null, '/sales')).status, 401);
    assert.equal((await month(outsider)).status, 403, 'a role without Sales sees nothing');
    assert.equal((await api(outsider, '/sales', { method: 'POST', body: sale() })).status, 403);
    assert.equal((await month(staff)).status, 200, 'Staff see the ledger by default');
    assert.equal((await api(staff, '/sales', { method: 'POST', body: sale({ artworkId: art }) })).status, 403, 'but cannot record');
    assert.equal(await statusOf(art), 'Available', 'a refused sale changes nothing');

    // Recording needs the available pieces, so Sales can read the inventory.
    const pieces = await api(accounts, '/artworks');
    assert.equal(pieces.status, 200);
    assert.ok(pieces.body.some(a => a.id === art));
    assert.equal((await api(accounts, `/artworks/${art}`, { method: 'PUT', body: { title: 'x' } })).status, 403, 'but not change it');
});

test('selling a piece marks it Sold, keeps a snapshot, and a second sale is refused', async () => {
    const art = await artwork('Indigo Field', 85_000);
    const made = await api(accounts, '/sales', { method: 'POST', body: sale({ artworkId: art, itemTitle: 'ignored', itemPrice: 1, amount: 80_000, paymentMode: 'Card', referenceNo: 'AUTH 4411' }) });
    assert.equal(made.status, 201, made.text);
    assert.match(made.body.saleNumber, /^SAL-\d{3}$/);
    assert.equal(made.body.itemTitle, 'Indigo Field', 'the title comes from the piece');
    assert.equal(made.body.itemPrice, 85_000, 'and so does the price');
    assert.equal(made.body.inInventory, true);
    assert.equal(made.body.imageUrl, `/api/files/${art}.jpg`);
    assert.equal(await statusOf(art), 'Sold');

    const again = await api(owner, '/sales', { method: 'POST', body: sale({ artworkId: art }) });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'That piece is already sold');

    const reserved = await artwork('Held for a client', 40_000, 'Reserved');
    const r = await api(owner, '/sales', { method: 'POST', body: sale({ artworkId: reserved }) });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'reserved');
    assert.equal(await statusOf(reserved), 'Reserved');

    assert.equal((await api(owner, '/sales', { method: 'POST', body: sale({ artworkId: 'art_gone' }) })).status, 404);
});

test('an upload retried with the same id returns the first sale, not a second', async () => {
    const id = 'sale_offline0000000001';
    const first = await api(accounts, '/sales', { method: 'POST', body: { ...sale({ itemTitle: 'Gift card' }), id } });
    assert.equal(first.status, 201, first.text);
    const retry = await api(accounts, '/sales', { method: 'POST', body: { ...sale({ itemTitle: 'Gift card' }), id } });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.saleNumber, first.body.saleNumber);
    assert.equal((await month()).body.sales.filter(s => s.id === id).length, 1);
    assert.equal((await api(accounts, '/sales', { method: 'POST', body: { ...sale(), id: 'not-a-sale-id' } })).status, 400);
});

test('bad sales are refused with a reason', async () => {
    const post = (s) => api(owner, '/sales', { method: 'POST', body: s });
    assert.equal((await post(sale())).status, 400, 'no piece and no description');
    assert.equal((await post(sale({ itemTitle: 'Frame', buyerName: ' ' }))).status, 400);
    assert.equal((await post(sale({ itemTitle: 'Frame', amount: 0 }))).status, 400);
    assert.equal((await post(sale({ itemTitle: 'Frame', amount: 10.005 }))).status, 400, 'at most paise');
    assert.equal((await post(sale({ itemTitle: 'Frame', paymentMode: 'Barter' }))).status, 400);
    assert.equal((await post(sale({ itemTitle: 'Frame', saleDate: '2099-01-01' }))).status, 400, 'not in the future');
    assert.equal((await post(sale({ itemTitle: 'Frame', saleDate: '15/09/2026' }))).status, 400);
    assert.equal((await api(owner, '/sales?from=2026-09-30&to=2026-09-01')).status, 400);
    assert.equal((await api(owner, '/sales?from=2024-01-01&to=2026-09-30')).status, 400, 'at most a year at a time');
});

test('deleting a piece leaves its sale intact', async () => {
    const art = await artwork('Harbour at Dusk', 64_000);
    const made = await api(accounts, '/sales', { method: 'POST', body: sale({ artworkId: art, amount: 60_000 }) });
    assert.equal(made.status, 201, made.text);
    assert.equal((await api(owner, `/artworks/${art}`, { method: 'DELETE' })).status, 200);
    const kept = (await month()).body.sales.find(s => s.id === made.body.id);
    assert.ok(kept, 'the sale is still in the ledger');
    assert.equal(kept.itemTitle, 'Harbour at Dusk');
    assert.equal(kept.itemPrice, 64_000);
    assert.equal(kept.artworkId, art);
    assert.equal(kept.inInventory, false, 'marked as removed from the inventory');
    assert.equal(kept.imageUrl, null);
});

test('deleting a sale puts the piece back on sale; numbers are never reused', async () => {
    const art = await artwork('Salt Pans', 30_000);
    const made = await api(accounts, '/sales', { method: 'POST', body: sale({ artworkId: art, amount: 30_000 }) });
    assert.equal(await statusOf(art), 'Sold');
    assert.equal((await api(staff, `/sales/${made.body.id}`, { method: 'DELETE' })).status, 403);
    assert.equal((await api(accounts, `/sales/${made.body.id}`, { method: 'DELETE' })).status, 200);
    assert.equal(await statusOf(art), 'Available');
    assert.equal((await month()).body.sales.some(s => s.id === made.body.id), false);
    assert.equal((await api(accounts, `/sales/${made.body.id}`, { method: 'DELETE' })).status, 404, 'once');
    assert.equal((await api(accounts, '/sales', { method: 'POST', body: { ...sale({ itemTitle: 'x' }), id: made.body.id } })).status, 410, 'a late retry does not bring it back');

    const resold = await api(accounts, '/sales', { method: 'POST', body: sale({ artworkId: art, amount: 29_000 }) });
    assert.equal(resold.status, 201, 'it can be sold again');
    const n = (s) => Number(s.slice(4));
    assert.equal(n(resold.body.saleNumber), n(made.body.saleNumber) + 1, 'the deleted number stays taken');
});

test('editing changes the payment, not the piece', async () => {
    const art = await artwork('Quiet Courtyard', 45_000);
    const made = (await api(accounts, '/sales', { method: 'POST', body: sale({ artworkId: art, amount: 45_000, paymentMode: 'Cash' }) })).body;
    const edited = await api(accounts, `/sales/${made.id}`, { method: 'PUT', body: { ...made, itemTitle: 'Renamed', itemPrice: 1, amount: 44_500, paymentMode: 'Cheque', referenceNo: 'CHQ 000123', saleDate: '2026-09-14' } });
    assert.equal(edited.status, 200, edited.text);
    assert.equal(edited.body.amount, 44_500);
    assert.equal(edited.body.paymentMode, 'Cheque');
    assert.equal(edited.body.referenceNo, 'CHQ 000123');
    assert.equal(edited.body.saleDate, '2026-09-14');
    assert.equal(edited.body.itemTitle, 'Quiet Courtyard', 'a piece’s snapshot stays');
    assert.equal(edited.body.saleNumber, made.saleNumber);
    assert.equal((await api(staff, `/sales/${made.id}`, { method: 'PUT', body: made })).status, 403);
    assert.equal((await api(accounts, '/sales/sale_nothing_here', { method: 'PUT', body: made })).status, 404);
});

test('the summary adds up, by payment mode, within the dates asked for', async () => {
    const range = '?from=2026-08-01&to=2026-08-31';
    for (const [amount, paymentMode] of [[0.1, 'Cash'], [0.2, 'Cash'], [1000, 'UPI'], [250.5, 'Bank transfer']]) {
        assert.equal((await api(accounts, '/sales', { method: 'POST', body: sale({ itemTitle: 'Print', amount, paymentMode, saleDate: '2026-08-20' }) })).status, 201);
    }
    assert.equal((await api(accounts, '/sales', { method: 'POST', body: sale({ itemTitle: 'Print', amount: 999, saleDate: '2026-07-31' }) })).status, 201, 'outside the range');
    const { body } = await api(staff, `/sales${range}`);
    assert.equal(body.summary.count, 4);
    assert.equal(body.summary.totalAmount, 1250.8);
    assert.deepEqual(body.summary.byMode, {
        Cash: { count: 2, amount: 0.3 },
        UPI: { count: 1, amount: 1000 },
        'Bank transfer': { count: 1, amount: 250.5 },
    });
    assert.equal(body.sales.length, 4);

    // The month: what the sales there add up to, deleted ones left out.
    const sept = (await month()).body;
    assert.equal(sept.summary.count, sept.sales.length);
    assert.equal(sept.summary.totalAmount, sept.sales.reduce((a, s) => a + Math.round(s.amount * 100), 0) / 100);
});

test('a table from before tags and photos gains them; its sales read back untouched', async () => {
    const june = await api(staff, '/sales?from=2026-06-01&to=2026-06-30');
    assert.equal(june.status, 200, june.text);
    const old = june.body.sales.find(s => s.id === 'sale_from_before_tags');
    assert.ok(old);
    assert.deepEqual(old.tags, []);
    assert.deepEqual(old.photoUrls, []);
    assert.equal(old.saleNumber, 'SAL-001');
});

test('tags: cleaned, kept per sale, offered back as suggestions', async () => {
    const tagged = await api(accounts, '/sales', { method: 'POST', body: sale({ itemTitle: 'Candle set', saleDate: '2026-07-12', tags: ['  Kala Ghoda   Fair ', 'kala ghoda fair', 'Diwali', 42, ''] }) });
    assert.equal(tagged.status, 201, tagged.text);
    assert.deepEqual(tagged.body.tags, ['Kala Ghoda Fair', 'Diwali'], 'trimmed, spaces collapsed, no repeats ignoring case, text only');
    const other = await api(accounts, '/sales', { method: 'POST', body: sale({ itemTitle: 'Postcards', saleDate: '2026-07-13', tags: ['Diwali'] }) });
    assert.equal(other.status, 201);
    assert.equal((await api(accounts, '/sales', { method: 'POST', body: sale({ itemTitle: 'Mug', saleDate: '2026-07-14', tags: Array.from({ length: 15 }, (_, i) => `t${i}`) }) })).body.tags.length, 10, 'at most 10');

    const july = (await api(staff, '/sales?from=2026-07-01&to=2026-07-31')).body;
    assert.ok(july.allTags.includes('Kala Ghoda Fair'));
    assert.equal(july.allTags.filter(t => t.toLowerCase() === 'diwali').length, 1, 'each tag once');

    const edited = await api(accounts, `/sales/${tagged.body.id}`, { method: 'PUT', body: { ...tagged.body, tags: ['Walk-in'] } });
    assert.deepEqual(edited.body.tags, ['Walk-in']);
});

test('photos: for items not in the inventory, checked, and shown as the picture', async () => {
    const urls = ['/api/files/uploads/a.jpg', '/api/files/uploads/b.jpg'];
    const withPhotos = await api(accounts, '/sales', { method: 'POST', body: sale({ itemTitle: 'Hand-painted tray', photoUrls: urls }) });
    assert.equal(withPhotos.status, 201, withPhotos.text);
    assert.deepEqual(withPhotos.body.photoUrls, urls);
    assert.equal(withPhotos.body.imageUrl, urls[0]);
    assert.equal((await api(accounts, '/sales', { method: 'POST', body: sale({ itemTitle: 'Tray', photoUrls: ['https://evil.example/x.jpg'] }) })).status, 400, 'only our own uploads');
    assert.equal((await api(accounts, '/sales', { method: 'POST', body: sale({ itemTitle: 'Tray', photoUrls: Array.from({ length: 11 }, (_, i) => `/api/files/u/${i}.jpg`) }) })).status, 400, 'at most 10');

    const art = await artwork('Blue Vessel', 12_000);
    const piece = await api(accounts, '/sales', { method: 'POST', body: sale({ artworkId: art, photoUrls: urls }) });
    assert.equal(piece.status, 201);
    assert.deepEqual(piece.body.photoUrls, [], 'an inventory piece uses its own photos');
    assert.equal(piece.body.imageUrl, `/api/files/${art}.jpg`);

    const fewer = await api(accounts, `/sales/${withPhotos.body.id}`, { method: 'PUT', body: { ...withPhotos.body, photoUrls: [urls[1]] } });
    assert.deepEqual(fewer.body.photoUrls, [urls[1]]);
});

test('in an organization’s own database too', async () => {
    const admin = worker.browser();
    assert.equal((await admin.signIn('admin@example.com', 'provider-admin-password')).status, 200);
    assert.equal((await admin.call('/admin/users', { method: 'POST', body: { email: 'org-owner@example.com', name: 'Org Owner', temporaryPassword: 'member password 123' } })).status, 201);
    const org = (await admin.call('/admin/orgs', { method: 'POST', body: { name: 'Sales Org', businessType: 'gallery', ownerEmail: 'org-owner@example.com' } })).body;
    const orgOwner = worker.browser();
    assert.equal((await orgOwner.signIn('org-owner@example.com', 'member password 123')).status, 200);
    const app = path => `/api/o/${org.id}${path}`;

    const art = 'art_org_1';
    assert.equal((await orgOwner.call(app('/artworks'), { method: 'POST', body: { id: art, customId: 'O-1', title: 'Org Piece', price: 7000, status: 'Available', imageUrls: [], createdAt: Date.now() } })).status, 201);
    const first = await orgOwner.call(app('/sales'), { method: 'POST', body: sale({ artworkId: art, amount: 7000 }) });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.saleNumber, 'SAL-001', 'each organization numbers its own sales');
    assert.equal((await orgOwner.call(app('/sales'), { method: 'POST', body: sale({ artworkId: art }) })).status, 409);
    const listed = await orgOwner.call(app(`/sales?from=${MONTH.from}&to=${MONTH.to}`));
    assert.equal(listed.body.summary.totalAmount, 7000);
    assert.equal(listed.body.sales[0].inInventory, true);
    assert.equal((await orgOwner.call(app(`/sales/${first.body.id}`), { method: 'DELETE' })).status, 200);
    assert.equal((await orgOwner.call(app('/artworks'))).body.find(a => a.id === art).status, 'Available');
});
