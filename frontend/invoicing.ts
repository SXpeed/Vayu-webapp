// Billing documents (proforma, tax invoice / bill of supply, delivery challan,
// credit and debit notes), the billing setup, and the rules the server
// enforces. Pure, so the app and the Worker share it (like salesRules.ts).

import {
    computeTotals, docNumberProblem, formatDocNumber, fyLabel, gstinProblem, hsnProblem, nextSeq,
    STATES, type TaxMode, type Totals,
} from './gstRules';

export type DocKind = 'proforma' | 'tax' | 'challan' | 'credit' | 'debit';

export const KIND_LABEL: Record<DocKind, string> = {
    proforma: 'Proforma Invoice',
    tax: 'Tax Invoice',
    challan: 'Delivery Challan',
    credit: 'Credit Note',
    debit: 'Debit Note',
};

/** 'Paid' only on proformas from before Billing (they could be marked paid). */
export type ProformaStatus = 'Draft' | 'Sent' | 'Accepted' | 'Rejected' | 'Converted' | 'Paid';
export type IssuedStatus = 'Draft' | 'Issued' | 'Cancelled';
export type ChallanStatus = 'Draft' | 'Issued' | 'Delivered' | 'Returned' | 'Invoiced' | 'Cancelled';
export type DocStatus = ProformaStatus | IssuedStatus | ChallanStatus;

export type SupplyType = 'regular' | 'export-igst' | 'export-lut' | 'sez-igst' | 'sez-lut';
export const SUPPLY_LABEL: Record<SupplyType, string> = {
    regular: 'Regular (domestic)',
    'export-igst': 'Export, with IGST paid',
    'export-lut': 'Export under LUT (no IGST)',
    'sez-igst': 'SEZ, with IGST paid',
    'sez-lut': 'SEZ under LUT (no IGST)',
};

export type ChallanPurpose = 'approval' | 'exhibition' | 'job-work' | 'sale' | 'transfer' | 'other';
export const PURPOSE_LABEL: Record<ChallanPurpose, string> = {
    approval: 'Supply on approval',
    exhibition: 'Exhibition / display',
    'job-work': 'Job work (framing, restoration)',
    sale: 'Delivery against a sale',
    transfer: 'Stock transfer between stores',
    other: 'Other',
};
/** Purposes where the goods are expected back. */
export const RETURNABLE: ReadonlySet<ChallanPurpose> = new Set(['approval', 'exhibition', 'job-work']);

export type PaymentMode = 'Cash' | 'UPI' | 'Card' | 'Bank transfer' | 'Cheque' | 'Payment link';
export const PAYMENT_MODES: readonly PaymentMode[] = ['Cash', 'UPI', 'Card', 'Bank transfer', 'Cheque', 'Payment link'];

export interface Party {
    name: string;
    phone: string;
    email: string;
    /** '' for an unregistered buyer (B2C). */
    gstin: string;
    address: string;
    /** State code, e.g. '27'. */
    state: string;
    pincode: string;
    sameShipping: boolean;
    shipName: string;
    shipAddress: string;
    shipState: string;
    shipPincode: string;
}

export interface DocLine {
    key: string;
    /** '' for a line that isn't an inventory piece. */
    artworkId: string;
    description: string;
    /** Artist, medium, size… printed under the description. */
    detail: string;
    hsn: string;
    qty: number;
    unit: string;
    ratePaise: number;
    discountPct: number;
    gstRate: number;
    /** Challan only: how many came back. */
    returnedQty?: number;
    /** A line that isn't an inventory piece: its own photos (the first prints on the proforma). */
    photoUrls?: string[];
}

export interface Payment {
    id: string;
    date: number;
    amountPaise: number;
    mode: PaymentMode;
    reference: string;
}

export interface Transport {
    mode: '' | 'Road' | 'Rail' | 'Air' | 'Ship' | 'Hand delivery' | 'Courier';
    vehicleNo: string;
    transporter: string;
    lrNo: string;
    dispatchDate: string;
}

export interface ExportInfo {
    lutNo: string;
    currency: string;
    exchangeRate: string;
    portCode: string;
    shippingBillNo: string;
    shippingBillDate: string;
}

/** Seller details frozen on the document when it is issued, so later setup changes never alter it. */
export interface Seller {
    legalName: string;
    tradeName: string;
    address: string;
    state: string;
    gstin: string;
    pan: string;
    phone: string;
    email: string;
    bank: BankAccount | null;
    registration: Registration;
}

export interface HistoryEntry { at: number; text: string }

export interface BillingDoc {
    id: string;
    kind: DocKind;
    storeId: string;
    /** '' until numbered (drafts of issued kinds; proformas saved offline). */
    number: string;
    seriesKey?: string;
    seq?: number;
    status: DocStatus;
    date: number;
    /** Tax invoice: payment due. */
    dueDate?: number;
    /** Proforma: offer valid until. */
    validUntil?: number;
    /** Proforma: advance requested, paise. */
    advancePaise?: number;
    party: Party;
    placeOfSupply: string;
    reverseCharge: boolean;
    supplyType: SupplyType;
    priceIncludesTax: boolean;
    billDiscountPaise: number;
    lines: DocLine[];
    notes: string;
    terms: string;
    /** Never printed. */
    internalNote: string;
    reference: string;
    transport: Transport;
    ewayBillNo: string;
    irn: string;
    ackNo: string;
    ackDate: string;
    exportInfo: ExportInfo;
    challanPurpose?: ChallanPurpose;
    /** Challan: print tax (movement for a supply) or values only. */
    challanTax?: boolean;
    returnBy?: number;
    /** Proforma/challan this was converted from; for notes, the invoice they adjust. */
    sourceId?: string;
    /** Credit/debit note: why. */
    noteReason?: string;
    /** Set when the proforma was made from an inquiry. */
    inquiryId?: string;
    /** Worked out by the server on every save (payment links read these). */
    totalPaise?: number;
    taxPaise?: number;
    payments: Payment[];
    cancelReason?: string;
    seller?: Seller;
    history: HistoryEntry[];
    createdAt: number;
    updatedAt: number;
    issuedAt?: number;
}

