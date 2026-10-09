// Control-centre functions beyond organizations and plans: the overview
// dashboard, the account directory, provider administrators and system
// health.
//
// Nothing here returns a password, a session token, an API secret or a
// payment credential: accounts are shown by name, email and state; secrets
// only as "configured" or "missing".

import { hashPassword } from 'better-auth/crypto';
import type { Env } from '../workerEnv';
import { text } from '../rows';
import { auditStmt } from './audit';
import { googleConfigured, getEffectiveLoginMethods } from './settings';
import { OrgError, type Actor } from './orgs';
import { secretsConfigured } from './secrets';
import { getNotificationSettings } from './notify';
import { getAppPaymentsOrg } from './payments';
import { keyUsage } from './secretRotation';
import { emailConfigured } from './email';
import { jobsHealth } from './jobs';

// ── Overview ──────────────────────────────────────────────────────────────

async function countBy(db: D1Database, sql: string): Promise<Record<string, number>> {
  const { results } = await db.prepare(sql).all<{ k: string; n: number }>();
  return Object.fromEntries(results.map(r => [r.k, r.n]));
}

export async function overview(env: Env, db: D1Database) {
  const [orgs, applications, subscriptions, outbox] = await Promise.all([
    countBy(db, 'SELECT status AS k, COUNT(*) AS n FROM organizations GROUP BY status'),
    countBy(db, 'SELECT review_status AS k, COUNT(*) AS n FROM applications GROUP BY review_status'),
    countBy(db, 'SELECT status AS k, COUNT(*) AS n FROM subscriptions GROUP BY status'),
    countBy(db, 'SELECT status AS k, COUNT(*) AS n FROM notification_outbox GROUP BY status'),
  ]);
  const totals = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM "user") AS users,
            (SELECT COUNT(*) FROM provider_admins WHERE status = 'active') AS admins,
            (SELECT COUNT(*) FROM memberships WHERE status = 'active') AS memberships,
            (SELECT COUNT(*) FROM plans WHERE status = 'published') AS plans,
            (SELECT COUNT(*) FROM platform_user_status WHERE status = 'disabled') AS disabled_users,
            (SELECT COUNT(*) FROM "user" WHERE createdAt >= ?) AS new_users_7d`,
  ).bind(new Date(Date.now() - 7 * 86_400_000).toISOString()).first();
  const { results: planMix } = await db.prepare(
    `SELECT p.name AS plan, COUNT(*) AS n FROM subscriptions s
     JOIN plan_versions v ON v.id = s.plan_version_id JOIN plans p ON p.id = v.plan_id
     GROUP BY p.name ORDER BY n DESC`,
  ).all();
  const { results: recentApplications } = await db.prepare(
    `SELECT a.id, a.business_name, a.review_status, a.submitted_at, u.email
     FROM applications a JOIN "user" u ON u.id = a.user_id
     WHERE a.review_status IN ('pending_review','needs_information')
     ORDER BY a.submitted_at DESC LIMIT 5`,
  ).all();
  const { results: recentAudit } = await db.prepare(
    `SELECT a.at, a.action, a.actor_kind, u.email AS actor_email
     FROM platform_audit a LEFT JOIN "user" u ON u.id = a.actor_user_id
     ORDER BY a.at DESC LIMIT 8`,
  ).all();
  const failedSetups = await db.prepare(
    "SELECT COUNT(*) AS n FROM applications WHERE review_status = 'approved' AND provisioning_status = 'failed'",
  ).first<{ n: number }>();
  const trialsEnding = await db.prepare(
    "SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'trialing' AND trial_ends_at BETWEEN ? AND ?",
  ).bind(Date.now(), Date.now() + 7 * 86_400_000).first<{ n: number }>();
  return {
    organizations: orgs, applications, subscriptions, notifications: outbox,
    totals, planMix, recentApplications, recentAudit,
    trialsEndingThisWeek: trialsEnding?.n ?? 0,
    failedSetups: failedSetups?.n ?? 0,
    emailConfigured: emailConfigured(env),
    generatedAt: Date.now(),
  };
}

// ── Accounts ──────────────────────────────────────────────────────────────

export async function listUsers(db: D1Database, params: URLSearchParams) {
  const q = (params.get('q') ?? '').trim().toLowerCase();
  const limit = Math.min(Math.max(Number(params.get('limit')) || 50, 1), 200);
  const where = q ? 'WHERE lower(u.email) LIKE ? OR lower(u.name) LIKE ?' : '';
  const stmt = db.prepare(
    `SELECT u.id, u.name, u.email, u.emailVerified AS email_verified, u.twoFactorEnabled AS two_factor, u.createdAt AS created_at,
            COALESCE(s.status, 'active') AS status,
            (SELECT COUNT(*) FROM memberships m WHERE m.user_id = u.id AND m.status = 'active') AS organizations,
            (SELECT COUNT(*) FROM session se WHERE se.userId = u.id AND se.expiresAt > ?) AS active_sessions,
            (SELECT role FROM provider_admins pa WHERE pa.user_id = u.id AND pa.status = 'active') AS provider_role,
            (SELECT MAX(se.updatedAt) FROM session se WHERE se.userId = u.id) AS last_seen
     FROM "user" u LEFT JOIN platform_user_status s ON s.user_id = u.id
     ${where} ORDER BY u.createdAt DESC LIMIT ?`,
  );
  const now = new Date().toISOString();
  const { results } = await (q ? stmt.bind(now, `%${q}%`, `%${q}%`, limit) : stmt.bind(now, limit)).all();
  return results;
}

export async function getUser(db: D1Database, userId: string) {
  const user = await db.prepare(
    `SELECT u.id, u.name, u.email, u.emailVerified AS email_verified, u.twoFactorEnabled AS two_factor, u.createdAt AS created_at,
            COALESCE(s.status, 'active') AS status, s.reason AS status_reason
     FROM "user" u LEFT JOIN platform_user_status s ON s.user_id = u.id WHERE u.id = ?`,
  ).bind(userId).first();
  if (!user) throw new OrgError(404, 'not_found', 'Account not found.');
  const { results: memberships } = await db.prepare(
    `SELECT m.id, m.role, m.status, o.id AS org_id, o.name AS org_name, o.status AS org_status
     FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = ? ORDER BY o.name`,
  ).bind(userId).all();
  // Sessions are described, never exposed: no token leaves the server. The id
  // is not a credential; it lets a person's own profile mark "this device".
  const { results: sessions } = await db.prepare(
    `SELECT id, createdAt AS created_at, updatedAt AS last_active, expiresAt AS expires_at, userAgent AS user_agent, ipAddress AS ip
     FROM session WHERE userId = ? AND expiresAt > ? ORDER BY updatedAt DESC LIMIT 20`,
  ).bind(userId, new Date().toISOString()).all();
  const { results: logins } = await db.prepare('SELECT providerId AS provider FROM account WHERE userId = ?').bind(userId).all();
  const admin = await db.prepare('SELECT role, status FROM provider_admins WHERE user_id = ?').bind(userId).first();
  return { user, memberships, sessions, loginMethods: logins.map(l => (l as { provider: string }).provider), providerAdmin: admin ?? null };
}

export async function revokeSessions(db: D1Database, userId: string, actor: Actor) {
  const [result] = await db.batch([
    db.prepare('DELETE FROM session WHERE userId = ?').bind(userId),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'user.sessions.revoke', targetType: 'user', targetId: userId, ip: actor.ip }),
  ]);
  return { revoked: result?.meta?.changes ?? 0 };
}

export async function setUserStatus(db: D1Database, userId: string, body: Record<string, unknown>, actor: Actor) {
  const status = body.status === 'disabled' || body.status === 'active' ? body.status : null;
  if (!status) throw new OrgError(400, 'invalid', 'Status must be active or disabled.');
  if (userId === actor.userId) throw new OrgError(409, 'self', 'You cannot disable your own account.');
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
  if (status === 'disabled' && reason.length < 3) throw new OrgError(400, 'invalid', 'Say why the account is being disabled.');
  const exists = await db.prepare('SELECT 1 FROM "user" WHERE id = ?').bind(userId).first();
  if (!exists) throw new OrgError(404, 'not_found', 'Account not found.');
  const statements = [
    db.prepare(
      `INSERT INTO platform_user_status (user_id, status, reason, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET status = excluded.status, reason = excluded.reason, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).bind(userId, status, reason || null, Date.now(), actor.userId),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: `user.${status === 'disabled' ? 'disable' : 'enable'}`, targetType: 'user', targetId: userId, details: { reason }, ip: actor.ip }),
  ];
  // Disabling ends every session immediately; enabling does not create one.
  if (status === 'disabled') statements.push(db.prepare('DELETE FROM session WHERE userId = ?').bind(userId));
  await db.batch(statements);
  return getUser(db, userId);
}

