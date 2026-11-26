// Ask AI's saved chats. Private to their author, like My Notes (notes.ts):
// every query is scoped to the signed-in person, admins included. The screen
// owns the thread (it edits and regenerates answers) and saves it whole.

import { err, json, runSetupOnce, text } from './rows';
import type { Ctx, SessionData } from './workerEnv';
import { getSession } from './workerRoles';

const ID_PATH = /^\/assistant\/chats\/([\w-]{1,64})$/;
const MAX_CHATS = 200; // per person; the oldest go first
const MAX_TURNS = 100;
const MAX_BODY = 1_000_000;

type Handler = (ctx: Ctx) => Promise<Response>;
type Row = Record<string, unknown>;
export interface Turn { q: string; a: string }

function ensureTable(db: D1Database): Promise<void> {
    return runSetupOnce(db, 'assistantChatsTable', async () => {
        await db.prepare(`CREATE TABLE IF NOT EXISTS assistant_chats (
            id         TEXT PRIMARY KEY,
            owner_id   TEXT NOT NULL,
            title      TEXT NOT NULL DEFAULT '',
            turns      TEXT NOT NULL DEFAULT '[]',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )`).run();
        await db.prepare('CREATE INDEX IF NOT EXISTS idx_assistant_chats_owner ON assistant_chats (owner_id, updated_at)').run();
    });
}

async function caller(ctx: Ctx): Promise<SessionData | Response> {
    const session = await getSession(ctx.request, ctx.env.VAYU_KV);
    if (!session) return err('Unauthorized', 401);
    await ensureTable(ctx.env.VAYU_DB);
    return session;
}

/** A saved chat from the screen, or what is wrong with it. */
export function parseChat(raw: unknown): { title: string; turns: Turn[] } | { problem: string } {
    const b = (raw && typeof raw === 'object' ? raw : {}) as Row;
    if (!Array.isArray(b.turns) || !b.turns.length) return { problem: 'A chat needs at least one question.' };
    if (b.turns.length > MAX_TURNS) return { problem: `A chat can hold up to ${MAX_TURNS} questions. Start a new chat.` };
    const turns: Turn[] = [];
    for (const t of b.turns) {
        const r = (t && typeof t === 'object' ? t : {}) as Row;
        if (typeof r.q !== 'string' || typeof r.a !== 'string' || !r.q.trim()) return { problem: 'That chat is not in the right shape.' };
        turns.push({ q: r.q.slice(0, 1000), a: r.a.slice(0, 20_000) });
    }
    const title = (typeof b.title === 'string' && b.title.trim() ? b.title : turns[0].q).trim().slice(0, 100);
    return { title, turns };
}

/** GET /assistant/chats: your chats, newest first, without their text. */
const list: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const { results } = await ctx.env.VAYU_DB.prepare('SELECT id, title, updated_at FROM assistant_chats WHERE owner_id = ? ORDER BY updated_at DESC LIMIT ?')
        .bind(session.userId, MAX_CHATS).all<Row>();
    return json({ chats: results.map(r => ({ id: text(r.id), title: text(r.title), updatedAt: Number(r.updated_at) })) });
};

const get: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const r = await ctx.env.VAYU_DB.prepare('SELECT id, title, turns, updated_at FROM assistant_chats WHERE id = ? AND owner_id = ?')
        .bind(ID_PATH.exec(ctx.path)![1], session.userId).first<Row>();
    if (!r) return err('That chat was not found.', 404);
    let turns: unknown = [];
    try { turns = JSON.parse(text(r.turns)); } catch { /* shown empty */ }
    return json({ id: text(r.id), title: text(r.title), turns: Array.isArray(turns) ? turns : [], updatedAt: Number(r.updated_at) });
};

/** PUT /assistant/chats/:id { title?, turns }: saves the whole chat (the id is the screen's). */
const save: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const raw = await ctx.request.text();
    if (raw.length > MAX_BODY) return err('That chat is too long to save. Start a new chat.', 413);
    let body: unknown = null;
    try { body = JSON.parse(raw); } catch { /* reported below */ }
    const c = parseChat(body);
    if ('problem' in c) return err(c.problem);
    const id = ID_PATH.exec(ctx.path)![1];
    const now = Date.now();
    const db = ctx.env.VAYU_DB;
    // Another person's id is never overwritten: the update only touches the caller's own row.
    const done = await db.prepare(`INSERT INTO assistant_chats (id, owner_id, title, turns, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, turns = excluded.turns, updated_at = excluded.updated_at WHERE assistant_chats.owner_id = excluded.owner_id`)
        .bind(id, session.userId, c.title, JSON.stringify(c.turns), now, now).run();
    if (!done.meta.changes) return err('That chat was not found.', 404);
    await db.prepare(`DELETE FROM assistant_chats WHERE owner_id = ? AND id NOT IN
        (SELECT id FROM assistant_chats WHERE owner_id = ? ORDER BY updated_at DESC LIMIT ${MAX_CHATS})`).bind(session.userId, session.userId).run();
    return json({ id, title: c.title, updatedAt: now });
};

const remove: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const res = await ctx.env.VAYU_DB.prepare('DELETE FROM assistant_chats WHERE id = ? AND owner_id = ?').bind(ID_PATH.exec(ctx.path)![1], session.userId).run();
    if (!res.meta.changes) return err('That chat was not found.', 404);
    return json({ ok: true });
};

/** DELETE /assistant/chats: clears all of your chat history. */
const clear: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const res = await ctx.env.VAYU_DB.prepare('DELETE FROM assistant_chats WHERE owner_id = ?').bind(session.userId).run();
    return json({ ok: true, deleted: res.meta.changes ?? 0 });
};

export const chatRoutes = [
    { method: 'GET', match: (p: string) => p === '/assistant/chats', handler: list },
    { method: 'DELETE', match: (p: string) => p === '/assistant/chats', handler: clear },
    { method: 'GET', match: (p: string) => ID_PATH.test(p), handler: get },
    { method: 'PUT', match: (p: string) => ID_PATH.test(p), handler: save },
    { method: 'DELETE', match: (p: string) => ID_PATH.test(p), handler: remove },
];