// ── Setup ────────────────────────────────────────────────────────────────

export type Registration = 'regular' | 'composition' | 'unregistered';

export interface BankAccount {
    id: string;
    label: string;
    accountName: string;
    accountNumber: string;
    ifsc: string;
    bankName: string;
    branch: string;
    upiId: string;
}

/** A store's billing details. In the app these are extra columns on the existing `stores` table. */
export interface BillingStore {
    id: string;
    name: string;
    /** Short code for per-store number prefixes, e.g. "M". */
    code: string;
    address: string;
    state: string;
    pincode: string;
    gstin: string;
    phone: string;
    email: string;
    /** '' = the default bank. */
    bankId: string;
}

export interface Series { prefix: string; start: number }

export interface TallySettings {
    /** The company name exactly as in Tally ('' imports into the company that is open). */
    company: string;
    /** "{rate}" in the name splits sales by GST rate, e.g. "Sales @{rate}%". */
    salesLedger: string;
    cgstLedger: string;
    sgstLedger: string;
    igstLedger: string;
    roundOffLedger: string;
    /** The group customer ledgers are created under. */
    partyGroup: string;
}

export interface BillingSettings {
    legalName: string;
    tradeName: string;
    pan: string;
    cin: string;
    email: string;
    phone: string;
    website: string;
    /** Registered office; also the seller address when there are no stores. */
    address: string;
    state: string;
    pincode: string;
    gstin: string;
    registration: Registration;
    signatoryName: string;
    /** Data URL; the app would upload it like other photos. */
    signatureImage: string;
    logoImage: string;
    terms: string;
    notes: string;
    jurisdiction: string;
    banks: BankAccount[];
    defaultBankId: string;
    showUpiQr: boolean;
    series: Record<DocKind, Series>;
    /** Each store numbers on its own (prefix + store code); otherwise one series per GSTIN. */
    seriesPerStore: boolean;
    defaultHsnArt: string;
    defaultSacService: string;
    defaultGstArt: number;
    defaultGstService: number;
    pricesIncludeTax: boolean;
    hsnMinDigits: 4 | 6 | 8;
    roundOff: boolean;
    print: {
        photosOnProforma: boolean;
        photosOnInvoice: boolean;
        hsnSummary: boolean;
        copies: { original: boolean; duplicate: boolean; triplicate: boolean };
        footer: string;
    };
    proformaValidityDays: number;
    advancePct: number;
    /** Issuing a tax invoice marks inventory pieces Sold; approval/exhibition challans mark them out. */
    inventoryEffects: boolean;
    /** Names used in the Tally export; they must match (or will create) ledgers in the Tally company. */
    tally: TallySettings;
    stores: BillingStore[];
}

export const EMPTY_SETTINGS: BillingSettings = {
    legalName: '', tradeName: '', pan: '', cin: '', email: '', phone: '', website: '',
    address: '', state: '', pincode: '', gstin: '', registration: 'regular',
    signatoryName: '', signatureImage: '', logoImage: '',
    terms: '', notes: 'Thank you for your business.', jurisdiction: '',
    banks: [], defaultBankId: '', showUpiQr: true,
    series: {
        proforma: { prefix: 'PI', start: 1 },
        tax: { prefix: 'INV', start: 1 },
        challan: { prefix: 'DC', start: 1 },
        credit: { prefix: 'CN', start: 1 },
        debit: { prefix: 'DN', start: 1 },
    },
    seriesPerStore: false,
    defaultHsnArt: '9701', defaultSacService: '', defaultGstArt: 5, defaultGstService: 18,
    pricesIncludeTax: false, hsnMinDigits: 4, roundOff: true,
    print: {
        photosOnProforma: true, photosOnInvoice: false, hsnSummary: true,
        copies: { original: true, duplicate: false, triplicate: false }, footer: '',
    },
    proformaValidityDays: 15, advancePct: 50, inventoryEffects: true,
    tally: {
        company: '', salesLedger: 'Sales @{rate}%', cgstLedger: 'Output CGST', sgstLedger: 'Output SGST',
        igstLedger: 'Output IGST', roundOffLedger: 'Round Off', partyGroup: 'Sundry Debtors',
    },
    stores: [],
};

/** The store a document is billed from, or null when the org has no stores (the org profile sells). */
export const storeOf = (s: BillingSettings, storeId: string): BillingStore | null =>
    s.stores.find(st => st.id === storeId) ?? null;