/** Sets a new temporary password and signs the account out everywhere. */
export async function resetPassword(db: D1Database, userId: string, body: Record<string, unknown>, actor: Actor) {
  const password = typeof body.temporaryPassword === 'string' ? body.temporaryPassword : '';
  if (password.length < 10 || password.length > 128) throw new OrgError(400, 'invalid', 'The temporary password must be 10–128 characters.');
  const account = await db.prepare("SELECT id FROM account WHERE userId = ? AND providerId = 'credential'").bind(userId).first<{ id: string }>();
  const hash = await hashPassword(password);
  const now = new Date().toISOString();
  await db.batch([
    account
      ? db.prepare('UPDATE account SET password = ?, updatedAt = ? WHERE id = ?').bind(hash, now, account.id)
      : db.prepare("INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, 'credential', ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), userId, userId, hash, now, now),
    db.prepare('DELETE FROM session WHERE userId = ?').bind(userId),
    // The password itself never enters the audit log.
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'user.password.reset', targetType: 'user', targetId: userId, ip: actor.ip }),
  ]);
  return { ok: true };
}

// ── Provider administrators ───────────────────────────────────────────────

const ADMIN_ROLES = ['owner', 'admin', 'support'] as const;

export async function listAdmins(db: D1Database) {
  const { results } = await db.prepare(
    `SELECT pa.user_id, pa.role, pa.status, pa.created_at, u.email, u.name, u.twoFactorEnabled AS two_factor
     FROM provider_admins pa JOIN "user" u ON u.id = pa.user_id ORDER BY pa.role, u.email`,
  ).all();
  return results;
}

