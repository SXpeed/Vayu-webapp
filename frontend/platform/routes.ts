// /api/v2/* — the platform (SaaS) API, separate from the original /api routes.
//
//   /api/v2/auth/*                    Better Auth (sign-in, sessions, 2FA, Google)
//   GET  /api/v2/public/login-methods which sign-in buttons to show
//   GET  /api/v2/admin/me             provider-admin identity check
//   GET  /api/v2/admin/settings/login-methods
//   PUT  /api/v2/admin/settings/login-methods
//   GET  /api/v2/admin/audit
//   GET|POST        /api/v2/admin/orgs                       list / create (with owner)
//   GET             /api/v2/admin/orgs/:id                   detail + members
//   POST            /api/v2/admin/orgs/:id/status            suspend / reactivate
//   POST            /api/v2/admin/orgs/:id/members           add an existing account
//   PATCH           /api/v2/admin/orgs/:id/members/:mid      role / enable / disable
//   GET|PUT|DELETE  /api/v2/admin/orgs/:id/payments/razorpay the org's own Razorpay
//   POST            /api/v2/admin/orgs/:id/payments/razorpay/verify
//   POST            /api/v2/admin/users                      create a sign-in account
//   GET|POST        /api/v2/admin/orgs/:id/import-legacy     move the original app in
//   POST            /api/v2/webhooks/razorpay/:orgId         signed, per organization
//   GET             /api/v2/me/orgs                          my organizations
//   /api/v2/org/:orgId/*                                     that org's own data
//
// Every admin route goes through requireProviderAdmin(); hiding the panel is
// not the boundary. Responses are never cacheable, and errors never carry
// internal details.

import type { Env } from '../workerEnv';
import { AUTH_BASE_PATH, getAuth, resolveAuthOrigin, type PlatformAuth } from './auth';
import {
  SettingsError, getEffectiveLoginMethods, getStoredLoginMethods, googleConfigured,
  parseLoginMethods, rememberLoginMethods, saveLoginMethodsStmt, validateLoginMethods,
} from './settings';
import { auditStmt } from './audit';
import {
  OrgError, addMember, createOrganization, createUserAccount, getOrganization,
  listOrganizations, setOrganizationStatus, updateMember, type Actor,
} from './orgs';
import { connectRazorpay, describeRazorpay, disconnectRazorpay, receiveRazorpayWebhook, verifyRazorpay } from './payments';
import { importLegacyWorkspace, listImports } from './legacyImport';
import { SecretsUnavailable } from './secrets';
import { OrgAccessError, handleOrgRequest, listMyOrganizations, resolveOrgContext } from './orgApi';

const NO_STORE = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };

function reply(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: NO_STORE });
}

function fail(status: number, code: string, message: string): Response {
  return reply({ error: message, code }, status);
}

interface AdminContext {
  userId: string;
  email: string;
  role: string;
  sessionCreatedAt: number;
}

type Gate = { ok: true; admin: AdminContext } | { ok: false; response: Response };

async function requireProviderAdmin(env: Env, db: D1Database, auth: PlatformAuth, request: Request, url: URL): Promise<Gate> {
  if (env.ADMIN_HOST && url.host !== env.ADMIN_HOST) {
    return { ok: false, response: fail(404, 'not_found', 'Not found') };
  }
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return { ok: false, response: fail(401, 'unauthenticated', 'Sign in first.') };
  const row = await db.prepare(
    "SELECT role FROM provider_admins WHERE user_id = ? AND status = 'active'",
  ).bind(session.user.id).first<{ role: string }>();
  if (!row) return { ok: false, response: fail(403, 'not_provider_admin', 'This account is not a provider administrator.') };
  if (env.ADMIN_REQUIRE_2FA !== 'off' && !session.user.twoFactorEnabled) {
    return { ok: false, response: fail(403, '2fa_required', 'Set up two-factor authentication to use the control panel.') };
  }
  return {
    ok: true,
    admin: {
      userId: session.user.id,
      email: session.user.email,
      role: row.role,
      sessionCreatedAt: new Date(session.session.createdAt).getTime(),
    },
  };
}

const FRESH_SESSION_MS = 30 * 60_000;

