// Billing (invoicing.ts, gstRules.ts, invoicingReports.ts): GST maths, numbering, locking and GSTR-1 rows.
//
//   node --test frontend/tests/invoicing.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers/load.mjs';

const g = await load('gstRules.ts');
const inv = await load('invoicing.ts');
const rep = await load('invoicingReports.ts');

const line = (rupees, gstRate = 5, extra = {}) => ({ qty: 1, ratePaise: rupees * 100, discountPct: 0, gstRate, hsn: '9701', ...extra });
const opts = (o = {}) => ({ mode: 'intra', inclusive: false, billDiscountPaise: 0, roundOff: false, ...o });

test('intra-state splits tax into equal CGST and SGST; inter-state is IGST', () => {
    const intra = g.computeTotals([line(100000)], opts());
    assert.equal(intra.taxable, 100000_00);
    assert.equal(intra.cgst, 2500_00);
    assert.equal(intra.sgst, 2500_00);
    assert.equal(intra.igst, 0);
    assert.equal(intra.total, 105000_00);
    const inter = g.computeTotals([line(100000)], opts({ mode: 'inter' }));
    assert.deepEqual([inter.cgst, inter.sgst, inter.igst, inter.total], [0, 0, 5000_00, 105000_00]);
});

test('zero-rated and no-tax documents carry no tax', () => {
    for (const mode of ['zero', 'none']) {
        const t = g.computeTotals([line(1000, 18)], opts({ mode }));
        assert.equal(t.tax, 0);
        assert.equal(t.total, 1000_00);
    }
});

test('inclusive prices back the taxable value out', () => {
    const t = g.computeTotals([line(105)], opts({ inclusive: true }));
    assert.equal(t.taxable, 100_00);
    assert.equal(t.tax, 5_00);
    assert.equal(t.total, 105_00);
});

test('line discount first, then the bill discount spread pro rata before tax, to the paisa', () => {
    const t = g.computeTotals([line(300, 18, { discountPct: 10 }), line(100, 18)], opts({ billDiscountPaise: 37_00 }));
    // 270 and 100 after line discount; 37 shared 27 / 10.
    assert.deepEqual(t.lines.map(l => l.billDiscount), [27_00, 10_00]);
    assert.equal(t.taxable, 333_00);
    assert.equal(t.discount, 30_00 + 37_00);
    const odd = g.computeTotals([line(1), line(1), line(1)], opts({ billDiscountPaise: 1_00 }));
    assert.equal(odd.lines.reduce((s, l) => s + l.billDiscount, 0), 1_00, 'shares add up exactly');
    const capped = g.computeTotals([line(10)], opts({ billDiscountPaise: 50_00 }));
    assert.equal(capped.taxable, 0, 'a discount can’t go below zero');
});

test('round off to whole rupees, shown as its own line', () => {
    const t = g.computeTotals([{ qty: 1, ratePaise: 1175_77, discountPct: 0, gstRate: 5, hsn: '9701' }], opts({ roundOff: true }));
    assert.equal(t.total % 100, 0);
    assert.equal(t.total - t.roundOff, t.taxable + t.tax);
    assert.ok(Math.abs(t.roundOff) <= 50);
});

test('HSN summary groups by code and rate', () => {
    const t = g.computeTotals([line(100), line(200), line(50, 18, { hsn: '998599' })], opts());
    assert.deepEqual(t.hsn.map(h => [h.hsn, h.rate, h.taxable]), [['9701', 5, 300_00], ['998599', 18, 50_00]]);
});

test('amount in words uses lakh and crore', () => {
    assert.equal(g.amountInWords(1_23_45_678_90), 'Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Ninety Paise Only');
    assert.equal(g.amountInWords(0), 'Rupees Zero Only');
    assert.equal(g.amountInWords(100_000_00), 'Rupees One Lakh Only');
});