async function activeOwners(db: D1Database): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM provider_admins WHERE role = 'owner' AND status = 'active'").first<{ n: number }>())?.n ?? 0;
}

/** Only a provider owner may change who administers the platform. */
function requireOwner(actorRole: string) {
  if (actorRole !== 'owner') throw new OrgError(403, 'owner_only', 'Only a platform owner can manage administrators.');
}

export async function addAdmin(db: D1Database, body: Record<string, unknown>, actor: Actor & { role: string }) {
  requireOwner(actor.role);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const role = ADMIN_ROLES.includes(body.role as never) ? body.role as string : null;
  if (!role) throw new OrgError(400, 'invalid', `Role must be one of: ${ADMIN_ROLES.join(', ')}.`);
  const user = await db.prepare('SELECT id FROM "user" WHERE email = ?').bind(email).first<{ id: string }>();
  if (!user) throw new OrgError(404, 'user_not_found', 'No account with that email. Create the account first.');
  await db.batch([
    db.prepare(
      `INSERT INTO provider_admins (user_id, role, status, created_at, created_by) VALUES (?, ?, 'active', ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET role = excluded.role, status = 'active'`,
    ).bind(user.id, role, Date.now(), actor.userId),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'provider_admin.add', targetType: 'user', targetId: user.id, details: { email, role }, ip: actor.ip }),
  ]);
  return listAdmins(db);
}

