// Billing reports: sales register, GST summaries, GSTR-1 CSVs, receivables,
// open challans. Pure; amounts in paise until written to CSV.

import { docTotals, balanceOf, KIND_LABEL, sellerOf, taxModeOf, RETURNABLE, type BillingDoc, type BillingSettings } from './invoicing';
import { fyRange, fyStartYear, stateName, type HsnRow } from './gstRules';

export type Range = [number, number];

export type Period = 'all' | 'month' | 'last-month' | 'fy' | 'last-fy';
export const PERIODS: { id: Period; label: string }[] = [
    { id: 'all', label: 'All time' }, { id: 'month', label: 'This month' }, { id: 'last-month', label: 'Last month' },
    { id: 'fy', label: 'This financial year' }, { id: 'last-fy', label: 'Last financial year' },
];

export function periodRange(p: Period, now: number): [number, number] {
    const d = new Date(now);
    switch (p) {
        case 'month': return [new Date(d.getFullYear(), d.getMonth(), 1).getTime(), new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()];
        case 'last-month': return [new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime(), new Date(d.getFullYear(), d.getMonth(), 1).getTime()];
        case 'fy': return fyRange(fyStartYear(now));
        case 'last-fy': return fyRange(fyStartYear(now) - 1);
        default: return [0, Number.MAX_SAFE_INTEGER];
    }
}


const inRange = (d: BillingDoc, [from, to]: Range) => d.date >= from && d.date < to;
const issuedIn = (docs: readonly BillingDoc[], range: Range, kinds: string[]) =>
    docs.filter(d => kinds.includes(d.kind) && d.status !== 'Draft' && inRange(d, range));

export interface RegisterRow {
    doc: BillingDoc;
    sign: 1 | -1;
    taxable: number;
    cgst: number;
    sgst: number;
    igst: number;
    total: number;
    cancelled: boolean;
}

/** Tax invoices and notes in the period; credit notes count negative; cancelled ones count zero. */
export function salesRegister(docs: readonly BillingDoc[], s: BillingSettings, range: Range): RegisterRow[] {
    return issuedIn(docs, range, ['tax', 'credit', 'debit'])
        .sort((a, b) => a.date - b.date)
        .map(doc => {
            const t = docTotals(doc, s);
            const cancelled = doc.status === 'Cancelled';
            const sign = doc.kind === 'credit' ? -1 : 1;
            const k = cancelled ? 0 : sign;
            const v = (x: number) => k * x || 0; // no "-0.00" when a credit note has none of a tax
            return { doc, sign, cancelled, taxable: v(t.taxable), cgst: v(t.cgst), sgst: v(t.sgst), igst: v(t.igst), total: v(t.total) };
        });
}

export function sumRows<T extends { taxable: number; cgst: number; sgst: number; igst: number }>(rows: readonly T[]) {
    return rows.reduce((a, r) => ({ taxable: a.taxable + r.taxable, cgst: a.cgst + r.cgst, sgst: a.sgst + r.sgst, igst: a.igst + r.igst }),
        { taxable: 0, cgst: 0, sgst: 0, igst: 0 });
}

const live = (rows: RegisterRow[]) => rows.filter(r => !r.cancelled);

/** HSN-wise summary across the period, net of credit notes. */
export function hsnSummary(rows: readonly RegisterRow[], s: BillingSettings): HsnRow[] {
    const map = new Map<string, HsnRow>();
    for (const r of live([...rows])) {
        for (const h of docTotals(r.doc, s).hsn) {
            const key = `${h.hsn}|${h.rate}`;
            const acc = map.get(key) ?? { hsn: h.hsn, rate: h.rate, qty: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
            acc.qty += r.sign * h.qty;
            acc.taxable += r.sign * h.taxable;
            acc.cgst += r.sign * h.cgst;
            acc.sgst += r.sign * h.sgst;
            acc.igst += r.sign * h.igst;
            map.set(key, acc);
        }
    }
    return [...map.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate);
}

export interface Split { label: string; taxable: number; tax: number; total: number; count: number }

/** B2B vs B2C and intra- vs inter-state, net of credit notes. */
export function splits(rows: readonly RegisterRow[], s: BillingSettings): Split[] {
    const buckets: Record<string, Split> = {};
    const add = (label: string, r: RegisterRow) => {
        const b = buckets[label] ?? (buckets[label] = { label, taxable: 0, tax: 0, total: 0, count: 0 });
        b.taxable += r.taxable;
        b.tax += r.cgst + r.sgst + r.igst;
        b.total += r.total;
        b.count += 1;
    };
    for (const r of live([...rows])) {
        add(r.doc.party.gstin ? 'B2B (registered buyers)' : 'B2C (unregistered buyers)', r);
        add(taxModeOf(r.doc, sellerOf(r.doc, s)) === 'intra' ? 'Within the state (CGST + SGST)' : 'Other state / export (IGST)', r);
    }
    return Object.values(buckets);
}

// ── GSTR-1 ───────────────────────────────────────────────────────────────
// Column names follow the GST offline tool's CSV templates.
// shortcut: core sections only (no cess, e-commerce or amendments); check against the current offline tool before filing.

/** B2C inter-state invoices above this go to B2CL (₹1 lakh since Aug 2024). */
export const B2CL_LIMIT = 10_000_000; // paise

const csvRupees = (paise: number) => (paise / 100).toFixed(2);
export const gstDate = (ms: number) =>
    new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).replaceAll(' ', '-');