async function handleAdmin(env: Env, db: D1Database, auth: PlatformAuth, request: Request, url: URL, path: string): Promise<Response> {
  const gate = await requireProviderAdmin(env, db, auth, request, url);
  if (!gate.ok) return gate.response;
  const { admin } = gate;
  const method = request.method;

  if (path === '/admin/me' && method === 'GET') {
    return reply({ userId: admin.userId, email: admin.email, role: admin.role });
  }

  if (path === '/admin/settings/login-methods' && method === 'GET') {
    const stored = await getStoredLoginMethods(db);
    const effective = await getEffectiveLoginMethods(env, db);
    const origin = resolveAuthOrigin(env, url);
    const linked = await db.prepare(
      "SELECT 1 FROM account WHERE userId = ? AND providerId = 'google'",
    ).bind(admin.userId).first();
    return reply({
      stored,
      effective,
      googleConfigured: googleConfigured(env),
      googleRedirectUri: origin ? `${origin}${AUTH_BASE_PATH}/callback/google` : null,
      actorHasGoogle: !!linked,
    });
  }

  if (path === '/admin/settings/login-methods' && method === 'PUT') {
    if (Date.now() - admin.sessionCreatedAt > FRESH_SESSION_MS) {
      return fail(403, 'reauth_required', 'Sign in again to change login methods.');
    }
    let next;
    try {
      next = parseLoginMethods(await request.json().catch(() => null));
      const linked = await db.prepare(
        "SELECT 1 FROM account WHERE userId = ? AND providerId = 'google'",
      ).bind(admin.userId).first();
      validateLoginMethods(next, { googleConfigured: googleConfigured(env), actorHasGoogle: !!linked });
    } catch (e) {
      if (e instanceof SettingsError) return fail(400, e.code, e.message);
      throw e;
    }
    const before = await getStoredLoginMethods(db);
    await db.batch([
      saveLoginMethodsStmt(db, next, admin.userId),
      auditStmt(db, {
        actorUserId: admin.userId, actorKind: 'provider_admin', action: 'settings.login_methods.update',
        targetType: 'platform_settings', targetId: 'login_methods', details: { before, after: next },
        ip: request.headers.get('cf-connecting-ip'),
      }),
    ]);
    rememberLoginMethods(next);
    return reply({ stored: next, effective: await getEffectiveLoginMethods(env, db) });
  }

  if (path === '/admin/audit' && method === 'GET') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
    const { results } = await db.prepare(
      `SELECT a.id, a.at, a.actor_kind, a.action, a.target_type, a.target_id, a.org_id, a.details, u.email AS actor_email
       FROM platform_audit a LEFT JOIN "user" u ON u.id = a.actor_user_id
       ORDER BY a.at DESC LIMIT ?`,
    ).bind(limit).all();
    return reply({ entries: results });
  }

  const orgRoute = /^\/admin\/orgs(?:\/([A-Za-z0-9-]{1,64})(\/.*)?)?$/.exec(path);
  if (orgRoute || path === '/admin/users') {
    const actor: Actor = { userId: admin.userId, ip: request.headers.get('cf-connecting-ip') };
    const fresh = Date.now() - admin.sessionCreatedAt <= FRESH_SESSION_MS;
    const needFresh = () => fail(403, 'reauth_required', 'Sign in again to do this.');
    const body = async () => {
      const b = await request.json().catch(() => null);
      return (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
    };
    try {
      if (path === '/admin/users' && method === 'POST') {
        return reply(await createUserAccount(db, await body(), actor), 201);
      }
      const orgId = orgRoute?.[1];
      const rest = orgRoute?.[2] ?? '';
      if (!orgId) {
        if (method === 'GET') return reply({ organizations: await listOrganizations(db, url.searchParams) });
        if (method === 'POST') return reply(await createOrganization(db, await body(), actor), 201);
      } else if (rest === '' && method === 'GET') {
        return reply(await getOrganization(db, orgId));
      } else if (rest === '/status' && method === 'POST') {
        if (!fresh) return needFresh();
        return reply(await setOrganizationStatus(db, orgId, await body(), actor));
      } else if (rest === '/members' && method === 'POST') {
        return reply(await addMember(db, orgId, await body(), actor), 201);
      } else if (rest.startsWith('/members/') && method === 'PATCH') {
        const mid = rest.slice('/members/'.length);
        if (!/^[A-Za-z0-9-]{1,64}$/.test(mid)) return fail(404, 'not_found', 'Not found');
        return reply(await updateMember(db, orgId, mid, await body(), actor));
      } else if (rest === '/payments/razorpay') {
        const origin = resolveAuthOrigin(env, url);
        const webhookUrl = `${origin}/api/v2/webhooks/razorpay/${orgId}`;
        if (method === 'GET') {
          await getOrganization(db, orgId);
          return reply(await describeRazorpay(db, orgId, webhookUrl));
        }
        if (!fresh) return needFresh();
        if (method === 'PUT') {
          await connectRazorpay(env, db, orgId, await body(), actor);
          return reply(await describeRazorpay(db, orgId, webhookUrl));
        }
        if (method === 'DELETE') {
          await disconnectRazorpay(db, orgId, actor);
          return reply(await describeRazorpay(db, orgId, webhookUrl));
        }
      } else if (rest === '/import-legacy' && method === 'GET') {
        return reply({ imports: await listImports(db, orgId) });
      } else if (rest === '/import-legacy' && method === 'POST') {
        // Dry run by default; a real import needs a recent sign-in.
        const b = await body();
        if (b.dryRun === false && !fresh) return needFresh();
        return reply(await importLegacyWorkspace(env, db, orgId, b, actor));
      } else if (rest === '/payments/razorpay/verify' && method === 'POST') {
        return reply(await verifyRazorpay(env, db, orgId, actor));
      }
    } catch (e) {
      if (e instanceof OrgError) return fail(e.status, e.code, e.message);
      if (e instanceof SecretsUnavailable) return fail(503, 'secrets_unavailable', 'Payment credential storage is not configured.');
      throw e;
    }
  }

  return fail(404, 'not_found', 'Not found');
}

