// Per-person read receipts and reactions on chat messages.
//
// Both live on the message row as JSON maps keyed by user id:
//   read_by    { userId: readAt }   who has seen it, and when
//   reactions  { userId: emoji }    one reaction per person, as on WhatsApp
// Each change is one UPDATE with SQLite's JSON functions, so two people
// reacting at the same moment never overwrite each other. Every UPDATE is
// paired with a change_log row gated on `changes() > 0` (the same pattern as
// deltaSync's statusUpgradeStmts): a repeated read or the same reaction again
// writes nothing and announces nothing.

import { CONVERSATION_SCOPE_SQL } from './privateRooms';
import { runSetupOnce } from './rows';
import { workspaceId, type Env } from './workerEnv';

/** User ids are server-made; anything else is never used inside a JSON path. */
const SAFE_ID = /^[A-Za-z0-9_.:@-]{1,128}$/;

/** The JSON path of one person's entry, or null for an id that can't be one. */
export function userPath(userId: string): string | null {
  return SAFE_ID.test(userId) ? `$."${userId}"` : null;
}

/** Adds read_by and reactions to an older messages table, once per database. */
export function ensureMessageColumns(db: D1Database): Promise<void> {
  return runSetupOnce(db, 'columns:messages:receipts', async () => {
    const { results } = await db.prepare('PRAGMA table_info(messages)').all<{ name: string }>();
    const existing = new Set(results.map(c => c.name));
    for (const column of ['read_by', 'reactions']) {
      if (existing.has(column)) continue;
      try {
        await db.prepare(`ALTER TABLE messages ADD COLUMN ${column} TEXT`).run();
      } catch (e) {
        // Another isolate may have added it at the same moment.
        if (!/duplicate column/i.test((e as Error).message)) throw e;
      }
    }
  });
}

/** The change_log row for a message, written only if the UPDATE before it changed something. */
function changeLogIfChanged(db: D1Database, env: Env, id: string, actorId: string): D1PreparedStatement {
  return db.prepare(
    'INSERT INTO change_log (workspace_id, entity, entity_id, op, changed_at, actor_id, scope) ' +
    `SELECT ?, 'message', t.id, 'put', ?, ?, (SELECT ${CONVERSATION_SCOPE_SQL} FROM conversations c WHERE c.id = t.conversation_id) ` +
    'FROM messages t WHERE t.id = ? AND changes() > 0',
  ).bind(workspaceId(env), Date.now(), actorId, id);
}

/**
 * "This member has read this message": records who and when (first time
 * only) and moves the message's own status to read. Only someone in the
 * conversation counts, never its sender, and never an admin looking in from
 * outside. With `conversationId`, only messages of that conversation.
 * The UPDATE returns `id, conversation_id` when it changed the row.
 */
export function readReceiptStmts(
  db: D1Database, env: Env, id: string, userId: string, conversationId?: string,
): [D1PreparedStatement, D1PreparedStatement] | null {
  const path = userPath(userId);
  if (!path) return null;
  let where = "id = ? AND sender_id != ? AND json_extract(IFNULL(read_by, '{}'), ?) IS NULL" +
    ' AND EXISTS (SELECT 1 FROM conversations c, json_each(c.participant_ids) p WHERE c.id = messages.conversation_id AND p.value = ?)';
  const binds: (string | number)[] = [path, Date.now(), id, userId, path, userId];
  if (conversationId !== undefined) {
    where += ' AND conversation_id = ?';
    binds.push(conversationId);
  }
  const update = db.prepare(
    `UPDATE messages SET read_by = json_insert(IFNULL(read_by, '{}'), ?, ?), status = 'read' WHERE ${where} RETURNING id, conversation_id`,
  ).bind(...binds);
  return [update, changeLogIfChanged(db, env, id, userId)];
}

/**
 * Sets this person's reaction (replacing any earlier one), or removes it
 * when `emoji` is null. The caller checks they are in the conversation.
 * The UPDATE returns `id, conversation_id` when it changed the row.
 */
export function reactionStmts(
  db: D1Database, env: Env, id: string, userId: string, emoji: string | null,
): [D1PreparedStatement, D1PreparedStatement] | null {
  const path = userPath(userId);
  if (!path) return null;
  const update = emoji === null
    ? db.prepare(
      "UPDATE messages SET reactions = json_remove(IFNULL(reactions, '{}'), ?) " +
      "WHERE id = ? AND json_extract(IFNULL(reactions, '{}'), ?) IS NOT NULL RETURNING id, conversation_id",
    ).bind(path, id, path)
    : db.prepare(
      "UPDATE messages SET reactions = json_set(IFNULL(reactions, '{}'), ?, ?) " +
      "WHERE id = ? AND json_extract(IFNULL(reactions, '{}'), ?) IS NOT ? RETURNING id, conversation_id",
    ).bind(path, emoji, id, path, emoji);
  return [update, changeLogIfChanged(db, env, id, userId)];
}