test('GSTIN: format, state code and check character', () => {
    assert.equal(g.gstinProblem('27AAPFU0939F1ZV'), null);
    assert.equal(g.gstinProblem('29AAGCB7383J1Z4'), null);
    assert.match(g.gstinProblem('27AAPFU0939F1ZX'), /typo/);
    assert.match(g.gstinProblem('99AAPFU0939F1ZV'), /state code/);
    assert.match(g.gstinProblem('27AAPFU0939F1Z'), /15 characters/);
});

test('financial year turns over at midnight IST on 1 April', () => {
    assert.equal(g.fyLabel(Date.UTC(2027, 2, 31, 18, 29)), '26-27'); // 23:59 IST, 31 Mar
    assert.equal(g.fyLabel(Date.UTC(2027, 2, 31, 18, 30)), '27-28'); // 00:00 IST, 1 Apr
    assert.equal(g.formatDocNumber('INV', Date.UTC(2026, 10, 2), 7), 'INV/26-27/0007');
    assert.equal(g.docNumberProblem('INV/26-27/0007'), null);
    assert.match(g.docNumberProblem('INVOICE-MUM/26-27/0001'), /at most 16/);
    assert.match(g.docNumberProblem('INV#1'), /letters, digits/);
});

test('numbers: one past the highest used, from the starting number, per series', () => {
    const used = [{ seriesKey: 'a', seq: 3 }, { seriesKey: 'a', seq: 1 }, { seriesKey: 'b', seq: 9 }];
    assert.equal(g.nextSeq(used, 'a', 1), 4);
    assert.equal(g.nextSeq(used, 'c', 1), 1);
    assert.equal(g.nextSeq(used, 'a', 120), 120, 'a series continued from Tally starts at its number');
});

// ── Documents ────────────────────────────────────────────────────────────

const GSTIN_MH = '27AAPFU0939F1ZV';
const GSTIN_KA = '29AAGCB7383J1Z4';
const settings = (o = {}) => ({
    ...inv.EMPTY_SETTINGS, legalName: 'Test Co', address: 'Fort, Mumbai', state: '27', gstin: GSTIN_MH, signatoryName: 'A. B.',
    stores: [
        { id: 'm', name: 'Mumbai', code: 'M', address: 'Mumbai', state: '27', pincode: '', gstin: GSTIN_MH, phone: '', email: '', bankId: '' },
        { id: 'b', name: 'Bengaluru', code: 'B', address: 'Bengaluru', state: '29', pincode: '', gstin: GSTIN_KA, phone: '', email: '', bankId: '' },
    ],
    ...o,
});
const NOV = Date.UTC(2026, 10, 2);
const doc = (kind, s, o = {}) => {
    const d = inv.newDoc(kind, s, o.storeId ?? 'm', NOV);
    return {
        ...d, ...o,
        party: { ...d.party, name: 'Buyer', phone: '1', state: '27', ...(o.party ?? {}) },
        lines: o.lines ?? [{ key: 'k1', artworkId: 'a1', description: 'Painting', detail: '', hsn: '9701', qty: 1, unit: 'Nos', ratePaise: 100000_00, discountPct: 0, gstRate: 5 }],
    };
};

test('series: per GSTIN by default, per store when set, and fresh each financial year', () => {
    const s = settings();
    assert.notEqual(inv.seriesKeyFor(s, 'tax', 'm', NOV), inv.seriesKeyFor(s, 'tax', 'b', NOV), 'two GSTINs never share');
    assert.notEqual(inv.seriesKeyFor(s, 'tax', 'm', NOV), inv.seriesKeyFor(s, 'tax', 'm', Date.UTC(2027, 4, 1)), 'new FY, new series');
    const first = doc('tax', s, { status: 'Issued' });
    Object.assign(first, inv.assignNumber(first, [], s));
    assert.equal(first.number, 'INV/26-27/0001');
    assert.equal(inv.assignNumber(doc('tax', s), [first], s).number, 'INV/26-27/0002');
    const perStore = settings({ seriesPerStore: true });
    assert.equal(inv.assignNumber(doc('tax', perStore, { storeId: 'b' }), [], perStore).number, 'INVB/26-27/0001');
});

