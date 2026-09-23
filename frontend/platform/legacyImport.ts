// Moving the original single-business app into the platform.
//
// The existing app keeps its data in one shared D1 database (VAYU_DB) and its
// users in KV. This copies both into one organization: business rows into that
// organization's own database, users into platform accounts plus memberships.
//
// Properties that matter:
//  - Record ids and timestamps are preserved, so references between records
//    (artwork ids in catalogs, sender ids in messages) still line up.
//  - Passwords are carried over as-is (the old PBKDF2 hashes verify against
//    Better Auth, see platform/auth.ts), so nobody has to reset.
//  - It is idempotent: rows that exist are left alone, so a retry after a
//    failure resumes instead of duplicating.
//  - Dry run is the default and writes nothing, anywhere.
//  - It never runs by itself — only when a provider admin asks.

import type { Env } from '../workerEnv';
import { auditStmt } from './audit';
import { OrgError, type Actor } from './orgs';
import type { OrgStore } from './orgStore';

/** Business tables copied from the shared database, in dependency order. */
const TABLES = [
  'artworks', 'collections', 'catalogs', 'contacts', 'inquiries', 'inquiry_messages',
  'conversations', 'messages', 'invoices', 'events', 'stores', 'attendance',
  'activity_logs', 'deleted_items',
] as const;

const PAGE = 200;

export interface ImportReport {
  mode: 'dry_run' | 'run';
  orgId: string;
  users: { found: number; created: number; matchedExisting: number; memberships: number; owner: string | null };
  tables: Record<string, { source: number; inserted: number; alreadyThere: number }>;
  warnings: string[];
}

export interface LegacyUser {
  id: string;
  name?: string;
  email?: string;
  role?: string;
  /** The original app stores its PBKDF2 hash here. */
  hashedPassword?: string;
  password?: string;
  passwordHash?: string;
}

/** The stored password hash of an original-app user, whichever field holds it. */
export function legacyPasswordHash(user: LegacyUser): string | undefined {
  return user.hashedPassword || user.password || user.passwordHash || undefined;
}

async function tableCount(db: D1Database, table: string): Promise<number | null> {
  try {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
    return row?.n ?? 0;
  } catch {
    return null; // table missing in this environment
  }
}

