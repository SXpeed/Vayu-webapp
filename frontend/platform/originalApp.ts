// Connecting the original app (Vayu's data) to an organization.
//
// The original app predates organizations: one database, one set of files and
// settings, and its own list of people. Rather than copy all of it, one
// organization is marked as owning it (app_storage = 'original'); inside the
// app that organization then works on the original storage directly
// (frontend/orgApp.ts). Nothing is moved, so nothing can be lost in a move.
//
// Its people are brought in as platform accounts and memberships:
//  - Same id where possible, so everything they wrote stays theirs.
//  - Same password: the original hashes verify as they are (platform/auth.ts).
//  - Someone who already has a platform account (matched by email) keeps it;
//    their membership remembers their original app id (app_user_id).
//  - Their app role stays in the original app's records: custom roles and all.
// Dry run is the default and writes nothing. Running it twice changes nothing.

import type { Env } from '../workerEnv';
import { auditStmt } from './audit';
import { legacyPasswordHash, readLegacyUsers, type LegacyUser } from './legacyImport';
import { OrgError, type Actor } from './orgs';

/** Marks which organization owns the original app's data, or releases it. */
export async function setAppStorage(db: D1Database, orgId: string, body: Record<string, unknown>, actor: Actor) {
  const storage = body.storage;
  if (storage !== 'original' && storage !== 'own') throw new OrgError(400, 'invalid', 'Choose "original" or "own".');
  const org = await db.prepare('SELECT slug, name, app_storage FROM organizations WHERE id = ?').bind(orgId).first<{ slug: string; name: string; app_storage: string }>();
  if (!org) throw new OrgError(404, 'org_not_found', 'Organization not found.');
  // It changes what everyone in the organization sees: typed confirmation.
  if (body.confirm !== org.slug) throw new OrgError(400, 'confirm', `Type the organization's address name (${org.slug}) to confirm.`);
  if (org.app_storage === storage) return { appStorage: storage };
  if (storage === 'original') {
    const other = await db.prepare("SELECT name FROM organizations WHERE app_storage = 'original' AND id <> ?").bind(orgId).first<{ name: string }>();
    if (other) throw new OrgError(409, 'taken', `${other.name} already uses the original app's data. Release it there first.`);
  }
  await db.batch([
    db.prepare('UPDATE organizations SET app_storage = ?, updated_at = ? WHERE id = ?').bind(storage, Date.now(), orgId),
    auditStmt(db, {
      actorUserId: actor.userId, actorKind: 'provider_admin', action: 'org.app_storage', targetType: 'organization', targetId: orgId, orgId,
      details: { from: org.app_storage, to: storage }, ip: actor.ip,
    }),
  ]);
  return { appStorage: storage };
}

export interface PeopleReport {
  mode: 'dry_run' | 'run';
  found: number;
  accountsCreated: number;
  accountsMatched: number;
  membershipsAdded: number;
  alreadyMembers: number;
  people: { email: string; outcome: string }[];
  warnings: string[];
}

interface PersonPlan {
  email: string;
  userId: string;
  /** Their original app id when it differs from the account id. */
  appUserId: string | null;
  hasAccount: boolean;
  member: { id: string; app_user_id: string | null } | null;
  hash: string | undefined;
  name: string;
  role: 'admin' | 'staff';
}

/** What happens to one person: which account they sign in with, and whether they join. */
async function planPerson(db: D1Database, orgId: string, person: LegacyUser, email: string): Promise<PersonPlan> {
  const byEmail = await db.prepare('SELECT id FROM "user" WHERE email = ?').bind(email).first<{ id: string }>();
  const idTaken = byEmail ? null : await db.prepare('SELECT email FROM "user" WHERE id = ?').bind(person.id).first<{ email: string }>();
  // Their platform account: the one they have, or a new one with their
  // original id (a fresh id only if that one is somehow taken).
  const userId = byEmail?.id ?? (idTaken ? crypto.randomUUID() : person.id);
  const member = await db.prepare('SELECT id, app_user_id FROM memberships WHERE org_id = ? AND user_id = ?')
    .bind(orgId, userId).first<{ id: string; app_user_id: string | null }>();
  return {
    email, userId, appUserId: userId === person.id ? null : person.id, hasAccount: !!byEmail, member,
    hash: legacyPasswordHash(person), name: person.name?.slice(0, 120) || email, role: person.role === 'admin' ? 'admin' : 'staff',
  };
}