test('tax mode: same state CGST+SGST, other state IGST, LUT zero, composition and plain challans none', () => {
    const s = settings();
    const seller = inv.currentSeller(s, 'm');
    assert.equal(inv.taxModeOf(doc('tax', s), seller), 'intra');
    assert.equal(inv.taxModeOf(doc('tax', s, { placeOfSupply: '29' }), seller), 'inter');
    assert.equal(inv.taxModeOf(doc('tax', s, { placeOfSupply: '27' }), inv.currentSeller(s, 'b')), 'inter', 'Bengaluru store selling into Maharashtra');
    assert.equal(inv.taxModeOf(doc('tax', s, { supplyType: 'export-lut' }), seller), 'zero');
    assert.equal(inv.taxModeOf(doc('tax', s, { supplyType: 'sez-igst' }), seller), 'inter');
    assert.equal(inv.taxModeOf(doc('challan', s), seller), 'none');
    assert.equal(inv.taxModeOf(doc('tax', s), { ...seller, registration: 'composition' }), 'none');
    assert.equal(inv.kindLabel('tax', 'composition'), 'Bill of Supply');
});

test('issue checks: setup, HSN on tax documents only, customer GSTIN, LUT number', () => {
    const s = settings();
    assert.deepEqual(inv.issueProblems(doc('tax', s), s), []);
    assert.ok(inv.issueProblems(doc('tax', inv.EMPTY_SETTINGS), inv.EMPTY_SETTINGS).includes('Finish billing setup first.'));
    const noHsn = { lines: [{ key: 'k', artworkId: '', description: 'Frame', detail: '', hsn: '', qty: 1, unit: 'Nos', ratePaise: 100, discountPct: 0, gstRate: 18 }] };
    assert.ok(inv.issueProblems(doc('tax', s, noHsn), s).some(p => p.includes('HSN')));
    assert.ok(!inv.issueProblems(doc('proforma', s, noHsn), s).some(p => p.includes('HSN')));
    assert.ok(inv.issueProblems(doc('tax', s, { party: { gstin: '27AAPFU0939F1ZX' } }), s).some(p => p.startsWith('Customer GSTIN')));
    assert.ok(inv.issueProblems(doc('tax', s, { supplyType: 'export-lut' }), s).includes('Add the LUT/bond number.'));
});

test('issued documents are locked except payments, transport, e-way/IRN and challan returns', () => {
    const s = settings();
    const draft = doc('tax', s);
    assert.equal(inv.lockedFieldChanged(draft, { ...draft, lines: [] }), null, 'drafts are free');
    const issued = { ...draft, status: 'Issued', number: 'INV/26-27/0001' };
    assert.equal(inv.lockedFieldChanged(issued, { ...issued, lines: [] }), 'lines');
    assert.equal(inv.lockedFieldChanged(issued, { ...issued, party: { ...issued.party, name: 'X' } }), 'party');
    assert.equal(inv.lockedFieldChanged(issued, { ...issued, number: 'INV/26-27/0009' }), 'number');
    assert.equal(inv.lockedFieldChanged(issued, { ...issued, payments: [{ id: 'p', amountPaise: 1 }], ewayBillNo: '1', status: 'Cancelled' }), null);
    const challan = { ...doc('challan', s), status: 'Issued' };
    assert.equal(inv.lockedFieldChanged(challan, { ...challan, lines: challan.lines.map(l => ({ ...l, returnedQty: 1 })) }), null);
    assert.equal(inv.lockedFieldChanged(challan, { ...challan, lines: challan.lines.map(l => ({ ...l, qty: 2 })) }), 'lines');
    const proforma = { ...doc('proforma', s), status: 'Sent', number: 'PI/26-27/0001' };
    assert.equal(inv.lockedFieldChanged(proforma, { ...proforma, lines: [] }), null, 'proformas stay editable');
});

