// My Notes, in My Space. Private to their author: every query is scoped to the
// signed-in person, admins included (docs/IMPLEMENTATION_PLAN.md 8.2).
//
// Storage: one table in the workspace's own database, created on first use.
// Nothing goes through change_log: the screen refetches when it opens.

import { err, json, runSetupOnce, text } from './rows';
import { MAX_NOTES, parseNote, type Note } from './noteRules';
import type { Ctx, SessionData } from './workerEnv';
import { getSession } from './workerRoles';

const ID_PATH = /^\/notes\/([\w-]{1,64})$/;

type Handler = (ctx: Ctx) => Promise<Response>;
export interface NoteRoute { method: string; match: (path: string) => boolean; handler: Handler }

function ensureNotesTable(db: D1Database): Promise<void> {
    return runSetupOnce(db, 'notesTable', async () => {
        await db.prepare(`CREATE TABLE IF NOT EXISTS notes (
            id         TEXT PRIMARY KEY,
            owner_id   TEXT NOT NULL,
            title      TEXT NOT NULL DEFAULT '',
            body       TEXT NOT NULL DEFAULT '',
            pinned     INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )`).run();
        await db.prepare('CREATE INDEX IF NOT EXISTS idx_notes_owner ON notes (owner_id, updated_at)').run();
    });
}

async function caller(ctx: Ctx): Promise<SessionData | Response> {
    const session = await getSession(ctx.request, ctx.env.VAYU_KV);
    if (!session) return err('Unauthorized', 401);
    await ensureNotesTable(ctx.env.VAYU_DB);
    return session;
}

const rowToNote = (r: Record<string, unknown>): Note => ({
    id: text(r.id), title: text(r.title), body: text(r.body), pinned: Number(r.pinned) === 1,
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
});

async function body(ctx: Ctx): Promise<unknown> {
    try { return await ctx.request.json(); } catch { return null; }
}

// shortcut: the list carries every note's full text (up to 500 × 20 000 characters); send previews only if it gets slow.
/** GET /notes — your notes, pinned first, then most recently changed. */
const list: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const { results } = await ctx.env.VAYU_DB.prepare(
        'SELECT * FROM notes WHERE owner_id = ? ORDER BY pinned DESC, updated_at DESC LIMIT ?',
    ).bind(session.userId, MAX_NOTES).all();
    return json({ notes: results.map(r => rowToNote(r as Record<string, unknown>)) });
};

const create: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const n = parseNote(await body(ctx));
    if ('problem' in n) return err(n.problem);
    const db = ctx.env.VAYU_DB;
    const count = await db.prepare('SELECT COUNT(*) AS n FROM notes WHERE owner_id = ?').bind(session.userId).first<{ n: number }>();
    if (Number(count?.n ?? 0) >= MAX_NOTES) return err(`You can keep up to ${MAX_NOTES} notes. Delete some old ones first.`, 409);
    const now = Date.now();
    const id = `note_${now}_${crypto.randomUUID().slice(0, 8)}`;
    await db.prepare('INSERT INTO notes (id, owner_id, title, body, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, session.userId, n.title, n.body, n.pinned ? 1 : 0, now, now).run();
    return json({ id, ...n, createdAt: now, updatedAt: now } satisfies Note, 201);
};

const update: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const id = ID_PATH.exec(ctx.path)![1];
    const n = parseNote(await body(ctx));
    if ('problem' in n) return err(n.problem);
    const now = Date.now();
    const row = await ctx.env.VAYU_DB.prepare('UPDATE notes SET title = ?, body = ?, pinned = ?, updated_at = ? WHERE id = ? AND owner_id = ? RETURNING created_at')
        .bind(n.title, n.body, n.pinned ? 1 : 0, now, id, session.userId).first<{ created_at: number }>();
    if (!row) return err('That note was not found.', 404);
    return json({ id, ...n, createdAt: Number(row.created_at), updatedAt: now } satisfies Note);
};

const remove: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const id = ID_PATH.exec(ctx.path)![1];
    const res = await ctx.env.VAYU_DB.prepare('DELETE FROM notes WHERE id = ? AND owner_id = ?').bind(id, session.userId).run();
    if (!res.meta.changes) return err('That note was not found.', 404);
    return json({ ok: true });
};

export const noteRoutes: NoteRoute[] = [
    { method: 'GET', match: p => p === '/notes', handler: list },
    { method: 'POST', match: p => p === '/notes', handler: create },
    { method: 'PUT', match: p => ID_PATH.test(p), handler: update },
    { method: 'DELETE', match: p => ID_PATH.test(p), handler: remove },
];
