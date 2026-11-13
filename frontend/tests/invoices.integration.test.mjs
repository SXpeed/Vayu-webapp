// Billing against a real local Worker: the setup, proformas from before
// Billing (old shape, old table), numbering (consecutive, never reused, safe
// under concurrent issues, honouring a starting number), locking after issue,
// payments, credit notes, cancelling, deleting, conversions and permissions.
//
//   node --test frontend/tests/invoices.integration.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { withSessionToken } from './helpers/session.mjs';
import { startDevWorker } from './helpers/devWorker.mjs';

const OWNER = { name: 'Aarav Shah', email: 'owner@example.com', password: 'owner-password-1234' };
const NOV = Date.UTC(2026, 10, 2, 6); // 2 Nov 2026, FY 26-27
const GSTIN_MH = '27AAPFU0939F1ZV';

// The table as it shipped for proformas, with one saved in the old shape.
const OLD_PROFORMA = { id: 'inv_1700000000000', invoiceNumber: 'PI-2026-K3F9QZ', customerName: 'Mrs. Mehta', customerEmail: '', customerPhone: '98200 11111', items: [{ artworkId: '', title: 'Framing', price: 1000 }], subtotal: 1000, taxRate: 0.18, total: 1180, date: NOV, status: 'Sent' };
const INVOICES_TABLE_V1 = `CREATE TABLE invoices (
    id TEXT PRIMARY KEY, invoice_number TEXT NOT NULL DEFAULT '', customer_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Draft', date INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}',
    created_by TEXT, created_by_name TEXT, updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO invoices (id, invoice_number, customer_name, status, date, data, updated_at)
VALUES ('${OLD_PROFORMA.id}', '${OLD_PROFORMA.invoiceNumber}', 'Mrs. Mehta', 'Sent', ${NOV}, '${JSON.stringify(OLD_PROFORMA)}', 1);`;

const SETUP = {
    legalName: 'Test Atelier Private Limited', address: 'Kala Ghoda, Mumbai', state: '27', gstin: GSTIN_MH, signatoryName: 'A. Mehra',
    banks: [{ id: 'b1', label: 'Current', accountName: 'Test Atelier', accountNumber: '50200012345678', ifsc: 'HDFC0000060', bankName: 'HDFC Bank', branch: 'Fort', upiId: 'test@hdfc' }],
    defaultBankId: 'b1',
};

let worker;
let owner;
let viewer;   // Billing "view" only
let outsider; // no Billing

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
    const res = await api(owner, '/auth/users', { method: 'POST', body: { name, email, password: 'staff-password-1234', role: roleId } });
    assert.ok(res.status === 200 || res.status === 201, res.text);
    return (await api(null, '/auth/login', { method: 'POST', body: { email, password: 'staff-password-1234' } })).body.token;
}

async function role(name, permissions) {
    const res = await api(owner, '/auth/roles', { method: 'POST', body: { name, permissions } });
    assert.equal(res.status, 201, res.text);
    return res.body.id;
}

let seq = 0;
const line = (rupees, extra = {}) => ({ key: `k${++seq}`, artworkId: '', description: 'Painting', detail: '', hsn: '9701', qty: 1, unit: 'Nos', ratePaise: rupees * 100, discountPct: 0, gstRate: 5, ...extra });
const draft = (kind, extra = {}) => ({
    id: `doc_${kind}_${++seq}`, kind, storeId: '', number: '', status: 'Draft', date: NOV,
    party: { name: 'Kiran Interiors', phone: '99000 44556', email: '', gstin: '', address: 'Bandra', state: '27', pincode: '', sameShipping: true, shipName: '', shipAddress: '', shipState: '', shipPincode: '' },
    placeOfSupply: '27', reverseCharge: false, supplyType: 'regular', priceIncludesTax: false, billDiscountPaise: 0,
    lines: [line(100000)], notes: '', terms: '', internalNote: '', reference: '',
    transport: { mode: '', vehicleNo: '', transporter: '', lrNo: '', dispatchDate: '' }, ewayBillNo: '', irn: '', ackNo: '', ackDate: '',
    exportInfo: { lutNo: '', currency: 'USD', exchangeRate: '', portCode: '', shippingBillNo: '', shippingBillDate: '' },
    payments: [], history: [], createdAt: NOV, updatedAt: NOV, ...(kind === 'challan' ? { challanPurpose: 'approval', challanTax: false } : {}), ...extra,
});
const save = (doc, token = owner) => api(token, `/invoices/${doc.id}`, { method: 'PUT', body: doc });
const issue = (id, token = owner) => api(token, `/invoices/${id}/issue`, { method: 'POST' });
const list = async () => (await api(owner, '/invoices')).body;
const find = async (id) => (await list()).find(d => d.id === id);

