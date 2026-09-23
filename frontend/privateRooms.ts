// Private rooms: closed group conversations.
//
// A private room is a group conversation (is_private = 1) that only its
// members can see. Unlike ordinary chats, admins who are not members get no
// access at all: not in the "all conversations" view, not through delta sync,
// not through the realtime hub, not in the deleted-items archive.
//
// Who may do what:
//   create               admins
//   rename, add/remove   the room's creator, or an admin who is a member
//   delete               the same
//   read, send, receipts members only
//
// Shared by the Worker (worker.ts, deltaSync.ts) and the SyncHub Durable
// Object (realtime.ts), so it imports nothing from either.

/**
 * Marker appended to a private room's change-log scope. A scope containing it
 * is visible only to the ids listed, even to admins (scopeAllows). It can
 * never be a user id: those are generated as `user_…` / `admin_…`.
 */
export const PRIVATE_SCOPE = '!private';

/** The change-log scope for a conversation's rows. */
export function conversationScope(participantIds: string[], isPrivate: boolean): string[] {
  return isPrivate ? [...participantIds, PRIVATE_SCOPE] : participantIds;
}

/**
 * SQL for a conversation's change-log scope, given a `conversations` row
 * aliased `c`. Needs the is_private column (ensurePrivateRoomColumns).
 */
export const CONVERSATION_SCOPE_SQL =
  `CASE WHEN IFNULL(c.is_private, 0) = 1 THEN json_insert(c.participant_ids, '$[#]', '${PRIVATE_SCOPE}') ELSE c.participant_ids END`;

export interface RoomAccess {
  members: string[];
  isPrivate: boolean;
  createdBy: string | null;
}

/** Reads the access fields from a `SELECT *` conversations row (columns may be missing on old rows). */
export function roomAccessOf(row: Record<string, unknown>): RoomAccess {
  let members: string[] = [];
  try {
    const ids: unknown = JSON.parse(String(row.participant_ids ?? '[]'));
    if (Array.isArray(ids)) members = ids.map(String);
  } catch { /* malformed row: no members */ }
  return {
    members,
    isPrivate: Number(row.is_private ?? 0) === 1,
    createdBy: row.created_by ? String(row.created_by) : null,
  };
}

/** May this person read and write the conversation? Admins may use any conversation except a private room they are not in. */
export function mayUseConversation(userId: string, isAdmin: boolean, room: RoomAccess): boolean {
  if (room.members.includes(userId)) return true;
  return isAdmin && !room.isPrivate;
}

/** May this person rename the room, change its members or delete it? */
export function mayManageRoom(userId: string, isAdmin: boolean, room: RoomAccess): boolean {
  if (!room.isPrivate) return mayUseConversation(userId, isAdmin, room);
  return room.createdBy === userId || (isAdmin && room.members.includes(userId));
}

// ── Schema ────────────────────────────────────────────────────────────────

/**
 * Adds is_private and created_by to conversations when missing. Remembered
 * per isolate as a plain flag once done: never a shared promise, because on
 * Workers a request must not wait on another request's unfinished work.
 */
let columnsReady = false;

export async function ensurePrivateRoomColumns(db: D1Database): Promise<void> {
  if (columnsReady) return;
  const { results } = await db.prepare('PRAGMA table_info(conversations)').all<{ name: string }>();
  const existing = new Set(results.map(c => c.name));
  for (const [column, definition] of [['is_private', 'INTEGER DEFAULT 0'], ['created_by', 'TEXT']] as const) {
    if (existing.has(column)) continue;
    try {
      await db.prepare(`ALTER TABLE conversations ADD COLUMN ${column} ${definition}`).run();
    } catch (e) {
      // Another isolate may have added it at the same moment.
      if (!/duplicate column/i.test((e as Error).message)) throw e;
    }
  }
  columnsReady = true;
}