export async function updateAdmin(db: D1Database, userId: string, body: Record<string, unknown>, actor: Actor & { role: string }) {
  requireOwner(actor.role);
  if (userId === actor.userId) throw new OrgError(409, 'self', 'You cannot change your own administrator access.');
  const current = await db.prepare('SELECT role, status FROM provider_admins WHERE user_id = ?').bind(userId).first<{ role: string; status: string }>();
  if (!current) throw new OrgError(404, 'not_found', 'Not an administrator.');
  const validRole = ADMIN_ROLES.includes(body.role as never) ? text(body.role) : null;
  const validStatus = body.status === 'disabled' || body.status === 'active' ? body.status : null;
  const role = body.role === undefined ? current.role : validRole;
  const status = body.status === undefined ? current.status : validStatus;
  if (!role || !status) throw new OrgError(400, 'invalid', 'Invalid role or status.');
  const losingOwner = current.role === 'owner' && current.status === 'active' && (role !== 'owner' || status !== 'active');
  if (losingOwner && await activeOwners(db) <= 1) {
    throw new OrgError(409, 'last_owner', 'The platform must keep at least one active owner.');
  }
  const statements = [
    db.prepare('UPDATE provider_admins SET role = ?, status = ? WHERE user_id = ?').bind(role, status, userId),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'provider_admin.update', targetType: 'user', targetId: userId, details: { from: current, to: { role, status } }, ip: actor.ip }),
  ];
  if (status === 'disabled') statements.push(db.prepare('DELETE FROM session WHERE userId = ?').bind(userId));
  await db.batch(statements);
  return listAdmins(db);
}

// ── System health ─────────────────────────────────────────────────────────

/** What is configured, as yes/no. Never a secret value. */
/**
 * The original app's payment links (no organization): the shared account, if
 * the LEGACY_PAYMENT_LINKS switch still allows them, its mode, and whether its
 * payments reach the app at once (webhook) or only via the scheduled check.
 * Workspaces use their own accounts (each organization's Customer payments).
 */
async function appPaymentLinksCheck(env: Env, db: D1Database): Promise<{ ok: boolean; detail: string }> {
  const leftover = await getAppPaymentsOrg(db);
  const leftoverNote = leftover ? ' The retired "app account" setting is still stored; clear it on that organization’s card.' : '';
  if (env.LEGACY_PAYMENT_LINKS !== 'on') return { ok: !leftover, detail: `Original app: payment links retired (made from workspaces only).${leftoverNote}` };
  const mode = /^rzp_(test|live)_/.exec(env.RAZORPAY_KEY_ID ?? '')?.[1];
  if (!mode || !env.RAZORPAY_KEY_SECRET) {
    return { ok: false, detail: 'Original app: RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set or not a Razorpay key: it cannot create payment links' };
  }
  const production = env.PLATFORM_ENV !== 'development';
  if (mode === 'test' && production && env.SHARED_RAZORPAY_ALLOW_TEST !== 'on') {
    return { ok: false, detail: 'Original app: the shared account has TEST keys, and test links are not allowed in production: set live keys (or SHARED_RAZORPAY_ALLOW_TEST=on to test)' };
  }
  if (!env.RAZORPAY_WEBHOOK_SECRET) {
    return { ok: false, detail: `Original app: shared account (${mode}); RAZORPAY_WEBHOOK_SECRET not set, so payments show as paid only after the scheduled check.${leftoverNote}` };
  }
  return { ok: !leftover, detail: `Original app: shared account (${mode}); keys and webhook secret set.${leftoverNote}` };
}

/**
 * The payment-credential keys: configured, and every stored value on a key
 * this Worker has (counts only; decrypting every value is Security → Check).
 */