/** Handles /api/v2/*. Returns null for any other path. */
export async function handlePlatformRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/v2/')) return null;
  const path = url.pathname.slice('/api/v2'.length);

  const db = env.PLATFORM_DB;
  if (!db || !env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) {
    return fail(503, 'platform_unavailable', 'The platform is not configured in this environment.');
  }

  // Payment-provider webhooks: authenticated by the organization's own
  // signing secret, not by a session, so they skip the auth layer.
  const hook = /^\/webhooks\/razorpay\/([A-Za-z0-9-]{1,64})$/.exec(path);
  if (hook) {
    if (request.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST');
    try {
      const out = await receiveRazorpayWebhook(env, db, hook[1], request);
      return reply(out.body, out.status);
    } catch (e) {
      console.error('razorpay webhook failed', e);
      return fail(500, 'internal', 'Something went wrong.');
    }
  }

  const origin = resolveAuthOrigin(env, url);
  if (!origin) return fail(403, 'unknown_origin', 'This address is not allowed to sign in.');

  try {
    const methods = await getEffectiveLoginMethods(env, db);
    const auth = getAuth(env, db, origin, methods);

    if (path.startsWith('/auth/')) {
      const res = await auth.handler(request);
      res.headers.set('Cache-Control', 'no-store');
      return res;
    }
    if (path === '/public/login-methods' && request.method === 'GET') {
      return reply({
        emailPassword: methods.emailPassword,
        google: methods.google,
      });
    }
    if (path.startsWith('/admin/')) return await handleAdmin(env, db, auth, request, url, path);

    if (path === '/me/orgs' && request.method === 'GET') {
      try {
        return reply({ organizations: await listMyOrganizations(db, auth, request) });
      } catch (e) {
        if (e instanceof OrgAccessError) return fail(e.status, e.code, e.message);
        throw e;
      }
    }

    // An organization's own business data. resolveOrgContext checks the
    // session, the membership and the organization's status before any
    // database is opened; it never falls back to another organization.
    const org = /^\/org\/([A-Za-z0-9-]{1,64})(\/.*)?$/.exec(path);
    if (org) {
      try {
        const ctx = await resolveOrgContext(env, db, auth, request, org[1]);
        return reply(await handleOrgRequest(ctx, request, org[2] ?? '', url));
      } catch (e) {
        if (e instanceof OrgAccessError) return fail(e.status, e.code, e.message);
        throw e;
      }
    }
    return fail(404, 'not_found', 'Not found');
  } catch (e) {
    console.error('platform request failed', url.pathname, e);
    return fail(500, 'internal', 'Something went wrong. Please try again.');
  }
}
