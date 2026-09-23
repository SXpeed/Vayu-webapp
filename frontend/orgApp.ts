// The app, per organization.
//
// Requests to /api/o/<organization id>/<path> run the app's normal routes for
// that organization. On the way in (openOrgRequest):
//
//   1. The organization must exist and be active.
//   2. The caller's platform sign-in (Better Auth cookie) is checked, and so
//      is their membership, on every request: removing someone takes effect
//      at once. Signed in but not a member, or no such organization: the same
//      404, so the address reveals nothing. Private viewing rooms are the only
//      routes that work without a sign-in (a client with a link).
//   3. The request gets that organization's storage (orgStorageEnv): its own
//      database, files and settings, or, for the organization that owns the
//      original app's data, the original ones.
//   4. The member's record in the app (name, app role, store) is found or
//      created, and becomes the request's session, so every existing handler
//      and permission check works unchanged.
//
// Requests to /api/<path> without an organization keep working exactly as
// before, with the original app's own sign-in, for installed copies of the
// app that have not signed in again yet.

import { configuredOrigins, getAuth, resolveAuthOrigin } from './platform/auth';
import { getEffectiveLoginMethods } from './platform/settings';
import { resolveEntitlements } from './platform/plans';
import { orgDatabase, orgFilePrefix, orgKvPrefix, prefixedBucket, prefixedKv } from './orgStorage';
import type { Env, SessionData } from './workerEnv';
import type { StoredUser } from './workerRoles';

export const ORG_PATH = /^\/api\/o\/([A-Za-z0-9-]{1,64})(\/[^?]*)?$/;

export type AppStorage = 'own' | 'original';
export type MemberRole = 'owner' | 'admin' | 'manager' | 'staff';

interface OrgRow {
  id: string;
  name: string;
  status: string;
  app_storage: AppStorage;
  role: MemberRole | null;
  member_status: string | null;
  app_user_id: string | null;
}

/** The bindings the app's handlers use, pointed at one organization's storage. */
export function orgStorageEnv(env: Env, org: { id: string; app_storage: AppStorage }): Env {
  if (org.app_storage === 'original') {
    return { ...env, ORG_ID: org.id, ORG_STORAGE: 'original', FILES_BASE: '/api/files/' };
  }
  if (!env.ORG_APP_DB) throw new Error('Organization app storage (ORG_APP_DB) is not configured.');
  return {
    ...env,
    ORG_ID: org.id,
    ORG_STORAGE: 'own',
    VAYU_DB: orgDatabase(env.ORG_APP_DB, org.id),
    VAYU_KV: prefixedKv(env.VAYU_KV, orgKvPrefix(org.id)),
    VAYU_R2: prefixedBucket(env.VAYU_R2, orgFilePrefix(org.id)),
    // Realtime: one hub per organization, so updates never cross over.
    WORKSPACE_ID: `org-${org.id}`,
    FILES_BASE: `/api/o/${org.id}/files/`,
  };
}

/** The app role a new member starts with: owners and admins run the app. */
export function defaultAppRole(role: MemberRole): string {
  return role === 'owner' || role === 'admin' ? 'admin' : 'user';
}

/**
 * The member's record in the organization's app data, created on first use.
 * Holds what the app needs (name, app role, store); sign-in stays with the
 * platform account, so there is no password here.
 */
export async function ensureAppUser(
  orgEnv: Env,
  member: { appUserId: string; name: string; email: string; role: MemberRole; appRole?: string },
): Promise<StoredUser> {
  const key = `auth:user:${member.appUserId}`;
  const raw = await orgEnv.VAYU_KV.get(key);
  if (raw) return JSON.parse(raw) as StoredUser;
  const email = member.email.toLowerCase();
  const record: StoredUser = {
    id: member.appUserId,
    name: member.name || email,
    email,
    hashedPassword: '',
    role: member.appRole ?? defaultAppRole(member.role),
    createdAt: Date.now(),
  };
  await orgEnv.VAYU_KV.put(key, JSON.stringify(record));
  await orgEnv.VAYU_KV.put(`auth:email:${email}`, member.appUserId);
  return record;
}

/** Routes a client reaches with a private link and no account. */
function isPublicPath(rest: string): boolean {
  return rest.startsWith('/viewing/');
}

