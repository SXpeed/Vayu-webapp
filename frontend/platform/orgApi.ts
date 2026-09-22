// /api/v2/org/:orgId/* — an organization's own business data.
//
// The order for every request is fixed and fails closed at each step:
//   session → active membership → organization status → role → that
//   organization's database.
//
// The organization id in the URL is only a lookup key: it is accepted only if
// the signed-in person has an active membership of that organization. A
// browser can never choose which database is opened, and there is no fallback
// to a "default" organization — unresolved means refused.

import type { Env } from '../workerEnv';
import type { PlatformAuth } from './auth';
import type { Actor } from './orgStore';
import { limitOf, resolveEntitlements } from './plans';

export interface OrgContext {
  orgId: string;
  orgName: string;
  db: D1Database;
  actor: Actor;
  store: DurableObjectStub<import('./orgStore').OrgStore>;
}

export class OrgAccessError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/** Roles allowed to change business data. Staff may read. */
const WRITE_ROLES = new Set(['owner', 'admin', 'manager', 'staff']);
const MANAGE_ROLES = new Set(['owner', 'admin', 'manager']);

export async function resolveOrgContext(env: Env, db: D1Database, auth: PlatformAuth, request: Request, orgId: string): Promise<OrgContext> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new OrgAccessError(401, 'unauthenticated', 'Sign in first.');

  // One query decides membership AND organization status, so a suspended
  // organization or a disabled member is refused before anything is opened.
  const row = await db.prepare(
    `SELECT m.role, m.status AS membership_status, o.status AS org_status, o.name
     FROM memberships m JOIN organizations o ON o.id = m.org_id
     WHERE m.org_id = ? AND m.user_id = ?`,
  ).bind(orgId, session.user.id).first<{ role: string; membership_status: string; org_status: string; name: string }>();

  // Not a member and "no such organization" answer the same way, so the API
  // never reveals which organizations exist.
  if (!row || row.membership_status !== 'active') {
    throw new OrgAccessError(403, 'no_access', 'You do not have access to this organization.');
  }
  if (row.org_status === 'suspended') throw new OrgAccessError(403, 'org_suspended', 'This organization is suspended. Contact support.');
  if (row.org_status !== 'active') throw new OrgAccessError(403, 'org_unavailable', 'This organization is not available.');

  if (!env.ORG_STORE) throw new OrgAccessError(503, 'store_unavailable', 'Organization storage is not configured in this environment.');
  // Named by organization id: one object, one database, per organization.
  const store = env.ORG_STORE.get(env.ORG_STORE.idFromName(orgId)) as DurableObjectStub<import('./orgStore').OrgStore>;

  return { orgId, orgName: row.name, db, actor: { userId: session.user.id, role: row.role }, store };
}

/** Organizations the signed-in person can open, for the workspace switcher. */
export async function listMyOrganizations(db: D1Database, auth: PlatformAuth, request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new OrgAccessError(401, 'unauthenticated', 'Sign in first.');
  const { results } = await db.prepare(
    `SELECT o.id, o.name, o.slug, o.business_type, o.status, m.role
     FROM memberships m JOIN organizations o ON o.id = m.org_id
     WHERE m.user_id = ? AND m.status = 'active' AND o.status <> 'closed'
     ORDER BY o.name`,
  ).bind(session.user.id).all();
  return results;
}

/**
 * Stops a create when the organization is at its plan's limit. Nothing is
 * deleted or hidden when a plan shrinks: existing records stay, only new ones
 * are refused.
 */
async function requireRoomFor(ctx: OrgContext, limitKey: string, countKey: string, label: string): Promise<void> {
  const entitlements = await resolveEntitlements(ctx.db, ctx.orgId);
  if (!entitlements.active) {
    throw new OrgAccessError(402, 'subscription_inactive', 'This organization’s plan is not active. Contact support to continue.');
  }
  const limit = limitOf(entitlements, limitKey);
  if (limit === null) return;
  const counts = await ctx.store.counts();
  const used = counts[countKey] ?? 0;
  if (used >= limit) {
    throw new OrgAccessError(409, 'limit_reached', `This organization's plan allows ${limit} ${label} and ${used} are stored. Remove some, or move to a larger plan.`);
  }
}

function requireRole(ctx: OrgContext, allowed: Set<string>): void {
  if (!allowed.has(ctx.actor.role)) {
    throw new OrgAccessError(403, 'forbidden', 'Your role does not allow this.');
  }
}

/**
 * Routes one organization request. `rest` is the path after the org id, e.g.
 * "/artworks" or "/artworks/<id>/status".
 */
export async function handleOrgRequest(ctx: OrgContext, request: Request, rest: string, url: URL): Promise<unknown> {
  const method = request.method;
  const body = async () => {
    const b = await request.json().catch(() => null);
    return (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
  };

  try {
    if (rest === '' && method === 'GET') {
      const info = await ctx.store.info();
      return { id: ctx.orgId, name: ctx.orgName, role: ctx.actor.role, storage: info };
    }

    if (rest === '/artworks' && method === 'GET') {
      const limit = Number(url.searchParams.get('limit')) || 200;
      const offset = Number(url.searchParams.get('offset')) || 0;
      return { artworks: await ctx.store.listArtworks(limit, offset) };
    }

    if (rest === '/artworks' && method === 'POST') {
      requireRole(ctx, WRITE_ROLES);
      await requireRoomFor(ctx, 'maxItems', 'artworks', 'inventory items');
      return await ctx.store.putArtwork(await body(), ctx.actor);
    }

    const one = /^\/artworks\/([A-Za-z0-9-]{1,64})(\/status)?$/.exec(rest);
    if (one) {
      const id = one[1];
      if (!one[2] && method === 'GET') return await ctx.store.getArtwork(id);
      if (!one[2] && method === 'PUT') {
        requireRole(ctx, WRITE_ROLES);
        return await ctx.store.putArtwork({ ...(await body()), id }, ctx.actor);
      }
      if (!one[2] && method === 'DELETE') {
        requireRole(ctx, MANAGE_ROLES);
        return await ctx.store.deleteArtwork(id, ctx.actor);
      }
      if (one[2] && method === 'POST') {
        requireRole(ctx, WRITE_ROLES);
        const b = await body();
        return await ctx.store.setArtworkStatus(id, String(b.expected ?? ''), String(b.status ?? ''), ctx.actor);
      }
    }

    if (rest === '/audit' && method === 'GET') {
      requireRole(ctx, MANAGE_ROLES);
      return { entries: await ctx.store.recentAudit(Number(url.searchParams.get('limit')) || 50) };
    }
  } catch (e) {
    // Errors thrown inside the Durable Object arrive as plain Errors; the
    // code is preserved in the message by the RPC boundary.
    const message = String((e as Error)?.message ?? e);
    const codes: Record<string, number> = { not_found: 404, conflict: 409, invalid: 400 };
    for (const [code, status] of Object.entries(codes)) {
      if (message.startsWith(`${code}: `)) {
        throw new OrgAccessError(status, code, message.slice(code.length + 2));
      }
    }
    throw e;
  }

  throw new OrgAccessError(404, 'not_found', 'Not found');
}