export async function readLegacyUsers(env: Env): Promise<LegacyUser[]> {
  const users: LegacyUser[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.VAYU_KV.list({ prefix: 'auth:user:', cursor });
    for (const key of page.keys) {
      const raw = await env.VAYU_KV.get(key.name);
      if (!raw) continue;
      try { users.push(JSON.parse(raw) as LegacyUser); } catch { /* skip unreadable */ }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return users;
}

/** Legacy roles are 'admin', 'user' or a custom role id. */
function mapRole(user: LegacyUser, ownerEmail: string | null): 'owner' | 'admin' | 'staff' {
  if (ownerEmail && user.email?.toLowerCase() === ownerEmail) return 'owner';
  return user.role === 'admin' ? 'admin' : 'staff';
}

/**
 * Reads everything, reports what would happen and — unless this is a dry run —
 * writes it into the organization.
 */
export async function importLegacyWorkspace(
  env: Env,
  db: D1Database,
  orgId: string,
  body: Record<string, unknown>,
  actor: Actor,
): Promise<ImportReport> {
  const dryRun = body.dryRun !== false; // anything but an explicit false is a dry run
  const ownerEmail = typeof body.ownerEmail === 'string' ? body.ownerEmail.trim().toLowerCase() : null;

  const org = await db.prepare('SELECT status FROM organizations WHERE id = ?').bind(orgId).first<{ status: string }>();
  if (!org) throw new OrgError(404, 'org_not_found', 'Organization not found.');
  if (org.status !== 'active') throw new OrgError(409, 'org_not_active', 'The organization must be active to import into it.');
  if (!env.ORG_STORE) throw new OrgError(503, 'store_unavailable', 'Organization storage is not configured in this environment.');
  if (!env.VAYU_DB) throw new OrgError(503, 'legacy_unavailable', 'The original database is not available in this environment.');

  const store = env.ORG_STORE.get(env.ORG_STORE.idFromName(orgId)) as DurableObjectStub<OrgStore>;
  const report: ImportReport = {
    mode: dryRun ? 'dry_run' : 'run',
    orgId,
    users: { found: 0, created: 0, matchedExisting: 0, memberships: 0, owner: null },
    tables: {},
    warnings: [],
  };

  const importId = crypto.randomUUID();
  const startedAt = Date.now();
  if (!dryRun) {
    await db.prepare(
      `INSERT INTO org_imports (id, org_id, source, mode, status, started_at, started_by)
       VALUES (?, ?, 'legacy_workspace', 'run', 'running', ?, ?)`,
    ).bind(importId, orgId, startedAt, actor.userId).run();
  }

  try {
    // ── Users ────────────────────────────────────────────────────────────
    const legacyUsers = await readLegacyUsers(env);
    report.users.found = legacyUsers.length;
    if (ownerEmail && !legacyUsers.some(u => u.email?.toLowerCase() === ownerEmail)) {
      report.warnings.push(`No existing user has the email ${ownerEmail}; nobody would be made owner by it.`);
    }

    const existingOwner = await db.prepare(
      "SELECT 1 FROM memberships WHERE org_id = ? AND role = 'owner' AND status = 'active'",
    ).bind(orgId).first();

    for (const user of legacyUsers) {
      const email = user.email?.trim().toLowerCase();
      if (!email || !user.id) {
        report.warnings.push(`Skipped a user record without an id or email.`);
        continue;
      }
      const role = mapRole(user, ownerEmail);
      if (role === 'owner') report.users.owner = email;

      const existing = await db.prepare('SELECT id FROM "user" WHERE email = ?').bind(email).first<{ id: string }>();
      const userId = existing?.id ?? user.id;
      if (existing) {
        report.users.matchedExisting += 1;
        if (existing.id !== user.id) {
          report.warnings.push(`${email} already has a platform account with a different id; its membership will use the existing account.`);
        }
      } else {
        report.users.created += 1;
      }

      const alreadyMember = await db.prepare('SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ?')
        .bind(orgId, userId).first();
      if (!alreadyMember) report.users.memberships += 1;

      if (dryRun) continue;

      const nowIso = new Date().toISOString();
      const statements: D1PreparedStatement[] = [];
      if (!existing) {
        statements.push(
          db.prepare('INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, twoFactorEnabled) VALUES (?, ?, ?, 0, ?, ?, 0)')
            .bind(user.id, user.name?.slice(0, 120) || email, email, nowIso, nowIso),
        );
        const hash = legacyPasswordHash(user);
        if (hash) {
          statements.push(
            db.prepare("INSERT OR IGNORE INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, 'credential', ?, ?, ?, ?)")
              .bind(crypto.randomUUID(), user.id, user.id, hash, nowIso, nowIso),
          );
        } else {
          report.warnings.push(`${email} has no stored password; they will need a new one.`);
        }
      }
      if (!alreadyMember) {
        // Only one owner is created here; if the organization already has one,
        // the legacy admin becomes an admin instead.
        const finalRole = role === 'owner' && existingOwner ? 'admin' : role;
        statements.push(
          db.prepare(`INSERT OR IGNORE INTO memberships (id, org_id, user_id, role, status, created_at, created_by, updated_at)
                      VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`)
            .bind(crypto.randomUUID(), orgId, userId, finalRole, Date.now(), actor.userId, Date.now()),
        );
      }
      if (statements.length) await db.batch(statements);
    }

    // ── Business rows ────────────────────────────────────────────────────
    const before = await store.counts();
    for (const table of TABLES) {
      const source = await tableCount(env.VAYU_DB, table);
      if (source === null) {
        report.warnings.push(`Table "${table}" does not exist in the original database; skipped.`);
        continue;
      }
      report.tables[table] = { source, inserted: 0, alreadyThere: before[table] ?? 0 };
      if (dryRun || source === 0) continue;

      for (let offset = 0; offset < source; offset += PAGE) {
        const { results } = await env.VAYU_DB.prepare(`SELECT * FROM ${table} LIMIT ? OFFSET ?`).bind(PAGE, offset).all();
        if (!results?.length) break;
        const outcome = await store.importRows(table, results as Record<string, unknown>[]);
        report.tables[table].inserted += outcome.inserted;
      }
    }

    if (!dryRun) {
      await db.batch([
        db.prepare('UPDATE org_imports SET status = ?, counts = ?, finished_at = ? WHERE id = ?')
          .bind('done', JSON.stringify(report), Date.now(), importId),
        auditStmt(db, {
          actorUserId: actor.userId, actorKind: 'provider_admin', action: 'org.import.legacy',
          targetType: 'organization', targetId: orgId, orgId,
          details: { users: report.users, tables: report.tables }, ip: actor.ip,
        }),
      ]);
    }
    return report;
  } catch (e) {
    if (!dryRun) {
      await db.prepare('UPDATE org_imports SET status = ?, error = ?, finished_at = ? WHERE id = ?')
        .bind('failed', String((e as Error)?.message ?? e).slice(0, 500), Date.now(), importId).run()
        .catch(() => { /* the original error matters more */ });
    }
    throw e;
  }
}

/** Past import attempts for one organization. */
export async function listImports(db: D1Database, orgId: string) {
  const { results } = await db.prepare(
    'SELECT id, source, mode, status, counts, error, started_at, finished_at FROM org_imports WHERE org_id = ? ORDER BY started_at DESC LIMIT 20',
  ).bind(orgId).all();
  return results;
}
