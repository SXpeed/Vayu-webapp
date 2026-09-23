// Invitations: how an organization's owner or admins bring people in.
//
// An admin invites an email address with a role. The person gets an email
// with a link (app address /join/<token>); opening it, they sign in (email or
// Google) or create an account, and join. Properties:
//
//  - The token is 32 random bytes; only its SHA-256 hash is stored.
//  - Single use, expires after 7 days, and tied to one email address: it
//    can only be accepted by an account with that address.
//  - One open invitation per address per organization; inviting again
//    replaces it (the old link stops working).
//  - A pending invitation doesn't hold a seat: the plan's member limit is
//    checked when it is accepted, in the same statement that adds the member.
//  - Accepting through the link proves the person reads that inbox, so the
//    account's email counts as confirmed.
//  - Creating an account through an invitation works even while public
//    sign-up is closed: the invitation is the permission.

import { hashPassword } from 'better-auth/crypto';
import { APP_NAME } from '../brand';
import { defaultAppRole, ensureAppUser, orgStorageEnv, type AppStorage, type MemberRole } from '../orgApp';
import type { Env } from '../workerEnv';
import { auditStmt } from './audit';
import { sendEmail } from './email';
import { OrgError } from './orgs';
import { insertMemberWithinSeatLimit, limitOf, resolveEntitlements, seatUsage } from './plans';

export const INVITATION_DAYS = 7;
// Each part excludes the separators around it, so matching never backtracks.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

interface InvitationRow {
  id: string; org_id: string; email: string; role: MemberRole; app_role: string; status: string;
  invited_by: string; created_at: number; expires_at: number; accepted_at: number | null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function newToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
}

const TOKEN_RE = /^[0-9a-f]{64}$/;

/** Admins' own view: who is invited, and when it runs out. */
export async function listInvitations(db: D1Database, orgId: string) {
  const { results } = await db.prepare(
    `SELECT i.id, i.email, i.role, i.app_role, i.status, i.created_at, i.expires_at, i.accepted_at, u.name AS invited_by_name
     FROM invitations i LEFT JOIN "user" u ON u.id = i.invited_by
     WHERE i.org_id = ? AND (i.status = 'pending' OR i.created_at > ?)
     ORDER BY i.created_at DESC LIMIT 100`,
  ).bind(orgId, Date.now() - 30 * 86_400_000).all<InvitationRow & { invited_by_name: string | null }>();
  const now = Date.now();
  return results.map(r => ({
    id: r.id, email: r.email, appRole: r.app_role, invitedBy: r.invited_by_name, createdAt: r.created_at, expiresAt: r.expires_at,
    status: r.status === 'pending' && r.expires_at <= now ? 'expired' : r.status,
  }));
}

export interface InviteInput {
  orgId: string;
  email: unknown;
  appRole: string;
  /** Platform account of the admin sending it. */
  invitedBy: string;
  inviterName: string;
  /** Where the app is served, for the link (the page the admin is on). */
  appOrigin: string;
}