/** Seller details as they are now, for a draft; issued documents carry their frozen copy. */
export function currentSeller(s: BillingSettings, storeId: string): Seller {
    const store = storeOf(s, storeId);
    const bankId = store?.bankId || s.defaultBankId;
    return {
        legalName: s.legalName,
        tradeName: s.tradeName,
        address: [store?.address || s.address, store ? store.pincode : s.pincode].filter(Boolean).join(' - '),
        state: store?.state || s.state,
        gstin: store?.gstin || s.gstin,
        pan: s.pan,
        phone: store?.phone || s.phone,
        email: store?.email || s.email,
        bank: s.banks.find(b => b.id === bankId) ?? s.banks[0] ?? null,
        registration: s.registration,
    };
}

export const sellerOf = (doc: BillingDoc, s: BillingSettings): Seller => doc.seller ?? currentSeller(s, doc.storeId);

function businessProblems(s: BillingSettings): [string, string][] {
    const out: [string, string][] = [];
    const storesHave = (f: (st: BillingStore) => string) => s.stores.some(st => f(st).trim());
    if (!s.legalName.trim()) out.push(['business', 'Legal business name']);
    if (s.registration === 'regular' && !s.gstin && !storesHave(st => st.gstin)) out.push(['business', 'GSTIN']);
    if (s.gstin && gstinProblem(s.gstin)) out.push(['business', 'A valid GSTIN']);
    if (!s.address.trim() && !storesHave(st => st.address)) out.push(['business', 'Business address']);
    if (!s.state && !storesHave(st => st.state)) out.push(['business', 'Business state']);
    if (!s.signatoryName.trim()) out.push(['business', 'Authorised signatory']);
    return out;
}

function storeProblems(st: BillingStore): [string, string][] {
    if (!st.gstin) return [];
    if (gstinProblem(st.gstin)) return [['stores', `A valid GSTIN for ${st.name}`]];
    return st.state && st.gstin.slice(0, 2) !== st.state ? [['stores', `${st.name}: GSTIN is for another state`]] : [];
}

/** What still has to be filled in before tax invoices and challans can be issued, as [section, message]. */
export function setupProblems(s: BillingSettings): [string, string][] {
    const numbering = (['tax', 'challan', 'credit', 'debit'] as const).flatMap((kind): [string, string][] => {
        const p = docNumberProblem(docNumberFor(s, kind, s.stores[0]?.id ?? '', Date.now(), 9999));
        return p ? [['numbering', `${KIND_LABEL[kind]}: ${p}`]] : [];
    });
    return [...businessProblems(s), ...s.stores.flatMap(storeProblems), ...numbering];
}

// ── Numbering ────────────────────────────────────────────────────────────

/** Series per kind, per FY, and per store (if set) or per GSTIN: two GSTINs never share one. */
export function seriesKeyFor(s: BillingSettings, kind: DocKind, storeId: string, date: number): string {
    const store = storeOf(s, storeId);
    const owner = s.seriesPerStore ? (storeId || 'org') : (store?.gstin || s.gstin || 'org');
    return `${kind}|${owner}|${fyLabel(date)}`;
}

export function prefixFor(s: BillingSettings, kind: DocKind, storeId: string): string {
    const code = s.seriesPerStore ? storeOf(s, storeId)?.code ?? '' : '';
    return `${s.series[kind].prefix}${code}`;
}

export const docNumberFor = (s: BillingSettings, kind: DocKind, storeId: string, date: number, seq: number): string =>
    formatDocNumber(prefixFor(s, kind, storeId), date, seq);

/** Assigns the next number in the document's series (the server does this in one statement). */
export function assignNumber(doc: BillingDoc, all: readonly BillingDoc[], s: BillingSettings): Pick<BillingDoc, 'number' | 'seriesKey' | 'seq'> {
    const seriesKey = seriesKeyFor(s, doc.kind, doc.storeId, doc.date);
    const seq = nextSeq(all, seriesKey, s.series[doc.kind].start);
    return { seriesKey, seq, number: docNumberFor(s, doc.kind, doc.storeId, doc.date, seq) };
}

// ── Tax ──────────────────────────────────────────────────────────────────

/** Composition and unregistered sellers issue a Bill of Supply, never a Tax Invoice. */
export const isBillOfSupply = (registration: Registration): boolean => registration !== 'regular';

export const kindLabel = (kind: DocKind, registration: Registration): string =>
    kind === 'tax' && isBillOfSupply(registration) ? 'Bill of Supply' : KIND_LABEL[kind];

export function taxModeOf(doc: BillingDoc, seller: Seller): TaxMode {
    if (isBillOfSupply(seller.registration)) return 'none';
    if (doc.kind === 'challan' && !doc.challanTax) return 'none';
    if (doc.supplyType === 'export-lut' || doc.supplyType === 'sez-lut') return 'zero';
    if (doc.supplyType !== 'regular') return 'inter';
    return seller.state && doc.placeOfSupply && seller.state !== doc.placeOfSupply ? 'inter' : 'intra';
}

export function docTotals(doc: BillingDoc, s: BillingSettings): Totals {
    return computeTotals(doc.lines, {
        mode: taxModeOf(doc, sellerOf(doc, s)),
        inclusive: doc.priceIncludesTax,
        billDiscountPaise: doc.billDiscountPaise,
        roundOff: s.roundOff,
    });
}

// ── Lifecycle rules ──────────────────────────────────────────────────────