function describe(plan: PersonPlan, originalId: string): string {
  const joins = plan.member ? 'already a member' : 'joins';
  if (!plan.hasAccount) return `${joins} (new account, same password)`;
  return `${joins} (existing account${plan.userId === originalId ? '' : ', keeps their history'})`;
}

function count(report: PeopleReport, plan: PersonPlan, originalId: string): void {
  if (plan.member) report.alreadyMembers += 1; else report.membershipsAdded += 1;
  if (plan.hasAccount) report.accountsMatched += 1; else report.accountsCreated += 1;
  if (!plan.hasAccount && !plan.hash) report.warnings.push(`${plan.email} has no stored password: they will need "Forgot password?" to choose one.`);
  report.people.push({ email: plan.email, outcome: describe(plan, originalId) });
}

/** The writes for one person; nothing when they are already set up. */
function personStatements(db: D1Database, orgId: string, plan: PersonPlan, actor: Actor): D1PreparedStatement[] {
  const nowIso = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  if (!plan.hasAccount) {
    statements.push(db.prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, twoFactorEnabled) VALUES (?, ?, ?, 1, ?, ?, 0)')
      .bind(plan.userId, plan.name, plan.email, nowIso, nowIso));
    if (plan.hash) {
      statements.push(db.prepare("INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, 'credential', ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), plan.userId, plan.userId, plan.hash, nowIso, nowIso));
    }
  }
  if (!plan.member) {
    statements.push(db.prepare(
      `INSERT INTO memberships (id, org_id, user_id, role, status, created_at, created_by, updated_at, app_user_id)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), orgId, plan.userId, plan.role, Date.now(), actor.userId, Date.now(), plan.appUserId));
  } else if (plan.appUserId && !plan.member.app_user_id) {
    statements.push(db.prepare('UPDATE memberships SET app_user_id = ?, updated_at = ? WHERE id = ?').bind(plan.appUserId, Date.now(), plan.member.id));
  }
  return statements;
}

/** Brings the original app's people into the organization that owns its data. */
export async function importOriginalPeople(env: Env, db: D1Database, orgId: string, body: Record<string, unknown>, actor: Actor): Promise<PeopleReport> {
  const dryRun = body.dryRun !== false;
  const org = await db.prepare('SELECT app_storage FROM organizations WHERE id = ?').bind(orgId).first<{ app_storage: string }>();
  if (!org) throw new OrgError(404, 'org_not_found', 'Organization not found.');
  if (org.app_storage !== 'original') throw new OrgError(409, 'not_original', "Connect this organization to the original app's data first.");

  const report: PeopleReport = { mode: dryRun ? 'dry_run' : 'run', found: 0, accountsCreated: 0, accountsMatched: 0, membershipsAdded: 0, alreadyMembers: 0, people: [], warnings: [] };
  const people = await readLegacyUsers(env);
  report.found = people.length;

  for (const person of people) {
    const email = person.email?.trim().toLowerCase();
    if (!email || !person.id) { report.warnings.push('Skipped a record without an id or email.'); continue; }
    const plan = await planPerson(db, orgId, person, email);
    count(report, plan, person.id);
    if (dryRun) continue;
    const statements = personStatements(db, orgId, plan, actor);
    if (statements.length) await db.batch(statements);
  }

  if (!dryRun) {
    await auditStmt(db, {
      actorUserId: actor.userId, actorKind: 'provider_admin', action: 'org.import.original_people', targetType: 'organization', targetId: orgId, orgId,
      details: { found: report.found, accountsCreated: report.accountsCreated, accountsMatched: report.accountsMatched, membershipsAdded: report.membershipsAdded },
      ip: actor.ip,
    }).run();
  }
  return report;
}
