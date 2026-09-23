// Authenticated delta sync.
//
// /api/sync returns everything that changed since the caller's cursor —
// creations, updates and deletion tombstones — filtered to what the caller's
// role may read (including conversation membership for chat rows). It also
// owns the change_log table: every D1 mutation elsewhere in worker.ts appends
// its change_log row in the SAME D1 batch as the mutation, so the business
// write and the change record commit atomically.
//
// Ordering and cursor safety: change_log.seq is an AUTOINCREMENT primary key
// and SQLite serializes writes, so sequence order equals commit order. A
// client that has applied everything up to seq N can never be surprised by a
// later-committed row with seq <= N. Pages advance the cursor to the last seq
// of the page whether or not rows were emitted (permission-filtered rows must
// not be re-read forever).
//
// KV-backed data (users, roles, sessions, payment links, settings, presence)
// is intentionally NOT in the change log — KV and D1 cannot share a
// transaction. Those datasets keep their existing refresh paths; the hub
// signals them with invalidate events that trigger targeted refetches.

import {
  err, json, runSetupOnce, rowToArtwork, rowToAttendance, rowToCatalog,
  rowToCollection, rowToContact, rowToConversation, rowToEvent, rowToInquiry,
  rowToInquiryMessage, rowToInvoice, rowToMessage, rowToStore,
} from './rows';
import { permissionsForRoles, readableEntities, scopeAllows, type SyncEntity } from './entityAccess';
import { ADMIN_ROLE_ID, atLeast } from './permissions';
import { CONVERSATION_SCOPE_SQL, mayUseConversation, roomAccessOf, type RoomAccess } from './privateRooms';
import { getRoles, getSession } from './workerRoles';
import {
  addD1Usage, flagEnabled, rawRealtimeSecret, realtimeEnabled, workspaceId,
  type ChangeEvent, type Ctx, type Env, type SessionData,
} from './workerEnv';

// ── change_log plumbing ─────────────────────────────────────────────────────

const CHANGE_LOG_SETUP_KEY = 'changeLogTable';

export function ensureChangeLogTable(db: D1Database): Promise<void> {
  return runSetupOnce(CHANGE_LOG_SETUP_KEY, () => db.prepare(`
      CREATE TABLE IF NOT EXISTS change_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        entity TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        op TEXT NOT NULL,
        changed_at INTEGER NOT NULL,
        actor_id TEXT NOT NULL DEFAULT '',
        scope TEXT
      )
    `).run().then(() => db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_change_log_ws_seq ON change_log (workspace_id, seq)',
    ).run()).then(() => db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_change_log_ws_changed ON change_log (workspace_id, changed_at)',
    ).run()));
}

/**
 * The change_log insert that a mutation handler appends to its D1 batch, so
 * the business write and the change record commit atomically.
 * `scope` is a JSON array of user ids entitled to the row (conversation
 * participants for chat rows, the employee for attendance rows) or null for
 * team-wide rows.
 */