export async function createInvitation(env: Env, db: D1Database, input: InviteInput) {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email) || email.length > 254) throw new OrgError(400, 'invalid', 'Enter a valid email address.');

  const org = await db.prepare('SELECT name, status FROM organizations WHERE id = ?').bind(input.orgId).first<{ name: string; status: string }>();
  if (!org || org.status !== 'active') throw new OrgError(409, 'org_not_active', 'This workspace is not active.');
  const member = await db.prepare(
    `SELECT 1 FROM memberships m JOIN "user" u ON u.id = m.user_id WHERE m.org_id = ? AND u.email = ? AND m.status = 'active'`,
  ).bind(input.orgId, email).first();
  if (member) throw new OrgError(409, 'already_member', 'That person is already in the team.');
  const seats = await seatUsage(db, input.orgId);
  if (seats.limit !== null && seats.used >= seats.limit) {
    throw new OrgError(409, 'seat_limit', `Your plan allows ${seats.limit} ${seats.limit === 1 ? 'person' : 'people'} and the team is full. Remove someone first, or ask us about a bigger plan.`);
  }

  const token = newToken();
  const id = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + INVITATION_DAYS * 86_400_000;
  const role: MemberRole = input.appRole === 'admin' ? 'admin' : 'staff';
  await db.batch([
    // Inviting again replaces the open invitation: its link stops working.
    db.prepare("UPDATE invitations SET status = 'revoked' WHERE org_id = ? AND email = ? AND status = 'pending'").bind(input.orgId, email),
    db.prepare(
      `INSERT INTO invitations (id, org_id, email, role, app_role, token_hash, status, invited_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ).bind(id, input.orgId, email, role, input.appRole, await sha256Hex(token), input.invitedBy, now, expiresAt),
    auditStmt(db, { actorUserId: input.invitedBy, actorKind: 'user', action: 'invitation.create', targetType: 'invitation', targetId: id, orgId: input.orgId, details: { email, appRole: input.appRole } }),
  ]);

  const link = `${input.appOrigin}/join/${token}`;
  const sent = await sendEmail(env, email, `Join ${org.name} on ${APP_NAME}`, {
    heading: `Join ${org.name}`,
    paragraphs: [
      `${input.inviterName} invited you to work in ${org.name} on ${APP_NAME}: the inventory, catalogs, clients and messages the team shares.`,
      'Open the link to join. You can sign in with Google, or with an email and password.',
    ],
    action: { label: `Join ${org.name}`, url: link },
    footnote: `The link works once and runs out in ${INVITATION_DAYS} days. It only works for ${email}.`,
  });
  return {
    invitation: { id, email, appRole: input.appRole, status: 'pending', createdAt: now, expiresAt },
    emailSent: sent.sent,
    // When email isn't set up, the admin can pass the link on themselves.
    link: sent.sent ? undefined : link,
  };
}

export async function revokeInvitation(db: D1Database, orgId: string, id: string, actorId: string) {
  const res = await db.prepare("UPDATE invitations SET status = 'revoked' WHERE id = ? AND org_id = ? AND status = 'pending'").bind(id, orgId).run();
  if (!res.meta.changes) throw new OrgError(404, 'not_found', 'That invitation is no longer open.');
  await auditStmt(db, { actorUserId: actorId, actorKind: 'user', action: 'invitation.revoke', targetType: 'invitation', targetId: id, orgId }).run();
}

async function openInvitation(db: D1Database, token: string): Promise<(InvitationRow & { org_name: string; org_status: string; app_storage: AppStorage; inviter: string | null }) | null> {
  if (!TOKEN_RE.test(token)) return null;
  return db.prepare(
    `SELECT i.*, o.name AS org_name, o.status AS org_status, o.app_storage, u.name AS inviter
     FROM invitations i JOIN organizations o ON o.id = i.org_id LEFT JOIN "user" u ON u.id = i.invited_by
     WHERE i.token_hash = ?`,
  ).bind(await sha256Hex(token)).first();
}

function invitationState(row: { status: string; expires_at: number; org_status: string }): 'open' | 'expired' | 'used' | 'closed' {
  if (row.status === 'accepted') return 'used';
  if (row.status !== 'pending' || row.org_status !== 'active') return 'closed';
  return row.expires_at <= Date.now() ? 'expired' : 'open';
}

/** What the join page shows before anyone signs in. */
export async function describeInvitation(db: D1Database, token: string) {
  const row = await openInvitation(db, token);
  if (!row) throw new OrgError(404, 'not_found', 'This invitation link is not valid. Ask for a new one.');
  const hasAccount = !!(await db.prepare('SELECT 1 FROM "user" WHERE email = ?').bind(row.email).first());
  return { orgName: row.org_name, email: row.email, invitedBy: row.inviter, state: invitationState(row), hasAccount, expiresAt: row.expires_at };
}

/** Joins the organization as the signed-in account, which must have the invited address. */
export async function acceptInvitation(env: Env, db: D1Database, token: string, user: { id: string; email: string; name: string }) {
  const row = await openInvitation(db, token);
  if (!row) throw new OrgError(404, 'not_found', 'This invitation link is not valid. Ask for a new one.');
  const state = invitationState(row);
  if (state === 'used') {
    const already = await db.prepare("SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ? AND status = 'active'").bind(row.org_id, user.id).first();
    if (already) return { orgId: row.org_id, orgName: row.org_name };
    throw new OrgError(409, 'used', 'This invitation was already used.');
  }
  if (state === 'expired') throw new OrgError(410, 'expired', 'This invitation has run out. Ask for a new one.');
  if (state === 'closed') throw new OrgError(409, 'closed', 'This invitation is no longer open. Ask for a new one.');
  if (user.email.toLowerCase() !== row.email) {
    throw new OrgError(403, 'wrong_account', `This invitation is for ${row.email}. Sign in with that account to accept it.`);
  }

  const existing = await db.prepare('SELECT id, status FROM memberships WHERE org_id = ? AND user_id = ?').bind(row.org_id, user.id).first<{ id: string; status: string }>();
  const joinStatement = existing
    ? await rejoinStatement(db, row, existing.id)
    : insertMemberWithinSeatLimit(db, {
      id: crypto.randomUUID(), orgId: row.org_id, userId: user.id, role: row.role, actorId: row.invited_by,
      maxMembers: limitOf(await resolveEntitlements(db, row.org_id), 'maxMembers'),
    });
  // The invitation is used, and the address confirmed, only if the person is
  // now an active member: when the plan has no free place, nothing changes.
  const isMember = 'EXISTS (SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ? AND status = \'active\')';
  await db.batch([
    joinStatement,
    db.prepare(`UPDATE invitations SET status = 'accepted', accepted_at = ?, accepted_by = ? WHERE id = ? AND status = 'pending' AND ${isMember}`)
      .bind(Date.now(), user.id, row.id, row.org_id, user.id),
    db.prepare(`UPDATE "user" SET emailVerified = 1 WHERE id = ? AND ${isMember}`).bind(user.id, row.org_id, user.id),
  ]);
  const joined = await db.prepare("SELECT status FROM invitations WHERE id = ?").bind(row.id).first<{ status: string }>();
  if (joined?.status !== 'accepted') {
    throw new OrgError(409, 'seat_limit', `${row.org_name} has no free places on its plan right now. Ask whoever invited you.`);
  }
  await auditStmt(db, { actorUserId: user.id, actorKind: 'user', action: 'invitation.accept', targetType: 'invitation', targetId: row.id, orgId: row.org_id, details: { email: row.email } }).run();

  // Their record in the app, with the role they were invited with.
  const member = await db.prepare('SELECT app_user_id FROM memberships WHERE org_id = ? AND user_id = ?').bind(row.org_id, user.id).first<{ app_user_id: string | null }>();
  const orgEnv = orgStorageEnv(env, { id: row.org_id, app_storage: row.app_storage });
  const appUserId = member?.app_user_id ?? user.id;
  const key = `auth:user:${appUserId}`;
  const raw = await orgEnv.VAYU_KV.get(key);
  if (raw) {
    // Someone coming back keeps their history; the invitation sets the role.
    await orgEnv.VAYU_KV.put(key, JSON.stringify({ ...JSON.parse(raw), role: row.app_role }));
  } else {
    await ensureAppUser(orgEnv, { appUserId, name: user.name, email: user.email, role: row.role, appRole: row.app_role || defaultAppRole(row.role) });
  }
  return { orgId: row.org_id, orgName: row.org_name };
}

/**
 * Someone who was in the team before (their membership was disabled) comes
 * back: re-enabled with the invited role, if the plan has a free place. An
 * owner stays owner.
 */
async function rejoinStatement(db: D1Database, row: InvitationRow, membershipId: string): Promise<D1PreparedStatement> {
  const seats = await seatUsage(db, row.org_id);
  const full = seats.limit !== null && seats.used >= seats.limit;
  return db.prepare(
    `UPDATE memberships SET status = 'active', role = CASE WHEN role = 'owner' THEN role ELSE ? END, updated_at = ?
     WHERE id = ? AND (status = 'active' OR ? = 0)`,
  ).bind(row.role, Date.now(), membershipId, full ? 1 : 0);
}

/**
 * For someone without an account: creates it (with the invited address,
 * already confirmed) and joins. They then sign in with the password they chose.
 */
export async function createAccountFromInvitation(env: Env, db: D1Database, token: string, body: Record<string, unknown>) {
  const row = await openInvitation(db, token);
  if (!row || invitationState(row) !== 'open') throw new OrgError(409, 'closed', 'This invitation is no longer open. Ask for a new one.');
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!name) throw new OrgError(400, 'invalid', 'Enter your name.');
  if (password.length < 10 || password.length > 128) throw new OrgError(400, 'invalid', 'Choose a password of at least 10 characters.');
  if (await db.prepare('SELECT 1 FROM "user" WHERE email = ?').bind(row.email).first()) {
    throw new OrgError(409, 'account_exists', 'There is already an account with this email. Sign in to accept the invitation.');
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.batch([
    db.prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, twoFactorEnabled) VALUES (?, ?, ?, 1, ?, ?, 0)')
      .bind(id, name, row.email, now, now),
    db.prepare("INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, 'credential', ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), id, id, await hashPassword(password), now, now),
  ]);
  return acceptInvitation(env, db, token, { id, email: row.email, name });
}
