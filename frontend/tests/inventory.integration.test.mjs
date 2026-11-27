// Stock locations, custom statuses and cost prices against a real local Worker:
// the first-run move of free-text locations into real ones, settings, sales and
// tax invoices taking from a location, stock history, and cost prices never
// reaching a role that can't see them.
//
//   node --test frontend/tests/inventory.integration.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { withSessionToken } from './helpers/session.mjs';
import { startDevWorker } from './helpers/devWorker.mjs';
import { load } from './helpers/load.mjs';

const { locationIdFor } = await load('inventoryRules.ts');

const OWNER = { name: 'Aarav Shah', email: 'owner@example.com', password: 'owner-password-1234' };
const NOV = Date.UTC(2026, 10, 2, 6);
// Artworks from before stock locations: free-text locations, one blank, one sold.
const BEFORE_LOCATIONS = `
INSERT INTO artworks (id, title, status, location, created_at, quantity) VALUES
  ('old_a', 'A', 'Available', 'Store', 1, 3), ('old_b', 'B', 'Available', ' store ', 1, 1), ('old_c', 'C', 'Available', 'Office', 1, 2),
  ('old_d', 'D', 'Available', '', 1, 1), ('old_e', 'E', 'Sold', 'Office', 1, 0);`;

let worker, owner, staff, keeper;

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
    return (await api(null, '/auth/login', { method: 'POST', body: { email, password: 'staff-password-1234' } })).body.token;
}

const STORE = locationIdFor('Store');
const OFFICE = locationIdFor('Office');
const art = async (id, token = owner) => (await api(token, '/artworks')).body.find(a => a.id === id);
const sale = (extra) => ({ itemTitle: '', itemPrice: 0, contactId: null, buyerName: 'Meera', buyerPhone: '', saleDate: '2026-11-02', amount: 100, paymentMode: 'Cash', referenceNo: '', notes: '', ...extra });

before(async () => {
    const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
    worker = await startDevWorker({ seedLegacy: { sql: `${schema}\n${BEFORE_LOCATIONS}` } });
    assert.equal((await api(null, '/auth/setup', { method: 'POST', body: OWNER })).status, 200);
    owner = (await api(null, '/auth/login', { method: 'POST', body: { email: OWNER.email, password: OWNER.password } })).body.token;
    staff = await person('Priya', 'priya@example.com');
    const keeperRole = await api(owner, '/auth/roles', { method: 'POST', body: { name: 'Stock + costs', permissions: { inventory: 'edit', costs: 'edit' } } });
    keeper = await person('Ravi', 'ravi@example.com', keeperRole.body.id);
});

after(async () => { await worker?.stop(); worker?.cleanup(); });

test('first run: free-text locations become locations, stock goes to them, the most used is the default', async () => {
    const settings = (await api(owner, '/inventory-settings')).body;
    assert.deepEqual(settings.locations.map(l => [l.name, !!l.isDefault]), [['Store', true], ['Office', false]]);
    assert.deepEqual(settings.statuses.map(s => s.id), ['Available', 'Reserved', 'Sold']);
    assert.deepEqual((await art('old_a')).stock, { [STORE]: 3 });
    assert.deepEqual((await art('old_b')).stock, { [STORE]: 1 }, 'same name, other spacing and case');
    assert.deepEqual((await art('old_c')).stock, { [OFFICE]: 2 });
    assert.deepEqual((await art('old_d')).stock, { [STORE]: 1 }, 'no location: the default');
    assert.deepEqual((await art('old_e')).stock, {}, 'sold: none');
});