export function changeLogStmt(
  db: D1Database, env: Env, entity: string, entityId: string,
  op: 'put' | 'delete', options?: { scope?: string[] | null; actorId?: string },
): D1PreparedStatement {
  const scope = options?.scope === undefined ? null : JSON.stringify(options.scope);
  return db.prepare(
    'INSERT INTO change_log (workspace_id, entity, entity_id, op, changed_at, actor_id, scope) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(workspaceId(env), entity, entityId, op, Date.now(), options?.actorId ?? '', scope);
}

/** Mark several ids changed at once (same shape as changeLogStmt). */
export function changeLogStmts(
  db: D1Database, env: Env, entity: string, ids: string[],
  op: 'put' | 'delete', options?: { scope?: string[] | null; actorId?: string },
): D1PreparedStatement[] {
  return ids.map(id => changeLogStmt(db, env, entity, id, op, options));
}

export type AckStatus = 'delivered' | 'read';

/** Only forward receipt statuses are accepted from clients. */
export function ackStatus(value: unknown): AckStatus | null {
  return value === 'read' || value === 'delivered' ? value : null;
}

interface StatusUpgradeOptions {
  actorId: string;
  /** Only upgrade rows in this conversation (hub acks name one conversation). */
  conversationId?: string;
  /** Only upgrade rows in conversations this user participates in. */
  memberId?: string;
  /**
   * An admin: any conversation, except private rooms this admin is not in.
   * (Callers pass memberId or adminId; the SQL needs the is_private column.)
   */
  adminId?: string;
}

/**
 * A forward-only receipt upgrade (sent -> delivered -> read) and its
 * change_log row, as a statement PAIR for one D1 batch. The insert is gated
 * on `changes() > 0` of the preceding UPDATE, so both commit together and a
 * repeated ack writes nothing and announces nothing (no feedback loops).
 * Chat rows copy the conversation's participant_ids as the change scope.
 * The UPDATE returns `id` (+ `conversation_id` for chat) for changed rows.
 */
export function statusUpgradeStmts(
  db: D1Database, env: Env, table: 'messages' | 'inquiry_messages',
  id: string, status: AckStatus, options: StatusUpgradeOptions,
): [D1PreparedStatement, D1PreparedStatement] {
  const isChat = table === 'messages';
  const guard = status === 'read' ? "IFNULL(status, 'sent') != 'read'" : "IFNULL(status, 'sent') = 'sent'";
  let where = `id = ? AND ${guard}`;
  const binds: string[] = [status, id];
  if (isChat && options.conversationId !== undefined) {
    where += ' AND conversation_id = ?';
    binds.push(options.conversationId);
  }
  if (isChat && options.memberId !== undefined) {
    where += ' AND EXISTS (SELECT 1 FROM conversations c, json_each(c.participant_ids) p' +
      ' WHERE c.id = messages.conversation_id AND p.value = ?)';
    binds.push(options.memberId);
  }
  if (isChat && options.adminId !== undefined) {
    where += ' AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = messages.conversation_id' +
      ' AND (IFNULL(c.is_private, 0) = 0 OR EXISTS (SELECT 1 FROM json_each(c.participant_ids) p WHERE p.value = ?)))';
    binds.push(options.adminId);
  }
  const update = db.prepare(
    `UPDATE ${table} SET status = ? WHERE ${where} RETURNING id${isChat ? ', conversation_id' : ''}`,
  ).bind(...binds);
  // A private room's scope carries the private marker (privateRooms.ts).
  const scopeExpr = isChat
    ? `(SELECT ${CONVERSATION_SCOPE_SQL} FROM conversations c WHERE c.id = t.conversation_id)`
    : 'NULL';
  const log = db.prepare(
    'INSERT INTO change_log (workspace_id, entity, entity_id, op, changed_at, actor_id, scope) ' +
    `SELECT ?, ?, t.id, 'put', ?, ?, ${scopeExpr} FROM ${table} t WHERE t.id = ? AND changes() > 0`,
  ).bind(workspaceId(env), isChat ? 'message' : 'inquiry_message', Date.now(), options.actorId, id);
  return [update, log];
}

/**
 * Fire-and-forget notification to the hub AFTER the change has committed. A
 * failed notification never loses data: the change_log row is already
 * committed and clients recover through /api/sync.
 */
export function queueHubNotify(ctx: Ctx, events: ChangeEvent[]): void {
  if (!realtimeEnabled(ctx.env) || events.length === 0) return;
  ctx.execCtx.waitUntil((async () => {
    try {
      const stub = ctx.env.SYNC_HUB!.get(ctx.env.SYNC_HUB!.idFromName(workspaceId(ctx.env)));
      await stub.fetch('https://hub.internal/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-hub-key': rawRealtimeSecret(ctx.env) },
        body: JSON.stringify({ events }),
      });
    } catch {
      /* clients recover through sync — never break the request for a signal */
    }
  })());
}

// ── Retention ───────────────────────────────────────────────────────────────

/** How long change rows are kept; older cursors get `resyncRequired`. */
export const CHANGE_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
let lastPruneAt = 0;

/**
 * Delete change rows older than the retention window. The newest row is always
 * kept so MAX(seq) — the boundary every cursor is measured against — never
 * drops back to empty (an empty log would make every cursor look expired).
 */
export async function pruneChangeLog(env: Env, now = Date.now()): Promise<number> {
  const ws = workspaceId(env);
  const res = await env.VAYU_DB.prepare(
    'DELETE FROM change_log WHERE workspace_id = ? AND changed_at < ? ' +
    'AND seq < (SELECT MAX(seq) FROM change_log WHERE workspace_id = ?)',
  ).bind(ws, now - CHANGE_LOG_RETENTION_MS, ws).run();
  return res.meta?.changes ?? 0;
}