/** Kinds that are numbered and locked on Issue. Proformas are quotations: numbered on save, never locked. */
export const ISSUED_KINDS: ReadonlySet<DocKind> = new Set(['tax', 'challan', 'credit', 'debit']);

export const isLocked = (doc: BillingDoc): boolean => ISSUED_KINDS.has(doc.kind) && doc.status !== 'Draft';

/** Fields that can still change on a locked document. */
const OPEN_AFTER_ISSUE: ReadonlySet<keyof BillingDoc> = new Set([
    'status', 'payments', 'transport', 'ewayBillNo', 'irn', 'ackNo', 'ackDate', 'internalNote',
    'cancelReason', 'history', 'updatedAt', 'dueDate', 'returnBy',
]);

/** The first locked field an edit changes, or null. Challan return counts are the one line change allowed. */
export function lockedFieldChanged(before: BillingDoc, after: BillingDoc): string | null {
    if (!isLocked(before)) return null;
    const keys = new Set([...Object.keys(before), ...Object.keys(after)] as (keyof BillingDoc)[]);
    for (const k of keys) {
        if (OPEN_AFTER_ISSUE.has(k)) continue;
        if (k === 'lines' && before.kind === 'challan') {
            const strip = (d: BillingDoc) => JSON.stringify(d.lines.map(l => ({ ...l, returnedQty: undefined })));
            if (strip(before) !== strip(after)) return 'lines';
            continue;
        }
        if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) return k;
    }
    return null;
}

function partyProblems(doc: BillingDoc): string[] {
    const out: string[] = [];
    const p = doc.party;
    if (!p.name.trim()) out.push('Add the customer’s name.');
    if (doc.kind === 'proforma' && !p.phone.trim() && !p.email.trim()) out.push('Add the customer’s phone number or email.');
    if (ISSUED_KINDS.has(doc.kind) && !p.state && doc.supplyType === 'regular') out.push('Choose the customer’s state.');
    if (!doc.placeOfSupply) out.push('Choose the place of supply.');
    const gstin = p.gstin ? gstinProblem(p.gstin) : null;
    if (gstin) out.push(`Customer GSTIN: ${gstin}`);
    return out;
}

function lineProblems(doc: BillingDoc, s: BillingSettings): string[] {
    if (doc.lines.length === 0) return ['Add at least one item.'];
    const needsHsn = doc.kind !== 'proforma' && !isBillOfSupply(currentSeller(s, doc.storeId).registration);
    return doc.lines.flatMap((l, i) => {
        const n = `Line ${i + 1}`;
        const hsn = needsHsn ? hsnProblem(l.hsn, s.hsnMinDigits) : null;
        return [
            l.description.trim() ? '' : `${n}: add a description.`,
            Number.isFinite(l.qty) && l.qty > 0 ? '' : `${n}: quantity must be more than 0.`,
            Number.isFinite(l.ratePaise) && l.ratePaise >= 0 ? '' : `${n}: rate can’t be below 0.`,
            hsn ? `${n}: ${hsn}` : '',
        ].filter(Boolean);
    });
}

function kindProblems(doc: BillingDoc): string[] {
    const note = doc.kind === 'credit' || doc.kind === 'debit';
    return [
        doc.supplyType.endsWith('lut') && !doc.exportInfo.lutNo.trim() ? 'Add the LUT/bond number.' : '',
        doc.kind === 'challan' && !doc.challanPurpose ? 'Choose the challan’s purpose.' : '',
        note && !doc.sourceId ? 'A note has to be against an invoice.' : '',
        note && !doc.noteReason?.trim() ? 'Give the reason for the note.' : '',
    ].filter(Boolean);
}

/** Why a draft can't be issued yet; empty when it can. */
export function issueProblems(doc: BillingDoc, s: BillingSettings): string[] {
    const setup = ISSUED_KINDS.has(doc.kind) && setupProblems(s).length ? ['Finish billing setup first.'] : [];
    const number = docNumberProblem(docNumberFor(s, doc.kind, doc.storeId, doc.date, 9999));
    return [...setup, ...partyProblems(doc), ...lineProblems(doc, s), ...kindProblems(doc), ...(number ? [number] : [])];
}

/** A credit note may not take an invoice below zero: room left, in paise. */
export function creditRoom(invoice: BillingDoc, all: readonly BillingDoc[], s: BillingSettings, exceptId = ''): number {
    const credited = all
        .filter(d => d.kind === 'credit' && d.sourceId === invoice.id && d.status === 'Issued' && d.id !== exceptId)
        .reduce((sum, d) => sum + docTotals(d, s).total, 0);
    return docTotals(invoice, s).total - credited;
}

export interface Balance { total: number; credited: number; debited: number; paid: number; due: number; state: 'Unpaid' | 'Partly paid' | 'Paid' }

/** What a tax invoice is owed: its total, adjusted by issued notes, less payments. */
export function balanceOf(invoice: BillingDoc, all: readonly BillingDoc[], s: BillingSettings): Balance {
    const notes = all.filter(d => d.sourceId === invoice.id && d.status === 'Issued');
    const credited = notes.filter(d => d.kind === 'credit').reduce((sum, d) => sum + docTotals(d, s).total, 0);
    const debited = notes.filter(d => d.kind === 'debit').reduce((sum, d) => sum + docTotals(d, s).total, 0);
    const total = docTotals(invoice, s).total;
    const paid = invoice.payments.reduce((sum, p) => sum + p.amountPaise, 0);
    const due = total - credited + debited - paid;
    let state: Balance['state'] = 'Unpaid';
    if (due <= 0) state = 'Paid';
    else if (paid > 0) state = 'Partly paid';
    return { total, credited, debited, paid, due, state };
}