test('settings: add and rename; a location holding stock cannot be archived; an older copy hides nothing', async () => {
    const settings = (await api(owner, '/inventory-settings')).body;
    const shop = { id: 'loc_shop0001', name: 'Shop' };
    const onLoan = { id: 'st_onloan01', name: 'On loan', behaves: 'Reserved', color: 'blue' };
    const put = await api(owner, '/inventory-settings', { method: 'PUT', body: { locations: [...settings.locations.map(l => l.id === OFFICE ? { ...l, name: 'Back office' } : l), shop], statuses: [...settings.statuses, onLoan] } });
    assert.equal(put.status, 200, put.text);
    assert.deepEqual(put.body.locations.map(l => l.name), ['Store', 'Back office', 'Shop']);
    assert.equal((await api(staff, '/inventory-settings', { method: 'PUT', body: put.body })).status, 200, 'Staff edit inventory by default');

    const archiveOffice = await api(owner, '/inventory-settings', { method: 'PUT', body: { ...put.body, locations: put.body.locations.map(l => l.id === OFFICE ? { ...l, archived: true } : l) } });
    assert.equal(archiveOffice.status, 409);
    assert.match(archiveOffice.body.error, /Back office still holds 2 units/);

    // Someone saves a copy opened before Shop and On loan were added: both stay as they are.
    const older = await api(owner, '/inventory-settings', { method: 'PUT', body: { locations: settings.locations, statuses: settings.statuses } });
    assert.equal(older.status, 200, older.text);
    assert.deepEqual(older.body.locations.find(l => l.id === shop.id), { id: shop.id, name: 'Shop' });
    assert.equal(older.body.statuses.find(s => s.id === onLoan.id).archived, undefined);
    const archived = await api(owner, '/inventory-settings', { method: 'PUT', body: { ...older.body, locations: older.body.locations.map(l => l.id === shop.id ? { ...l, archived: true } : l) } });
    assert.deepEqual(archived.body.locations.find(l => l.id === shop.id), { id: shop.id, name: 'Shop', archived: true }, 'archiving is explicit');
});

test('an edit moves stock between locations and writes history', async () => {
    const a = await art('old_a');
    const moved = await api(owner, '/artworks/old_a', { method: 'PUT', body: { ...a, stock: { [STORE]: 1, [OFFICE]: 2 }, stockNote: 'Moved 2 to Back office', stockSeen: { status: a.status, quantity: a.quantity } } });
    assert.equal(moved.status, 200, moved.text);
    const now = await art('old_a');
    assert.deepEqual([now.quantity, now.stock], [3, { [OFFICE]: 2, [STORE]: 1 }]);
    const history = (await api(owner, '/artworks/old_a/stock-history')).body;
    assert.deepEqual(history[0].change, { [STORE]: -2, [OFFICE]: 2 });
    assert.equal(history[0].note, 'Moved 2 to Back office');
    assert.equal(history[0].byName, OWNER.name);
});

test('sales take from the location chosen, else the default; deleting puts the units back there', async () => {
    // old_a: Store 1, Office 2.
    const tooFew = await api(owner, '/sales', { method: 'POST', body: sale({ artworkId: 'old_a', qty: 2, locationId: STORE }) });
    assert.equal(tooFew.status, 409);
    assert.match(tooFew.body.error, /Only 1 at Store/);
    const fromOffice = await api(owner, '/sales', { method: 'POST', body: sale({ artworkId: 'old_a', qty: 2, locationId: OFFICE }) });
    assert.equal(fromOffice.status, 201, fromOffice.text);
    assert.equal(fromOffice.body.locationId, OFFICE);
    assert.deepEqual((await art('old_a')).stock, { [STORE]: 1 });
    const fromDefault = await api(owner, '/sales', { method: 'POST', body: sale({ artworkId: 'old_a', qty: 1 }) });
    assert.equal(fromDefault.body.locationId, STORE);
    assert.deepEqual([(await art('old_a')).status, (await art('old_a')).quantity], ['Sold', 0]);

    assert.equal((await api(owner, `/sales/${fromOffice.body.id}`, { method: 'DELETE' })).status, 200);
    const back = await art('old_a');
    assert.deepEqual([back.status, back.quantity, back.stock], ['Available', 2, { [OFFICE]: 2 }]);
    assert.match((await api(owner, '/artworks/old_a/stock-history')).body[0].note, /deleted/);
});

test('a split piece with no one location holding enough is refused with where the units are', async () => {
    const id = 'split_1';
    assert.equal((await api(owner, '/artworks', { method: 'POST', body: { id, title: 'Split', price: 10, status: 'Available', imageUrls: [], createdAt: 1, stock: { [STORE]: 1, [OFFICE]: 1 } } })).status, 201);
    const refused = await api(owner, '/sales', { method: 'POST', body: sale({ artworkId: id, qty: 2 }) });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /No one location has 2/);
});

