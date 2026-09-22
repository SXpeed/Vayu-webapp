// Organizations and memberships in the platform database.
//
// Callers are provider-admin routes for now. Every function takes the org id
// from the route and re-reads rows by (org_id, id): a membership id from
// another organization simply isn't found.

import { hashPassword } from 'better-auth/crypto';
import { auditStmt } from './audit';
import { insertMemberWithinSeatLimit, limitOf, resolveEntitlements, seatUsage } from './plans';

export const BUSINESS_TYPES = ['artist', 'studio', 'gallery', 'store', 'multi_store', 'other'] as const;
export const ORG_ROLES = ['owner', 'admin', 'manager', 'staff'] as const;
export const ORG_STATUSES = ['active', 'suspended'] as const;

export type BusinessType = typeof BUSINESS_TYPES[number];
export type OrgRole = typeof ORG_ROLES[number];

export class OrgError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export interface Actor {
  userId: string;
  ip: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function str(v: unknown, field: string, { min = 1, max = 200 } = {}): string {
  if (typeof v !== 'string') throw new OrgError(400, 'invalid', `${field} is required.`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw new OrgError(400, 'invalid', `${field} must be ${min}–${max} characters.`);
  return s;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], field: string): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw new OrgError(400, 'invalid', `${field} must be one of: ${allowed.join(', ')}.`);
  }
  return v as T;
}

export function slugify(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'org';
}

function isUniqueViolation(e: unknown): boolean {
  return /UNIQUE constraint failed/i.test(String((e as Error)?.message ?? e));
}

function isOwnerGuard(e: unknown): boolean {
  return /at least one active owner/i.test(String((e as Error)?.message ?? e));
}

async function userIdByEmail(db: D1Database, email: string): Promise<string | null> {
  const row = await db.prepare('SELECT id FROM "user" WHERE email = ?').bind(email.toLowerCase()).first<{ id: string }>();
  return row?.id ?? null;
}

// ── Users (identity) ──────────────────────────────────────────────────────

/**
 * Creates a sign-in identity with a temporary password the provider hands
 * over out of band (verification email isn't available yet). Membership is
 * a separate step.
 */
export async function createUserAccount(db: D1Database, body: Record<string, unknown>, actor: Actor) {
  const email = str(body.email, 'Email', { max: 254 }).toLowerCase();
  if (!EMAIL_RE.test(email)) throw new OrgError(400, 'invalid', 'Enter a valid email address.');
  const name = str(body.name, 'Name', { max: 120 });
  const password = typeof body.temporaryPassword === 'string' ? body.temporaryPassword : '';
  if (password.length < 10 || password.length > 128) throw new OrgError(400, 'invalid', 'Temporary password must be 10–128 characters.');
  if (await userIdByEmail(db, email)) throw new OrgError(409, 'email_taken', 'An account with this email already exists.');

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await db.batch([
      db.prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, twoFactorEnabled) VALUES (?, ?, ?, 0, ?, ?, 0)')
        .bind(id, name, email, now, now),
      db.prepare("INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, 'credential', ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), id, id, await hashPassword(password), now, now),
      auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'user.create', targetType: 'user', targetId: id, details: { email }, ip: actor.ip }),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) throw new OrgError(409, 'email_taken', 'An account with this email already exists.');
    throw e;
  }
  return { id, email, name };
}

// ── Organizations ─────────────────────────────────────────────────────────

