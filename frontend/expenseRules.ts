// Expenses: the shape and the checks, shared by the server (expenses.ts) and
// the My Space screen. Plain functions (tests/expenseRules.test.mjs).

import { isIsoDate } from './salesRules';

export const EXPENSE_CATEGORIES = ['Travel', 'Food', 'Fuel', 'Supplies', 'Shipping', 'Phone & internet', 'Other'] as const;
export const MAX_RECEIPTS = 6;
export const MAX_NOTE = 500;
const MAX_PAISE = 10_000_000_000; // ₹10 crore: past this it is a typo

export interface Expense {
    id: string;
    date: string; // YYYY-MM-DD
    amountPaise: number;
    category: string;
    note: string;
    receipts: string[]; // uploaded file URLs
    createdAt: number;
    updatedAt: number;
}

export type ExpenseInput = Pick<Expense, 'date' | 'amountPaise' | 'category' | 'note' | 'receipts'>;

// Only the app's own uploads, so a receipt can't point anywhere else.
const RECEIPT_URL = /^\/api\/(?:o\/[A-Za-z0-9-]+\/)?files\/\S{1,300}$/;

/** A clean expense from what a client sent, or why it can't be saved. */
export function parseExpense(raw: unknown): ExpenseInput | { problem: string } {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (!isIsoDate(r.date)) return { problem: 'Choose the date of the expense.' };
    const amountPaise = r.amountPaise;
    if (typeof amountPaise !== 'number' || !Number.isInteger(amountPaise) || amountPaise <= 0 || amountPaise > MAX_PAISE) {
        return { problem: 'Enter an amount above ₹0.' };
    }
    const category = typeof r.category === 'string' ? r.category : '';
    if (!(EXPENSE_CATEGORIES as readonly string[]).includes(category)) return { problem: 'Choose a category.' };
    const note = typeof r.note === 'string' ? r.note.trim() : '';
    if (note.length > MAX_NOTE) return { problem: `Keep the note under ${MAX_NOTE} characters.` };
    const receipts = r.receipts ?? [];
    if (!Array.isArray(receipts) || receipts.length > MAX_RECEIPTS || !receipts.every(u => typeof u === 'string' && RECEIPT_URL.test(u))) {
        return { problem: `Attach up to ${MAX_RECEIPTS} receipt photos.` };
    }
    return { date: r.date, amountPaise, category, note, receipts: receipts as string[] };
}