test('cost prices: only roles that can see them get them, and only roles that can change them change them', async () => {
    const id = 'cost_1';
    const base = { id, title: 'Costed', price: 50000, status: 'Available', imageUrls: [], createdAt: 1, stock: { [STORE]: 1 } };
    assert.equal((await api(keeper, '/artworks', { method: 'POST', body: { ...base, costPrice: 30000 } })).status, 201);
    assert.equal((await art(id, keeper)).costPrice, 30000);
    assert.equal((await art(id, owner)).costPrice, 30000, 'admins always');
    const seen = await art(id, staff);
    assert.ok(!('costPrice' in seen), 'Staff never receive it');

    assert.equal((await api(staff, `/artworks/${id}`, { method: 'PUT', body: { ...seen, title: 'Renamed', costPrice: 1 } })).status, 200);
    assert.deepEqual([(await art(id, owner)).title, (await art(id, owner)).costPrice], ['Renamed', 30000], 'their edit saves, the cost stays');

    const snap = await api(staff, '/sync?snapshot=artwork&limit=500');
    assert.equal(snap.status, 200, snap.text);
    assert.ok(snap.body.records.every(r => !('costPrice' in r)), 'nor through sync');
    const boundary = (await api(staff, '/sync')).body.cursor;
    await api(keeper, `/artworks/${id}`, { method: 'PUT', body: { ...(await art(id, keeper)), costPrice: 31000 } });
    const changes = (await api(staff, `/sync?cursor=${boundary}`)).body.changes.filter(c => c.entity === 'artwork');
    assert.ok(changes.length > 0 && changes.every(c => !('costPrice' in (c.record ?? {}))), 'nor through incremental sync');
    assert.equal((await api(keeper, `/sync?cursor=${boundary}`)).body.changes.find(c => c.id === id).record.costPrice, 31000);
});

