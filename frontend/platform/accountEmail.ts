// Changing the email address an account signs in with.
//
// Two ways:
//  - Yourself (Profile → Email, in the app and the control centre): Better
//    Auth's change-email flow (auth.ts). With a confirmed address it takes
//    two links: one to the current address to approve, then one to the new
//    address to confirm it. It needs a recent sign-in.
//  - A provider admin, for someone who has lost the old mailbox (control
//    centre → Accounts). The new address starts unconfirmed and the account is
//    signed out everywhere, so it signs in again with the new address.
//
// Either way both addresses are told, and the change is audited. The app's own
// copy of the address (its per-organization user record) follows on the
// person's next request (ensureAppUser in orgApp.ts).

import { auditStmt } from './audit';
import { outboxStmt } from './notify';
import { OrgError, type Actor } from './orgs';

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** The notices and audit entry for a completed change. */
function changedStatements(db: D1Database, c: { userId: string; from: string; to: string; actorUserId: string; actorKind: 'user' | 'provider_admin'; ip: string | null }): D1PreparedStatement[] {
  const byAdmin = c.actorKind === 'provider_admin';
  const when = Date.now();
  return [
    auditStmt(db, {
      actorUserId: c.actorUserId, actorKind: c.actorKind, action: 'user.email.change', targetType: 'user', targetId: c.userId,
      details: { from: c.from, to: c.to }, ip: c.ip,
    }),
    // The old address is told, so a change nobody asked for is noticed.
    outboxStmt(db, {
      dedupeKey: `user:${c.userId}:email:${when}:old`, kind: 'account_email_changed', recipient: c.from,
      subject: 'Your sign-in email was changed',
      body: `${byAdmin ? 'Our support team changed' : 'You changed'} the email address for your account from ${c.from} to ${c.to}. From now on, sign in with ${c.to}. If you did not ask for this, reply to this email straight away.`,
    }),
    outboxStmt(db, {
      dedupeKey: `user:${c.userId}:email:${when}:new`, kind: 'account_email_changed', recipient: c.to,
      subject: 'Your sign-in email is now this address',
      body: `Your account now signs in with ${c.to} (it was ${c.from}). Your password stays the same.`,
    }),
  ];
}

/**
 * After Better Auth's verify-email link finished a change: the old address,
 * read from the link's token. Better Auth verified the token before updating
 * the account, so only its payload is read here.
 */
export function emailChangeFromLink(context: { path?: string; query?: Record<string, unknown> } | null): { from: string; to: string } | null {
  if (!context || !context.path?.endsWith('/verify-email')) return null;
  const token = context.query?.token;
  if (typeof token !== 'string') return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { email?: unknown; updateTo?: unknown; requestType?: unknown };
    if (payload.requestType !== 'change-email-verification') return null;
    if (typeof payload.email !== 'string' || typeof payload.updateTo !== 'string') return null;
    return { from: payload.email.toLowerCase(), to: payload.updateTo.toLowerCase() };
  } catch {
    return null;
  }
}

/** Audits a change someone made themselves and tells both addresses. */
export async function recordOwnEmailChange(db: D1Database, userId: string, change: { from: string; to: string }, ip: string | null): Promise<void> {
  await db.batch(changedStatements(db, { userId, ...change, actorUserId: userId, actorKind: 'user', ip }));
}

/**
 * Accounts that are provider administrators can only be changed by an owner
 * (or by themselves): otherwise a support admin could take over an owner's
 * account by resetting its password or email.
 */
export async function guardAccountTarget(db: D1Database, targetId: string, actor: Actor & { role: string }): Promise<void> {
  if (targetId === actor.userId || actor.role === 'owner') return;
  const admin = await db.prepare("SELECT role FROM provider_admins WHERE user_id = ? AND status = 'active'").bind(targetId).first();
  if (admin) throw new OrgError(403, 'owner_only', 'Only a platform owner can change another administrator’s account.');
}

/** A provider admin changes an account's sign-in email. */
export async function adminChangeEmail(db: D1Database, userId: string, body: Record<string, unknown>, actor: Actor & { role: string }) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email) || email.length > 254) throw new OrgError(400, 'invalid', 'Enter a valid email address.');
  if (userId === actor.userId) throw new OrgError(409, 'self', 'Change your own email from your Profile: it confirms both addresses.');
  await guardAccountTarget(db, userId, actor);
  const user = await db.prepare('SELECT email FROM "user" WHERE id = ?').bind(userId).first<{ email: string }>();
  if (!user) throw new OrgError(404, 'not_found', 'Account not found.');
  if (user.email === email) throw new OrgError(400, 'same', 'That is already the account’s email.');
  if (await db.prepare('SELECT 1 FROM "user" WHERE email = ?').bind(email).first()) {
    throw new OrgError(409, 'email_taken', 'Another account already uses that email.');
  }
  await db.batch([
    // Unconfirmed until its owner uses it; signed out so the next sign-in uses it.
    db.prepare('UPDATE "user" SET email = ?, emailVerified = 0, updatedAt = ? WHERE id = ?').bind(email, new Date().toISOString(), userId),
    db.prepare('DELETE FROM session WHERE userId = ?').bind(userId),
    ...changedStatements(db, { userId, from: user.email, to: email, actorUserId: actor.userId, actorKind: 'provider_admin', ip: actor.ip }),
  ]);
  return { email };
}
