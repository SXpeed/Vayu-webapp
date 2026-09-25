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
//   POST            /api/v2/admin/orgs/:id/app-storage       use the original app's data (or its own)
//   POST            /api/v2/admin/orgs/:id/import-original-people  the original app's people join it
//   GET|POST        /api/v2/invitations/:token[/accept|/create-account]  the join page
//   GET             /api/v2/admin/plans/schema               every limit/feature a plan can set
//   GET|POST        /api/v2/admin/plans                      plans and versions
//   GET|PATCH       /api/v2/admin/plans/:id
//   POST            /api/v2/admin/plans/:id/versions
//   PATCH           /api/v2/admin/plans/:id/versions/:vid    edit a draft / publish / retire
//   GET|POST        /api/v2/admin/orgs/:id/subscription      plan, trial, waiver
//   POST            /api/v2/admin/orgs/:id/subscription/extend-trial
//   POST|DELETE     /api/v2/admin/orgs/:id/entitlements      documented overrides
//   GET             /api/v2/public/plans                     published public plans
//   GET             /api/v2/public/branding                  platform name, tagline, logo
//   GET             /api/v2/public/branding/logo             the logo file
//   GET             /api/v2/public/orgs/:id/logo             an organization's own logo
//   POST|DELETE     /api/v2/admin/orgs/:id/logo              set (raw image body) / remove it
//   GET|PATCH       /api/v2/admin/settings/branding          name, tagline, accent colour
//   POST            /api/v2/admin/settings/branding/logo     upload a logo (raw image body)
//   POST            /api/v2/webhooks/razorpay/:orgId         signed, per organization
//   GET             /api/v2/me/orgs                          my organizations
//   GET             /api/v2/me/sessions                      my signed-in devices
//   POST            /api/v2/me/sessions/signout { id? }      sign out one other device, or all of them
//   /api/v2/org/:orgId/*                                     that org's own data
//   /api/v2/apply*                                           my business application (applyRoutes.ts)
//   /api/v2/admin/{overview,applications,accounts,admins,notifications,health}  (centerRoutes.ts)
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
import { connectRazorpay, describeRazorpay, disconnectRazorpay, receiveRazorpayWebhook, setAppPaymentsOrg, verifyRazorpay } from './payments';
import { importLegacyWorkspace, listImports } from './legacyImport';
import { PLAN_SCHEMA } from './planFields';
import {
  getBranding, getOrgBranding, orgLogoUrl, orgLogoUrls, publicBranding, removeOrgLogo, serveLogo, serveOrgLogo,
  updateBranding, uploadLogo, uploadOrgLogo,
} from './branding';
import {
  createPlan, createPlanVersion, extendTrial, getPlan, listPlans, publicPlans,
  removeOverride, resolveEntitlements, seatUsage, setOverride, setSubscription,
  updatePlan, updatePlanVersion,
} from './plans';
import { SecretsUnavailable } from './secrets';
import { OrgAccessError, handleOrgRequest, listMyOrganizations, resolveOrgContext } from './orgApi';