test('balance: payments and issued credit notes reduce what is due; credit room stops over-crediting', () => {
    const s = settings();
    const invoice = { ...doc('tax', s), id: 'i1', status: 'Issued', payments: [{ id: 'p', amountPaise: 5000_00 }] };
    const credit = { ...doc('credit', s), sourceId: 'i1', status: 'Issued', lines: [{ ...invoice.lines[0], ratePaise: 10000_00 }] };
    const b = inv.balanceOf(invoice, [invoice, credit], s);
    assert.equal(b.total, 105000_00);
    assert.equal(b.credited, 10500_00);
    assert.equal(b.due, 105000_00 - 10500_00 - 5000_00);
    assert.equal(b.state, 'Partly paid');
    assert.equal(inv.creditRoom(invoice, [invoice, credit], s), 105000_00 - 10500_00);
});

test('challan returns: Returned only when every line is back', () => {
    const s = settings();
    const c = doc('challan', s, { lines: [{ key: 'a', qty: 2, returnedQty: 2 }, { key: 'b', qty: 1, returnedQty: 0 }] });
    assert.equal(inv.statusAfterReturn(c), 'Delivered');
    assert.equal(inv.statusAfterReturn({ ...c, lines: c.lines.map(l => ({ ...l, returnedQty: l.qty })) }), 'Returned');
});

test('GSTR-1: registered buyers to B2B, small B2C summed in B2CS, big inter-state B2C to B2CL, cancelled counted in DOCS', () => {
    const s = settings();
    const range = [Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1)];
    const b2b = { ...doc('tax', s, { party: { gstin: GSTIN_KA, state: '29' }, placeOfSupply: '29' }), id: 'x1', status: 'Issued', number: 'INV/26-27/0001', seriesKey: 'k', seq: 1 };
    const small = { ...doc('tax', s, { lines: [{ key: 'l', hsn: '9701', qty: 1, ratePaise: 20000_00, discountPct: 0, gstRate: 5 }] }), id: 'x2', status: 'Issued', number: 'INV/26-27/0002', seriesKey: 'k', seq: 2 };
    const big = { ...doc('tax', s, { placeOfSupply: '29', party: { state: '29' } }), id: 'x3', status: 'Issued', number: 'INV/26-27/0003', seriesKey: 'k', seq: 3 };
    const gone = { ...small, id: 'x4', status: 'Cancelled', number: 'INV/26-27/0004', seq: 4 };
    const out = rep.gstr1([b2b, small, big, gone], s, range);
    assert.equal(out.b2b.split('\n').length, 2);
    assert.match(out.b2b, /29AAGCB7383J1Z4,Buyer,INV\/26-27\/0001,02-Nov-2026,105000.00,29-Karnataka,N,,Regular B2B,,5,100000.00/);
    assert.match(out.b2cs, /OE,27-Maharashtra,,5,20000.00/);
    assert.match(out.b2cl, /INV\/26-27\/0003/);
    assert.match(out.docs, /Invoices for outward supply,INV\/26-27\/0001,INV\/26-27\/0004,4,1/);
    const reg = rep.salesRegister([b2b, small, big, gone], s, range);
    assert.equal(reg.find(r => r.doc.id === 'x4').total, 0, 'cancelled counts zero');
});

// ── Data from outside ────────────────────────────────────────────────────

test('old proformas convert: one rate (kept as a fraction by the app, or a percent) on every line, same total', () => {
    const old = { id: 'inv_1', invoiceNumber: 'PI-2026-K3F9QZ', customerName: 'Mrs. Mehta', customerEmail: 'm@x.in', customerPhone: '98', items: [{ artworkId: 'a1', title: 'Study', price: 10000 }, { artworkId: '', title: 'Frame', price: 500, photoUrls: ['/api/files/p.jpg'] }], subtotal: 10500, taxRate: 0.18, total: 12390, date: 5, status: 'Paid', inquiryId: 'q1' };
    const converted = inv.toBillingDoc(old);
    assert.equal(converted.kind, 'proforma');
    assert.equal(converted.number, 'PI-2026-K3F9QZ');
    assert.equal(converted.status, 'Paid');
    assert.equal(converted.inquiryId, 'q1');
    assert.deepEqual(converted.lines.map(l => [l.description, l.ratePaise, l.gstRate]), [['Study', 10000_00, 18], ['Frame', 500_00, 18]]);
    assert.deepEqual(converted.lines[1].photoUrls, ['/api/files/p.jpg']);
    assert.equal(inv.docTotals(converted, settings()).total, 12390_00);
    assert.equal(inv.toBillingDoc({ ...old, taxRate: 18 }).lines[0].gstRate, 18, 'a percent stays a percent');
    assert.deepEqual(inv.toBillingDoc(converted), converted, 'converting twice changes nothing');
});