/** Opportunistic, per-isolate-throttled pruning off the request path. */
function maybePrune(ctx: Ctx): void {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  ctx.execCtx.waitUntil(pruneChangeLog(ctx.env, now).catch(e => {
    console.error('change_log prune failed:', e);
  }));
}

// ── Sync endpoint ───────────────────────────────────────────────────────────

const MAX_PAGE = 500;
const DEFAULT_PAGE = 200;

const ENTITY_TABLES: Record<SyncEntity, string> = {
  artwork: 'artworks',
  collection: 'collections',
  catalog: 'catalogs',
  contact: 'contacts',
  inquiry: 'inquiries',
  inquiry_message: 'inquiry_messages',
  invoice: 'invoices',
  event: 'events',
  message: 'messages',
  conversation: 'conversations',
  attendance: 'attendance',
  store: 'stores',
};

type RowMapper = (row: Record<string, unknown>) => unknown;
const ENTITY_MAPPERS: Record<SyncEntity, RowMapper> = {
  artwork: rowToArtwork,
  collection: rowToCollection,
  catalog: rowToCatalog,
  contact: rowToContact,
  inquiry: rowToInquiry,
  inquiry_message: rowToInquiryMessage,
  invoice: rowToInvoice,
  event: rowToEvent,
  message: rowToMessage,
  conversation: rowToConversation,
  attendance: rowToAttendance,
  store: rowToStore,
};

/** Entities whose rows are only visible to a scope of users. */
const SCOPED_ENTITIES: ReadonlySet<string> = new Set(['message', 'conversation', 'attendance']);

interface ChangeRow {
  seq: number;
  entity: string;
  entity_id: string;
  op: string;
  scope: string | null;
}

interface SyncChange {
  seq: number;
  entity: string;
  id: string;
  op: 'put' | 'delete';
  record?: unknown;
}

/**
 * GET /api/sync
 *   ?cursor=N&limit=M          incremental page since cursor N
 *   ?snapshot=<entity>&after_id=X&cursor=S[&limit=M]
 *                              paginated initial snapshot of one dataset;
 *                              cursor echoes the S from the first page
 * A `resync_required` answer means the client's cursor predates the retained
 * log and it must run a fresh snapshot.
 */
export async function handleSync(ctx: Ctx): Promise<Response> {
  const session = await getSessionOf(ctx);
  if (!session) return err('Unauthorized', 401);
  if (!flagEnabled(ctx.env.DELTA_SYNC_ENABLED)) return err('Not found', 404);
  const db = ctx.env.VAYU_DB;
  await ensureChangeLogTable(db);
  maybePrune(ctx);

  const params = ctx.url.searchParams;
  const limit = Math.min(Math.max(Number.parseInt(params.get('limit') || String(DEFAULT_PAGE), 10) || DEFAULT_PAGE, 1), MAX_PAGE);
  const isAdmin = session.role === ADMIN_ROLE_ID;

  const snapshotEntity = params.get('snapshot');
  if (snapshotEntity) {
    return snapshot(ctx, session, snapshotEntity, params, limit, isAdmin);
  }

  const rawCursor = params.get('cursor');
  if (rawCursor === null || rawCursor === '') {
    // No cursor yet: hand back the boundary and let the client take a full
    // copy. 0 is a valid boundary (empty log), so it is not reused as the
    // "no cursor" marker.
    const maxSeq = await maxSeqOf(ctx);
    return json({ mode: 'boundary', cursor: maxSeq, hasMore: false, changes: [] });
  }
  const cursor = Number(rawCursor);
  if (!Number.isSafeInteger(cursor) || cursor < 0) return err('cursor must be a non-negative integer');

  const bounds = await seqBounds(ctx);
  const maxSeq = bounds.maxSeq ?? 0;
  if (cursorExpired(cursor, bounds)) {
    return json({ resyncRequired: true, cursor: maxSeq, changes: [] });
  }

  const page = await db.prepare(
    'SELECT seq, entity, entity_id, op, scope FROM change_log WHERE workspace_id = ? AND seq > ? ORDER BY seq LIMIT ?',
  ).bind(workspaceId(ctx.env), cursor, limit).all<Record<string, unknown>>();
  addD1Usage(ctx.request, page.meta?.rows_read ?? 0, 0);
  const rows = (page.results || []) as unknown as ChangeRow[];

  const readable = await readableEntitiesFor(ctx, session);
  const visible = rows.filter(row =>
    readable.has(row.entity as SyncEntity) &&
    (!SCOPED_ENTITIES.has(row.entity) || scopeAllows(row.scope, session.userId, isAdmin)));

  const changes = await attachRecords(ctx, visible);
  const lastSeq = rows.length > 0 ? rows[rows.length - 1].seq : cursor;
  return json({
    mode: 'incremental',
    cursor: lastSeq,
    hasMore: rows.length === limit,
    changes,
  });
}

