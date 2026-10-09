// The sales ledger: sales made in the store and paid offline (cash, card, UPI,
// bank transfer, cheque), recorded by the accounts team, with the month's
// figures on the Home page.
//
// Who can do what comes from the "Sales" permission (permissions.ts):
//   view   — see the ledger and the month's figures
//   edit   — record, change and delete sales
//
// Selling an inventory piece marks it Sold with a conditional update (only if
// it is still Available), so two people selling the same piece at the same
// moment can't both succeed: the second is told it is already sold
// (docs/ORG_DATABASES.md, "Concurrent edits"). The piece's title and price are
// copied onto the sale, so the ledger reads the same after the piece is
// deleted. Deleting a sale archives it (the row stays, marked deleted, so its
// number is never reused) and puts the piece back to Available.
//
// Sale numbers (SAL-001, …) are assigned here, never by the app: a sale
// recorded offline carries only its id until it reaches the server, and that
// id makes a retried upload return the same sale instead of a second one.
//
// Storage: one table in the workspace's own database, created on first use.
// Like the staff roster, sales don't go through change_log: a change sends a
// signal-only "sales" invalidate and an open ledger refetches. The piece's
// status change does go through change_log, so every inventory list updates.

import { changeLogStmt, ensureChangeLogTable } from './deltaSync';
import { err, json, runSetupOnce, text } from './rows';
import {
    MAX_AMOUNT, cleanTags, isAmount, isIsoDate, isPaymentMode, saleFieldErrors, summarize,
    type PaymentMode, type Sale, type SaleInput,
} from './salesRules';
import type { ChangeEvent, Ctx, SessionData } from './workerEnv';
import { getSession } from './workerRoles';

const MAX_RANGE_DAYS = 366;
const MAX_ROWS = 2000;

export function ensureSalesTable(db: D1Database): Promise<void> {
    return runSetupOnce(db, 'salesTable', async () => {
        await db.prepare(`CREATE TABLE IF NOT EXISTS sales (
            id              TEXT PRIMARY KEY,
            seq             INTEGER NOT NULL UNIQUE,
            sale_number     TEXT NOT NULL,
            artwork_id      TEXT,
            item_title      TEXT NOT NULL DEFAULT '',
            item_price      REAL NOT NULL DEFAULT 0,
            contact_id      TEXT,
            buyer_name      TEXT NOT NULL DEFAULT '',
            buyer_phone     TEXT NOT NULL DEFAULT '',
            sale_date       TEXT NOT NULL,
            recorded_at     INTEGER NOT NULL,
            amount          REAL NOT NULL DEFAULT 0,
            payment_mode    TEXT NOT NULL,
            reference_no    TEXT NOT NULL DEFAULT '',
            notes           TEXT NOT NULL DEFAULT '',
            tags            TEXT NOT NULL DEFAULT '[]',
            photo_urls      TEXT NOT NULL DEFAULT '[]',
            created_by      TEXT,
            created_by_name TEXT NOT NULL DEFAULT '',
            updated_at      INTEGER NOT NULL,
            updated_by      TEXT,
            deleted_at      INTEGER,
            deleted_by      TEXT,
            deleted_by_name TEXT NOT NULL DEFAULT ''
        )`).run();
        await db.prepare('CREATE INDEX IF NOT EXISTS idx_sales_date ON sales (sale_date)').run();
        await db.prepare('CREATE INDEX IF NOT EXISTS idx_sales_artwork ON sales (artwork_id)').run();
        // Tables made before a column existed get it here.
        const have = new Set(((await db.prepare('PRAGMA table_info(sales)').all<{ name: string }>()).results || []).map(c => c.name));
        for (const [column, definition] of Object.entries(ADDED_COLUMNS)) {
            if (have.has(column)) continue;
            try {
                await db.prepare(`ALTER TABLE sales ADD COLUMN ${column} ${definition}`).run(); // NOSONAR: schema steps run one at a time
            } catch (e) {
                // Another isolate may have added it at the same moment.
                if (!/duplicate column/i.test((e as Error).message)) throw e;
            }
        }
    });
}