/** Proformas past their date read as Expired (not stored, so extending the date revives them). */
export function displayStatus(doc: BillingDoc, now: number): string {
    if (doc.kind === 'proforma' && doc.validUntil && doc.validUntil < now && (doc.status === 'Draft' || doc.status === 'Sent')) return 'Expired';
    if (doc.kind === 'challan' && doc.status === 'Delivered' && doc.lines.some(l => (l.returnedQty ?? 0) > 0)) return 'Part returned';
    return doc.status;
}

/** A challan's status after returns: Returned once every line is fully back. */
export function statusAfterReturn(doc: BillingDoc): ChallanStatus {
    const allBack = doc.lines.every(l => (l.returnedQty ?? 0) >= l.qty);
    return allBack ? 'Returned' : 'Delivered';
}

// ── New documents ────────────────────────────────────────────────────────

export const emptyParty = (): Party => ({
    name: '', phone: '', email: '', gstin: '', address: '', state: '', pincode: '',
    sameShipping: true, shipName: '', shipAddress: '', shipState: '', shipPincode: '',
});

const DAY = 864e5;

export function newDoc(kind: DocKind, s: BillingSettings, storeId: string, now: number): BillingDoc {
    const seller = currentSeller(s, storeId);
    return {
        id: crypto.randomUUID(),
        kind,
        storeId,
        number: '',
        status: 'Draft',
        date: now,
        dueDate: kind === 'tax' ? now + 15 * DAY : undefined,
        validUntil: kind === 'proforma' ? now + s.proformaValidityDays * DAY : undefined,
        party: emptyParty(),
        placeOfSupply: seller.state,
        reverseCharge: false,
        supplyType: 'regular',
        priceIncludesTax: s.pricesIncludeTax,
        billDiscountPaise: 0,
        lines: [],
        notes: s.notes,
        terms: kind === 'challan' ? '' : s.terms,
        internalNote: '',
        reference: '',
        transport: { mode: '', vehicleNo: '', transporter: '', lrNo: '', dispatchDate: '' },
        ewayBillNo: '', irn: '', ackNo: '', ackDate: '',
        exportInfo: { lutNo: '', currency: 'USD', exchangeRate: '', portCode: '', shippingBillNo: '', shippingBillDate: '' },
        challanPurpose: kind === 'challan' ? 'approval' : undefined,
        challanTax: kind === 'challan' ? false : undefined,
        payments: [],
        history: [],
        createdAt: now,
        updatedAt: now,
    };
}

/** A new draft of another kind from an existing document: same customer, items and store, linked back. */
export function convertDoc(source: BillingDoc, kind: DocKind, s: BillingSettings, now: number): BillingDoc {
    const base = newDoc(kind, s, source.storeId, now);
    const purpose: ChallanPurpose = source.kind === 'tax' ? 'sale' : 'approval';
    return {
        ...base,
        party: { ...source.party },
        placeOfSupply: source.placeOfSupply,
        supplyType: source.supplyType,
        priceIncludesTax: source.priceIncludesTax,
        billDiscountPaise: kind === 'credit' || kind === 'debit' ? 0 : source.billDiscountPaise,
        lines: source.lines.map(l => ({ ...l, key: crypto.randomUUID(), returnedQty: undefined })),
        reference: source.number ? `${KIND_LABEL[source.kind]} ${source.number}` : '',
        challanTax: kind === 'challan' ? source.kind !== 'proforma' : base.challanTax,
        challanPurpose: kind === 'challan' ? purpose : undefined,
        sourceId: source.id,
        notes: source.notes,
        terms: kind === 'challan' ? '' : source.terms,
    };
}

export const stateOfGstin = (gstin: string): string => (STATES.some(s => s.code === gstin.slice(0, 2)) ? gstin.slice(0, 2) : '');

// ── Data from outside: old proformas, requests, storage ──────────────────
// Everything that reaches the server (or comes back from a device's saved
// copy) goes through cleanDoc / cleanSettings: known fields, sane sizes.

type Raw = Record<string, unknown>;
const MAX_TIME = 4_102_444_800_000; // 2100
const MAX_LINES = 200;
const MAX_IMAGE = 400_000;
const KINDS: readonly DocKind[] = ['proforma', 'tax', 'challan', 'credit', 'debit'];
const ALL_STATUSES: readonly DocStatus[] = ['Draft', 'Sent', 'Accepted', 'Rejected', 'Converted', 'Paid', 'Issued', 'Cancelled', 'Delivered', 'Returned', 'Invoiced'];
const SUPPLY_TYPES = Object.keys(SUPPLY_LABEL) as SupplyType[];
const PURPOSES = Object.keys(PURPOSE_LABEL) as ChallanPurpose[];
const TRANSPORT_MODES: readonly Transport['mode'][] = ['', 'Road', 'Rail', 'Air', 'Ship', 'Hand delivery', 'Courier'];

