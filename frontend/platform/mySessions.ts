// The signed-in person's own devices (platform sign-in): the Signed-in devices
// card in the app's Profile.
//
// Better Auth's list-sessions endpoint demands a sign-in newer than freshAge
// (30 minutes, set for control-centre actions), so the card went empty half an
// hour after signing in. Seeing and signing out your own devices only needs a
// valid session. Tokens never leave the server: devices are named by session id.

import type { PlatformAuth } from './auth';
import { auditStmt } from './audit';
import { OrgAccessError } from './orgApi';

export interface MySession {
  id: string;
  userAgent: string | null;
  createdAt: number;
  lastUsedAt: number;
  current: boolean;
}

async function currentSession(auth: PlatformAuth, request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new OrgAccessError(401, 'unauthenticated', 'Sign in first.');
  return session;
}

/** D1 keeps Better Auth's dates as ISO text; tolerate epoch numbers too. */
function toMs(value: unknown): number {
  if (typeof value === 'number') return value;
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : 0;
}

export async function listMySessions(db: D1Database, auth: PlatformAuth, request: Request): Promise<MySession[]> {
  const { session, user } = await currentSession(auth, request);
  const { results } = await db.prepare(
    `SELECT id, userAgent, createdAt, updatedAt FROM session
     WHERE userId = ? AND expiresAt > ? ORDER BY updatedAt DESC LIMIT 50`,
  ).bind(user.id, new Date().toISOString()).all<{ id: string; userAgent: string | null; createdAt: unknown; updatedAt: unknown }>();
  return results.map(r => ({
    id: r.id,
    userAgent: r.userAgent,
    createdAt: toMs(r.createdAt),
    lastUsedAt: toMs(r.updatedAt),
    current: r.id === session.id,
  }));
}

/**
 * Sign out one of your other devices (`id`), or all of them (no id). The
 * device asking is never signed out here; that is the ordinary sign-out.
 */
export async function signOutMySessions(db: D1Database, auth: PlatformAuth, request: Request, id?: string): Promise<number> {
  const { session, user } = await currentSession(auth, request);
  const remove = id
    ? db.prepare('DELETE FROM session WHERE id = ? AND userId = ? AND id <> ?').bind(id, user.id, session.id)
    : db.prepare('DELETE FROM session WHERE userId = ? AND id <> ?').bind(user.id, session.id);
  const [result] = await db.batch([
    remove,
    auditStmt(db, {
      actorUserId: user.id, actorKind: 'user', action: id ? 'user.session.revoke' : 'user.sessions.revoke_others',
      targetType: 'user', targetId: user.id, ip: request.headers.get('CF-Connecting-IP'),
    }),
  ]);
  return result?.meta?.changes ?? 0;
}
