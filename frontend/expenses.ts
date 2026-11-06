// Expenses, recorded by each person in My Space and shared a month at a time
// as a PDF (to the accounts team, or wherever they choose). Private: every
// query is scoped to the signed-in person, admins included. No approval step
// yet (docs/IMPLEMENTATION_PLAN.md 8.3).
//
// Storage: one table in the workspace's own database, created on first use.
// Nothing goes through change_log: the screen refetches when it opens.

import { err, json, runSetupOnce, text } from './rows';
import { parseExpense, type Expense } from './expenseRules';
import { monthRange } from './salesRules';
import type { Ctx, SessionData } from './workerEnv';
import { getSession } from './workerRoles';

const MAX_PER_MONTH = 500;
const ID_PATH = /^\/expenses\/([\w-]{1,64})$/;

type Handler = (ctx: Ctx) => Promise<Response>;
export interface ExpenseRoute { method: string; match: (path: string) => boolean; handler: Handler }

function ensureExpensesTable(db: D1Database): Promise<void> {
    return runSetupOnce(db, 'expensesTable', async () => {
        await db.prepare(`CREATE TABLE IF NOT EXISTS expenses (
            id           TEXT PRIMARY KEY,
            owner_id     TEXT NOT NULL,
            date         TEXT NOT NULL,
            amount_paise INTEGER NOT NULL,
            category     TEXT NOT NULL,
            note         TEXT NOT NULL DEFAULT '',
            receipts     TEXT NOT NULL DEFAULT '[]',
            created_at   INTEGER NOT NULL,
            updated_at   INTEGER NOT NULL
        )`).run();
        await db.prepare('CREATE INDEX IF NOT EXISTS idx_expenses_owner_date ON expenses (owner_id, date)').run();
    });
}

async function caller(ctx: Ctx): Promise<SessionData | Response> {
    const session = await getSession(ctx.request, ctx.env.VAYU_KV);
    if (!session) return err('Unauthorized', 401);
    await ensureExpensesTable(ctx.env.VAYU_DB);
    return session;
}

function rowToExpense(r: Record<string, unknown>): Expense {
    let receipts: string[] = [];
    try { receipts = JSON.parse(text(r.receipts)); } catch { /* a damaged row shows without receipts */ }
    return {
        id: text(r.id), date: text(r.date), amountPaise: Number(r.amount_paise), category: text(r.category), note: text(r.note),
        receipts, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
    };
}

async function body(ctx: Ctx): Promise<unknown> {
    try { return await ctx.request.json(); } catch { return null; }
}

const monthCount = async (db: D1Database, owner: string, date: string) => {
    const [from, to] = monthRange(date);
    const row = await db.prepare('SELECT COUNT(*) AS n FROM expenses WHERE owner_id = ? AND date BETWEEN ? AND ?').bind(owner, from, to).first<{ n: number }>();
    return Number(row?.n ?? 0);
};

/** GET /expenses?month=YYYY-MM-01 — your expenses that month, newest first. */
const list: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const month = ctx.url.searchParams.get('month') ?? '';
    if (!/^\d{4}-\d{2}-01$/.test(month)) return err('Give a month.');
    const [from, to] = monthRange(month);
    const { results } = await ctx.env.VAYU_DB.prepare(
        'SELECT * FROM expenses WHERE owner_id = ? AND date BETWEEN ? AND ? ORDER BY date DESC, created_at DESC LIMIT ?',
    ).bind(session.userId, from, to, MAX_PER_MONTH).all();
    return json({ expenses: results.map(r => rowToExpense(r as Record<string, unknown>)) });
};

const create: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const e = parseExpense(await body(ctx));
    if ('problem' in e) return err(e.problem);
    const db = ctx.env.VAYU_DB;
    if (await monthCount(db, session.userId, e.date) >= MAX_PER_MONTH) return err(`You can record up to ${MAX_PER_MONTH} expenses a month.`, 409);
    const now = Date.now();
    const id = `exp_${now}_${crypto.randomUUID().slice(0, 8)}`;
    await db.prepare('INSERT INTO expenses (id, owner_id, date, amount_paise, category, note, receipts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, session.userId, e.date, e.amountPaise, e.category, e.note, JSON.stringify(e.receipts), now, now).run();
    return json({ id, ...e, createdAt: now, updatedAt: now } satisfies Expense, 201);
};

const update: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const id = ID_PATH.exec(ctx.path)![1];
    const e = parseExpense(await body(ctx));
    if ('problem' in e) return err(e.problem);
    const db = ctx.env.VAYU_DB;
    const old = await db.prepare('SELECT * FROM expenses WHERE id = ? AND owner_id = ?').bind(id, session.userId).first<Record<string, unknown>>();
    if (!old) return err('That expense was not found.', 404);
    if (e.date.slice(0, 7) !== text(old.date).slice(0, 7) && await monthCount(db, session.userId, e.date) >= MAX_PER_MONTH) {
        return err(`You can record up to ${MAX_PER_MONTH} expenses a month.`, 409);
    }
    const now = Date.now();
    await db.prepare('UPDATE expenses SET date = ?, amount_paise = ?, category = ?, note = ?, receipts = ?, updated_at = ? WHERE id = ? AND owner_id = ?')
        .bind(e.date, e.amountPaise, e.category, e.note, JSON.stringify(e.receipts), now, id, session.userId).run();
    return json({ id, ...e, createdAt: Number(old.created_at), updatedAt: now } satisfies Expense);
};

// shortcut: receipt photos stay in storage after their expense is deleted; delete them here once storage use matters.
const remove: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const id = ID_PATH.exec(ctx.path)![1];
    const res = await ctx.env.VAYU_DB.prepare('DELETE FROM expenses WHERE id = ? AND owner_id = ?').bind(id, session.userId).run();
    if (!res.meta.changes) return err('That expense was not found.', 404);
    return json({ ok: true });
};

export const expenseRoutes: ExpenseRoute[] = [
    { method: 'GET', match: p => p === '/expenses', handler: list },
    { method: 'POST', match: p => p === '/expenses', handler: create },
    { method: 'PUT', match: p => ID_PATH.test(p), handler: update },
    { method: 'DELETE', match: p => ID_PATH.test(p), handler: remove },
];