test('cleanDoc keeps known fields within limits and drops the rest', () => {
    const d = inv.cleanDoc({
        id: 'x', kind: 'evil', status: 'Hacked', lines: Array.from({ length: 500 }, () => ({ qty: -3, ratePaise: 'abc', gstRate: 900, hsn: '97-01x' })),
        party: { name: 'A'.repeat(1000), gstin: '27aapfu0939f1zv' }, payments: [{ amountPaise: -5 }, { amountPaise: 100, mode: 'Gold' }], extra: 'dropped',
    });
    assert.equal(d.kind, 'proforma');
    assert.equal(d.status, 'Draft');
    assert.equal(d.lines.length, 200);
    assert.deepEqual([d.lines[0].qty, d.lines[0].ratePaise, d.lines[0].gstRate, d.lines[0].hsn], [0, 0, 100, '9701']);
    assert.equal(d.party.name.length, 120);
    assert.equal(d.party.gstin, '27AAPFU0939F1ZV');
    assert.deepEqual(d.payments.map(p => [p.amountPaise, p.mode]), [[100, 'Cash']]);
    assert.equal('extra' in d, false);
    assert.equal(inv.cleanDoc({ lines: [{ qty: 2, returnedQty: 9 }] }).lines[0].returnedQty, 2, 'never more back than went out');
});

test('cleanSettings: defaults for what is missing, only image data, clean prefixes', () => {
    const s = inv.cleanSettings({ series: { tax: { prefix: 'in v#', start: -4 } }, logoImage: 'javascript:alert(1)', signatureImage: 'data:image/png;base64,AAAA', tally: { salesLedger: '  ' } });
    assert.equal(s.series.tax.prefix, 'INV');
    assert.equal(s.series.tax.start, 1);
    assert.equal(s.series.challan.prefix, 'DC');
    assert.equal(s.logoImage, '');
    assert.equal(s.signatureImage, 'data:image/png;base64,AAAA');
    assert.equal(s.tally.salesLedger, 'Sales @{rate}%');
    assert.equal(s.roundOff, true);
    assert.equal(inv.cleanSettings({ roundOff: false }).roundOff, false);
});

test('saves may not issue, cancel or convert by status; challans may go delivered and returned', () => {
    const s = settings();
    const draft = doc('tax', s);
    assert.match(inv.statusChangeProblem(draft, { ...draft, status: 'Issued' }), /Issue or Cancel/);
    assert.match(inv.statusChangeProblem(null, { ...draft, status: 'Issued' }), /drafts/);
    const issued = { ...draft, status: 'Issued' };
    assert.match(inv.statusChangeProblem(issued, { ...issued, status: 'Cancelled' }), /Issue or Cancel/);
    assert.match(inv.statusChangeProblem(issued, { ...issued, kind: 'proforma' }), /kind/);
    const pf = doc('proforma', s);
    assert.equal(inv.statusChangeProblem(pf, { ...pf, status: 'Sent' }), null);
    assert.match(inv.statusChangeProblem(pf, { ...pf, status: 'Converted' }), /by hand/);
    const ch = { ...doc('challan', s), status: 'Issued' };
    assert.equal(inv.statusChangeProblem(ch, { ...ch, status: 'Delivered' }), null);
    assert.match(inv.statusChangeProblem(ch, { ...ch, status: 'Returned' }), /Not every item/);
    assert.equal(inv.statusChangeProblem(ch, { ...ch, status: 'Returned', lines: ch.lines.map(l => ({ ...l, returnedQty: l.qty })) }), null);
});