async function paymentKeysCheck(env: Env, db: D1Database): Promise<{ ok: boolean; detail: string }> {
  if (!secretsConfigured(env)) return { ok: false, detail: 'PAYMENT_SECRETS_KEY missing or invalid — organizations cannot connect Razorpay' };
  const usage = await keyUsage(env, db, false);
  if (usage.missingKeys.length) return { ok: false, detail: `Stored values use ${usage.missingKeys.join(', ')}, which is not configured: those credentials can't be read` };
  const older = Object.entries(usage.byKid).filter(([kid]) => kid !== usage.active).reduce((n, [, c]) => n + c, 0);
  if (usage.rotation?.running) return { ok: true, detail: `Active key ${usage.active}; re-encryption in progress (${older} left)` };
  if (older) return { ok: false, detail: `Active key ${usage.active}; ${older} value(s) still on an older key — re-encrypt before retiring it` };
  return { ok: true, detail: `Active key ${usage.active}; every stored value uses it` };
}

/** A check's words, when it passes and when it doesn't. */
const status = (ok: boolean, yes: string, no: string) => [ok, ok ? yes : no] as const;

export async function systemHealth(env: Env, db: D1Database) {
  // `fix` names the control-centre screen where a failing check is put right;
  // checks without one are fixed in the deployment (secrets, bindings, vars).
  const checks: { name: string; ok: boolean; detail: string; fix?: string }[] = [];
  const check = (name: string, ok: boolean, detail: string, fix?: string) => checks.push({ name, ok, detail, ...(ok || !fix ? {} : { fix }) });

  check('Platform database', true, 'Connected');
  check('Organization databases', ...status(!!env.ORG_STORE, 'Available', 'ORG_STORE binding missing'));
  check('File storage', ...status(!!env.VAYU_R2, 'Available', 'R2 binding missing'));
  check('Original app database', ...status(!!env.VAYU_DB, 'Available (needed for the import)', 'Not bound'));
  check('Sign-in secret', ...status((env.BETTER_AUTH_SECRET?.length ?? 0) >= 32, 'Configured', 'Missing or too short'));
  const keys = await paymentKeysCheck(env, db);
  check('Payment credential keys', keys.ok, keys.detail, keys.ok ? undefined : 'security');
  check('Google sign-in', ...status(googleConfigured(env), 'Credentials configured', 'Not configured (optional)'));
  check('Two-factor for admins', ...status(env.ADMIN_REQUIRE_2FA !== 'off', 'Required', 'OFF — only acceptable locally'));
  check('Admin host restriction', ...status(!!env.ADMIN_HOST, `Only on ${env.ADMIN_HOST}`, 'Not set (any configured host)'));
  check('Email delivery', ...status(emailConfigured(env),
    `Cloudflare Email Service, from ${env.EMAIL_FROM || 'no-reply@ateliersupport.com'}`,
    'Not configured — notices wait in the outbox; no confirmation or reset emails'));
  const { providerEmail } = await getNotificationSettings(db);
  check('Provider notification address', !!providerEmail, providerEmail ?? 'Not set — new applications only appear in the queue', 'notifications');
  // Which Razorpay account the app's payment links use, and whether payments
  // on it can reach the app at once (webhook) or only via its status check.
  const links = await appPaymentLinksCheck(env, db);
  check('App payment links', links.ok, links.detail);
  check('Private file access', ...status(env.FILE_AUTH === 'on', 'Files need a session', 'OFF — files are reachable by URL'));
  const jobs = await jobsHealth(db);
  check('Scheduled jobs', jobs.ok, jobs.detail);

  let migrations: string[] = [];
  try {
    const { results } = await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>();
    migrations = results.map(r => r.name);
  } catch { /* applied by hand, without the migrations table */ }

  const methods = await getEffectiveLoginMethods(env, db);
  return {
    environment: env.PLATFORM_ENV ?? 'production',
    checks,
    migrations,
    loginMethods: methods,
    jobs: jobs.jobs,
    authOrigins: (env.AUTH_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    flags: { realtime: env.REALTIME_ENABLED ?? 'off', deltaSync: env.DELTA_SYNC_ENABLED ?? 'off', fileAuth: env.FILE_AUTH ?? 'off' },
  };
}