before(async () => {
    const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
    worker = await startDevWorker({ seedLegacy: { sql: `${schema}\n${INVOICES_TABLE_V1}` } });
    assert.equal((await api(null, '/auth/setup', { method: 'POST', body: OWNER })).status, 200);
    owner = (await api(null, '/auth/login', { method: 'POST', body: { email: OWNER.email, password: OWNER.password } })).body.token;
    viewer = await person('Accounts Viewer', 'viewer@example.com', await role('Billing viewer', { invoices: 'view' }));
    outsider = await person('Stock Keeper', 'stock@example.com', await role('Stock', { inventory: 'edit' }));
});

after(async () => { await worker?.stop(); worker?.cleanup(); });

test('old proformas come back in the new shape, from the old table', async () => {
    const old = await find(OLD_PROFORMA.id);
    assert.equal(old.kind, 'proforma');
    assert.equal(old.number, 'PI-2026-K3F9QZ');
    assert.equal(old.party.name, 'Mrs. Mehta');
    assert.deepEqual(old.lines.map(l => [l.description, l.ratePaise, l.gstRate]), [['Framing', 1000_00, 18]]);
    // Saving it from the new app keeps its number and works out its total.
    const saved = await save({ ...old, status: 'Accepted' });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.body.number, 'PI-2026-K3F9QZ');
    assert.equal(saved.body.totalPaise, 1180_00);
    // One only a phone had, uploaded now in the old shape, keeps its number too.
    const upload = await save({ ...OLD_PROFORMA, id: 'inv_1700000000001', invoiceNumber: 'PI-2026-ONPHONE' });
    assert.equal(upload.status, 201, upload.text);
    assert.equal(upload.body.number, 'PI-2026-ONPHONE');
});

test('billing setup: owner saves, Billing "view" reads, others get nothing', async () => {
    assert.equal((await api(owner, '/invoices/settings')).body.series.tax.prefix, 'INV', 'defaults before any setup');
    const put = await api(owner, '/invoices/settings', { method: 'PUT', body: { ...SETUP, logoImage: 'javascript:alert(1)' } });
    assert.equal(put.status, 200, put.text);
    assert.equal(put.body.legalName, SETUP.legalName);
    assert.equal(put.body.logoImage, '', 'only image data is kept');
    assert.equal((await api(viewer, '/invoices/settings')).body.gstin, GSTIN_MH);
    assert.equal((await api(viewer, '/invoices/settings', { method: 'PUT', body: SETUP })).status, 403);
    assert.equal((await api(outsider, '/invoices/settings')).status, 403);
    assert.equal((await api(outsider, '/invoices')).status, 403);
    assert.equal((await save(draft('tax'), viewer)).status, 403);
});