// ── Snapshot mode ───────────────────────────────────────────────────────────

async function snapshot(
  ctx: Ctx, session: SessionData, entityName: string,
  params: URLSearchParams, limit: number, isAdmin: boolean,
): Promise<Response> {
  if (!(Object.keys(ENTITY_TABLES) as string[]).includes(entityName)) {
    return err(`Unknown dataset "${entityName}"`, 400);
  }
  const entity = entityName as SyncEntity;
  const readable = await readableEntitiesFor(ctx, session);
  if (!readable.has(entity)) return err("Your role doesn't have access to this dataset", 403);

  // The snapshot cursor is chosen by the FIRST page; later pages echo it so
  // the trailing incremental pass starts from a stable boundary.
  const rawCursor = params.get('cursor');
  const cursor = rawCursor === null || rawCursor === '' ? await maxSeqOf(ctx) : Number(rawCursor);
  if (!Number.isSafeInteger(cursor) || cursor < 0) return err('cursor must be a non-negative integer');
  const afterId = params.get('after_id') ?? '';
  const table = ENTITY_TABLES[entity];

  // Keyset pagination on id. Rows committed during the snapshot have
  // change_log rows with seq > the cursor, so the final incremental pass
  // catches anything a concurrent write moved out from under an earlier page.
  let sql = `SELECT * FROM ${table} WHERE id > ? ORDER BY id LIMIT ?`;
  const binds: (string | number)[] = [afterId, limit + 1];

  const ownAttendance = entity === 'attendance' && !isAdmin && !await canManageAttendance(ctx, session);
  if (entity === 'attendance' && ownAttendance) {
    sql = `SELECT * FROM ${table} WHERE id > ? AND employee_id = ? ORDER BY id LIMIT ?`;
    binds.splice(1, 0, session.userId);
  }

  const result = await ctx.env.VAYU_DB.prepare(sql).bind(...binds).all<Record<string, unknown>>();
  addD1Usage(ctx.request, result.meta?.rows_read ?? 0, 0);
  let rows = (result.results || []) as Record<string, unknown>[];
  const hasMore = rows.length > limit;
  rows = rows.slice(0, limit);
  const after = rows.length > 0 ? String(rows[rows.length - 1].id) : afterId;

  // Visibility filtering. afterId always advances past every raw row so a
  // filtered row can't stall the pagination.
  const map = ENTITY_MAPPERS[entity];
  const records: unknown[] = [];
  if (entity === 'conversation') {
    for (const row of rows) {
      if (mayUseConversation(session.userId, isAdmin, roomAccessOf(row))) records.push(map(row));
    }
  } else if (entity === 'message') {
    const rooms = await conversationMemberships(ctx, rows.map(r => String(r.conversation_id)));
    for (const row of rows) {
      const room = rooms.get(String(row.conversation_id));
      if (room && mayUseConversation(session.userId, isAdmin, room)) records.push(map(row));
    }
  } else if (entity === 'attendance' && ownAttendance) {
    for (const row of rows) records.push(map(row)); // already filtered in SQL
  } else {
    for (const row of rows) records.push(map(row));
  }

  return json({ mode: 'snapshot', entity, cursor, records, hasMore, afterId: after });
}

