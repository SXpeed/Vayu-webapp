// Account routes inside an organization (/api/o/<id>/…).
//
// There, people sign in with their platform account, so the original app's
// own sign-in, password and device routes don't apply. The team is the
// organization's memberships: adding someone is an invitation (by email,
// platform/invitations.ts), removing someone ends their membership, and an
// app role change keeps the platform role in step (the app's admins are the
// organization's admins; the owner always keeps full access).
//
// These routes are checked before the app's usual ones, only for requests
// inside an organization. Everything else runs unchanged.

import { APP_ORIGIN } from './brand';
import { configuredOrigins } from './platform/auth';
import { createInvitation, listInvitations, revokeInvitation } from './platform/invitations';
import { OrgError } from './platform/orgs';
import { ADMIN_ROLE_ID } from './permissions';
import { err, json } from './rows';
import type { Ctx, SessionData } from './workerEnv';
import { getRoles, getSession, type StoredUser } from './workerRoles';

type Handler = (ctx: Ctx) => Promise<Response>;
export interface OrgRoute { method: string; match: (path: string) => boolean; handler: Handler }

/** What these routes borrow from worker.ts. */
export interface TeamDeps {
  publicUser: (user: StoredUser) => object;
  logChange: (ctx: Ctx, session: SessionData, action: string, entity: string, id: string, details: string) => void;
  closeConnections: (ctx: Ctx, userId: string) => void;
  /** The original PUT /auth/me: name and contact details. */
  updateMe: Handler;
}

const exact = (p: string) => (path: string) => path === p;
const under = (p: string) => (path: string) => path.startsWith(p) && path.length > p.length;

async function appAdmin(ctx: Ctx): Promise<SessionData | Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  if (session.role !== ADMIN_ROLE_ID) return err('Only admins can manage the team', 403);
  return session;
}

function orgError(e: unknown): Response {
  if (e instanceof OrgError) return json({ error: e.message, code: e.code }, e.status);
  throw e;
}

interface MemberRow { id: string; role: string; user_id: string }

/** The membership behind an app user id (it can differ from the account id; see migration 0007). */
function membershipOf(ctx: Ctx, appUserId: string): Promise<MemberRow | null> {
  return ctx.env.PLATFORM_DB!.prepare(
    'SELECT id, role, user_id FROM memberships WHERE org_id = ? AND COALESCE(app_user_id, user_id) = ?',
  ).bind(ctx.env.ORG_ID, appUserId).first<MemberRow>();
}

/** Where to point invitation links: the app page the admin is on, if it is ours. */
function appOrigin(ctx: Ctx): string {
  const origin = ctx.request.headers.get('Origin');
  return origin && configuredOrigins(ctx.env).includes(origin) ? origin : APP_ORIGIN;
}

/** The app role after an edit, or why it can't change. */
async function nextAppRole(ctx: Ctx, session: SessionData, existing: StoredUser, member: MemberRow, requested?: string): Promise<string | Response> {
  if (requested === undefined || requested === existing.role) return existing.role;
  const roles = await getRoles(ctx.env.VAYU_KV);
  if (!roles.some(r => r.id === requested)) return err('That role does not exist', 400);
  if (existing.id === session.userId && existing.role === ADMIN_ROLE_ID) return err("You can't remove your own admin role", 400);
  if (member.role === 'owner' && requested !== ADMIN_ROLE_ID) return err('The owner always has full access.', 400);
  return requested;
}

/** The app's admins manage the organization's team too; the owner stays owner. */
async function syncPlatformRole(ctx: Ctx, member: MemberRow, appRole: string): Promise<void> {
  if (member.role === 'owner') return;
  let platformRole = member.role;
  if (appRole === ADMIN_ROLE_ID) platformRole = 'admin';
  else if (member.role === 'admin') platformRole = 'staff';
  if (platformRole === member.role) return;
  await ctx.env.PLATFORM_DB!.prepare('UPDATE memberships SET role = ?, updated_at = ? WHERE id = ?').bind(platformRole, Date.now(), member.id).run();
}

