// Billing on the server: proformas, tax invoices / bills of supply, delivery
// challans, credit and debit notes, and the billing setup. The rules are
// shared with the app (invoicing.ts); here they are binding: the server
// numbers documents, freezes them once issued, and works out every total.
//
// Each document is stored whole as JSON in `data` (proformas from before
// Billing have the old shape and are converted when read: toBillingDoc).

import { changeLogStmt, ensureChangeLogTable } from './deltaSync';
import { err, json, runSetupOnce } from './rows';
import { ADMIN_ROLE_ID } from './permissions';
import {
    cleanSettings, creditRoom, currentSeller, docNumberFor, docTotals, isLocked, ISSUED_KINDS, issueProblems, KIND_LABEL,
    lockedFieldChanged, paymentsProblem, RETURNABLE, seriesKeyFor, statusChangeProblem, toBillingDoc,
    type BillingDoc, type BillingSettings,
} from './invoicing';
import type { ChangeEvent, Ctx, SessionData } from './workerEnv';
import { getSession } from './workerRoles';

export function ensureInvoicesTable(db: D1Database): Promise<void> {
    return runSetupOnce(db, 'invoicesTable', async () => {
        await db.prepare(`CREATE TABLE IF NOT EXISTS invoices (
            id TEXT PRIMARY KEY,
            invoice_number TEXT NOT NULL DEFAULT '',
            customer_name TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'Draft',
            date INTEGER NOT NULL DEFAULT 0,
            data TEXT NOT NULL DEFAULT '{}',
            created_by TEXT,
            created_by_name TEXT,
            updated_at INTEGER NOT NULL DEFAULT 0
        )`).run();
        // Billing (2026-11): the kind, and the number series each issued document took its number from.
        const have = new Set(((await db.prepare('PRAGMA table_info(invoices)').all<{ name: string }>()).results || []).map(c => c.name));
        for (const [column, definition] of Object.entries(ADDED_COLUMNS)) {
            if (have.has(column)) continue;
            try {
                await db.prepare(`ALTER TABLE invoices ADD COLUMN ${column} ${definition}`).run(); // NOSONAR: schema steps run one at a time
            } catch (e) {
                // Another isolate may have added it at the same moment.
                if (!/duplicate column/i.test((e as Error).message)) throw e;
            }
        }
        await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_series ON invoices (series_key, seq)').run();
        // The last number used in each series. Kept apart from the documents so a deleted proforma's number is never handed out again.
        await db.prepare('CREATE TABLE IF NOT EXISTS invoice_series (series_key TEXT PRIMARY KEY, last INTEGER NOT NULL)').run();
    });
}

const ADDED_COLUMNS: Record<string, string> = {
    kind: "TEXT NOT NULL DEFAULT 'proforma'",
    series_key: 'TEXT',
    seq: 'INTEGER',
};

// ── Billing setup ─────────────────────────────────────────────────────────

const SETTINGS_KEY = 'billing_settings';
/** Logo and signature travel inside the setup as small images. */
const MAX_SETTINGS_BYTES = 1_000_000;

export async function readBillingSettings(kv: KVNamespace): Promise<BillingSettings> {
    try {
        return cleanSettings(JSON.parse((await kv.get(SETTINGS_KEY)) ?? '{}'));
    } catch {
        return cleanSettings({});
    }
}

// ── Routes ──────────────────────────────────────────────────────────────────

type Handler = (ctx: Ctx) => Promise<Response>;
export interface InvoiceRoute { method: string; match: (path: string) => boolean; handler: Handler }

/** What these routes borrow from worker.ts. */
export interface InvoiceDeps {
    logChange: (ctx: Ctx, session: SessionData, action: string, entity: string, id: string, details: string) => void;
    notify: (ctx: Ctx, events: ChangeEvent[]) => void;
    archive: (ctx: Ctx, session: SessionData, entity: string, id: string, summary: string, payload: unknown) => void;
}