const notFound = () => Response.json({ error: 'Not found' }, { status: 404 });

// Whether the organization's plan lets it work (active, trialing, or no plan
// yet), remembered for a minute per organization: it changes rarely, and
// every request asks.
const planMemo = new Map<string, { at: number; active: boolean }>();
async function planActive(db: D1Database, orgId: string): Promise<boolean> {
  const hit = planMemo.get(orgId);
  if (hit && Date.now() - hit.at < 60_000) return hit.active;
  const { active } = await resolveEntitlements(db, orgId);
  if (planMemo.size > 1000) planMemo.clear();
  planMemo.set(orgId, { at: Date.now(), active });
  return active;
}

/** The platform account signed in on this request (Better Auth cookie), if any. */
async function platformSignIn(request: Request, env: Env, db: D1Database): Promise<{ user: { id: string; name: string; email: string } | null; expiresAt: number }> {
  const authOrigin = resolveAuthOrigin(env, new URL(request.url));
  if (!authOrigin) return { user: null, expiresAt: 0 };
  const auth = await getAuth(env, db, authOrigin, await getEffectiveLoginMethods(env, db));
  const signedIn = await auth.api.getSession({ headers: request.headers });
  if (!signedIn) return { user: null, expiresAt: 0 };
  return { user: signedIn.user, expiresAt: new Date(signedIn.session.expiresAt).getTime() };
}

export interface OpenedOrg {
  env: Env;
  session: SessionData | null;
  orgId: string;
}

export async function openOrgRequest(request: Request, env: Env, orgId: string, rest: string): Promise<Response | OpenedOrg> {
  const db = env.PLATFORM_DB;
  if (!db || !env.BETTER_AUTH_SECRET) return notFound();

  // Changes only from our own pages (the session cookie is SameSite=Lax too).
  const origin = request.headers.get('Origin');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && origin && !configuredOrigins(env).includes(origin)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { user, expiresAt } = await platformSignIn(request, env, db);

  const row = await db.prepare(
    `SELECT o.id, o.name, o.status, o.app_storage, m.role, m.status AS member_status, m.app_user_id
     FROM organizations o LEFT JOIN memberships m ON m.org_id = o.id AND m.user_id = ?
     WHERE o.id = ?`,
  ).bind(user?.id ?? '', orgId).first<OrgRow>();
  if (!row) return notFound();

  const member = user && row.role && row.member_status === 'active' ? row.role : null;
  // Signed in elsewhere but not here: the same answer as no such organization.
  if (user && !member && !isPublicPath(rest)) return notFound();
  if (row.status !== 'active') {
    return Response.json({ error: 'This workspace is paused. Contact support to restore it.', code: 'org_inactive' }, { status: 403 });
  }

  if (member && !(await planActive(db, orgId))) {
    return Response.json({ error: 'This workspace opens once its plan is active (payment or renewal). Contact us if this is unexpected.', code: 'subscription_inactive' }, { status: 402 });
  }

  const orgEnv = orgStorageEnv(env, row);
  let session: SessionData | null = null;
  if (user && member) {
    const record = await ensureAppUser(orgEnv, { appUserId: row.app_user_id ?? user.id, name: user.name, email: user.email, role: member });
    session = { userId: record.id, email: record.email, name: record.name, role: record.role, expiresAt, platformUserId: user.id };
  }
  return { env: orgEnv, session, orgId };
}

/**
 * The organization's active members, as the app's user records (created for
 * anyone who has not opened the app yet), for the team list and pickers.
 */
export async function orgMemberRecords(env: Env): Promise<StoredUser[]> {
  const db = env.PLATFORM_DB;
  if (!db || !env.ORG_ID) return [];
  const { results } = await db.prepare(
    `SELECT m.role, m.app_user_id, u.id AS user_id, u.name, u.email FROM memberships m
     JOIN "user" u ON u.id = m.user_id WHERE m.org_id = ? AND m.status = 'active'`,
  ).bind(env.ORG_ID).all<{ role: MemberRole; app_user_id: string | null; user_id: string; name: string; email: string }>();
  return Promise.all(results.map(m => ensureAppUser(env, {
    appUserId: m.app_user_id ?? m.user_id, name: m.name, email: m.email, role: m.role,
  })));
}
