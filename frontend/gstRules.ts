// GST maths for Billing: state codes, GSTIN check, financial year, document
// numbers, line/tax/round-off totals, amount in words. Pure (no imports) so the
// app and the Worker can share it, like salesRules.ts. Money is integer paise.

export interface StateInfo {
    code: string;
    name: string;
    /** Union territory without a legislature: its half of the tax is UTGST, not SGST. */
    ut?: boolean;
}

export const STATES: readonly StateInfo[] = [
    { code: '01', name: 'Jammu and Kashmir' },
    { code: '02', name: 'Himachal Pradesh' },
    { code: '03', name: 'Punjab' },
    { code: '04', name: 'Chandigarh', ut: true },
    { code: '05', name: 'Uttarakhand' },
    { code: '06', name: 'Haryana' },
    { code: '07', name: 'Delhi' },
    { code: '08', name: 'Rajasthan' },
    { code: '09', name: 'Uttar Pradesh' },
    { code: '10', name: 'Bihar' },
    { code: '11', name: 'Sikkim' },
    { code: '12', name: 'Arunachal Pradesh' },
    { code: '13', name: 'Nagaland' },
    { code: '14', name: 'Manipur' },
    { code: '15', name: 'Mizoram' },
    { code: '16', name: 'Tripura' },
    { code: '17', name: 'Meghalaya' },
    { code: '18', name: 'Assam' },
    { code: '19', name: 'West Bengal' },
    { code: '20', name: 'Jharkhand' },
    { code: '21', name: 'Odisha' },
    { code: '22', name: 'Chhattisgarh' },
    { code: '23', name: 'Madhya Pradesh' },
    { code: '24', name: 'Gujarat' },
    { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu', ut: true },
    { code: '27', name: 'Maharashtra' },
    { code: '29', name: 'Karnataka' },
    { code: '30', name: 'Goa' },
    { code: '31', name: 'Lakshadweep', ut: true },
    { code: '32', name: 'Kerala' },
    { code: '33', name: 'Tamil Nadu' },
    { code: '34', name: 'Puducherry' },
    { code: '35', name: 'Andaman and Nicobar Islands', ut: true },
    { code: '36', name: 'Telangana' },
    { code: '37', name: 'Andhra Pradesh' },
    { code: '38', name: 'Ladakh', ut: true },
    { code: '97', name: 'Other Territory' },
    { code: '96', name: 'Foreign Country' },
];

export const stateName = (code: string): string => STATES.find(s => s.code === code)?.name ?? '';
/** "Maharashtra (27)", or '' when unknown. */
export const stateLabel = (code: string): string => (stateName(code) ? `${stateName(code)} (${code})` : '');
export const sgstLabel = (placeOfSupply: string): 'SGST' | 'UTGST' => (STATES.find(s => s.code === placeOfSupply)?.ut ? 'UTGST' : 'SGST');

/** GST rates offered in the editor. shortcut: fixed list; check against the current notification before going live. */
export const GST_RATES: readonly number[] = [0, 0.1, 0.25, 1, 1.5, 3, 5, 12, 18, 28, 40];

// ── GSTIN ────────────────────────────────────────────────────────────────

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const B36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The 15th character of a GSTIN, from its first 14 (the GSTN mod-36 checksum). */
export function gstinCheckChar(first14: string): string {
    let sum = 0;
    for (let i = 0; i < 14; i++) {
        const product = B36.indexOf(first14[i]) * (i % 2 ? 2 : 1);
        sum += Math.floor(product / 36) + (product % 36);
    }
    return B36[(36 - (sum % 36)) % 36];
}

/** Why a GSTIN is not valid, or null. Expects it already upper-cased and trimmed. */
export function gstinProblem(gstin: string): string | null {
    if (!GSTIN_RE.test(gstin)) return 'A GSTIN is 15 characters, like 27ABCDE1234F1Z5.';
    if (!STATES.some(s => s.code === gstin.slice(0, 2))) return 'This GSTIN starts with an unknown state code.';
    if (gstinCheckChar(gstin.slice(0, 14)) !== gstin[14]) return 'The last character doesn’t match. Check the GSTIN for a typo.';
    return null;
}

/** HSN/SAC: 4, 6 or 8 digits, at least `minDigits`. */
export function hsnProblem(hsn: string, minDigits = 4): string | null {
    if (!/^(\d{4}|\d{6}|\d{8})$/.test(hsn)) return 'HSN/SAC is 4, 6 or 8 digits.';
    if (hsn.length < minDigits) return `Use at least ${minDigits} digits of HSN/SAC.`;
    return null;
}

// ── Financial year and numbers ───────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 3600e3;

/** The year the Indian financial year (April–March, IST) containing `ms` starts in. */
export function fyStartYear(ms: number): number {
    const d = new Date(ms + IST_OFFSET_MS);
    return d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

/** "26-27" for FY 2026–27. */
export function fyLabel(ms: number): string {
    const y = fyStartYear(ms);
    return `${String(y % 100).padStart(2, '0')}-${String((y + 1) % 100).padStart(2, '0')}`;
}

/** [start, end) of the financial year starting in April `startYear`, in ms. */
export const fyRange = (startYear: number): [number, number] =>
    [Date.UTC(startYear, 3, 1) - IST_OFFSET_MS, Date.UTC(startYear + 1, 3, 1) - IST_OFFSET_MS];

export const MAX_DOC_NUMBER_LENGTH = 16;

/** "INV/26-27/0001". GST allows 16 characters: letters, digits, '-' and '/'. */
export const formatDocNumber = (prefix: string, ms: number, seq: number): string =>
    `${prefix}/${fyLabel(ms)}/${String(seq).padStart(4, '0')}`;

export function docNumberProblem(n: string): string | null {
    if (n.length > MAX_DOC_NUMBER_LENGTH) return `Numbers can be at most ${MAX_DOC_NUMBER_LENGTH} characters (this one is ${n.length}). Use a shorter prefix.`;
    if (!/^[A-Za-z0-9/-]+$/.test(n)) return 'Numbers can only use letters, digits, “-” and “/”.';
    return null;
}

/** The next number in a series: one past the highest used, never below `start`. Numbers are never reused. */
export function nextSeq(used: readonly { seriesKey?: string; seq?: number }[], seriesKey: string, start: number): number {
    let max = Math.max(1, start) - 1;
    for (const u of used) if (u.seriesKey === seriesKey && (u.seq ?? 0) > max) max = u.seq ?? 0;
    return max + 1;
}

// ── Totals ───────────────────────────────────────────────────────────────

/**
 * intra: CGST + SGST/UTGST · inter: IGST · zero: zero-rated (export/SEZ under
 * LUT, rate shown, no tax) · none: no tax at all (bill of supply, challan).
 */
export type TaxMode = 'intra' | 'inter' | 'zero' | 'none';

export interface LineInput {
    qty: number;
    /** Price of one unit, paise. */
    ratePaise: number;
    discountPct: number;
    /** Percent, e.g. 5. */
    gstRate: number;
    hsn: string;
}

export interface LineTotals {
    gross: number;
    discount: number;
    /** This line's share of the bill-level discount. */
    billDiscount: number;
    taxable: number;
    cgst: number;
    sgst: number;
    igst: number;
    total: number;
}

export interface HsnRow { hsn: string; rate: number; qty: number; taxable: number; cgst: number; sgst: number; igst: number }

export interface Totals {
    lines: LineTotals[];
    gross: number;
    discount: number;
    taxable: number;
    cgst: number;
    sgst: number;
    igst: number;
    tax: number;
    roundOff: number;
    total: number;
    hsn: HsnRow[];
}

export interface TotalsOptions {
    mode: TaxMode;
    /** Rates already include GST: the taxable value is backed out of them. */
    inclusive: boolean;
    billDiscountPaise: number;
    /** Round the grand total to whole rupees with a "Round off" line, as Tally does. */
    roundOff: boolean;
}

/**
 * Totals the way GST wants them: line discount, then the bill discount spread
 * over lines in proportion (before tax), then tax on each line's taxable value.
 */
export function computeTotals(lines: readonly LineInput[], o: TotalsOptions): Totals {
    const afters = lines.map(l => {
        const gross = Math.round(Math.max(0, l.qty) * Math.max(0, l.ratePaise));
        const discount = Math.round(gross * Math.min(100, Math.max(0, l.discountPct)) / 100);
        return { gross, discount, after: gross - discount };
    });
    const sumAfter = afters.reduce((s, a) => s + a.after, 0);
    const bill = Math.min(Math.max(0, Math.round(o.billDiscountPaise)), sumAfter);
    const lastPositive = afters.map(a => a.after > 0).lastIndexOf(true);
    let allocated = 0;

    const out: LineTotals[] = lines.map((l, i) => {
        const { gross, discount, after } = afters[i];
        let share = 0;
        if (bill > 0 && after > 0) share = i === lastPositive ? bill - allocated : Math.round(bill * after / sumAfter);
        allocated += share;
        const value = after - share;
        const rate = o.mode === 'none' || o.mode === 'zero' ? 0 : l.gstRate;
        const taxable = o.inclusive ? Math.round(value * 100 / (100 + rate)) : value;
        let cgst = 0, sgst = 0, igst = 0;
        if (o.mode === 'intra') cgst = sgst = Math.round(taxable * rate / 200);
        else if (o.mode === 'inter') igst = Math.round(taxable * rate / 100);
        return { gross, discount, billDiscount: share, taxable, cgst, sgst, igst, total: taxable + cgst + sgst + igst };
    });

    const sum = (k: keyof LineTotals) => out.reduce((s, l) => s + l[k], 0);
    const beforeRound = sum('total');
    const total = o.roundOff ? Math.round(beforeRound / 100) * 100 : beforeRound;

    const hsnMap = new Map<string, HsnRow>();
    lines.forEach((l, i) => {
        const rate = o.mode === 'none' ? 0 : l.gstRate;
        const key = `${l.hsn}|${rate}`;
        const row = hsnMap.get(key) ?? { hsn: l.hsn, rate, qty: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
        row.qty += l.qty;
        row.taxable += out[i].taxable;
        row.cgst += out[i].cgst;
        row.sgst += out[i].sgst;
        row.igst += out[i].igst;
        hsnMap.set(key, row);
    });

    return {
        lines: out,
        gross: sum('gross'),
        discount: sum('discount') + sum('billDiscount'),
        taxable: sum('taxable'),
        cgst: sum('cgst'),
        sgst: sum('sgst'),
        igst: sum('igst'),
        tax: sum('cgst') + sum('sgst') + sum('igst'),
        roundOff: total - beforeRound,
        total,
        hsn: [...hsnMap.values()],
    };
}

// ── Words and formatting ─────────────────────────────────────────────────

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
    'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n: number): string {
    if (n < 20) return ONES[n];
    const tens = TENS[Math.floor(n / 10)];
    return n % 10 ? `${tens} ${ONES[n % 10]}` : tens;
}

/** Indian system: crore, lakh, thousand, hundred. */
function indianWords(n: number): string {
    if (n === 0) return '';
    const parts: string[] = [];
    const crore = Math.floor(n / 1e7);
    if (crore) parts.push(`${indianWords(crore)} Crore`);
    const lakh = Math.floor((n % 1e7) / 1e5);
    if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
    const thousand = Math.floor((n % 1e5) / 1e3);
    if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
    const hundred = Math.floor((n % 1e3) / 100);
    if (hundred) parts.push(`${ONES[hundred]} Hundred`);
    const rest = n % 100;
    if (rest) parts.push(twoDigits(rest));
    return parts.join(' ');
}

/** "Rupees One Lakh Twenty Thousand and Fifty Paise Only". */
export function amountInWords(paise: number): string {
    const p = Math.round(Math.abs(paise));
    const rupees = Math.floor(p / 100);
    const rest = p % 100;
    const paisePart = rest ? ` and ${twoDigits(rest)} Paise` : '';
    return `Rupees ${indianWords(rupees) || 'Zero'}${paisePart} Only`;
}

/** Paise as "1,23,456.50". */
export const formatPaise = (paise: number): string =>
    (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Paise as "₹1,23,456.50" for the screen. */
export const rupeesText = (paise: number): string => `${paise < 0 ? '−' : ''}₹${formatPaise(Math.abs(paise))}`;

/** A rupee amount typed by a person, as paise; NaN when it isn't a number. */
export const toPaise = (rupees: string | number): number => {
    const n = typeof rupees === 'number' ? rupees : Number(String(rupees).replaceAll(',', '').trim());
    return Number.isFinite(n) ? Math.round(n * 100) : Number.NaN;
};