import { fail, jsonBody, reply } from './http';
import { handleCenterRoute } from './centerRoutes';
import { handleApplyRoute } from './applyRoutes';
import { deliverOutbox } from './notify';
import { acceptInvitation, createAccountFromInvitation, describeInvitation } from './invitations';
import { importOriginalPeople, setAppStorage } from './originalApp';
import { emailConfigured } from './email';
import { listMySessions, signOutMySessions } from './mySessions';

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

  const center = await handleCenterRoute(env, db, request, url, path, {
    userId: admin.userId,
    role: admin.role,
    ip: request.headers.get('cf-connecting-ip'),
    fresh: Date.now() - admin.sessionCreatedAt <= FRESH_SESSION_MS,
  });
  if (center) return center;

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

  if (path === '/admin/settings/branding' && method === 'GET') {
    return reply(await getBranding(db));
  }

  if (path === '/admin/settings/branding' && method === 'PATCH') {
    try {
      return reply(await updateBranding(db, await request.json().catch(() => ({})) as Record<string, unknown>, {
        userId: admin.userId, ip: request.headers.get('cf-connecting-ip'),
      }));
    } catch (e) {
      if (e instanceof OrgError) return fail(e.status, e.code, e.message);
      throw e;
    }
  }

  if (path === '/admin/settings/branding/logo' && method === 'POST') {
    try {
      return reply(await uploadLogo(env, db, request, { userId: admin.userId, ip: request.headers.get('cf-connecting-ip') }));
    } catch (e) {
      if (e instanceof OrgError) return fail(e.status, e.code, e.message);
      throw e;
    }
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

  const planRoute = /^\/admin\/plans(?:\/([A-Za-z0-9-]{1,64})(\/.*)?)?$/.exec(path);
  if (planRoute) {
    const actor: Actor = { userId: admin.userId, ip: request.headers.get('cf-connecting-ip') };
    const planBody = async () => {
      const b = await request.json().catch(() => null);
      return (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
    };
    try {
      const planId = planRoute[1];
      const rest = planRoute[2] ?? '';
      if (planId === 'schema' && method === 'GET') {
        // Everything a plan can control, so the editor never drifts from the
        // server's validation.
        return reply(PLAN_SCHEMA);
      }
      if (!planId) {
        if (method === 'GET') return reply({ plans: await listPlans(db) });
        if (method === 'POST') return reply(await createPlan(db, await planBody(), actor), 201);
      } else if (rest === '' && method === 'GET') {
        return reply(await getPlan(db, planId));
      } else if (rest === '' && method === 'PATCH') {
        return reply(await updatePlan(db, planId, await planBody(), actor));
      } else if (rest === '/versions' && method === 'POST') {
        return reply(await createPlanVersion(db, planId, await planBody(), actor), 201);
      } else if (rest.startsWith('/versions/') && method === 'PATCH') {
        const vid = rest.slice('/versions/'.length);
        if (!/^[A-Za-z0-9-]{1,64}$/.test(vid)) return fail(404, 'not_found', 'Not found');
        return reply(await updatePlanVersion(db, planId, vid, await planBody(), actor));
      }
    } catch (e) {
      if (e instanceof OrgError) return fail(e.status, e.code, e.message);
      throw e;
    }
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
        const [org, branding] = await Promise.all([getOrganization(db, orgId), getOrgBranding(db, orgId)]);
        return reply({ ...org, logoUrl: orgLogoUrl(orgId, branding) });
      } else if (rest === '/logo' && (method === 'POST' || method === 'DELETE')) {
        const branding = method === 'POST'
          ? await uploadOrgLogo(env, db, orgId, request, actor)
          : await removeOrgLogo(db, orgId, actor);
        return reply({ logoUrl: orgLogoUrl(orgId, branding) });
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
        const origin = env.API_ORIGIN || resolveAuthOrigin(env, url);
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
      } else if (rest === '/payments/razorpay/app' && (method === 'POST' || method === 'DELETE')) {
        // Which account the app's payment links use: this organization's
        // (POST) or, if it was this one, back to the shared account (DELETE).
        if (!fresh) return needFresh();
        await setAppPaymentsOrg(db, method === 'POST' ? orgId : null, actor);
        const origin = env.API_ORIGIN || resolveAuthOrigin(env, url);
        return reply(await describeRazorpay(db, orgId, `${origin}/api/v2/webhooks/razorpay/${orgId}`));
      } else if (rest === '/subscription' && method === 'GET') {
        const [entitlements, seats] = await Promise.all([resolveEntitlements(db, orgId), seatUsage(db, orgId)]);
        return reply({ ...entitlements, seats });
      } else if (rest === '/subscription' && method === 'POST') {
        if (!fresh) return needFresh();
        return reply(await setSubscription(db, orgId, await body(), actor));
      } else if (rest === '/subscription/extend-trial' && method === 'POST') {
        return reply(await extendTrial(db, orgId, await body(), actor));
      } else if (rest === '/entitlements' && method === 'POST') {
        if (!fresh) return needFresh();
        return reply(await setOverride(db, orgId, await body(), actor));
      } else if (rest.startsWith('/entitlements/') && method === 'DELETE') {
        if (!fresh) return needFresh();
        return reply(await removeOverride(db, orgId, rest.slice('/entitlements/'.length).slice(0, 40), actor));
      } else if (rest === '/import-legacy' && method === 'GET') {
        return reply({ imports: await listImports(db, orgId) });
      } else if (rest === '/import-legacy' && method === 'POST') {
        // Dry run by default; a real import needs a recent sign-in.
        const b = await body();
        if (b.dryRun === false && !fresh) return needFresh();
        return reply(await importLegacyWorkspace(env, db, orgId, b, actor));
      } else if (rest === '/payments/razorpay/verify' && method === 'POST') {
        return reply(await verifyRazorpay(env, db, orgId, actor));
      } else if (rest === '/app-storage' && method === 'POST') {
        // Which data this organization works on in the app (originalApp.ts).
        if (!fresh) return needFresh();
        return reply(await setAppStorage(db, orgId, await body(), actor));
      } else if (rest === '/import-original-people' && method === 'POST') {
        const b = await body();
        if (b.dryRun === false && !fresh) return needFresh();
        return reply(await importOriginalPeople(env, db, orgId, b, actor));
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
/** What the Worker around the platform API hooks into. */
export interface PlatformHooks {
  /** A verified Razorpay event for an organization (the app applies its own payment links). */
  onPaymentEvent?: (orgId: string, event: unknown) => Promise<void>;
  /** Work to finish after the response (the request's ExecutionContext.waitUntil). */
  waitUntil?: (work: Promise<unknown>) => void;
}

export async function handlePlatformRequest(request: Request, env: Env, hooks: PlatformHooks = {}): Promise<Response | null> {
  const res = await routePlatformRequest(request, env, hooks);
  // A change may have queued notices (application sent, approved, ...):
  // send them now rather than waiting for the scheduled run.
  if (res && res.ok && request.method !== 'GET' && emailConfigured(env) && env.PLATFORM_DB && hooks.waitUntil) {
    const db = env.PLATFORM_DB;
    hooks.waitUntil(deliverOutbox(env, db).catch(e => console.error('outbox delivery failed', e)));
  }
  return res;
}

/** Invitations: the join page (app /join/<token>) reads and accepts them. */
async function handleInvitationRoute(env: Env, db: D1Database, auth: PlatformAuth, request: Request, path: string): Promise<Response | null> {
  const invite = /^\/invitations\/([0-9a-f]{64})(\/accept|\/create-account)?$/.exec(path);
  if (!invite) return null;
  const [, token, action] = invite;
  try {
    if (!action && request.method === 'GET') return reply(await describeInvitation(db, token));
    if (action === '/accept' && request.method === 'POST') {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) return fail(401, 'unauthenticated', 'Sign in first.');
      return reply(await acceptInvitation(env, db, token, session.user));
    }
    if (action === '/create-account' && request.method === 'POST') {
      return reply(await createAccountFromInvitation(env, db, token, await jsonBody(request)));
    }
  } catch (e) {
    if (e instanceof OrgError) return fail(e.status, e.code, e.message);
    throw e;
  }
  return fail(405, 'method_not_allowed', 'Not allowed');
}

async function routePlatformRequest(request: Request, env: Env, hooks: PlatformHooks): Promise<Response | null> {
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
      // A failure here answers 500, so Razorpay retries and the retry applies it.
      if (out.status === 200 && out.event !== undefined) await hooks.onPaymentEvent?.(hook[1], out.event);
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
    const auth = await getAuth(env, db, origin, methods);

    if (path.startsWith('/auth/')) {
      const res = await auth.handler(request);
      res.headers.set('Cache-Control', 'no-store');
      return res;
    }
    if (path === '/public/branding' && request.method === 'GET') {
      const res = reply(await publicBranding(db));
      res.headers.set('Cache-Control', 'public, max-age=60');
      return res;
    }
    if (path === '/public/branding/logo' && request.method === 'GET') {
      return await serveLogo(env, db);
    }
    const orgLogo = /^\/public\/orgs\/([A-Za-z0-9-]{1,64})\/logo$/.exec(path);
    if (orgLogo && request.method === 'GET') {
      return await serveOrgLogo(env, db, orgLogo[1]);
    }
    if (path === '/public/plans' && request.method === 'GET') {
      // Public: only published, public plans, and only what a price card needs.
      const res = reply({ plans: await publicPlans(db) });
      res.headers.set('Cache-Control', 'public, max-age=60');
      return res;
    }
    if (path === '/public/login-methods' && request.method === 'GET') {
      return reply({
        emailPassword: methods.emailPassword,
        google: methods.google,
      });
    }
    if (path.startsWith('/admin/')) return await handleAdmin(env, db, auth, request, url, path);

    const apply = await handleApplyRoute(db, auth, request, path, { requireVerifiedEmail: emailConfigured(env) });
    if (apply) return apply;

    const invitation = await handleInvitationRoute(env, db, auth, request, path);
    if (invitation) return invitation;

    if (path === '/me/orgs' && request.method === 'GET') {
      try {
        const organizations = await listMyOrganizations(db, auth, request) as { id: string }[];
        const logos = await orgLogoUrls(db, organizations.map(o => o.id));
        return reply({ organizations: organizations.map(o => ({ ...o, logoUrl: logos.get(o.id) ?? null })) });
      } catch (e) {
        if (e instanceof OrgAccessError) return fail(e.status, e.code, e.message);
        throw e;
      }
    }

    if (path === '/me/sessions' || path === '/me/sessions/signout') {
      try {
        if (request.method === 'GET' && path === '/me/sessions') return reply({ sessions: await listMySessions(db, auth, request) });
        if (request.method === 'POST' && path === '/me/sessions/signout') {
          const b = await jsonBody(request);
          const id = typeof b.id === 'string' && b.id ? b.id : undefined;
          return reply({ signedOut: await signOutMySessions(db, auth, request, id) });
        }
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