const DOC_PATH = /^\/invoices\/([\w.-]{1,80})$/;
const ACTION_PATH = /^\/invoices\/([\w.-]{1,80})\/(issue|cancel)$/;

async function caller(ctx: Ctx): Promise<SessionData | Response> {
    return (await getSession(ctx.request, ctx.env.VAYU_KV)) ?? err('Unauthorized', 401);
}

async function body(ctx: Ctx): Promise<Record<string, unknown> | null> {
    try {
        const raw = await ctx.request.json();
        return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

interface Stored { doc: BillingDoc; createdBy: string | null; createdByName: string | null }

async function load(db: D1Database, id: string): Promise<Stored | null> {
    const row = await db.prepare('SELECT data, created_by, created_by_name, seq, series_key FROM invoices WHERE id = ?').bind(id)
        .first<{ data: string; created_by: string | null; created_by_name: string | null; seq: number | null; series_key: string | null }>();
    if (!row) return null;
    let doc: BillingDoc;
    try { doc = toBillingDoc(JSON.parse(row.data)); } catch { doc = toBillingDoc({ id }); }
    // The columns are what numbering trusts (see allocate).
    if (row.seq && !doc.seq) doc = { ...doc, seq: row.seq, seriesKey: row.series_key ?? undefined };
    return { doc, createdBy: row.created_by, createdByName: row.created_by_name };
}

/** Credit and debit notes against one invoice. */
async function notesFor(db: D1Database, invoiceId: string): Promise<BillingDoc[]> {
    const rows = await db.prepare("SELECT data FROM invoices WHERE kind IN ('credit', 'debit') AND json_extract(data, '$.sourceId') = ?")
        .bind(invoiceId).all<{ data: string }>();
    return (rows.results || []).map(r => toBillingDoc(JSON.parse(r.data)));
}

type PieceStatus = 'Available' | 'Reserved' | 'Sold';

/** Pieces a document moves, only from the statuses given, so an older document never undoes a later sale. */
const pieces = (doc: BillingDoc, ids?: string[]) => ids ?? doc.lines.map(l => l.artworkId).filter(Boolean);

function moveStatements(ctx: Ctx, session: SessionData, ids: string[], to: PieceStatus, from: PieceStatus[]): D1PreparedStatement[] {
    const db = ctx.env.VAYU_DB;
    return ids.flatMap(id => [
        db.prepare(`UPDATE artworks SET status = ? WHERE id = ? AND status IN (${from.map(() => '?').join(', ')})`).bind(to, id, ...from),
        changeLogStmt(db, ctx.env, 'artwork', id, 'put', { actorId: session.userId }),
    ]);
}

/** What happens to inventory when a document is issued, cancelled, or its goods come back (Billing setup → Update inventory). */
function inventoryMoves(event: 'issue' | 'cancel' | 'return', doc: BillingDoc, returnedIds: string[] = []): { to: PieceStatus; from: PieceStatus[]; ids: string[] } | null {
    const returnable = doc.kind === 'challan' && !!doc.challanPurpose && RETURNABLE.has(doc.challanPurpose);
    if (event === 'issue' && doc.kind === 'tax') return { to: 'Sold', from: ['Available', 'Reserved'], ids: pieces(doc) };
    if (event === 'issue' && returnable) return { to: 'Reserved', from: ['Available'], ids: pieces(doc) };
    if (event === 'cancel' && doc.kind === 'tax') return { to: 'Available', from: ['Sold'], ids: pieces(doc) };
    if (event === 'cancel' && returnable) return { to: 'Available', from: ['Reserved'], ids: pieces(doc) };
    if (event === 'return' && returnable) return { to: 'Available', from: ['Reserved'], ids: returnedIds };
    return null;
}

/** Inventory pieces whose every item came back in this save. */
function fullyReturned(before: BillingDoc | null, after: BillingDoc): string[] {
    if (!before || after.kind !== 'challan') return [];
    const was = new Map(before.lines.map(l => [l.key, l.returnedQty ?? 0]));
    return after.lines.filter(l => l.artworkId && (l.returnedQty ?? 0) >= l.qty && (was.get(l.key) ?? 0) < l.qty).map(l => l.artworkId);
}

/**
 * A proforma in the old shape (a device uploading what it saved before Billing,
 * or an app not yet updated). It keeps its number: customers may hold its PDF.
 */
const fromBeforeBilling = (raw: Record<string, unknown>): boolean => Array.isArray(raw.items) && !Array.isArray(raw.lines);

const withTotals = (doc: BillingDoc, s: BillingSettings): BillingDoc => {
    const t = docTotals(doc, s);
    return { ...doc, totalPaise: t.total, taxPaise: t.tax };
};

const logged = (doc: BillingDoc, text: string, session: SessionData, at = Date.now()): BillingDoc =>
    ({ ...doc, history: [...doc.history, { at, text: `${text} (${session.name})` }].slice(-200), updatedAt: at });

const describe = (doc: BillingDoc) => `${KIND_LABEL[doc.kind]} ${doc.number || 'draft'} (${doc.party.name || 'no customer'})`;

/**
 * Gives a document the next number in its series, once. The counter and the
 * document change together (one batch), and only while the document has no
 * number yet, so a retry gets the same number and no number is skipped.
 */
async function allocate(db: D1Database, id: string, seriesKey: string, start: number): Promise<{ seq: number; seriesKey: string }> {
    await db.batch([
        db.prepare(`INSERT INTO invoice_series (series_key, last)
            SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM invoices WHERE id = ?3 AND seq IS NULL)
            ON CONFLICT (series_key) DO UPDATE SET last = MAX(last + 1, excluded.last)`).bind(seriesKey, start, id),
        db.prepare('UPDATE invoices SET series_key = ?1, seq = (SELECT last FROM invoice_series WHERE series_key = ?1) WHERE id = ?2 AND seq IS NULL').bind(seriesKey, id),
    ]);
    const row = await db.prepare('SELECT seq, series_key FROM invoices WHERE id = ?').bind(id).first<{ seq: number; series_key: string }>();
    if (!row?.seq) throw new Error('Numbering failed');
    return { seq: row.seq, seriesKey: row.series_key };
}

/** Why a credit or debit note can't be issued against its invoice, or null. */
async function noteProblem(db: D1Database, note: BillingDoc, invoice: BillingDoc | null, s: BillingSettings): Promise<string | null> {
    if (note.kind !== 'credit' && note.kind !== 'debit') return null;
    if (invoice?.kind !== 'tax' || invoice.status !== 'Issued') return 'Notes can only adjust an issued tax invoice.';
    if (note.kind === 'debit') return null;
    const room = creditRoom(invoice, await notesFor(db, invoice.id), s, note.id);
    return docTotals(note, s).total > room ? 'This credit is more than the invoice has left.' : null;
}

/** Issuing a tax invoice converts its proforma and invoices its challan; null when the source doesn't change. */
function sourceAfterIssue(source: BillingDoc, issued: BillingDoc, session: SessionData, now: number): BillingDoc | null {
    if (issued.kind !== 'tax') return null;
    if (source.kind === 'proforma' && source.status !== 'Converted') return logged({ ...source, status: 'Converted' }, `Converted to ${issued.number}`, session, now);
    if (source.kind === 'challan' && ['Issued', 'Delivered'].includes(source.status)) return logged({ ...source, status: 'Invoiced' }, `Invoiced in ${issued.number}`, session, now);
    return null;
}

export function invoiceRoutes(deps: InvoiceDeps): InvoiceRoute[] {
    /** Writes documents, and the inventory they move, in one batch (a transaction). */
    const writeDocs = async (ctx: Ctx, session: SessionData, docs: { doc: BillingDoc; createdBy: string | null; createdByName: string | null }[],
        move: ReturnType<typeof inventoryMoves> = null, s: BillingSettings | null = null) => {
        const db = ctx.env.VAYU_DB;
        await ensureChangeLogTable(db);
        const moved = move && s?.inventoryEffects && move.ids.length ? move : null;
        await db.batch([...docs.flatMap(({ doc, createdBy, createdByName }) => [
            db.prepare(`INSERT INTO invoices (id, invoice_number, customer_name, status, date, data, created_by, created_by_name, updated_at, kind, series_key, seq)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (id) DO UPDATE SET invoice_number = excluded.invoice_number, customer_name = excluded.customer_name, status = excluded.status,
                    date = excluded.date, data = excluded.data, updated_at = excluded.updated_at, kind = excluded.kind`)
                .bind(doc.id, doc.number, doc.party.name, doc.status, doc.date, JSON.stringify(doc), createdBy, createdByName, Date.now(), doc.kind, doc.seriesKey ?? null, doc.seq ?? null),
            changeLogStmt(db, ctx.env, 'invoice', doc.id, 'put', { actorId: session.userId }),
        ]), ...(moved ? moveStatements(ctx, session, moved.ids, moved.to, moved.from) : [])]);
        deps.notify(ctx, [
            ...docs.map(({ doc }) => ({ entity: 'invoice', id: doc.id, op: 'put' as const })),
            ...(moved?.ids ?? []).map(id => ({ entity: 'artwork', id, op: 'put' as const })),
        ]);
    };

    /** GET /invoices — every document, old proformas in the current shape. */
    const list: Handler = async (ctx) => {
        const session = await caller(ctx);
        if (session instanceof Response) return session;
        await ensureInvoicesTable(ctx.env.VAYU_DB);
        const rows = await ctx.env.VAYU_DB.prepare('SELECT data FROM invoices ORDER BY date DESC').all<{ data: string }>();
        const docs = (rows.results || []).flatMap(r => {
            try { return [toBillingDoc(JSON.parse(r.data))]; } catch { return []; }
        });
        return json(docs);
    };

    /**
     * PUT /invoices/:id — create or edit. Drafts and proformas change freely;
     * an issued document only in what GST lets change afterwards (payments,
     * transport, e-way bill, IRN, challan returns). Numbers, the seller and
     * the totals are the server's.
     */
    const save: Handler = async (ctx) => {
        const session = await caller(ctx);
        if (session instanceof Response) return session;
        const id = DOC_PATH.exec(ctx.path)?.[1];
        const raw = await body(ctx);
        if (!id || raw?.id !== id) return err('Invoice id mismatch');
        const db = ctx.env.VAYU_DB;
        await ensureInvoicesTable(db);
        const stored = await load(db, id);
        const before = stored?.doc ?? null;
        const sent = toBillingDoc(raw);
        const now = Date.now();
        let doc: BillingDoc = {
            ...sent,
            id,
            number: before?.number ?? (fromBeforeBilling(raw) ? sent.number : ''),
            seriesKey: before?.seriesKey,
            seq: before?.seq,
            seller: before?.seller,
            issuedAt: before?.issuedAt,
            cancelReason: before?.cancelReason,
            totalPaise: before?.totalPaise,
            taxPaise: before?.taxPaise,
            linkPaidPaise: before?.linkPaidPaise,
            history: before?.history ?? [],
            createdAt: before?.createdAt ?? now,
        };
        const s = await readBillingSettings(ctx.env.VAYU_KV);
        const locked = before ? lockedFieldChanged(before, doc) : null;
        const problem = statusChangeProblem(before, doc)
            ?? (locked ? `This ${KIND_LABEL[doc.kind].toLowerCase()} is issued, so “${locked}” can’t change. Use a credit or debit note.` : null)
            ?? paymentsProblem(before, doc, s);
        if (problem) return err(problem, 409);

        doc = withTotals(logged(doc, before ? 'Edited' : 'Created', session, now), s);
        const owner = { createdBy: stored ? stored.createdBy : session.userId, createdByName: stored ? stored.createdByName : session.name };
        await writeDocs(ctx, session, [{ doc, ...owner }], inventoryMoves('return', doc, fullyReturned(before, doc)), s);
        // A proforma is numbered on its first save; the others when issued.
        if (doc.kind === 'proforma' && !doc.number) {
            const { seq, seriesKey } = await allocate(db, id, seriesKeyFor(s, 'proforma', doc.storeId, doc.date), s.series.proforma.start);
            doc = { ...doc, seq, seriesKey, number: docNumberFor(s, 'proforma', doc.storeId, doc.date, seq) };
            await writeDocs(ctx, session, [{ doc, ...owner }]);
        }
        deps.logChange(ctx, session, before ? 'updated' : 'created', 'invoice', id, `${before ? 'Updated' : 'Created'} ${describe(doc)}`);
        return json(doc, before ? 200 : 201);
    };

    /** POST /invoices/:id/issue — numbers a draft, freezes it and the seller details. Answers with every document it changed. */
    const issue = async (ctx: Ctx, session: SessionData, stored: Stored): Promise<Response> => {
        const db = ctx.env.VAYU_DB;
        const before = stored.doc;
        if (!ISSUED_KINDS.has(before.kind)) return err('Proformas aren’t issued: they are numbered when saved.');
        if (before.status === 'Issued' && before.number) return json([before]);
        if (before.status !== 'Draft') return err('Only drafts can be issued.', 409);
        const s = await readBillingSettings(ctx.env.VAYU_KV);
        const problems = issueProblems(before, s);
        if (problems.length) return err(problems[0]);

        const source = before.sourceId ? await load(db, before.sourceId) : null;
        const noteRefused = await noteProblem(db, before, source?.doc ?? null, s);
        if (noteRefused) return err(noteRefused, 409);

        const now = Date.now();
        const { seq, seriesKey } = await allocate(db, before.id, seriesKeyFor(s, before.kind, before.storeId, before.date), s.series[before.kind].start);
        const number = docNumberFor(s, before.kind, before.storeId, before.date, seq);
        const issued = withTotals(logged({ ...before, number, seq, seriesKey, status: 'Issued', issuedAt: now, seller: currentSeller(s, before.storeId) }, `Issued as ${number}`, session, now), s);
        const sourceAfter = source ? sourceAfterIssue(source.doc, issued, session, now) : null;
        const changed: Stored[] = [{ ...stored, doc: issued }, ...(source && sourceAfter ? [{ ...source, doc: sourceAfter }] : [])];
        await writeDocs(ctx, session, changed, inventoryMoves('issue', issued), s);
        deps.logChange(ctx, session, 'updated', 'invoice', issued.id, `Issued ${describe(issued)}`);
        return json(changed.map(c => c.doc));
    };

    /** POST /invoices/:id/cancel {reason} — the number stays on record; the document counts zero from then on. */
    const cancel = async (ctx: Ctx, session: SessionData, stored: Stored): Promise<Response> => {
        const before = stored.doc;
        if (!isLocked(before) || before.status === 'Cancelled') return err('Only issued documents can be cancelled. Delete a draft instead.', 409);
        const sent = (await body(ctx))?.reason;
        const reason = typeof sent === 'string' ? sent.trim().slice(0, 200) : '';
        if (!reason) return err('Give a reason for cancelling.');
        if (before.payments.length) return err('Payments are recorded on this invoice. Remove them or issue a credit note instead.', 409);
        if ((await notesFor(ctx.env.VAYU_DB, before.id)).some(n => n.status === 'Issued')) return err('Notes are issued against this invoice. Cancel them first.', 409);
        const cancelled = logged({ ...before, status: 'Cancelled', cancelReason: reason }, `Cancelled: ${reason}`, session);
        await writeDocs(ctx, session, [{ ...stored, doc: cancelled }], inventoryMoves('cancel', cancelled), await readBillingSettings(ctx.env.VAYU_KV));
        deps.logChange(ctx, session, 'updated', 'invoice', cancelled.id, `Cancelled ${describe(cancelled)}: ${reason}`);
        return json(cancelled);
    };

    const action: Handler = async (ctx) => {
        const session = await caller(ctx);
        if (session instanceof Response) return session;
        const [, id, verb] = ACTION_PATH.exec(ctx.path) ?? [];
        if (!id) return err('Not found', 404);
        await ensureInvoicesTable(ctx.env.VAYU_DB);
        const stored = await load(ctx.env.VAYU_DB, id);
        if (!stored) return err('That document no longer exists.', 404);
        return verb === 'issue' ? issue(ctx, session, stored) : cancel(ctx, session, stored);
    };

    /** DELETE /invoices/:id — drafts and proformas only: an issued number stays on record forever. */
    const remove: Handler = async (ctx) => {
        const session = await caller(ctx);
        if (session instanceof Response) return session;
        const id = DOC_PATH.exec(ctx.path)?.[1];
        if (!id) return err('Not found', 404);
        const db = ctx.env.VAYU_DB;
        await ensureInvoicesTable(db);
        const row = await db.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first<Record<string, unknown>>();
        const doc = row ? toBillingDoc(JSON.parse(String(row.data))) : null;
        if (doc && doc.kind !== 'proforma' && doc.status !== 'Draft') return err('Issued documents can’t be deleted. Cancel it instead.', 409);
        await ensureChangeLogTable(db);
        await db.batch([
            db.prepare('DELETE FROM invoices WHERE id = ?').bind(id),
            changeLogStmt(db, ctx.env, 'invoice', id, 'delete', { actorId: session.userId }),
        ]);
        deps.notify(ctx, [{ entity: 'invoice', id, op: 'delete' }]);
        if (row && doc) {
            deps.archive(ctx, session, 'invoice', id, describe(doc), row);
            deps.logChange(ctx, session, 'deleted', 'invoice', id, `Deleted ${describe(doc)}`);
        }
        return json({ success: true });
    };

    /** GET /invoices/settings — the billing setup (business, stores, bank, numbering…). */
    const getSettings: Handler = async (ctx) => {
        const session = await caller(ctx);
        if (session instanceof Response) return session;
        return json(await readBillingSettings(ctx.env.VAYU_KV));
    };

    /**
     * PUT /invoices/settings — replaces the billing setup. Admins only: it holds
     * the bank account every invoice asks customers to pay into.
     */
    const putSettings: Handler = async (ctx) => {
        const session = await caller(ctx);
        if (session instanceof Response) return session;
        if (session.role !== ADMIN_ROLE_ID) return err('Only a workspace admin can change the billing setup.', 403);
        const text = await ctx.request.text();
        if (text.length > MAX_SETTINGS_BYTES) return err('The setup is too large. Use a smaller logo or signature image.', 413);
        let raw: unknown;
        try { raw = JSON.parse(text); } catch { return err('Invalid billing setup'); }
        const sentAt = (raw as { updatedAt?: unknown } | null)?.updatedAt;
        const current = await readBillingSettings(ctx.env.VAYU_KV);
        if (typeof sentAt === 'number' && sentAt !== current.updatedAt) {
            return err('Someone else changed the billing setup meanwhile. Close it and open it again to see their changes.', 409);
        }
        const settings = { ...cleanSettings(raw), updatedAt: Date.now() };
        await ctx.env.VAYU_KV.put(SETTINGS_KEY, JSON.stringify(settings));
        deps.logChange(ctx, session, 'updated', 'billing settings', '', 'Updated the billing setup');
        return json(settings);
    };

    const isExact = (p: string) => (path: string) => path === p;
    return [
        { method: 'GET', match: isExact('/invoices/settings'), handler: getSettings },
        { method: 'PUT', match: isExact('/invoices/settings'), handler: putSettings },
        { method: 'GET', match: isExact('/invoices'), handler: list },
        { method: 'POST', match: path => ACTION_PATH.test(path), handler: action },
        { method: 'PUT', match: path => DOC_PATH.test(path), handler: save },
        { method: 'DELETE', match: path => DOC_PATH.test(path), handler: remove },
    ];
}