export function orgAccountRoutes(deps: TeamDeps): OrgRoute[] {
  const notHere: Handler = async () => err('Not available here: your account is managed at sign-in.', 404);

  const invitationsList: Handler = async (ctx) => {
    const session = await appAdmin(ctx);
    if (session instanceof Response) return session;
    return json(await listInvitations(ctx.env.PLATFORM_DB!, ctx.env.ORG_ID!));
  };

  const invitationsCreate: Handler = async (ctx) => {
    const session = await appAdmin(ctx);
    if (session instanceof Response) return session;
    const body = await ctx.request.json<{ email?: unknown; role?: unknown }>().catch(() => ({} as { email?: unknown; role?: unknown }));
    const roles = await getRoles(ctx.env.VAYU_KV);
    const appRole = typeof body.role === 'string' && roles.some(r => r.id === body.role) ? body.role : 'user';
    try {
      const result = await createInvitation(ctx.env, ctx.env.PLATFORM_DB!, {
        orgId: ctx.env.ORG_ID!, email: body.email, appRole,
        invitedBy: session.platformUserId ?? session.userId, inviterName: session.name, appOrigin: appOrigin(ctx),
      });
      deps.logChange(ctx, session, 'created', 'invitation', result.invitation.id, `Invited ${result.invitation.email}`);
      return json(result, 201);
    } catch (e) { return orgError(e); }
  };

  const invitationsRevoke: Handler = async (ctx) => {
    const session = await appAdmin(ctx);
    if (session instanceof Response) return session;
    const id = decodeURIComponent(ctx.path.slice('/team/invitations/'.length));
    try {
      await revokeInvitation(ctx.env.PLATFORM_DB!, ctx.env.ORG_ID!, id, session.platformUserId ?? session.userId);
      deps.logChange(ctx, session, 'deleted', 'invitation', id, 'Withdrew an invitation');
      return json({ success: true });
    } catch (e) { return orgError(e); }
  };

  const usersCreate: Handler = async () =>
    json({ error: 'Invite people by email instead: they choose their own password or sign in with Google.', code: 'use_invitations' }, 400);

  const usersUpdate: Handler = async (ctx) => {
    const session = await appAdmin(ctx);
    if (session instanceof Response) return session;
    const userId = decodeURIComponent(ctx.path.slice('/auth/users/'.length));
    const key = `auth:user:${userId}`;
    const raw = await ctx.env.VAYU_KV.get(key);
    const member = raw ? await membershipOf(ctx, userId) : null;
    if (!raw || !member) return err('User not found', 404);
    const existing = JSON.parse(raw) as StoredUser;
    const body = await ctx.request.json<{ name?: string; email?: string; role?: string; password?: string; storeId?: string }>();
    if ((body.email && body.email.trim().toLowerCase() !== existing.email) || body.password) {
      return err('People change their own email and password when they sign in.', 400);
    }
    const role = await nextAppRole(ctx, session, existing, member, body.role);
    if (role instanceof Response) return role;
    const updated: StoredUser = {
      ...existing,
      name: body.name?.trim().slice(0, 100) || existing.name,
      role,
      storeId: typeof body.storeId === 'string' ? body.storeId : existing.storeId,
    };
    await ctx.env.VAYU_KV.put(key, JSON.stringify(updated));
    await syncPlatformRole(ctx, member, role);
    deps.logChange(ctx, session, 'updated', 'user', userId, `Updated "${updated.name}" (${updated.email})`);
    return json({ ...deps.publicUser(updated), deviceLimit: null, devices: [] });
  };

  const usersDelete: Handler = async (ctx) => {
    const session = await appAdmin(ctx);
    if (session instanceof Response) return session;
    const userId = decodeURIComponent(ctx.path.slice('/auth/users/'.length));
    if (userId === session.userId) return err('You can\'t remove yourself', 400);
    const member = await membershipOf(ctx, userId);
    if (!member) return err('User not found', 404);
    if (member.role === 'owner') return err('The owner can\'t be removed. Contact support to hand over the workspace.', 400);
    await ctx.env.PLATFORM_DB!.prepare('DELETE FROM memberships WHERE id = ?').bind(member.id).run();
    const raw = await ctx.env.VAYU_KV.get(`auth:user:${userId}`);
    const name = raw ? (JSON.parse(raw) as StoredUser).name : userId;
    // The record stays, so their name still shows on what they wrote; the
    // membership is what lets them in, and it is gone.
    deps.closeConnections(ctx, userId);
    deps.logChange(ctx, session, 'deleted', 'user', userId, `Removed "${name}" from the team`);
    return json({ success: true });
  };

  const meUpdate: Handler = async (ctx) => {
    const session = await getSession(ctx.request, ctx.env.VAYU_KV);
    const res = await deps.updateMe(ctx);
    // Their name belongs to their account: keep the account in step.
    if (res.ok && session?.platformUserId) {
      const saved = await res.clone().json<{ name?: string }>().catch(() => ({} as { name?: string }));
      if (saved.name) {
        await ctx.env.PLATFORM_DB!.prepare('UPDATE "user" SET name = ?, updatedAt = ? WHERE id = ?')
          .bind(saved.name, new Date().toISOString(), session.platformUserId).run();
      }
    }
    return res;
  };

  return [
    { method: 'GET', match: exact('/auth/status'), handler: async () => json({ needsSetup: false }) },
    { method: 'POST', match: exact('/auth/setup'), handler: notHere },
    { method: 'POST', match: exact('/auth/login'), handler: notHere },
    { method: 'PUT', match: exact('/auth/me'), handler: meUpdate },
    { method: 'GET', match: exact('/auth/devices'), handler: async () => json({ limit: null, devices: [] }) },
    { method: 'POST', match: exact('/auth/devices/signout'), handler: notHere },
    { method: 'POST', match: exact('/auth/devices/signout-others'), handler: notHere },
    { method: 'POST', match: (p) => /^\/auth\/users\/[^/]+\/devices\/signout$/.test(p), handler: notHere },
    { method: 'POST', match: exact('/auth/users'), handler: usersCreate },
    { method: 'PUT', match: under('/auth/users/'), handler: usersUpdate },
    { method: 'DELETE', match: under('/auth/users/'), handler: usersDelete },
    { method: 'GET', match: exact('/team/invitations'), handler: invitationsList },
    { method: 'POST', match: exact('/team/invitations'), handler: invitationsCreate },
    { method: 'DELETE', match: under('/team/invitations/'), handler: invitationsRevoke },
  ];
}
