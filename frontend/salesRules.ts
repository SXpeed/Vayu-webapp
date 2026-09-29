// The sales ledger's shared rules: the record's shape, the payment modes, field
// checks and the summary maths. Pure and dependency-free, so the Worker
// (sales.ts), the app and the unit tests all use the same ones.

export const PAYMENT_MODES = ['Cash', 'Card', 'UPI', 'Bank transfer', 'Cheque', 'Other'] as const;
export type PaymentMode = typeof PAYMENT_MODES[number];

export const isPaymentMode = (v: unknown): v is PaymentMode => (PAYMENT_MODES as readonly unknown[]).includes(v);

/** One recorded sale, as the API returns it. */
export interface Sale {
    id: string;
    /** "SAL-001", assigned by the server when the sale reaches it. */
    saleNumber: string;
    /** The inventory piece sold, or null for an item that was never in the inventory. */
    artworkId: string | null;
    /** False once the linked piece has been deleted from the inventory (the sale keeps its snapshot). */
    inInventory: boolean;
    /** The picture to show: the piece's first photo while it is in the inventory, else the sale's own first photo. */
    imageUrl: string | null;
    /** Photos of an item that isn't in the inventory (none for inventory pieces: they have their own). */
    photoUrls: string[];
    /** Labels to group sales by, such as the event they were made at. */
    tags: string[];
    /** Snapshots taken when the sale was recorded: they outlive the piece. */
    itemTitle: string;
    itemPrice: number;
    contactId: string | null;
    buyerName: string;
    buyerPhone: string;
    /** The day of the sale (YYYY-MM-DD), which may be before the day it was recorded. */
    saleDate: string;
    recordedAt: number;
    amount: number;
    paymentMode: PaymentMode;
    referenceNo: string;
    notes: string;
    createdByName: string;
    updatedAt: number;
}

/** What the app sends to record or change a sale. */
export interface SaleInput {
    artworkId: string | null;
    /** Used only when artworkId is null (the server snapshots the piece itself). */
    itemTitle: string;
    itemPrice: number;
    contactId: string | null;
    buyerName: string;
    buyerPhone: string;
    saleDate: string;
    amount: number;
    paymentMode: PaymentMode;
    referenceNo: string;
    notes: string;
    tags: string[];
    /** Used only when artworkId is null. */
    photoUrls: string[];
}

export interface SalesSummary {
    count: number;
    totalAmount: number;
    /** Only the modes that have sales in the range. */
    byMode: Partial<Record<PaymentMode, { count: number; amount: number }>>;
}

export const MAX_AMOUNT = 1_000_000_000;
export const MAX_TAGS = 10;
export const MAX_TAG_LENGTH = 40;
export const MAX_PHOTOS = 10;

/**
 * Tags as they are stored: trimmed, inner spaces collapsed, at most
 * MAX_TAG_LENGTH characters, no repeats (ignoring case; the first spelling
 * wins), at most MAX_TAGS. Anything that isn't a list of text gives none.
 */
export function cleanTags(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of raw) {
        if (typeof item !== 'string') continue;
        const tag = item.replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LENGTH).trim();
        if (!tag || seen.has(tag.toLowerCase())) continue;
        seen.add(tag.toLowerCase());
        out.push(tag);
        if (out.length === MAX_TAGS) break;
    }
    return out;
}

/** An uploaded file's address, as storage gives it: /api/files/… or /api/o/<organization>/files/… */
export const isFileUrl = (v: unknown): v is string =>
    typeof v === 'string' && v.length <= 512 && /^\/api\/(?:o\/[A-Za-z0-9-]+\/)?files\/[^?#\s]+$/.test(v);

export interface TagTotal { tag: string; count: number; amount: number }

/**
 * Totals per tag, largest first; untagged sales last, under the tag ''. A sale
 * with two tags counts under both, so the rows can add up to more than the
 * whole.
 */
export function summarizeByTag(sales: readonly Pick<Sale, 'amount' | 'tags'>[]): TagTotal[] {
    const rows = new Map<string, TagTotal>();
    const add = (key: string, tag: string, amount: number) => {
        const row = rows.get(key) ?? { tag, count: 0, amount: 0 };
        rows.set(key, { tag: row.tag, count: row.count + 1, amount: addRupees(row.amount, amount) });
    };
    for (const s of sales) {
        if (!s.tags.length) add('', '', s.amount);
        for (const tag of s.tags) add(tag.toLowerCase(), tag, s.amount);
    }
    // Largest first, untagged always last.
    return [...rows.values()].sort((a, b) => Number(a.tag === '') - Number(b.tag === '') || b.amount - a.amount);
}

export const isIsoDate = (s: unknown): s is string =>
    typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
    && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

/** Rupees with at most two decimals, from 0 up to MAX_AMOUNT. */
export const isAmount = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_AMOUNT && Math.abs(Math.round(v * 100) - v * 100) < 1e-6;

/** Money adds up in paise, so ₹0.10 + ₹0.20 is ₹0.30 and not 0.30000000000000004. */
const addRupees = (a: number, b: number): number => (Math.round(a * 100) + Math.round(b * 100)) / 100;

export function summarize(sales: readonly Pick<Sale, 'amount' | 'paymentMode'>[]): SalesSummary {
    const byMode: SalesSummary['byMode'] = {};
    let totalAmount = 0;
    for (const s of sales) {
        totalAmount = addRupees(totalAmount, s.amount);
        const m = byMode[s.paymentMode] ?? { count: 0, amount: 0 };
        byMode[s.paymentMode] = { count: m.count + 1, amount: addRupees(m.amount, s.amount) };
    }
    return { count: sales.length, totalAmount, byMode };
}

/** Problems with a sale's fields, most important first; empty when it can be saved. */
export function saleFieldErrors(s: SaleInput): string[] {
    const errors: string[] = [];
    if (!s.artworkId && !s.itemTitle.trim()) errors.push('Choose the piece sold, or type what it was.');
    if (!s.buyerName.trim()) errors.push('Enter the buyer’s name.');
    if (!isIsoDate(s.saleDate)) errors.push('Choose the day of the sale.');
    else if (s.saleDate > todayIso(1)) errors.push('The sale date is in the future.');
    if (!isAmount(s.amount) || s.amount <= 0) errors.push('Enter the amount received.');
    if (!isPaymentMode(s.paymentMode)) errors.push('Choose how it was paid.');
    if (!isAmount(s.itemPrice)) errors.push('Enter a valid price for the item.');
    if (s.photoUrls.length > MAX_PHOTOS) errors.push(`Add at most ${MAX_PHOTOS} photos.`);
    else if (!s.photoUrls.every(isFileUrl)) errors.push('A photo didn’t upload properly. Remove it and add it again.');
    return errors;
}

/**
 * Today as YYYY-MM-DD in local time, give or take some days. The server runs
 * in UTC, so it allows a day of slack for a sale recorded just after midnight
 * in India.
 */
export function todayIso(offsetDays = 0): string {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** First and last day of the month that contains this date. */
export function monthRange(iso: string): [string, string] {
    const [y, m] = iso.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const mm = String(m).padStart(2, '0');
    return [`${y}-${mm}-01`, `${y}-${mm}-${String(last).padStart(2, '0')}`];
}

/** The first day of the month `by` months away. */
export function shiftMonth(iso: string, by: number): string {
    const [y, m] = iso.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + by, 1));
    return d.toISOString().slice(0, 10);
}