test('proformas are numbered on save, and a deleted one’s number is never handed out again', async () => {
    const a = await save(draft('proforma'));
    assert.equal(a.status, 201, a.text);
    assert.equal(a.body.number, 'PI/26-27/0001');
    const b = await save(draft('proforma'));
    assert.equal(b.body.number, 'PI/26-27/0002');
    assert.equal((await api(owner, `/invoices/${b.body.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await save(draft('proforma'))).body.number, 'PI/26-27/0003');
    assert.match((await save({ ...a.body, status: 'Converted' })).text, /by hand/);
});

test('a tax invoice is numbered and frozen when issued, never before', async () => {
    const d = draft('tax', { lines: [line(100000), line(8000, { hsn: '998599', gstRate: 18, unit: 'Job' })] });
    assert.equal((await save(d)).status, 201);
    assert.equal((await save({ ...d, status: 'Issued' })).status, 409, 'a save can’t issue');
    assert.equal((await find(d.id)).number, '');

    const issued = await issue(d.id);
    assert.equal(issued.status, 200, issued.text);
    const inv = issued.body[0];
    assert.equal(inv.number, 'INV/26-27/0001');
    assert.equal(inv.status, 'Issued');
    assert.equal(inv.seller.legalName, SETUP.legalName, 'the seller details are frozen on it');
    assert.equal(inv.totalPaise, 1050_00_00 + 9440_00);
    assert.equal((await issue(d.id)).body[0].number, 'INV/26-27/0001', 'issuing again changes nothing');

    // Later setup changes don't touch it.
    await api(owner, '/invoices/settings', { method: 'PUT', body: { ...SETUP, legalName: 'Renamed Pvt Ltd' } });
    assert.equal((await find(d.id)).seller.legalName, SETUP.legalName);
    await api(owner, '/invoices/settings', { method: 'PUT', body: SETUP });

    const edited = await save({ ...inv, lines: [line(1)] });
    assert.equal(edited.status, 409);
    assert.match(edited.body.error, /lines/);
    assert.equal((await save({ ...inv, party: { ...inv.party, name: 'Someone else' } })).status, 409);
    const renumbered = (await save({ ...inv, number: 'INV/26-27/9999' })).body;
    assert.equal(renumbered.number, 'INV/26-27/0001', 'the number is the server’s');
    assert.equal((await save({ ...inv, ewayBillNo: '123456789012' })).status, 409, 'a save from the copy loaded before someone else’s save is refused');
    const transport = await save({ ...renumbered, ewayBillNo: '123456789012', transport: { ...inv.transport, mode: 'Road', vehicleNo: 'MH01AB1234' } });
    assert.equal(transport.status, 200, transport.text);
    assert.equal((await api(owner, `/invoices/${d.id}`, { method: 'DELETE' })).status, 409, 'issued documents are never deleted');
});

test('payments, credit notes and cancelling keep the invoice honest', async () => {
    const d = draft('tax');
    await save(d);
    const inv = (await issue(d.id)).body[0];
    const pay = (amountPaise, base = inv) => save({ ...base, payments: [...base.payments, { id: `p${++seq}`, date: NOV, amountPaise, mode: 'UPI', reference: 'UTR' }] });
    assert.equal((await pay(inv.totalPaise + 1)).status, 409, 'not more than the invoice');
    const paid = await pay(20_000_00);
    assert.equal(paid.status, 200, paid.text);

    const cancel = (id, reason) => api(owner, `/invoices/${id}/cancel`, { method: 'POST', body: { reason } });
    assert.equal((await cancel(inv.id, 'Wrong buyer')).status, 409, 'payments block cancelling');

    const tooMuch = draft('credit', { sourceId: inv.id, noteReason: 'Return', lines: [line(200000)] });
    await save(tooMuch);
    assert.equal((await issue(tooMuch.id)).status, 409, 'a credit can’t exceed the invoice');
    const credit = draft('credit', { sourceId: inv.id, noteReason: 'Discount after sale', lines: [line(10000)] });
    await save(credit);
    const cn = await issue(credit.id);
    assert.equal(cn.status, 200, cn.text);
    assert.equal(cn.body[0].number, 'CN/26-27/0001');

    // A draft that was never issued can go; a plain invoice can be cancelled, once, with a reason.
    assert.equal((await api(owner, `/invoices/${tooMuch.id}`, { method: 'DELETE' })).status, 200);
    const other = draft('tax');
    await save(other);
    await issue(other.id);
    assert.equal((await cancel(other.id, '')).status, 400);
    const cancelled = await cancel(other.id, 'Typed the wrong amount');
    assert.equal(cancelled.status, 200, cancelled.text);
    assert.equal(cancelled.body.status, 'Cancelled');
    assert.equal((await cancel(other.id, 'Again')).status, 409);
});

test('converting: the proforma becomes Converted, an invoiced challan Invoiced', async () => {
    const pf = (await save(draft('proforma'))).body;
    const fromPf = draft('tax', { sourceId: pf.id });
    await save(fromPf);
    const changed = (await issue(fromPf.id)).body;
    assert.deepEqual(changed.map(d => d.status), ['Issued', 'Converted']);

    const ch = draft('challan');
    await save(ch);
    const challan = (await issue(ch.id)).body[0];
    assert.match(challan.number, /^DC\/26-27\/0001$/);
    assert.equal((await save({ ...challan, status: 'Delivered' })).status, 200);
    const fromCh = draft('tax', { sourceId: ch.id });
    await save(fromCh);
    await issue(fromCh.id);
    assert.equal((await find(ch.id)).status, 'Invoiced');
});

test('issuing many at once gives consecutive numbers with no repeats, and a new starting number is honoured', async () => {
    const drafts = Array.from({ length: 6 }, () => draft('tax'));
    for (const d of drafts) await save(d);
    const numbers = (await Promise.all(drafts.map(d => issue(d.id)))).map(r => r.body[0].number);
    const seqs = numbers.map(n => Number(n.split('/')[2])).sort((a, b) => a - b);
    assert.equal(new Set(seqs).size, 6);
    assert.equal(seqs[5] - seqs[0], 5, 'no gaps');

    await api(owner, '/invoices/settings', { method: 'PUT', body: { ...SETUP, series: { tax: { prefix: 'INV', start: 120 } } } });
    const d = draft('tax');
    await save(d);
    assert.equal((await issue(d.id)).body[0].number, 'INV/26-27/0120');
});

test('nothing is issued without the setup', async () => {
    await api(owner, '/invoices/settings', { method: 'PUT', body: {} });
    const d = draft('tax');
    await save(d);
    const res = await issue(d.id);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /setup/);
    await api(owner, '/invoices/settings', { method: 'PUT', body: SETUP });
});

test('only workspace admins change the billing setup, and a save from an old copy is refused', async () => {
    const editor = await person('Accounts Editor', 'accounts.editor@example.com', await role('Billing editor', { invoices: 'edit' }));
    const refused = await api(editor, '/invoices/settings', { method: 'PUT', body: { ...SETUP, banks: [{ ...SETUP.banks[0], accountNumber: '999999999999' }] } });
    assert.equal(refused.status, 403, 'Billing "edit" alone can’t change the bank account on every invoice');
    assert.equal((await save(draft('proforma'), editor)).status, 201, 'but can still make documents');

    const loaded = (await api(owner, '/invoices/settings')).body;
    const first = await api(owner, '/invoices/settings', { method: 'PUT', body: { ...loaded, tradeName: 'First edit' } });
    assert.equal(first.status, 200, first.text);
    assert.ok(first.body.updatedAt > loaded.updatedAt);
    const stale = await api(owner, '/invoices/settings', { method: 'PUT', body: { ...loaded, tradeName: 'Second edit, from the old copy' } });
    assert.equal(stale.status, 409, 'the second editor would have wiped the first one’s change');
    assert.equal((await api(owner, '/invoices/settings')).body.tradeName, 'First edit');
});

test('issuing, cancelling and returns move inventory on the server', async () => {
    const piece = async (id) => {
        const res = await api(owner, '/artworks', { method: 'POST', body: { id, customId: id, title: id, price: 100000, status: 'Available', imageUrls: [], createdAt: Date.now() } });
        assert.equal(res.status, 201, res.text);
    };
    const statusOf = async (id) => (await api(owner, '/artworks')).body.find(a => a.id === id)?.status;
    await piece('art_sold');
    await piece('art_out');

    const sale = draft('tax', { lines: [line(100000, { artworkId: 'art_sold' })] });
    await save(sale);
    assert.equal(await statusOf('art_sold'), 'Available', 'a draft moves nothing');
    await issue(sale.id);
    assert.equal(await statusOf('art_sold'), 'Sold');
    assert.equal((await api(owner, `/invoices/${sale.id}/cancel`, { method: 'POST', body: { reason: 'Wrong piece' } })).status, 200);
    assert.equal(await statusOf('art_sold'), 'Available', 'cancelling frees it');

    const approval = draft('challan', { lines: [line(100000, { artworkId: 'art_out' })] });
    await save(approval);
    const out = (await issue(approval.id)).body[0];
    assert.equal(await statusOf('art_out'), 'Reserved', 'out on approval');
    const back = await save({ ...out, status: 'Returned', lines: out.lines.map(l => ({ ...l, returnedQty: l.qty })) });
    assert.equal(back.status, 200, back.text);
    assert.equal(await statusOf('art_out'), 'Available', 'back in stock once returned');

    // Stock: a tax invoice takes each line's quantity out, and cancelling puts it back.
    assert.equal((await api(owner, '/artworks', { method: 'POST', body: { id: 'art_run', customId: 'art_run', title: 'Prints', price: 1000, status: 'Available', quantity: 5, imageUrls: [], createdAt: Date.now() } })).status, 201);
    const stock = async () => { const a = (await api(owner, '/artworks')).body.find(x => x.id === 'art_run'); return [a.status, a.quantity]; };
    const three = draft('tax', { lines: [line(1000, { artworkId: 'art_run', qty: 2 }), line(1000, { artworkId: 'art_run', qty: 1 })] });
    await save(three);
    await issue(three.id);
    assert.deepEqual(await stock(), ['Available', 2]);
    const rest = draft('tax', { lines: [line(1000, { artworkId: 'art_run', qty: 2 })] });
    await save(rest);
    await issue(rest.id);
    assert.deepEqual(await stock(), ['Sold', 0], 'the last units make it Sold');
    assert.equal((await api(owner, `/invoices/${three.id}/cancel`, { method: 'POST', body: { reason: 'Returned' } })).status, 200);
    assert.deepEqual(await stock(), ['Available', 3]);
});