test('a tax invoice takes from the default first and cancelling puts back exactly what it took', async () => {
    const SETUP = {
        legalName: 'Test Atelier Private Limited', address: 'Kala Ghoda, Mumbai', state: '27', gstin: '27AAPFU0939F1ZV', signatoryName: 'A. Mehra',
        banks: [{ id: 'b1', label: 'Current', accountName: 'Test Atelier', accountNumber: '50200012345678', ifsc: 'HDFC0000060', bankName: 'HDFC Bank', branch: 'Fort', upiId: 'test@hdfc' }],
        defaultBankId: 'b1',
    };
    assert.equal((await api(owner, '/invoices/settings', { method: 'PUT', body: SETUP })).status, 200);
    const id = 'inv_piece';
    await api(owner, '/artworks', { method: 'POST', body: { id, title: 'Prints', price: 1000, status: 'Available', imageUrls: [], createdAt: 1, stock: { [STORE]: 2, [OFFICE]: 5 } } });
    const doc = {
        id: 'doc_tax_loc', kind: 'tax', storeId: '', number: '', status: 'Draft', date: NOV,
        party: { name: 'Kiran Interiors', phone: '99000 44556', email: '', gstin: '', address: 'Bandra', state: '27', pincode: '', sameShipping: true, shipName: '', shipAddress: '', shipState: '', shipPincode: '' },
        placeOfSupply: '27', reverseCharge: false, supplyType: 'regular', priceIncludesTax: false, billDiscountPaise: 0,
        lines: [{ key: 'k1', artworkId: id, description: 'Prints', detail: '', hsn: '9701', qty: 3, unit: 'Nos', ratePaise: 100000, discountPct: 0, gstRate: 5 }],
        notes: '', terms: '', internalNote: '', reference: '',
        transport: { mode: '', vehicleNo: '', transporter: '', lrNo: '', dispatchDate: '' }, ewayBillNo: '', irn: '', ackNo: '', ackDate: '',
        exportInfo: { lutNo: '', currency: 'USD', exchangeRate: '', portCode: '', shippingBillNo: '', shippingBillDate: '' },
        payments: [], history: [], createdAt: NOV, updatedAt: NOV,
    };
    assert.equal((await api(owner, `/invoices/${doc.id}`, { method: 'PUT', body: doc })).status, 201);
    const issued = await api(owner, `/invoices/${doc.id}/issue`, { method: 'POST' });
    assert.equal(issued.status, 200, issued.text);
    assert.deepEqual(issued.body[0].stockTaken, [{ artworkId: id, locationId: STORE, qty: 2 }, { artworkId: id, locationId: OFFICE, qty: 1 }]);
    assert.deepEqual((await art(id)).stock, { [OFFICE]: 4 });
    // Someone moves the rest meanwhile; the cancel still returns 2 to Store and 1 to Office.
    assert.equal((await api(owner, `/invoices/${doc.id}/cancel`, { method: 'POST', body: { reason: 'Wrong' } })).status, 200);
    assert.deepEqual((await art(id)).stock, { [OFFICE]: 5, [STORE]: 2 });

    // Two invoices for the same 3 units, issued at the same moment: only 3 are taken in all, and cancelling both returns only 3.
    const race = 'inv_race';
    await api(owner, '/artworks', { method: 'POST', body: { id: race, title: 'Race', price: 1000, status: 'Available', imageUrls: [], createdAt: 1, stock: { [STORE]: 3 } } });
    const twins = ['doc_race_a', 'doc_race_b'].map(d => ({ ...doc, id: d, lines: [{ ...doc.lines[0], artworkId: race }] }));
    for (const t of twins) await api(owner, `/invoices/${t.id}`, { method: 'PUT', body: t });
    const both = await Promise.all(twins.map(t => api(owner, `/invoices/${t.id}/issue`, { method: 'POST' })));
    assert.ok(both.every(r => r.status === 200), both.map(r => r.text).join(' | '));
    const recorded = both.flatMap(r => r.body[0].stockTaken).reduce((n, t) => n + t.qty, 0);
    assert.equal(recorded, 3, 'what the invoices say they took is what was there');
    assert.deepEqual([(await art(race)).status, (await art(race)).stock], ['Sold', {}]);
    for (const t of twins) await api(owner, `/invoices/${t.id}/cancel`, { method: 'POST', body: { reason: 'Test' } });
    assert.deepEqual((await art(race)).stock, { [STORE]: 3 });

    // Issued while Update inventory was off: cancelling adds nothing.
    await api(owner, '/invoices/settings', { method: 'PUT', body: { ...SETUP, inventoryEffects: false } });
    const quiet = { ...doc, id: 'doc_tax_quiet' };
    await api(owner, `/invoices/${quiet.id}`, { method: 'PUT', body: quiet });
    assert.equal((await api(owner, `/invoices/${quiet.id}/issue`, { method: 'POST' })).status, 200);
    await api(owner, '/invoices/settings', { method: 'PUT', body: { ...SETUP, inventoryEffects: true } });
    assert.equal((await api(owner, `/invoices/${quiet.id}/cancel`, { method: 'POST', body: { reason: 'Wrong' } })).status, 200);
    assert.deepEqual((await art(id)).stock, { [OFFICE]: 5, [STORE]: 2 }, 'nothing was taken, nothing comes back');
});

test('an app from before locations still saves: its quantity goes to the piece\'s one location', async () => {
    const id = 'legacy_1';
    assert.equal((await api(owner, '/artworks', { method: 'POST', body: { id, title: 'Legacy', price: 1, status: 'Available', location: ' OFFICE', quantity: 4, imageUrls: [], createdAt: 1 } })).status, 201);
    assert.deepEqual((await art(id)).stock, { [OFFICE]: 4 }, 'its Location text names a location');
    const a = await art(id);
    const { stock: _s, ...old } = a;
    assert.equal((await api(owner, `/artworks/${id}`, { method: 'PUT', body: { ...old, quantity: 6 } })).status, 200);
    assert.deepEqual((await art(id)).stock, { [OFFICE]: 6 });
    assert.equal((await art(id)).location, 'Office', 'Location text follows the stock');
});