/** Columns added after the table first shipped (2026-09-29), with their definitions. */
const ADDED_COLUMNS: Record<string, string> = {
    tags: "TEXT NOT NULL DEFAULT '[]'",
    photo_urls: "TEXT NOT NULL DEFAULT '[]'",
};

// ── Rows ────────────────────────────────────────────────────────────────────

function stringList(raw: unknown): string[] {
    if (typeof raw !== 'string') return [];
    try {
        const list = JSON.parse(raw) as unknown;
        return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : [];
    } catch { return []; }
}

/** A sales row, optionally LEFT JOINed with its artwork (art_id, art_images). */
function rowToSale(r: Record<string, unknown>): Sale {
    const artworkId = text(r.artwork_id) || null;
    const inInventory = !!artworkId && !!r.art_id;
    const photoUrls = artworkId ? [] : stringList(r.photo_urls);
    return {
        id: text(r.id),
        saleNumber: text(r.sale_number),
        artworkId,
        inInventory,
        imageUrl: (inInventory ? stringList(r.art_images)[0] : photoUrls[0]) ?? null,
        photoUrls,
        tags: stringList(r.tags),
        itemTitle: text(r.item_title),
        itemPrice: Number(r.item_price) || 0,
        contactId: text(r.contact_id) || null,
        buyerName: text(r.buyer_name),
        buyerPhone: text(r.buyer_phone),
        saleDate: text(r.sale_date),
        recordedAt: Number(r.recorded_at) || 0,
        amount: Number(r.amount) || 0,
        paymentMode: (isPaymentMode(r.payment_mode) ? r.payment_mode : 'Other') as PaymentMode,
        referenceNo: text(r.reference_no),
        notes: text(r.notes),
        createdByName: text(r.created_by_name),
        updatedAt: Number(r.updated_at) || 0,
    };
}

const SELECT_SALE = `SELECT s.*, a.id AS art_id, a.image_urls AS art_images
    FROM sales s LEFT JOIN artworks a ON a.id = s.artwork_id`;

// ── Routes ──────────────────────────────────────────────────────────────────

type Handler = (ctx: Ctx) => Promise<Response>;
export interface SalesRoute { method: string; match: (path: string) => boolean; handler: Handler }

/** What these routes borrow from worker.ts. */
export interface SalesDeps {
    logChange: (ctx: Ctx, session: SessionData, action: string, entity: string, id: string, details: string) => void;
    notify: (ctx: Ctx, events: ChangeEvent[]) => void;
}

const SALE_PATH = /^\/sales\/([A-Za-z0-9_-]{1,64})$/;
const CLIENT_ID = /^sale_[A-Za-z0-9_-]{8,56}$/;