const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? v as Raw : {});
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const num = (v: unknown, min: number, max: number, dflt = 0): number => {
    let n = Number.NaN;
    if (typeof v === 'number') n = v;
    else if (typeof v === 'string' && v.trim()) n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
const int = (v: unknown, min: number, max: number, dflt = 0): number => Math.round(num(v, min, max, dflt));
const flag = (v: unknown, dflt = false): boolean => (typeof v === 'boolean' ? v : dflt);
const oneOf = <T,>(v: unknown, options: readonly T[], dflt: T): T => (options.includes(v as T) ? v as T : dflt);
const digits = (v: unknown, max: number): string => str(v, 40).replaceAll(/\D/g, '').slice(0, max);
const time = (v: unknown): number | undefined => {
    const n = num(v, 0, MAX_TIME, 0);
    return n > 0 ? n : undefined;
};
/** `{ key: value }`, or nothing when the value is missing, so stored JSON has no empty keys. */
const optional = <T,>(key: string, value: T | undefined | ''): Record<string, T> => (value === undefined || value === '' ? {} : { [key]: value });

function cleanLine(v: unknown): DocLine {
    const l = obj(v);
    const qty = num(l.qty, 0, 1e6);
    const photos = list(l.photoUrls, 6).filter((u): u is string => typeof u === 'string' && u.length <= 500);
    return {
        key: str(l.key, 64) || crypto.randomUUID(),
        artworkId: str(l.artworkId, 64),
        description: str(l.description, 200),
        detail: str(l.detail, 240),
        hsn: digits(l.hsn, 8),
        qty,
        unit: str(l.unit, 12),
        ratePaise: int(l.ratePaise, 0, 1e13),
        discountPct: num(l.discountPct, 0, 100),
        gstRate: num(l.gstRate, 0, 100),
        ...(l.returnedQty === undefined ? {} : { returnedQty: num(l.returnedQty, 0, qty) }),
        ...(photos.length ? { photoUrls: photos } : {}),
    };
}

function cleanParty(v: unknown): Party {
    const p = obj(v);
    return {
        name: str(p.name, 120), phone: str(p.phone, 30), email: str(p.email, 120), gstin: str(p.gstin, 15).toUpperCase(),
        address: str(p.address, 400), state: str(p.state, 2), pincode: digits(p.pincode, 6), sameShipping: flag(p.sameShipping, true),
        shipName: str(p.shipName, 120), shipAddress: str(p.shipAddress, 400), shipState: str(p.shipState, 2), shipPincode: digits(p.shipPincode, 6),
    };
}

const REGISTRATIONS = ['regular', 'composition', 'unregistered'] as const;

function cleanSeller(v: unknown): Seller | undefined {
    if (!v || typeof v !== 'object') return undefined;
    const s = obj(v);
    const b = s.bank && typeof s.bank === 'object' ? obj(s.bank) : null;
    return {
        legalName: str(s.legalName, 120), tradeName: str(s.tradeName, 120), address: str(s.address, 420), state: str(s.state, 2),
        gstin: str(s.gstin, 15), pan: str(s.pan, 10), phone: str(s.phone, 30), email: str(s.email, 120),
        registration: oneOf(s.registration, REGISTRATIONS, 'regular'),
        bank: b ? {
            id: str(b.id, 64), label: str(b.label, 40), accountName: str(b.accountName, 120), accountNumber: str(b.accountNumber, 34),
            ifsc: str(b.ifsc, 11), bankName: str(b.bankName, 80), branch: str(b.branch, 80), upiId: str(b.upiId, 80),
        } : null,
    };
}

function cleanPayments(v: unknown, now: number): Payment[] {
    return list(v, 100).map(p => {
        const x = obj(p);
        return { id: str(x.id, 64) || crypto.randomUUID(), date: num(x.date, 0, MAX_TIME, now), amountPaise: int(x.amountPaise, 0, 1e13), mode: oneOf(x.mode, PAYMENT_MODES, 'Cash'), reference: str(x.reference, 60) };
    }).filter(p => p.amountPaise > 0);
}

/** Any document from a request or storage, reduced to known fields within limits. */
export function cleanDoc(v: unknown): BillingDoc {
    const d = obj(v);
    const now = Date.now();
    const t = obj(d.transport);
    const ex = obj(d.exportInfo);
    return {
        id: str(d.id, 80),
        kind: oneOf(d.kind, KINDS, 'proforma'),
        storeId: str(d.storeId, 64),
        number: str(d.number, 40),
        ...optional('seriesKey', str(d.seriesKey, 120)),
        ...optional('seq', d.seq === undefined || d.seq === null ? undefined : int(d.seq, 1, 1e9)),
        status: oneOf(d.status, ALL_STATUSES, 'Draft'),
        date: num(d.date, 0, MAX_TIME, now),
        ...optional('dueDate', time(d.dueDate)),
        ...optional('validUntil', time(d.validUntil)),
        ...optional('advancePaise', d.advancePaise === undefined ? undefined : int(d.advancePaise, 0, 1e13)),
        party: cleanParty(d.party),
        placeOfSupply: str(d.placeOfSupply, 2),
        reverseCharge: flag(d.reverseCharge),
        supplyType: oneOf(d.supplyType, SUPPLY_TYPES, 'regular'),
        priceIncludesTax: flag(d.priceIncludesTax),
        billDiscountPaise: int(d.billDiscountPaise, 0, 1e13),
        lines: list(d.lines, MAX_LINES).map(cleanLine),
        notes: str(d.notes, 2000),
        terms: str(d.terms, 4000),
        internalNote: str(d.internalNote, 2000),
        reference: str(d.reference, 80),
        transport: {
            mode: oneOf(t.mode, TRANSPORT_MODES, ''), vehicleNo: str(t.vehicleNo, 20), transporter: str(t.transporter, 80),
            lrNo: str(t.lrNo, 40), dispatchDate: str(t.dispatchDate, 10),
        },
        ewayBillNo: digits(d.ewayBillNo, 12),
        irn: str(d.irn, 64),
        ackNo: str(d.ackNo, 30),
        ackDate: str(d.ackDate, 10),
        exportInfo: {
            lutNo: str(ex.lutNo, 40), currency: str(ex.currency, 3), exchangeRate: str(ex.exchangeRate, 12), portCode: str(ex.portCode, 10),
            shippingBillNo: str(ex.shippingBillNo, 20), shippingBillDate: str(ex.shippingBillDate, 10),
        },
        ...optional('challanPurpose', d.challanPurpose === undefined ? undefined : oneOf(d.challanPurpose, PURPOSES, 'other')),
        ...optional('challanTax', typeof d.challanTax === 'boolean' ? d.challanTax : undefined),
        ...optional('returnBy', time(d.returnBy)),
        ...optional('sourceId', str(d.sourceId, 80)),
        ...optional('noteReason', str(d.noteReason, 120)),
        ...optional('inquiryId', str(d.inquiryId, 80)),
        ...optional('totalPaise', d.totalPaise === undefined ? undefined : int(d.totalPaise, -1e13, 1e13)),
        ...optional('taxPaise', d.taxPaise === undefined ? undefined : int(d.taxPaise, -1e13, 1e13)),
        payments: cleanPayments(d.payments, now),
        ...optional('cancelReason', str(d.cancelReason, 200)),
        ...optional('seller', cleanSeller(d.seller)),
        history: list(Array.isArray(d.history) ? d.history.slice(-200) : [], 200).map(h => ({ at: num(obj(h).at, 0, MAX_TIME, now), text: str(obj(h).text, 200) })),
        createdAt: num(d.createdAt, 0, MAX_TIME, now),
        updatedAt: num(d.updatedAt, 0, MAX_TIME, now),
        ...optional('issuedAt', time(d.issuedAt)),
    };
}

/** A stored or sent document in the current shape; proformas from before Billing are converted. */
export function toBillingDoc(v: unknown): BillingDoc {
    const d = obj(v);
    if (Array.isArray(d.lines) || !Array.isArray(d.items)) return cleanDoc(d);
    // An old proforma: one GST rate on the whole bill, kept by the app as a fraction (0.18).
    const stored = num(d.taxRate, 0, 100);
    const rate = stored > 0 && stored < 1 ? Math.round(stored * 10_000) / 100 : stored;
    return cleanDoc({
        id: d.id, kind: 'proforma', number: d.invoiceNumber, status: d.status, date: d.date, createdAt: d.date, updatedAt: d.date,
        party: { name: d.customerName, phone: d.customerPhone, email: d.customerEmail, address: d.customerAddress, sameShipping: true },
        inquiryId: d.inquiryId,
        lines: d.items.map((item, i) => {
            const x = obj(item);
            return { key: `l${i}`, artworkId: x.artworkId, description: x.title, qty: 1, unit: 'Nos', ratePaise: Math.round(num(x.price, 0, 1e11) * 100), gstRate: rate, photoUrls: x.photoUrls };
        }),
    });
}

function cleanSeries(v: unknown): Record<DocKind, Series> {
    const series = obj(v);
    return Object.fromEntries(KINDS.map(k => {
        const x = obj(series[k]);
        return [k, { prefix: str(x.prefix, 8).toUpperCase().replaceAll(/[^A-Z0-9-]/g, '') || EMPTY_SETTINGS.series[k].prefix, start: int(x.start, 1, 1e7, 1) }];
    })) as Record<DocKind, Series>;
}

function cleanPrint(v: unknown): BillingSettings['print'] {
    const print = obj(v);
    const copies = obj(print.copies);
    const e = EMPTY_SETTINGS.print;
    return {
        photosOnProforma: flag(print.photosOnProforma, e.photosOnProforma),
        photosOnInvoice: flag(print.photosOnInvoice, e.photosOnInvoice),
        hsnSummary: flag(print.hsnSummary, e.hsnSummary),
        copies: {
            original: flag(copies.original, e.copies.original),
            duplicate: flag(copies.duplicate, e.copies.duplicate),
            triplicate: flag(copies.triplicate, e.copies.triplicate),
        },
        footer: str(print.footer, 200),
    };
}

function cleanTally(v: unknown): TallySettings {
    const tally = obj(v);
    const ledger = (k: keyof TallySettings) => str(tally[k], 80).trim() || EMPTY_SETTINGS.tally[k];
    return {
        company: str(tally.company, 120).trim(), salesLedger: ledger('salesLedger'), cgstLedger: ledger('cgstLedger'), sgstLedger: ledger('sgstLedger'),
        igstLedger: ledger('igstLedger'), roundOffLedger: ledger('roundOffLedger'), partyGroup: ledger('partyGroup'),
    };
}

/** Billing setup from a request or storage; anything missing takes the default. */
export function cleanSettings(v: unknown): BillingSettings {
    const s = obj(v);
    const e = EMPTY_SETTINGS;
    const image = (x: unknown) => (typeof x === 'string' && x.length <= MAX_IMAGE && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(x) ? x : '');
    return {
        legalName: str(s.legalName, 120), tradeName: str(s.tradeName, 120), pan: str(s.pan, 10).toUpperCase(), cin: str(s.cin, 21).toUpperCase(),
        email: str(s.email, 120), phone: str(s.phone, 30), website: str(s.website, 120),
        address: str(s.address, 400), state: str(s.state, 2), pincode: digits(s.pincode, 6), gstin: str(s.gstin, 15).toUpperCase(),
        registration: oneOf(s.registration, REGISTRATIONS, 'regular'),
        signatoryName: str(s.signatoryName, 80), signatureImage: image(s.signatureImage), logoImage: image(s.logoImage),
        terms: str(s.terms, 4000), notes: s.notes === undefined ? e.notes : str(s.notes, 2000), jurisdiction: str(s.jurisdiction, 120),
        banks: list(s.banks, 10).map(b => {
            const x = obj(b);
            return {
                id: str(x.id, 64) || crypto.randomUUID(), label: str(x.label, 40), accountName: str(x.accountName, 120), accountNumber: str(x.accountNumber, 34),
                ifsc: str(x.ifsc, 11).toUpperCase(), bankName: str(x.bankName, 80), branch: str(x.branch, 80), upiId: str(x.upiId, 80),
            };
        }),
        defaultBankId: str(s.defaultBankId, 64),
        showUpiQr: flag(s.showUpiQr, e.showUpiQr),
        series: cleanSeries(s.series),
        seriesPerStore: flag(s.seriesPerStore, e.seriesPerStore),
        defaultHsnArt: s.defaultHsnArt === undefined ? e.defaultHsnArt : digits(s.defaultHsnArt, 8),
        defaultSacService: digits(s.defaultSacService, 8),
        defaultGstArt: num(s.defaultGstArt, 0, 100, e.defaultGstArt),
        defaultGstService: num(s.defaultGstService, 0, 100, e.defaultGstService),
        pricesIncludeTax: flag(s.pricesIncludeTax, e.pricesIncludeTax),
        hsnMinDigits: oneOf(s.hsnMinDigits, [4, 6, 8] as const, 4),
        roundOff: flag(s.roundOff, e.roundOff),
        print: cleanPrint(s.print),
        proformaValidityDays: int(s.proformaValidityDays, 1, 365, e.proformaValidityDays),
        advancePct: num(s.advancePct, 0, 100, e.advancePct),
        inventoryEffects: flag(s.inventoryEffects, e.inventoryEffects),
        tally: cleanTally(s.tally),
        stores: list(s.stores, 50).map(x => {
            const o = obj(x);
            return {
                id: str(o.id, 64) || crypto.randomUUID(), name: str(o.name, 60), code: str(o.code, 3).toUpperCase().replaceAll(/[^A-Z0-9]/g, ''),
                address: str(o.address, 400), state: str(o.state, 2), pincode: digits(o.pincode, 6), gstin: str(o.gstin, 15).toUpperCase(),
                phone: str(o.phone, 30), email: str(o.email, 120), bankId: str(o.bankId, 64),
            };
        }),
    };
}

// ── What a save may change (the server checks every PUT) ────────────────

/** Statuses a save may set. Issue, Cancel, Converted and Invoiced only come from the server's own actions. */
export function statusChangeProblem(before: BillingDoc | null, after: BillingDoc): string | null {
    if (before && before.kind !== after.kind) return 'A document can’t change its kind.';
    if (before?.status === after.status) return null;
    if (after.kind === 'proforma') return ['Draft', 'Sent', 'Accepted', 'Rejected'].includes(after.status) ? null : `A proforma can’t be marked ${after.status} by hand.`;
    if (!before) return after.status === 'Draft' ? null : 'New documents start as drafts.';
    if (after.kind === 'challan' && ['Issued', 'Delivered'].includes(before.status) && ['Delivered', 'Returned'].includes(after.status)) {
        return after.status === 'Returned' && statusAfterReturn(after) !== 'Returned' ? 'Not every item is back yet.' : null;
    }
    return `Use Issue or Cancel to change this ${KIND_LABEL[after.kind].toLowerCase()}’s status.`;
}

/** Payments only go on an issued tax invoice, and never add up to more than it. */
export function paymentsProblem(before: BillingDoc | null, after: BillingDoc, s: BillingSettings): string | null {
    if (JSON.stringify(before?.payments ?? []) === JSON.stringify(after.payments)) return null;
    if (after.kind !== 'tax' || after.status !== 'Issued') return 'Payments go on an issued tax invoice.';
    const paid = after.payments.reduce((t, p) => t + p.amountPaise, 0);
    return paid > docTotals(after, s).total ? 'Payments can’t add up to more than the invoice.' : null;
}

/** Why a payment link can't collect against this document, or null. */
export function linkProblem(doc: BillingDoc): string | null {
    if (doc.kind === 'proforma') return doc.status === 'Paid' || doc.status === 'Rejected' ? `This proforma is marked ${doc.status.toLowerCase()}.` : null;
    if (doc.kind === 'tax' && doc.status === 'Issued') return null;
    return 'Payment links can only collect against a proforma or an issued tax invoice.';
}