export async function createOrganization(db: D1Database, body: Record<string, unknown>, actor: Actor) {
  const name = str(body.name, 'Business name', { max: 120 });
  const businessType = oneOf(body.businessType, BUSINESS_TYPES, 'Business type');
  const slug = slugify(typeof body.slug === 'string' && body.slug.trim() ? body.slug : name);
  const ownerEmail = str(body.ownerEmail, 'Owner email', { max: 254 }).toLowerCase();
  const ownerId = await userIdByEmail(db, ownerEmail);
  if (!ownerId) throw new OrgError(404, 'owner_not_found', 'No account with that owner email. Create the account first.');
  const country = typeof body.country === 'string' ? body.country.trim().slice(0, 2).toUpperCase() || null : null;
  const timezone = typeof body.timezone === 'string' ? body.timezone.trim().slice(0, 64) || null : null;
  const isDemo = body.isDemo === true ? 1 : 0;

  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    // One batch = one transaction: the org never exists without its owner.
    await db.batch([
      db.prepare(`INSERT INTO organizations (id, slug, name, business_type, status, country, timezone, is_demo, created_at, created_by, updated_at)
                  VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`)
        .bind(id, slug, name, businessType, country, timezone, isDemo, now, actor.userId, now),
      db.prepare(`INSERT INTO memberships (id, org_id, user_id, role, status, created_at, created_by, updated_at)
                  VALUES (?, ?, ?, 'owner', 'active', ?, ?, ?)`)
        .bind(crypto.randomUUID(), id, ownerId, now, actor.userId, now),
      auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'org.create', targetType: 'organization', targetId: id, orgId: id, details: { name, slug, businessType, ownerEmail }, ip: actor.ip }),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) throw new OrgError(409, 'slug_taken', `The address name "${slug}" is already used by another organization.`);
    throw e;
  }
  return getOrganization(db, id);
}

export async function listOrganizations(db: D1Database, params: URLSearchParams) {
  const q = (params.get('q') ?? '').trim().toLowerCase();
  const status = params.get('status');
  const limit = Math.min(Math.max(Number(params.get('limit')) || 50, 1), 200);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (q) { where.push('(lower(o.name) LIKE ? OR o.slug LIKE ?)'); binds.push(`%${q}%`, `%${q}%`); }
  if (status && (['active', 'suspended', 'closed'] as string[]).includes(status)) { where.push('o.status = ?'); binds.push(status); }
  const { results } = await db.prepare(
    `SELECT o.id, o.slug, o.name, o.business_type, o.status, o.is_demo, o.created_at,
            (SELECT COUNT(*) FROM memberships m WHERE m.org_id = o.id AND m.status = 'active') AS active_members,
            (SELECT u.email FROM memberships m JOIN "user" u ON u.id = m.user_id
              WHERE m.org_id = o.id AND m.role = 'owner' AND m.status = 'active' ORDER BY m.created_at LIMIT 1) AS owner_email,
            (SELECT p.status FROM org_payment_integrations p WHERE p.org_id = o.id AND p.provider = 'razorpay') AS razorpay_status
     FROM organizations o
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY o.created_at DESC LIMIT ?`,
  ).bind(...binds, limit).all();
  return results;
}

export async function getOrganization(db: D1Database, orgId: string) {
  const org = await db.prepare(
    'SELECT id, slug, name, business_type, status, country, timezone, is_demo, created_at, updated_at FROM organizations WHERE id = ?',
  ).bind(orgId).first();
  if (!org) throw new OrgError(404, 'org_not_found', 'Organization not found.');
  const { results: members } = await db.prepare(
    `SELECT m.id, m.user_id, m.role, m.status, m.store_access, m.created_at, u.email, u.name
     FROM memberships m JOIN "user" u ON u.id = m.user_id
     WHERE m.org_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'manager' THEN 2 ELSE 3 END, u.email`,
  ).bind(orgId).all();
  return { ...org, members };
}

export async function setOrganizationStatus(db: D1Database, orgId: string, body: Record<string, unknown>, actor: Actor) {
  const status = oneOf(body.status, ORG_STATUSES, 'Status');
  const reason = str(body.reason, 'Reason', { min: 3, max: 500 });
  const before = await db.prepare('SELECT status FROM organizations WHERE id = ?').bind(orgId).first<{ status: string }>();
  if (!before) throw new OrgError(404, 'org_not_found', 'Organization not found.');
  if (before.status === 'closed') throw new OrgError(409, 'org_closed', 'A closed organization cannot be changed here.');
  await db.batch([
    db.prepare('UPDATE organizations SET status = ?, updated_at = ? WHERE id = ?').bind(status, Date.now(), orgId),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: `org.status.${status}`, targetType: 'organization', targetId: orgId, orgId, details: { from: before.status, to: status, reason }, ip: actor.ip }),
  ]);
  return getOrganization(db, orgId);
}