const cleanText = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const newId = () => `sale_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;

async function body(ctx: Ctx): Promise<Record<string, unknown> | null> {
    const parsed = await ctx.request.json().catch(() => null);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}

/** The fields a request may set, cleaned; the checks come after (saleFieldErrors). */
function readInput(raw: Record<string, unknown>): SaleInput {
    return {
        artworkId: typeof raw.artworkId === 'string' && raw.artworkId ? raw.artworkId.slice(0, 128) : null,
        itemTitle: cleanText(raw.itemTitle, 200),
        itemPrice: raw.itemPrice === undefined || raw.itemPrice === null || raw.itemPrice === '' ? 0 : Number(raw.itemPrice),
        contactId: typeof raw.contactId === 'string' && raw.contactId ? raw.contactId.slice(0, 128) : null,
        buyerName: cleanText(raw.buyerName, 120),
        buyerPhone: cleanText(raw.buyerPhone, 40),
        saleDate: text(raw.saleDate),
        amount: typeof raw.amount === 'number' ? raw.amount : Number.NaN,
        paymentMode: raw.paymentMode as PaymentMode,
        referenceNo: cleanText(raw.referenceNo, 80),
        notes: cleanText(raw.notes, 1000),
        tags: cleanTags(raw.tags),
        // Checked by saleFieldErrors (isFileUrl, at most MAX_PHOTOS).
        photoUrls: Array.isArray(raw.photoUrls) ? [...new Set(raw.photoUrls as string[])] : [],
    };
}

/** Every tag in use, most recently used first: suggestions for the next sale. */
async function tagsInUse(db: D1Database): Promise<string[]> {
    const rows = (await db.prepare("SELECT tags FROM sales WHERE deleted_at IS NULL AND tags <> '[]' ORDER BY recorded_at DESC LIMIT 5000").all()).results || [];
    const seen = new Map<string, string>();
    for (const tag of rows.flatMap(r => stringList(r.tags))) if (!seen.has(tag.toLowerCase())) seen.set(tag.toLowerCase(), tag);
    return [...seen.values()].slice(0, 200);
}

async function caller(ctx: Ctx): Promise<SessionData | Response> {
    const session = await getSession(ctx.request, ctx.env.VAYU_KV);
    if (!session) return err('Unauthorized', 401);
    await ensureSalesTable(ctx.env.VAYU_DB);
    return session;
}

async function loadSale(db: D1Database, id: string): Promise<Sale | null> {
    const row = await db.prepare(`${SELECT_SALE} WHERE s.id = ? AND s.deleted_at IS NULL`).bind(id).first<Record<string, unknown>>();
    return row ? rowToSale(row) : null;
}

/** A contact id must name a contact; the buyer's name and phone are kept either way. */
async function contactExists(db: D1Database, id: string): Promise<boolean> {
    try {
        return !!(await db.prepare('SELECT 1 FROM contacts WHERE id = ?').bind(id).first());
    } catch {
        return false; // no contacts table yet
    }
}

/**
 * Marks an inventory piece Sold and gives its title and price for the
 * sale's snapshot. The check and the change are one statement, so two
 * sales of the same piece can't both get through.
 */
async function sellPiece(db: D1Database, artworkId: string): Promise<{ title: string; price: number } | Response> {
    const art = await db.prepare('SELECT title, custom_id, price, status FROM artworks WHERE id = ?').bind(artworkId)
        .first<{ title: string; custom_id: string; price: number; status: string }>();
    if (!art) return err('That piece is no longer in the inventory.', 404);
    const sold = await db.prepare("UPDATE artworks SET status = 'Sold' WHERE id = ? AND status = 'Available'").bind(artworkId).run();
    if (!sold.meta.changes) {
        const now = await db.prepare('SELECT status FROM artworks WHERE id = ?').bind(artworkId).first<{ status: string }>();
        return json(now?.status === 'Reserved'
            ? { error: 'That piece is reserved. Mark it available first.', code: 'reserved' }
            : { error: 'That piece is already sold', code: 'already_sold' }, 409);
    }
    return { title: String(art.title || art.custom_id || 'Untitled'), price: Number(art.price) || 0 };
}

/**
 * Saves the sale with the next number, in a single statement so two sales
 * recorded at once can't share one (seq is UNIQUE besides). Deleted sales
 * keep theirs: numbers are never reused. If saving fails, a piece this
 * sale sold goes back on sale.
 */
async function insertSale(ctx: Ctx, session: SessionData, id: string, input: SaleInput, item: { title: string; price: number }): Promise<void> {
    const db = ctx.env.VAYU_DB;
    const now = Date.now();
    // An inventory piece shows its own photos; the sale keeps none of its own.
    const photoUrls = input.artworkId ? [] : input.photoUrls;
    try {
        await ensureChangeLogTable(db);
        const stmts: D1PreparedStatement[] = [db.prepare(
            `INSERT INTO sales (id, seq, sale_number, artwork_id, item_title, item_price, contact_id, buyer_name, buyer_phone,
                sale_date, recorded_at, amount, payment_mode, reference_no, notes, tags, photo_urls, created_by, created_by_name, updated_at, updated_by)
             SELECT ?, n, printf('SAL-%03d', n), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             FROM (SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM sales)`,
        ).bind(id, input.artworkId, item.title, item.price, input.contactId, input.buyerName, input.buyerPhone,
            input.saleDate, now, input.amount, input.paymentMode, input.referenceNo, input.notes,
            JSON.stringify(input.tags), JSON.stringify(photoUrls), session.userId, session.name, now, session.userId)];
        if (input.artworkId) stmts.push(changeLogStmt(db, ctx.env, 'artwork', input.artworkId, 'put', { actorId: session.userId }));
        await db.batch(stmts);
    } catch (e) {
        if (input.artworkId) await db.prepare("UPDATE artworks SET status = 'Available' WHERE id = ? AND status = 'Sold'").bind(input.artworkId).run().catch(() => undefined);
        throw e;
    }
}

/**
 * The id for a new sale. The app names new sales itself, so an upload
 * retried after a dropped connection finds the first one (answered as
 * it is) instead of recording it twice.
 */
async function newSaleId(db: D1Database, raw: Record<string, unknown>): Promise<{ id: string } | Response> {
    if (raw.id === undefined) return { id: newId() };
    if (typeof raw.id !== 'string' || !CLIENT_ID.test(raw.id)) return err('Invalid sale id.');
    const existing = await db.prepare('SELECT id, deleted_at FROM sales WHERE id = ?').bind(raw.id).first<{ deleted_at: number | null }>();
    if (!existing) return { id: raw.id };
    if (existing.deleted_at) return err('This sale was deleted.', 410);
    return json(await loadSale(db, raw.id), 200);
}

export function salesRoutes(deps: SalesDeps): SalesRoute[] {
    const signal = (ctx: Ctx, id: string, artworkId?: string | null) =>
        deps.notify(ctx, [{ entity: 'sales', id, op: 'put' }, ...(artworkId ? [{ entity: 'artwork', id: artworkId, op: 'put' as const }] : [])]);

    /** GET /sales?from=&to= — the sales in a date range (the day of the sale), their totals, and every tag in use. */
    const list: Handler = async (ctx) => {
        const session = await caller(ctx);
        if (session instanceof Response) return session;
        const today = new Date().toISOString().slice(0, 10);
        const from = ctx.url.searchParams.get('from') ?? `${today.slice(0, 7)}-01`;
        const to = ctx.url.searchParams.get('to') ?? today;
        if (!isIsoDate(from) || !isIsoDate(to) || to < from) return err('Give a valid date range.');
        if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_RANGE_DAYS) return err(`Ask for at most ${MAX_RANGE_DAYS} days at a time.`);
        const rows = (await ctx.env.VAYU_DB.prepare(
            `${SELECT_SALE} WHERE s.deleted_at IS NULL AND s.sale_date >= ? AND s.sale_date <= ? ORDER BY s.sale_date DESC, s.seq DESC LIMIT ${MAX_ROWS}`,
        ).bind(from, to).all()).results || [];
        const sales = rows.map(r => rowToSale(r as Record<string, unknown>));
        return json({ from, to, sales, summary: summarize(sales), allTags: await tagsInUse(ctx.env.VAYU_DB) });
    };

    /** POST /sales — record a sale. An inventory piece is marked Sold, only if it is still Available. */
    const create: Handler = async (ctx) => {
        const session = await caller(ctx);
        if (session instanceof Response) return session;
        const db = ctx.env.VAYU_DB;
        const raw = await body(ctx);
        if (!raw) return err('Invalid request body');
        const named = await newSaleId(db, raw);
        if (named instanceof Response) return named;
        const { id } = named;

        const input = readInput(raw);
        const errors = saleFieldErrors(input);
        if (errors.length) return err(errors[0]);
        if (input.contactId && !(await contactExists(db, input.contactId))) input.contactId = null;

        let item = { title: input.itemTitle, price: input.itemPrice };
        if (input.artworkId) {
            const piece = await sellPiece(db, input.artworkId);
            if (piece instanceof Response) return piece;
            item = piece;
        }
        if (!isAmount(item.price) || item.price > MAX_AMOUNT) item.price = 0;
        await insertSale(ctx, session, id, input, item);

        const sale = await loadSale(db, id);
        if (!sale) return err('The sale could not be saved. Please try again.', 500);
        deps.logChange(ctx, session, 'created', 'sale', id, `Recorded sale ${sale.saleNumber}: "${item.title}" to ${sale.buyerName} for ${rupees(sale.amount)} (${sale.paymentMode})`);
        signal(ctx, id, input.artworkId);
        return json(sale, 201);
    };

    /**
     * PUT /sales/:id — change the buyer, date, amount, payment or notes. The
     * piece sold stays as it is: to correct it, delete the sale and record it
     * again (which puts the first piece back on sale).
     */
    const update: Handler = async (ctx) => {
        const session = await caller(ctx);
        if (session instanceof Response) return session;
        const db = ctx.env.VAYU_DB;
        const id = SALE_PATH.exec(ctx.path)?.[1];
        const existing = id ? await loadSale(db, id) : null;
        if (!id || !existing) return err('That sale no longer exists.', 404);
        const raw = await body(ctx);
        if (!raw) return err('Invalid request body');
        const input = readInput(raw);
        input.artworkId = existing.artworkId;
        // A piece's title and price are its snapshot; a free-text item's can be corrected, and its photos changed.
        if (existing.artworkId) { input.itemTitle = existing.itemTitle; input.itemPrice = existing.itemPrice; input.photoUrls = []; }
        const errors = saleFieldErrors(input);
        if (errors.length) return err(errors[0]);
        if (input.contactId && !(await contactExists(db, input.contactId))) input.contactId = null;
        await db.prepare(
            `UPDATE sales SET item_title = ?, item_price = ?, contact_id = ?, buyer_name = ?, buyer_phone = ?, sale_date = ?, amount = ?,
               payment_mode = ?, reference_no = ?, notes = ?, tags = ?, photo_urls = ?, updated_at = ?, updated_by = ? WHERE id = ? AND deleted_at IS NULL`,
        ).bind(input.itemTitle, input.itemPrice, input.contactId, input.buyerName, input.buyerPhone, input.saleDate, input.amount,
            input.paymentMode, input.referenceNo, input.notes, JSON.stringify(input.tags), JSON.stringify(input.photoUrls), Date.now(), session.userId, id).run();
        const sale = await loadSale(db, id);
        if (!sale) return err('That sale no longer exists.', 404);
        deps.logChange(ctx, session, 'updated', 'sale', id, `Changed sale ${sale.saleNumber} ("${sale.itemTitle}", ${rupees(sale.amount)})`);
        signal(ctx, id);
        return json(sale);
    };

    /** DELETE /sales/:id — archive the sale and put its piece back to Available. */
    const remove: Handler = async (ctx) => {
        const session = await caller(ctx);
        if (session instanceof Response) return session;
        const db = ctx.env.VAYU_DB;
        const id = SALE_PATH.exec(ctx.path)?.[1];
        const existing = id ? await loadSale(db, id) : null;
        if (!id || !existing) return err('That sale no longer exists.', 404);
        await ensureChangeLogTable(db);
        const stmts: D1PreparedStatement[] = [
            db.prepare('UPDATE sales SET deleted_at = ?, deleted_by = ?, deleted_by_name = ? WHERE id = ? AND deleted_at IS NULL')
                .bind(Date.now(), session.userId, session.name, id),
        ];
        if (existing.artworkId) {
            // Only a piece this sale sold: not one reserved or sold again since.
            stmts.push(
                db.prepare(`UPDATE artworks SET status = 'Available' WHERE id = ? AND status = 'Sold'
                    AND NOT EXISTS (SELECT 1 FROM sales WHERE artwork_id = ? AND deleted_at IS NULL)`).bind(existing.artworkId, existing.artworkId),
                changeLogStmt(db, ctx.env, 'artwork', existing.artworkId, 'put', { actorId: session.userId }),
            );
        }
        await db.batch(stmts);
        deps.logChange(ctx, session, 'deleted', 'sale', id,
            `Deleted sale ${existing.saleNumber} ("${existing.itemTitle}", ${rupees(existing.amount)})${existing.inInventory ? '; the piece is available again' : ''}`);
        signal(ctx, id, existing.artworkId);
        return json({ success: true });
    };

    return [
        { method: 'GET', match: p => p === '/sales', handler: list },
        { method: 'POST', match: p => p === '/sales', handler: create },
        { method: 'PUT', match: p => SALE_PATH.test(p), handler: update },
        { method: 'DELETE', match: p => SALE_PATH.test(p), handler: remove },
    ];
}

