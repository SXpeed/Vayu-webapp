// Each person's bell (notifications) and the inquiries they have not opened
// yet (unread_items). Two separate things on purpose:
//   - a notification is new until it is opened (tapped) or dismissed, and
//     neither touches the inquiry it is about;
//   - an inquiry stays unread for a person until they open its details or
//     mark it read, whatever happened to its notifications.
// Notifications are written where pushes are sent (worker.ts), so every event
// that pushes also lands in the bell, for people without push turned on too.

import { linkPendingInquiries } from './contactStore';
import { notifyHub } from './deltaSync';
import { ADMIN_ROLE_ID, atLeast, withoutSections } from './permissions';
import { err, json, runSetupOnce } from './rows';
import { getRoles, getSession, permissionsFor } from './workerRoles';
import type { Ctx, Env, SessionData } from './workerEnv';

/** Notifications older than this are deleted, opened or not. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const LIST_LIMIT = 200;
/** IN lists stay under D1's 100 bound parameters. */
const MAX_IDS = 90;

export function ensureInboxTables(db: D1Database): Promise<void> {
  return runSetupOnce(db, 'inboxTables', () => db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, group_key TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'new')`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, state, created_at DESC)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS unread_items (
      user_id TEXT NOT NULL, kind TEXT NOT NULL, item_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, kind, item_id))`),
  ]));
}

/** What a push carries; the bell keeps the same. */
export interface InboxNote {
  title: string;
  body: string;
  /** Groups notifications about one source (inquiry-<id>, conv-<id>). */
  tag?: string;
  /** Where a tap leads (App.tsx pushTargetFrom). */
  data?: { view?: string; [k: string]: unknown };
}

/**
 * Puts a notification in each person's bell. One about an inquiry (new, or a
 * new message on it) also makes that inquiry unread for them again.
 */
export async function recordNotifications(env: Env, userIds: string[], note: InboxNote): Promise<void> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return;
  const db = env.VAYU_DB;
  await ensureInboxTables(db);
  const now = Date.now();
  const inquiryId = note.data?.view === 'inquiry' && typeof note.data.inquiryId === 'string' ? note.data.inquiryId : null;
  await db.batch(ids.flatMap(userId => [
    db.prepare('INSERT INTO notifications (id, user_id, group_key, title, body, link, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), userId, note.tag ?? '', note.title, note.body, JSON.stringify(note.data ?? {}), now),
    ...(inquiryId ? [db.prepare('INSERT OR IGNORE INTO unread_items (user_id, kind, item_id, created_at) VALUES (?, ?, ?, ?)')
      .bind(userId, 'inquiry', inquiryId, now)] : []),
  ]));
  await notifyHub(env, ids.map(id => ({ entity: 'inbox', id, op: 'put' as const })));
}

async function mayViewInquiries(ctx: Ctx, session: SessionData): Promise<boolean> {
  if (session.role === ADMIN_ROLE_ID) return true;
  const perms = withoutSections(permissionsFor(await getRoles(ctx.env.VAYU_KV), session.role), ctx.env.SECTIONS_OFF);
  return atLeast(perms.inquiries, 'view');
}

/** GET /inbox — this person's new notifications and unread inquiries. */
export async function handleInbox(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const db = ctx.env.VAYU_DB;
  await ensureInboxTables(db);
  // Every app asks here on start: a good moment to link older inquiries to contacts.
  ctx.execCtx.waitUntil(linkPendingInquiries(ctx.env).catch(e => console.error('Linking inquiries failed:', e)));
  const [, notes, unread] = await db.batch([
    db.prepare('DELETE FROM notifications WHERE user_id = ? AND created_at < ?').bind(session.userId, Date.now() - KEEP_MS),
    db.prepare(`SELECT id, group_key, title, body, link, created_at FROM notifications
      WHERE user_id = ? AND state = 'new' ORDER BY created_at DESC LIMIT ?`).bind(session.userId, LIST_LIMIT),
    // Joined so a deleted inquiry stops counting.
    db.prepare(`SELECT u.item_id FROM unread_items u JOIN inquiries i ON i.id = u.item_id
      WHERE u.user_id = ? AND u.kind = 'inquiry'`).bind(session.userId),
  ]);
  const notifications = (notes.results as Record<string, unknown>[]).map(row => {
    let link: unknown = {};
    try { link = JSON.parse(String(row.link)); } catch { /* malformed: no link */ }
    return { id: row.id, groupKey: row.group_key, title: row.title, body: row.body, link, createdAt: row.created_at };
  });
  const unreadInquiryIds = await mayViewInquiries(ctx, session)
    ? (unread.results as { item_id: string }[]).map(r => r.item_id)
    : [];
  return json({ notifications, unreadInquiryIds });
}

/** POST /inbox/notifications { ids, state: 'opened' | 'dismissed' } — never touches what they are about. */
export async function handleInboxNotifications(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json().catch(() => null) as { ids?: unknown; state?: unknown } | null;
  const state = body?.state;
  if (state !== 'opened' && state !== 'dismissed') return err('state must be opened or dismissed');
  const ids = Array.isArray(body?.ids) ? [...new Set(body.ids.filter((id): id is string => typeof id === 'string' && id.length <= 64))] : [];
  if (ids.length === 0) return err('ids are required');
  if (ids.length > LIST_LIMIT) return err(`At most ${LIST_LIMIT} at a time`);
  const db = ctx.env.VAYU_DB;
  await ensureInboxTables(db);
  const stmts = [];
  for (let i = 0; i < ids.length; i += MAX_IDS) {
    const chunk = ids.slice(i, i + MAX_IDS);
    // Only this person's own, and only while still new.
    stmts.push(db.prepare(`UPDATE notifications SET state = ? WHERE user_id = ? AND state = 'new' AND id IN (${chunk.map(() => '?').join(',')})`)
      .bind(state, session.userId, ...chunk));
  }
  await db.batch(stmts);
  ctx.execCtx.waitUntil(notifyHub(ctx.env, [{ entity: 'inbox', id: session.userId, op: 'put' }]));
  return json({ success: true });
}

/** POST /inbox/read { inquiryId, unread?: true } — opened its details, or "Mark unread". */
export async function handleInboxRead(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  if (!await mayViewInquiries(ctx, session)) return err("Your role doesn't have access to this", 403);
  const body = await ctx.request.json().catch(() => null) as { inquiryId?: unknown; unread?: unknown } | null;
  const inquiryId = typeof body?.inquiryId === 'string' && body.inquiryId.length <= 128 ? body.inquiryId : '';
  if (!inquiryId) return err('inquiryId is required');
  const db = ctx.env.VAYU_DB;
  await ensureInboxTables(db);
  if (body?.unread === true) {
    await db.prepare(`INSERT OR IGNORE INTO unread_items (user_id, kind, item_id, created_at)
      SELECT ?, 'inquiry', id, ? FROM inquiries WHERE id = ?`).bind(session.userId, Date.now(), inquiryId).run();
  } else {
    await db.prepare("DELETE FROM unread_items WHERE user_id = ? AND kind = 'inquiry' AND item_id = ?").bind(session.userId, inquiryId).run();
  }
  ctx.execCtx.waitUntil(notifyHub(ctx.env, [{ entity: 'inbox', id: session.userId, op: 'put' }]));
  return json({ success: true });
}