test('payments only on an issued tax invoice, never above its total; links only against proformas and issued invoices', () => {
    const s = settings();
    const draft = doc('tax', s);
    const pay = (d, amountPaise) => ({ ...d, payments: [{ id: 'p', date: 1, amountPaise, mode: 'UPI', reference: '' }] });
    assert.match(inv.paymentsProblem(draft, pay(draft, 100), s), /issued tax invoice/);
    const issued = { ...draft, status: 'Issued' };
    assert.equal(inv.paymentsProblem(issued, pay(issued, 105000_00), s), null);
    assert.match(inv.paymentsProblem(issued, pay(issued, 105000_01), s), /more than the invoice/);
    assert.equal(inv.linkProblem(issued), null);
    assert.equal(inv.linkProblem(doc('proforma', s)), null);
    assert.ok(inv.linkProblem(draft));
    assert.ok(inv.linkProblem({ ...doc('proforma', s), status: 'Paid' }));
    assert.ok(inv.linkProblem({ ...doc('challan', s), status: 'Issued' }));
});

test('Tally XML: a customer ledger, balanced vouchers, credit notes reversed, cancelled ones marked, XML escaped', () => {
    const s = settings();
    const range = [Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1)];
    const sale = { ...doc('tax', s, { party: { name: 'Kiran & Co <LLP>', gstin: GSTIN_KA, state: '29' }, placeOfSupply: '29' }), id: 't1', status: 'Issued', number: 'INV/26-27/0001', seq: 1 };
    const credit = { ...doc('credit', s, { party: sale.party, placeOfSupply: '29' }), id: 'c1', status: 'Issued', number: 'CN/26-27/0001', sourceId: 't1', lines: [{ ...sale.lines[0], ratePaise: 1000_00 }] };
    const gone = { ...doc('tax', s), id: 't2', status: 'Cancelled', number: 'INV/26-27/0002', seq: 2, cancelReason: 'Typo' };
    const out = rep.tallyXml([sale, credit, gone, doc('tax', s)], s, range);
    assert.match(out, /^<\?xml/);
    assert.equal((out.match(/<LEDGER NAME=/g) ?? []).length, 2, 'one ledger per customer');
    assert.match(out, /Kiran &amp; Co &lt;LLP&gt;/);
    assert.equal((out.match(/<VOUCHER /g) ?? []).length, 3, 'drafts are left out');
    // Every voucher balances: its ledger amounts (not the bill references inside them) add up to zero.
    for (const voucher of out.split('<VOUCHER ').slice(1)) {
        const amounts = [...voucher.matchAll(/<ISDEEMEDPOSITIVE>\w+<\/ISDEEMEDPOSITIVE><AMOUNT>(-?[\d.]+)<\/AMOUNT>/g)].map(m => Math.round(Number(m[1]) * 100));
        assert.equal(amounts.reduce((a, b) => a + b, 0), 0, 'debits equal credits');
    }
    assert.match(out, /VCHTYPE="Sales"[\s\S]*?<LEDGERNAME>Kiran &amp; Co &lt;LLP&gt;<\/LEDGERNAME><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>-105000.00/);
    assert.match(out, /<LEDGERNAME>Sales @5%<\/LEDGERNAME><ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE><AMOUNT>100000.00/);
    assert.match(out, /<LEDGERNAME>Output IGST<\/LEDGERNAME><ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE><AMOUNT>5000.00/);
    assert.match(out, /VCHTYPE="Credit Note"[\s\S]*?<NAME>INV\/26-27\/0001<\/NAME><BILLTYPE>Agst Ref<\/BILLTYPE>/);
    assert.match(out, /<VOUCHERNUMBER>INV\/26-27\/0002<\/VOUCHERNUMBER>[\s\S]*?<ISCANCELLED>Yes<\/ISCANCELLED><\/VOUCHER>/);
    assert.equal(rep.tallyDate(Date.UTC(2027, 2, 31, 18, 30)), '20270401', 'the day in India');
});