const pos = (code: string) => `${code}-${stateName(code)}`;

/** One entry per tax rate on a document. */
function byRate(doc: BillingDoc, s: BillingSettings): { rate: number; taxable: number }[] {
    const m = new Map<number, number>();
    for (const h of docTotals(doc, s).hsn) m.set(h.rate, (m.get(h.rate) ?? 0) + h.taxable);
    return [...m].map(([rate, taxable]) => ({ rate, taxable }));
}

export function toCsv(rows: readonly (readonly (string | number)[])[]): string {
    const cell = (v: string | number) => {
        const t = String(v);
        return /[",\n]/.test(t) ? `"${t.replaceAll('"', '""')}"` : t;
    };
    return rows.map(r => r.map(cell).join(',')).join('\n');
}

const HEADERS = {
    b2b: ['GSTIN/UIN of Recipient', 'Receiver Name', 'Invoice Number', 'Invoice date', 'Invoice Value', 'Place Of Supply', 'Reverse Charge', 'Applicable % of Tax Rate', 'Invoice Type', 'E-Commerce GSTIN', 'Rate', 'Taxable Value', 'Cess Amount'],
    b2cl: ['Invoice Number', 'Invoice date', 'Invoice Value', 'Place Of Supply', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN'],
    b2cs: ['Type', 'Place Of Supply', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN'],
    exp: ['Export Type', 'Invoice Number', 'Invoice date', 'Invoice Value', 'Port Code', 'Shipping Bill Number', 'Shipping Bill Date', 'Rate', 'Taxable Value', 'Cess Amount'],
    cdnr: ['GSTIN/UIN of Recipient', 'Receiver Name', 'Note Number', 'Note Date', 'Note Type', 'Place Of Supply', 'Reverse Charge', 'Note Supply Type', 'Note Value', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount'],
    cdnur: ['UR Type', 'Note Number', 'Note Date', 'Note Type', 'Place Of Supply', 'Note Value', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount'],
    hsn: ['HSN', 'Description', 'UQC', 'Total Quantity', 'Total Value', 'Rate', 'Taxable Value', 'Integrated Tax Amount', 'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount'],
    docs: ['Nature of Document', 'Sr. No. From', 'Sr. No. To', 'Total Number', 'Cancelled'],
};

const NATURE: Record<string, string> = {
    tax: 'Invoices for outward supply', credit: 'Credit Note', debit: 'Debit Note',
    challan: 'Delivery Challan in cases other than by way of supply (excluding at S no. 9 to 11)',
};

const SEZ_TYPE: Record<string, string> = { 'sez-igst': 'SEZ supplies with payment', 'sez-lut': 'SEZ supplies without payment' };

interface Gstr1Context { total: (d: BillingDoc) => number; inter: (d: BillingDoc) => boolean }
type InvoiceSection = 'exp' | 'b2b' | 'b2cl' | 'b2cs';
type RateRow = { rate: number; taxable: number };

const isExport = (d: BillingDoc) => d.supplyType.startsWith('export');
const yesNo = (v: boolean) => (v ? 'Y' : 'N');

/** Where an invoice is reported: export, registered buyer, large inter-state B2C, or the B2C summary. */
function sectionOf(d: BillingDoc, g: Gstr1Context): InvoiceSection {
    if (isExport(d)) return 'exp';
    if (d.party.gstin) return 'b2b';
    return g.inter(d) && g.total(d) > B2CL_LIMIT ? 'b2cl' : 'b2cs';
}

function invoiceRow(section: Exclude<InvoiceSection, 'b2cs'>, d: BillingDoc, r: RateRow, g: Gstr1Context): string[] {
    const value = csvRupees(g.total(d));
    const date = gstDate(d.date);
    if (section === 'exp') {
        const ex = d.exportInfo;
        return [d.supplyType === 'export-igst' ? 'WPAY' : 'WOPAY', d.number, date, value, ex.portCode, ex.shippingBillNo, ex.shippingBillDate, String(r.rate), csvRupees(r.taxable), ''];
    }
    if (section === 'b2b') {
        return [d.party.gstin, d.party.name, d.number, date, value, pos(d.placeOfSupply), yesNo(d.reverseCharge), '', SEZ_TYPE[d.supplyType] ?? 'Regular B2B', '', String(r.rate), csvRupees(r.taxable), ''];
    }
    return [d.number, date, value, pos(d.placeOfSupply), '', String(r.rate), csvRupees(r.taxable), '', ''];
}

/** An unregistered buyer's note goes to CDNUR only against an export or a large inter-state invoice. */
function unregisteredType(inv: BillingDoc | undefined, g: Gstr1Context): string {
    if (!inv) return '';
    if (isExport(inv)) return inv.supplyType === 'export-igst' ? 'EXPWP' : 'EXPWOP';
    return sectionOf(inv, g) === 'b2cl' ? 'B2CL' : '';
}

function noteRow(n: BillingDoc, inv: BillingDoc | undefined, r: RateRow, g: Gstr1Context): ['cdnr' | 'cdnur', string[]] | null {
    const type = n.kind === 'credit' ? 'C' : 'D';
    const value = csvRupees(g.total(n));
    if (n.party.gstin) {
        return ['cdnr', [n.party.gstin, n.party.name, n.number, gstDate(n.date), type, pos(n.placeOfSupply), yesNo(n.reverseCharge), 'Regular', value, '', String(r.rate), csvRupees(r.taxable), '']];
    }
    const ur = unregisteredType(inv, g);
    return ur ? ['cdnur', [ur, n.number, gstDate(n.date), type, pos(n.placeOfSupply), value, '', String(r.rate), csvRupees(r.taxable), '']] : null;
}

/** DOCS: first and last number of each series used in the period, with how many and how many cancelled. */
function documentRows(docs: readonly BillingDoc[], range: Range): string[][] {
    const series = new Map<string, BillingDoc[]>();
    for (const d of docs.filter(x => x.number && x.kind !== 'proforma' && inRange(x, range))) {
        const key = d.seriesKey ?? d.kind;
        series.set(key, [...(series.get(key) ?? []), d]);
    }
    return [...series.values()].map(list => {
        list.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
        return [NATURE[list[0].kind], list[0].number, list.at(-1)!.number, String(list.length), String(list.filter(d => d.status === 'Cancelled').length)];
    });
}

type Gstr1Rows = Record<'b2b' | 'b2cl' | 'exp' | 'cdnr' | 'cdnur', string[][]>;

/** Small B2C sales, summed by place of supply and rate. */
class B2csTotals {
    readonly sums = new Map<string, number>();
    add(code: string, rate: number, taxable: number): void {
        const key = `${code}|${rate}`;
        this.sums.set(key, (this.sums.get(key) ?? 0) + taxable);
    }
}

function addInvoices(invoices: BillingDoc[], s: BillingSettings, g: Gstr1Context, rows: Gstr1Rows, b2cs: B2csTotals): void {
    for (const d of invoices) {
        const section = sectionOf(d, g);
        for (const r of byRate(d, s)) {
            if (section === 'b2cs') b2cs.add(d.placeOfSupply, r.rate, r.taxable);
            else rows[section].push(invoiceRow(section, d, r, g));
        }
    }
}

function addNotes(notes: BillingDoc[], docs: readonly BillingDoc[], s: BillingSettings, g: Gstr1Context, rows: Gstr1Rows, b2cs: B2csTotals): void {
    for (const n of notes) {
        const inv = docs.find(d => d.id === n.sourceId);
        // Small B2C sales are reported net of their notes.
        const netted = !n.party.gstin && !!inv && sectionOf(inv, g) === 'b2cs';
        const sign = n.kind === 'credit' ? -1 : 1;
        for (const r of byRate(n, s)) {
            const row = netted ? null : noteRow(n, inv, r, g);
            if (netted) b2cs.add(n.placeOfSupply, r.rate, sign * r.taxable);
            else if (row) rows[row[0]].push(row[1]);
        }
    }
}

export function gstr1(docs: readonly BillingDoc[], s: BillingSettings, range: Range): Record<string, string> {
    const g: Gstr1Context = { total: d => docTotals(d, s).total, inter: d => taxModeOf(d, sellerOf(d, s)) !== 'intra' };
    const live = (kinds: string[]) => issuedIn(docs, range, kinds).filter(d => d.status !== 'Cancelled');
    const rows: Gstr1Rows = { b2b: [], b2cl: [], exp: [], cdnr: [], cdnur: [] };
    const b2cs = new B2csTotals();
    addInvoices(live(['tax']), s, g, rows, b2cs);
    addNotes(live(['credit', 'debit']), docs, s, g, rows, b2cs);

    const b2csRows = [...b2cs.sums].map(([key, taxable]) => {
        const [code, rate] = key.split('|');
        return ['OE', pos(code), '', rate, csvRupees(taxable), '', ''];
    });
    const hsnRows = hsnSummary(salesRegister(docs, s, range), s).map(h => [
        h.hsn, '', 'NOS-NUMBERS', String(h.qty), csvRupees(h.taxable + h.cgst + h.sgst + h.igst), String(h.rate),
        csvRupees(h.taxable), csvRupees(h.igst), csvRupees(h.cgst), csvRupees(h.sgst), '',
    ]);
    return {
        b2b: toCsv([HEADERS.b2b, ...rows.b2b]), b2cl: toCsv([HEADERS.b2cl, ...rows.b2cl]), b2cs: toCsv([HEADERS.b2cs, ...b2csRows]),
        cdnr: toCsv([HEADERS.cdnr, ...rows.cdnr]), cdnur: toCsv([HEADERS.cdnur, ...rows.cdnur]), exp: toCsv([HEADERS.exp, ...rows.exp]),
        hsn: toCsv([HEADERS.hsn, ...hsnRows]), docs: toCsv([HEADERS.docs, ...documentRows(docs, range)]),
    };
}

const REGISTER_TYPE: Record<string, string> = { tax: 'Invoice', credit: 'Credit note', debit: 'Debit note' };

export function registerCsv(rows: readonly RegisterRow[]): string {
    return toCsv([
        ['Type', 'Number', 'Date', 'Customer', 'GSTIN', 'Place of supply', 'Taxable', 'CGST', 'SGST/UTGST', 'IGST', 'Total', 'Status'],
        ...rows.map(r => [REGISTER_TYPE[r.doc.kind], r.doc.number, gstDate(r.doc.date),
            r.doc.party.name, r.doc.party.gstin, pos(r.doc.placeOfSupply), csvRupees(r.taxable), csvRupees(r.cgst), csvRupees(r.sgst), csvRupees(r.igst),
            csvRupees(r.total), r.doc.status]),
    ]);
}

// ── Receivables and challans ─────────────────────────────────────────────

export const AGE_BUCKETS = ['Not due', '1–30 days', '31–60 days', '61–90 days', '90+ days'] as const;

/** Unpaid issued invoices by days past their due date. */
export function receivables(docs: readonly BillingDoc[], s: BillingSettings, now: number) {
    const rows = docs
        .filter(d => d.kind === 'tax' && d.status === 'Issued')
        .map(d => {
            const due = balanceOf(d, docs, s).due;
            const late = Math.floor((now - (d.dueDate ?? d.date)) / 864e5);
            // 0: not due; then 1–30, 31–60, 61–90 and 90+ days late.
            const bucket = late <= 0 ? 0 : Math.min(4, Math.ceil(late / 30));
            return { doc: d, due, late, bucket };
        })
        .filter(r => r.due > 0)
        .sort((a, b) => b.late - a.late);
    const buckets = AGE_BUCKETS.map((label, i) => ({ label, amount: rows.filter(r => r.bucket === i).reduce((t, r) => t + r.due, 0) }));
    return { rows, buckets, total: rows.reduce((t, r) => t + r.due, 0) };
}

/** Challans whose goods are still out (approval, exhibition, job work). */
export function openChallans(docs: readonly BillingDoc[], now: number) {
    return docs
        .filter(d => d.kind === 'challan' && (d.status === 'Issued' || d.status === 'Delivered') && d.challanPurpose && RETURNABLE.has(d.challanPurpose))
        .map(d => ({ doc: d, out: d.lines.reduce((t, l) => t + l.qty - (l.returnedQty ?? 0), 0), overdue: !!d.returnBy && d.returnBy < now }))
        .sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.doc.returnBy ?? Infinity) - (b.doc.returnBy ?? Infinity));
}

/** Share of proformas in the period that became a sale. */
export function conversion(docs: readonly BillingDoc[], range: Range) {
    const sent = docs.filter(d => d.kind === 'proforma' && d.number && inRange(d, range));
    const converted = sent.filter(d => d.status === 'Converted').length;
    return { sent: sent.length, converted, pct: sent.length ? Math.round(converted * 100 / sent.length) : 0 };
}

// ── Tally export ─────────────────────────────────────────────────────────
// One XML file for Tally (Gateway of Tally → Import → Vouchers): a ledger for
// each customer, then an accounting voucher per tax invoice, credit note and
// debit note. Ledger names come from Billing setup → Tally.
// shortcut: accounting vouchers only (no stock items), so Tally's inventory isn't touched; add item invoices if they keep stock in Tally.

const xml = (s: string): string =>
    s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

/** 20261102, the day in India. */
export function tallyDate(ms: number): string {
    const d = new Date(ms + 5.5 * 3600e3);
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

const amount = (paise: number) => (paise / 100).toFixed(2);

/** In Tally XML a debit is negative with ISDEEMEDPOSITIVE Yes; a credit positive with No. */
function ledgerEntry(name: string, paise: number, extra = ''): string {
    return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xml(name)}</LEDGERNAME><ISDEEMEDPOSITIVE>${paise < 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`
        + `<AMOUNT>${amount(paise)}</AMOUNT>${extra}</ALLLEDGERENTRIES.LIST>`;
}

const registrationType = (doc: BillingDoc) => (doc.party.gstin ? 'Regular' : 'Unregistered/Consumer');

function partyLedger(doc: BillingDoc, group: string): string {
    const p = doc.party;
    const address = [p.address, p.pincode].filter(Boolean).join(' - ').split('\n').filter(Boolean)
        .map(l => `<ADDRESS>${xml(l.slice(0, 100))}</ADDRESS>`).join('');
    return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${xml(p.name)}"><NAME.LIST><NAME>${xml(p.name)}</NAME></NAME.LIST>`
        + `<PARENT>${xml(group)}</PARENT><ISBILLWISEON>Yes</ISBILLWISEON><COUNTRYNAME>India</COUNTRYNAME>`
        + (p.state ? `<LEDSTATENAME>${xml(stateName(p.state))}</LEDSTATENAME>` : '')
        + `<GSTREGISTRATIONTYPE>${registrationType(doc)}</GSTREGISTRATIONTYPE>`
        + (p.gstin ? `<PARTYGSTIN>${xml(p.gstin)}</PARTYGSTIN>` : '')
        + (address ? `<ADDRESS.LIST TYPE="String">${address}</ADDRESS.LIST>` : '')
        + (p.pincode ? `<PINCODE>${xml(p.pincode)}</PINCODE>` : '')
        + '</LEDGER></TALLYMESSAGE>';
}

const VOUCHER_TYPE: Partial<Record<BillingDoc['kind'], string>> = { tax: 'Sales', credit: 'Credit Note', debit: 'Debit Note' };

/** A sale credits sales, tax and round-off and debits the customer; a credit note is the reverse. */
function voucherEntries(doc: BillingDoc, source: BillingDoc | undefined, s: BillingSettings): string[] {
    const t = docTotals(doc, s);
    const tl = s.tally;
    const sign = doc.kind === 'credit' ? -1 : 1;
    const bill = doc.kind === 'credit' && source
        ? `<BILLALLOCATIONS.LIST><NAME>${xml(source.number)}</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>${amount(sign * t.total)}</AMOUNT></BILLALLOCATIONS.LIST>`
        : `<BILLALLOCATIONS.LIST><NAME>${xml(doc.number)}</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>${amount(-sign * t.total)}</AMOUNT></BILLALLOCATIONS.LIST>`;
    // One sales ledger per name: "{rate}" in the name splits by GST rate.
    const sales = new Map<string, number>();
    for (const h of t.hsn) {
        const name = tl.salesLedger.replaceAll('{rate}', String(h.rate));
        sales.set(name, (sales.get(name) ?? 0) + h.taxable);
    }
    const credits: [string, number][] = [...sales, [tl.cgstLedger, t.cgst], [tl.sgstLedger, t.sgst], [tl.igstLedger, t.igst], [tl.roundOffLedger, t.roundOff]];
    return [
        ledgerEntry(doc.party.name, -sign * t.total, `<ISPARTYLEDGER>Yes</ISPARTYLEDGER>${bill}`),
        ...credits.filter(([, paise]) => paise).map(([name, paise]) => ledgerEntry(name, sign * paise)),
    ];
}

function narrationOf(doc: BillingDoc, source: BillingDoc | undefined): string {
    const against = source ? ` against ${source.number}` : '';
    const reason = doc.noteReason ? `: ${doc.noteReason}` : '';
    return [
        doc.kind === 'tax' ? '' : KIND_LABEL[doc.kind] + against + reason,
        doc.status === 'Cancelled' && doc.cancelReason ? `Cancelled: ${doc.cancelReason}` : '',
        doc.reference,
    ].filter(Boolean).join('. ');
}

function voucher(doc: BillingDoc, all: readonly BillingDoc[], s: BillingSettings): string {
    const type = VOUCHER_TYPE[doc.kind]!;
    const source = doc.sourceId ? all.find(d => d.id === doc.sourceId) : undefined;
    const cancelled = doc.status === 'Cancelled';
    const entries = cancelled ? [] : voucherEntries(doc, source, s);
    const place = stateName(doc.placeOfSupply);
    const narration = narrationOf(doc, source);
    const party = xml(doc.party.name);
    return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${type}" ACTION="Create" OBJVIEW="Accounting Voucher View">`
        + `<DATE>${tallyDate(doc.date)}</DATE><EFFECTIVEDATE>${tallyDate(doc.date)}</EFFECTIVEDATE>`
        + `<VOUCHERTYPENAME>${type}</VOUCHERTYPENAME><VOUCHERNUMBER>${xml(doc.number)}</VOUCHERNUMBER>`
        + (source ? `<REFERENCE>${xml(source.number)}</REFERENCE>` : '')
        + `<PARTYLEDGERNAME>${party}</PARTYLEDGERNAME><PARTYNAME>${party}</PARTYNAME>`
        + `<BASICBUYERNAME>${party}</BASICBUYERNAME><GSTREGISTRATIONTYPE>${registrationType(doc)}</GSTREGISTRATIONTYPE>`
        + (doc.party.gstin ? `<PARTYGSTIN>${xml(doc.party.gstin)}</PARTYGSTIN>` : '')
        + (place ? `<STATENAME>${xml(place)}</STATENAME><PLACEOFSUPPLY>${xml(place)}</PLACEOFSUPPLY>` : '')
        + '<COUNTRYOFRESIDENCE>India</COUNTRYOFRESIDENCE><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>'
        + (narration ? `<NARRATION>${xml(narration)}</NARRATION>` : '')
        + (cancelled ? '<ISCANCELLED>Yes</ISCANCELLED>' : '')
        + entries.join('')
        + '</VOUCHER></TALLYMESSAGE>';
}

/** The Tally import file for issued tax invoices and notes dated in the range. */
export function tallyXml(docs: readonly BillingDoc[], s: BillingSettings, range: Range): string {
    const chosen = docs
        .filter(d => d.kind in VOUCHER_TYPE && d.number && d.status !== 'Draft' && inRange(d, range))
        .sort((a, b) => a.date - b.date || (a.seq ?? 0) - (b.seq ?? 0));
    const parties = new Map<string, BillingDoc>();
    for (const d of chosen) if (d.party.name && !parties.has(d.party.name)) parties.set(d.party.name, d);
    const company = s.tally.company ? `<STATICVARIABLES><SVCURRENTCOMPANY>${xml(s.tally.company)}</SVCURRENTCOMPANY></STATICVARIABLES>` : '';
    return '<?xml version="1.0" encoding="UTF-8"?>\n'
        + `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME>${company}</REQUESTDESC><REQUESTDATA>\n`
        + [...parties.values()].map(d => partyLedger(d, s.tally.partyGroup)).join('\n')
        + (parties.size ? '\n' : '')
        + chosen.map(d => voucher(d, docs, s)).join('\n')
        + '\n</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>\n';
}