/** Members and privacy for a set of conversations, in one query per chunk. */
async function conversationMemberships(ctx: Ctx, conversationIds: string[]): Promise<Map<string, RoomAccess>> {
  const map = new Map<string, RoomAccess>();
  const unique = [...new Set(conversationIds)].filter(Boolean);
  if (unique.length === 0) return map;
  for (const chunk of chunks(unique, MAX_BOUND_PARAMS)) {
    // SELECT *: works whether or not the private-room columns exist yet.
    const res = await ctx.env.VAYU_DB.prepare(
      `SELECT * FROM conversations WHERE id IN (${chunk.map(() => '?').join(',')})`,
    ).bind(...chunk).all<Record<string, unknown>>();
    addD1Usage(ctx.request, res.meta?.rows_read ?? 0, 0);
    for (const row of res.results || []) map.set(String(row.id), roomAccessOf(row));
  }
  return map;
}

// ── Shared helpers ──────────────────────────────────────────────────────────

/** D1 caps bound parameters per statement at 100; IN lists stay below it. */
const MAX_BOUND_PARAMS = 90;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * A cursor is unusable when rows it still needs were pruned, or when it is
 * ahead of the log (database reset, or WORKSPACE_ID changed) — either way the
 * client must take a fresh full copy.
 */
export function cursorExpired(cursor: number, bounds: { minSeq: number | null; maxSeq: number | null }): boolean {
  if (bounds.maxSeq === null) return cursor > 0;
  if (cursor > bounds.maxSeq) return true;
  return bounds.minSeq !== null && cursor + 1 < bounds.minSeq;
}

async function seqBounds(ctx: Ctx): Promise<{ minSeq: number | null; maxSeq: number | null }> {
  const res = await ctx.env.VAYU_DB.prepare(
    'SELECT MIN(seq) AS minSeq, MAX(seq) AS maxSeq FROM change_log WHERE workspace_id = ?',
  ).bind(workspaceId(ctx.env)).first<{ minSeq: number | null; maxSeq: number | null }>();
  addD1Usage(ctx.request, 1, 0);
  return { minSeq: res?.minSeq ?? null, maxSeq: res?.maxSeq ?? null };
}

async function maxSeqOf(ctx: Ctx): Promise<number> {
  return (await seqBounds(ctx)).maxSeq ?? 0;
}

async function readableEntitiesFor(ctx: Ctx, session: SessionData): Promise<Set<SyncEntity>> {
  const roles = await getRoles(ctx.env.VAYU_KV);
  return readableEntities(permissionsForRoles(roles, session.role));
}

async function canManageAttendance(ctx: Ctx, session: SessionData): Promise<boolean> {
  const roles = await getRoles(ctx.env.VAYU_KV);
  return atLeast(permissionsForRoles(roles, session.role)['attendance'], 'edit');
}

/**
 * Attach the current record to each put change. Rows whose record has since
 * disappeared degrade to tombstones, so a client never sees a put for a row
 * that no longer exists.
 */
async function attachRecords(ctx: Ctx, rows: ChangeRow[]): Promise<SyncChange[]> {
  const putRows = rows.filter(row => row.op === 'put');
  const idsByEntity = new Map<string, string[]>();
  for (const row of putRows) {
    if (!idsByEntity.has(row.entity)) idsByEntity.set(row.entity, []);
    idsByEntity.get(row.entity)!.push(row.entity_id);
  }

  const records = new Map<string, unknown>();
  for (const [entity, ids] of idsByEntity) {
    if (!(entity in ENTITY_TABLES)) continue;
    const table = ENTITY_TABLES[entity as SyncEntity];
    const map = ENTITY_MAPPERS[entity as SyncEntity];
    for (const chunk of chunks([...new Set(ids)], MAX_BOUND_PARAMS)) {
      const res = await ctx.env.VAYU_DB.prepare(
        `SELECT * FROM ${table} WHERE id IN (${chunk.map(() => '?').join(',')})`,
      ).bind(...chunk).all<Record<string, unknown>>();
      addD1Usage(ctx.request, res.meta?.rows_read ?? 0, 0);
      for (const row of res.results || []) records.set(`${entity}|${String(row.id)}`, map(row));
    }
  }

  return rows.map(row => {
    const change: SyncChange = { seq: row.seq, entity: row.entity, id: row.entity_id, op: row.op === 'delete' ? 'delete' : 'put' };
    if (change.op === 'put') {
      const record = records.get(`${change.entity}|${change.id}`);
      if (record === undefined) change.op = 'delete'; // deleted after being logged
      else change.record = record;
    }
    return change;
  });
}

async function getSessionOf(ctx: Ctx): Promise<SessionData | null> {
  return getSession(ctx.request, ctx.env.VAYU_KV);
}