// ── Memberships ───────────────────────────────────────────────────────────

export async function addMember(db: D1Database, orgId: string, body: Record<string, unknown>, actor: Actor) {
  const email = str(body.email, 'Email', { max: 254 }).toLowerCase();
  const role = oneOf(body.role, ORG_ROLES, 'Role');
  const org = await db.prepare('SELECT status FROM organizations WHERE id = ?').bind(orgId).first<{ status: string }>();
  if (!org) throw new OrgError(404, 'org_not_found', 'Organization not found.');
  if (org.status === 'closed') throw new OrgError(409, 'org_closed', 'This organization is closed.');
  const userId = await userIdByEmail(db, email);
  if (!userId) throw new OrgError(404, 'user_not_found', 'No account with that email. Create the account first.');
  const id = crypto.randomUUID();
  // Seats come from the plan. The insert itself carries the check, so two
  // people claiming the last seat at the same moment cannot both succeed.
  const entitlements = await resolveEntitlements(db, orgId);
  let result;
  try {
    [result] = await db.batch([
      insertMemberWithinSeatLimit(db, { id, orgId, userId, role, actorId: actor.userId, maxMembers: limitOf(entitlements, 'maxMembers') }),
      auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'membership.add', targetType: 'membership', targetId: id, orgId, details: { email, role }, ip: actor.ip }),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) throw new OrgError(409, 'already_member', 'That person is already a member of this organization.');
    throw e;
  }
  if ((result?.meta?.changes ?? 0) === 0) {
    const seats = await seatUsage(db, orgId);
    throw new OrgError(409, 'seat_limit', `This organization's plan allows ${seats.limit} member${seats.limit === 1 ? '' : 's'} and ${seats.used} are enabled. Disable someone, or raise the limit for this organization.`);
  }
  return getOrganization(db, orgId);
}

export async function updateMember(db: D1Database, orgId: string, membershipId: string, body: Record<string, unknown>, actor: Actor) {
  const current = await db.prepare('SELECT role, status FROM memberships WHERE id = ? AND org_id = ?')
    .bind(membershipId, orgId).first<{ role: string; status: string }>();
  if (!current) throw new OrgError(404, 'member_not_found', 'Member not found in this organization.');
  // Re-enabling someone takes a seat, so it is checked like adding one.
  if (current.status === 'disabled' && body.status === 'active') {
    const seats = await seatUsage(db, orgId);
    if (seats.remaining !== null && seats.remaining < 1) {
      throw new OrgError(409, 'seat_limit', `This organization's plan allows ${seats.limit} member${seats.limit === 1 ? '' : 's'} and ${seats.used} are already enabled.`);
    }
  }
  const role = body.role === undefined ? current.role : oneOf(body.role, ORG_ROLES, 'Role');
  const status = body.status === undefined ? current.status : oneOf(body.status, ['active', 'disabled'] as const, 'Status');
  if (role === current.role && status === current.status) return getOrganization(db, orgId);
  try {
    await db.batch([
      db.prepare('UPDATE memberships SET role = ?, status = ?, updated_at = ? WHERE id = ? AND org_id = ?')
        .bind(role, status, Date.now(), membershipId, orgId),
      auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'membership.update', targetType: 'membership', targetId: membershipId, orgId, details: { from: current, to: { role, status } }, ip: actor.ip }),
    ]);
  } catch (e) {
    if (isOwnerGuard(e)) throw new OrgError(409, 'last_owner', 'This is the last active owner. Make someone else an owner first.');
    throw e;
  }
  return getOrganization(db, orgId);
}
