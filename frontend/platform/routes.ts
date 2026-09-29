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
//   PUT             /api/v2/admin/orgs/:id/payments/razorpay/test-links  { allow } test keys may make customer links
//   DELETE          /api/v2/admin/orgs/:id/payments/razorpay/app  clear the retired "app account" setting (POST: 410)
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
//   DELETE          /api/v2/admin/plans/:id                  delete a plan nobody uses
//   PUT|DELETE      /api/v2/admin/plans/:id/offer            limited-time offer
//   POST            /api/v2/admin/plans/:id/versions/:vid/reprice  new price for new customers
//   POST            /api/v2/admin/plans/:id/versions/:vid/move     move its organizations to another version
//   POST            /api/v2/admin/orgs/:id/subscription/extend     add days to its plan
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
//   POST            /api/v2/webhooks/billing/razorpay        signed, the platform's own account (plan payments)
//   GET             /api/v2/admin/secrets?verify=1          which key each stored credential uses (owners, admins)
//   POST            /api/v2/admin/secrets/rotation          start re-encrypting under the active key
//   POST            /api/v2/admin/secrets/rotation/batch    run one batch of it (also every 10 minutes)
//   GET|PUT|DELETE  /api/v2/admin/billing/razorpay           the account organizations pay their plans into
//   POST            /api/v2/admin/billing/razorpay/verify
//   GET             /api/v2/admin/billing/payments?status=&org=  every plan payment, with details
//   POST            /api/v2/admin/billing/payments/:id/recheck   ask Razorpay again
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
  parseLoginMethods, rememberLoginMethods, saveLoginMethodsStmt, validateLoginMethods, type LoginMethods,
} from './settings';
import { auditStmt } from './audit';
import {
  OrgError, addMember, createOrganization, createUserAccount, getOrganization,
  listOrganizations, setOrganizationStatus, updateMember, type Actor,
} from './orgs';
import { keyUsage, runRotationBatch, startRotation } from './secretRotation';
import { clearAppPaymentsOrg, connectRazorpay, describeRazorpay, disconnectRazorpay, receiveRazorpayWebhook, setAllowTestLinks, verifyRazorpay } from './payments';
import { importLegacyWorkspace, listImports } from './legacyImport';
import { PLAN_SCHEMA } from './planFields';
import {
  getBranding, getOrgBranding, orgLogoUrl, orgLogoUrls, publicBranding, removeOrgLogo, serveLogo, serveOrgLogo,
  updateBranding, uploadLogo, uploadOrgLogo,
} from './branding';
import {
  createPlan, createPlanVersion, deletePlan, extendSubscription, extendTrial, getPlan, listPlans, moveVersionOrganizations,
  publicPlans, removeOverride, repriceVersion, resolveEntitlements, seatUsage, setOverride, setSubscription,
  updatePlan, updatePlanVersion,
} from './plans';
import { SecretsUnavailable } from './secrets';
import { removeOffer, setOffer } from './offers';
import {
  connectBillingAccount, describeBillingAccount, disconnectBillingAccount, listAllPayments, paymentView,
  receiveBillingWebhook, recheckAnyPayment, verifyBillingAccount,
} from './billing';
import { OrgAccessError, handleOrgRequest, listMyOrganizations, resolveOrgContext } from './orgApi';

import { fail, jsonBody, reply } from './http';
import { handleCenterRoute } from './centerRoutes';
import { handleApplyRoute } from './applyRoutes';
import { deliverOutbox } from './notify';
import { acceptInvitation, createAccountFromInvitation, describeInvitation } from './invitations';
import { importOriginalPeople, setAppStorage } from './originalApp';
import { emailConfigured } from './email';
import { forgetPlanActive } from '../orgApp';
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

/** One provider-admin request, with what every admin route needs to hand. */
interface AdminCtx {
  env: Env; db: D1Database; request: Request; url: URL; path: string; method: string;
  admin: { userId: string; email: string; role: string; sessionCreatedAt: number };
  actor: Actor;
  /** Signed in within FRESH_SESSION_MS: required for the most sensitive changes. */
  fresh: boolean;
}

/** An admin route: its path (exact, or a pattern whose groups reach `run`), its methods, and whether it needs a fresh sign-in. */
interface AdminRoute {
  path: string | RegExp;
  methods: string[];
  fresh?: boolean;
  run: (c: AdminCtx, match: RegExpExecArray | null) => Promise<Response>;
}

const needFresh = () => fail(403, 'reauth_required', 'Sign in again to do this.');

/** A JSON object from the request body, or {} when it isn't one. */
async function objectBody(request: Request): Promise<Record<string, unknown>> {
  const b = await request.json().catch(() => null);
  return (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
}

/** The route matching this request, and its pattern's match; null when none does. */
function findAdminRoute(table: AdminRoute[], path: string, method: string): { route: AdminRoute; match: RegExpExecArray | null } | null {
  for (const route of table) {
    if (!route.methods.includes(method)) continue;
    if (typeof route.path === 'string') {
      if (route.path === path) return { route, match: null };
      continue;
    }
    const match = route.path.exec(path);
    if (match) return { route, match };
  }
  return null;
}

/** Runs a table's matching route, turning expected errors into replies. Null when no route matches. */
async function runAdminTable(table: AdminRoute[], c: AdminCtx): Promise<Response | null> {
  const found = findAdminRoute(table, c.path, c.method);
  if (!found) return null;
  if (found.route.fresh && !c.fresh) return needFresh();
  try {
    return await found.route.run(c, found.match);
  } catch (e) {
    if (e instanceof OrgError) return fail(e.status, e.code, e.message);
    if (e instanceof SecretsUnavailable) return fail(503, 'secrets_unavailable', 'Payment credential storage is not configured.');
    throw e;
  }
}

const hasGoogleLinked = async (c: AdminCtx) =>
  !!(await c.db.prepare("SELECT 1 FROM account WHERE userId = ? AND providerId = 'google'").bind(c.admin.userId).first());

async function saveLoginMethods(c: AdminCtx): Promise<Response> {
  let next;
  try {
    next = parseLoginMethods(await c.request.json().catch(() => null));
    validateLoginMethods(next, { googleConfigured: googleConfigured(c.env), actorHasGoogle: await hasGoogleLinked(c) });
  } catch (e) {
    if (e instanceof SettingsError) return fail(400, e.code, e.message);
    throw e;
  }
  const before = await getStoredLoginMethods(c.db);
  await c.db.batch([
    saveLoginMethodsStmt(c.db, next, c.admin.userId),
    auditStmt(c.db, {
      actorUserId: c.admin.userId, actorKind: 'provider_admin', action: 'settings.login_methods.update',
      targetType: 'platform_settings', targetId: 'login_methods', details: { before, after: next },
      ip: c.request.headers.get('cf-connecting-ip'),
    }),
  ]);
  rememberLoginMethods(next);
  return reply({ stored: next, effective: await getEffectiveLoginMethods(c.env, c.db) });
}

const SETTINGS_ROUTES: AdminRoute[] = [
  {
    path: '/admin/settings/login-methods', methods: ['GET'],
    run: async (c) => {
      const origin = resolveAuthOrigin(c.env, c.url);
      return reply({
        stored: await getStoredLoginMethods(c.db),
        effective: await getEffectiveLoginMethods(c.env, c.db),
        googleConfigured: googleConfigured(c.env),
        googleRedirectUri: origin ? `${origin}${AUTH_BASE_PATH}/callback/google` : null,
        actorHasGoogle: await hasGoogleLinked(c),
      });
    },
  },
  {
    path: '/admin/settings/login-methods', methods: ['PUT'],
    run: (c) => (c.fresh ? saveLoginMethods(c) : Promise.resolve(fail(403, 'reauth_required', 'Sign in again to change login methods.'))),
  },
  { path: '/admin/settings/branding', methods: ['GET'], run: async (c) => reply(await getBranding(c.db)) },
  {
    path: '/admin/settings/branding', methods: ['PATCH'],
    run: async (c) => reply(await updateBranding(c.db, await c.request.json().catch(() => ({})) as Record<string, unknown>, { userId: c.actor.userId, ip: c.actor.ip })),
  },
  { path: '/admin/settings/branding/logo', methods: ['POST'], run: async (c) => reply(await uploadLogo(c.env, c.db, c.request, { userId: c.actor.userId, ip: c.actor.ip })) },
  {
    path: '/admin/audit', methods: ['GET'],
    run: async (c) => {
      const limit = Math.min(Math.max(Number(c.url.searchParams.get('limit')) || 50, 1), 200);
      const { results } = await c.db.prepare(
        `SELECT a.id, a.at, a.actor_kind, a.action, a.target_type, a.target_id, a.org_id, a.details, u.email AS actor_email
         FROM platform_audit a LEFT JOIN "user" u ON u.id = a.actor_user_id
         ORDER BY a.at DESC LIMIT ?`,
      ).bind(limit).all();
      return reply({ entries: results });
    },
  },
];

const billingWebhookUrl = (c: AdminCtx) => `${c.env.API_ORIGIN || resolveAuthOrigin(c.env, c.url)}/api/v2/webhooks/billing/razorpay`;

const BILLING_ROUTES: AdminRoute[] = [
  { path: '/admin/billing/razorpay', methods: ['GET'], run: async (c) => reply(await describeBillingAccount(c.env, c.db, billingWebhookUrl(c))) },
  {
    path: '/admin/billing/razorpay', methods: ['PUT'], fresh: true,
    run: async (c) => {
      await connectBillingAccount(c.env, c.db, await jsonBody(c.request), c.actor);
      return reply(await describeBillingAccount(c.env, c.db, billingWebhookUrl(c)));
    },
  },
  {
    path: '/admin/billing/razorpay', methods: ['DELETE'], fresh: true,
    run: async (c) => {
      await disconnectBillingAccount(c.db, c.actor);
      return reply(await describeBillingAccount(c.env, c.db, billingWebhookUrl(c)));
    },
  },
  { path: '/admin/billing/razorpay', methods: ['POST', 'PATCH'], fresh: true, run: async () => fail(405, 'method_not_allowed', 'Not allowed') },
  { path: '/admin/billing/razorpay/verify', methods: ['POST'], run: async (c) => reply(await verifyBillingAccount(c.env, c.db, c.actor)) },
  { path: '/admin/billing/payments', methods: ['GET'], run: async (c) => reply(await listAllPayments(c.db, c.url.searchParams)) },
  {
    path: /^\/admin\/billing\/payments\/([A-Za-z0-9-]{1,64})\/recheck$/, methods: ['POST'],
    run: async (c, m) => {
      const out = await recheckAnyPayment(c.env, c.db, m![1]);
      return reply({ payment: paymentView(out.payment, 'provider'), checked: out.checked, applied: out.applied, reason: out.reason ?? null });
    },
  },
];

// Payment credential keys (secretRotation.ts). Owners and admins only, not
// support; starting and running a rotation also needs a recent sign-in.
const managesSecrets = (c: AdminCtx) => c.admin.role === 'owner' || c.admin.role === 'admin';
const SECRETS_ROUTES: AdminRoute[] = [
  {
    path: '/admin/secrets', methods: ['GET'],
    run: async (c) => (managesSecrets(c)
      ? reply(await keyUsage(c.env, c.db, c.url.searchParams.get('verify') === '1'))
      : fail(403, 'forbidden', 'Only owners and admins can see payment credential keys.')),
  },
  {
    path: '/admin/secrets/rotation', methods: ['POST'], fresh: true,
    run: async (c) => (managesSecrets(c)
      ? reply(await startRotation(c.env, c.db, c.actor))
      : fail(403, 'forbidden', 'Only owners and admins can rotate payment credential keys.')),
  },
  {
    path: '/admin/secrets/rotation/batch', methods: ['POST'], fresh: true,
    run: async (c) => (managesSecrets(c)
      ? reply(await runRotationBatch(c.env, c.db, c.actor))
      : fail(403, 'forbidden', 'Only owners and admins can rotate payment credential keys.')),
  },
];

const ID = '[A-Za-z0-9-]{1,64}';
const planPath = (rest = '') => new RegExp(`^/admin/plans/(${ID})${rest}$`);

const PLAN_ROUTES: AdminRoute[] = [
  // Everything a plan can control, so the editor never drifts from the server's validation.
  { path: '/admin/plans/schema', methods: ['GET'], run: async () => reply(PLAN_SCHEMA) },
  { path: '/admin/plans', methods: ['GET'], run: async (c) => reply({ plans: await listPlans(c.db) }) },
  { path: '/admin/plans', methods: ['POST'], run: async (c) => reply(await createPlan(c.db, await objectBody(c.request), c.actor), 201) },
  { path: planPath(), methods: ['GET'], run: async (c, m) => reply(await getPlan(c.db, m![1])) },
  { path: planPath(), methods: ['PATCH'], run: async (c, m) => reply(await updatePlan(c.db, m![1], await objectBody(c.request), c.actor)) },
  {
    path: planPath(), methods: ['DELETE'], fresh: true,
    run: async (c, m) => { await deletePlan(c.db, m![1], c.actor); return reply({ deleted: true }); },
  },
  {
    path: planPath('/offer'), methods: ['PUT'],
    run: async (c, m) => { await setOffer(c.db, m![1], await objectBody(c.request), c.actor); return reply(await getPlan(c.db, m![1])); },
  },
  {
    path: planPath('/offer'), methods: ['DELETE'],
    run: async (c, m) => { await removeOffer(c.db, m![1], c.actor); return reply(await getPlan(c.db, m![1])); },
  },
  {
    path: planPath(`/versions/(${ID})/reprice`), methods: ['POST'], fresh: true,
    run: async (c, m) => reply(await repriceVersion(c.db, m![1], m![2], await objectBody(c.request), c.actor)),
  },
  {
    path: planPath(`/versions/(${ID})/move`), methods: ['POST'], fresh: true,
    run: async (c, m) => reply(await moveVersionOrganizations(c.db, m![1], m![2], await objectBody(c.request), c.actor)),
  },
  { path: planPath('/versions'), methods: ['POST'], run: async (c, m) => reply(await createPlanVersion(c.db, m![1], await objectBody(c.request), c.actor), 201) },
  {
    path: planPath(`/versions/(${ID})`), methods: ['PATCH'],
    run: async (c, m) => reply(await updatePlanVersion(c.db, m![1], m![2], await objectBody(c.request), c.actor)),
  },
];

const orgPath = (rest = '') => new RegExp(`^/admin/orgs/(${ID})${rest}$`);
const orgWebhookUrl = (c: AdminCtx, orgId: string) => `${c.env.API_ORIGIN || resolveAuthOrigin(c.env, c.url)}/api/v2/webhooks/razorpay/${orgId}`;

/** A dry run by default; a real run needs a recent sign-in. */
async function dryRunOrFresh(c: AdminCtx, orgId: string, run: (env: Env, db: D1Database, orgId: string, body: Record<string, unknown>, actor: Actor) => Promise<unknown>): Promise<Response> {
  const b = await objectBody(c.request);
  if (b.dryRun === false && !c.fresh) return needFresh();
  return reply(await run(c.env, c.db, orgId, b, c.actor));
}

const ORG_ROUTES: AdminRoute[] = [
  { path: '/admin/users', methods: ['POST'], run: async (c) => reply(await createUserAccount(c.db, await objectBody(c.request), c.actor), 201) },
  { path: '/admin/orgs', methods: ['GET'], run: async (c) => reply({ organizations: await listOrganizations(c.db, c.url.searchParams) }) },
  { path: '/admin/orgs', methods: ['POST'], run: async (c) => reply(await createOrganization(c.db, await objectBody(c.request), c.actor), 201) },
  {
    path: orgPath(), methods: ['GET'],
    run: async (c, m) => {
      const [org, branding] = await Promise.all([getOrganization(c.db, m![1]), getOrgBranding(c.db, m![1])]);
      return reply({ ...org, logoUrl: orgLogoUrl(m![1], branding) });
    },
  },
  { path: orgPath('/logo'), methods: ['POST'], run: async (c, m) => reply({ logoUrl: orgLogoUrl(m![1], await uploadOrgLogo(c.env, c.db, m![1], c.request, c.actor)) }) },
  { path: orgPath('/logo'), methods: ['DELETE'], run: async (c, m) => reply({ logoUrl: orgLogoUrl(m![1], await removeOrgLogo(c.db, m![1], c.actor)) }) },
  { path: orgPath('/status'), methods: ['POST'], fresh: true, run: async (c, m) => reply(await setOrganizationStatus(c.db, m![1], await objectBody(c.request), c.actor)) },
  { path: orgPath('/members'), methods: ['POST'], run: async (c, m) => reply(await addMember(c.db, m![1], await objectBody(c.request), c.actor), 201) },
  { path: orgPath(`/members/(${ID})`), methods: ['PATCH'], run: async (c, m) => reply(await updateMember(c.db, m![1], m![2], await objectBody(c.request), c.actor)) },
  {
    path: orgPath('/payments/razorpay'), methods: ['GET'],
    run: async (c, m) => { await getOrganization(c.db, m![1]); return reply(await describeRazorpay(c.db, m![1], orgWebhookUrl(c, m![1]))); },
  },
  {
    path: orgPath('/payments/razorpay'), methods: ['PUT'], fresh: true,
    run: async (c, m) => { await connectRazorpay(c.env, c.db, m![1], await objectBody(c.request), c.actor); return reply(await describeRazorpay(c.db, m![1], orgWebhookUrl(c, m![1]))); },
  },
  {
    path: orgPath('/payments/razorpay'), methods: ['DELETE'], fresh: true,
    run: async (c, m) => { await disconnectRazorpay(c.db, m![1], c.actor); return reply(await describeRazorpay(c.db, m![1], orgWebhookUrl(c, m![1]))); },
  },
  {
    // Retired (2026-09): a global choice of which organization's account the
    // original app's links use. New links are always attributed explicitly
    // (docs/PAYMENT_SECURITY.md). DELETE still clears an old setting.
    path: orgPath('/payments/razorpay/app'), methods: ['POST'],
    run: async () => fail(410, 'retired', "Choosing an organization for the original app's payment links has been retired: links are made in the account of the workspace they're made from."),
  },
  {
    path: orgPath('/payments/razorpay/app'), methods: ['DELETE'], fresh: true,
    run: async (c, m) => { await clearAppPaymentsOrg(c.db, c.actor); return reply(await describeRazorpay(c.db, m![1], orgWebhookUrl(c, m![1]))); },
  },
  {
    // Test-mode keys may make customer links in production only when allowed here.
    path: orgPath('/payments/razorpay/test-links'), methods: ['PUT'], fresh: true,
    run: async (c, m) => {
      const body = await objectBody(c.request);
      if (typeof body.allow !== 'boolean') return fail(400, 'invalid', 'Send { "allow": true } or { "allow": false }.');
      await setAllowTestLinks(c.db, m![1], body.allow, c.actor);
      return reply(await describeRazorpay(c.db, m![1], orgWebhookUrl(c, m![1])));
    },
  },
  { path: orgPath('/payments/razorpay/verify'), methods: ['POST'], run: async (c, m) => reply(await verifyRazorpay(c.env, c.db, m![1], c.actor)) },
  {
    path: orgPath('/subscription'), methods: ['GET'],
    run: async (c, m) => {
      const [entitlements, seats] = await Promise.all([resolveEntitlements(c.db, m![1]), seatUsage(c.db, m![1])]);
      return reply({ ...entitlements, seats });
    },
  },
  { path: orgPath('/subscription'), methods: ['POST'], fresh: true, run: async (c, m) => reply(await setSubscription(c.db, m![1], await objectBody(c.request), c.actor)) },
  { path: orgPath('/subscription/extend'), methods: ['POST'], run: async (c, m) => reply(await extendSubscription(c.db, m![1], await objectBody(c.request), c.actor)) },
  { path: orgPath('/subscription/extend-trial'), methods: ['POST'], run: async (c, m) => reply(await extendTrial(c.db, m![1], await objectBody(c.request), c.actor)) },
  {
    path: orgPath('/entitlements'), methods: ['POST'], fresh: true,
    run: async (c, m) => {
      const next = await setOverride(c.db, m![1], await objectBody(c.request), c.actor);
      forgetPlanActive(m![1]); // a module switched here applies at once on this isolate
      return reply(next);
    },
  },
  {
    path: orgPath('/entitlements/(.+)'), methods: ['DELETE'], fresh: true,
    run: async (c, m) => {
      const next = await removeOverride(c.db, m![1], m![2].slice(0, 40), c.actor);
      forgetPlanActive(m![1]);
      return reply(next);
    },
  },
  { path: orgPath('/import-legacy'), methods: ['GET'], run: async (c, m) => reply({ imports: await listImports(c.db, m![1]) }) },
  { path: orgPath('/import-legacy'), methods: ['POST'], run: (c, m) => dryRunOrFresh(c, m![1], importLegacyWorkspace) },
  // Which data this organization works on in the app (originalApp.ts).
  { path: orgPath('/app-storage'), methods: ['POST'], fresh: true, run: async (c, m) => reply(await setAppStorage(c.db, m![1], await objectBody(c.request), c.actor)) },
  { path: orgPath('/import-original-people'), methods: ['POST'], run: (c, m) => dryRunOrFresh(c, m![1], importOriginalPeople) },
];

async function handleAdmin(env: Env, db: D1Database, auth: PlatformAuth, request: Request, url: URL, path: string): Promise<Response> {
  const gate = await requireProviderAdmin(env, db, auth, request, url);
  if (!gate.ok) return gate.response;
  const { admin } = gate;
  const method = request.method;

  if (path === '/admin/me' && method === 'GET') {
    return reply({ userId: admin.userId, email: admin.email, role: admin.role });
  }

  const fresh = Date.now() - admin.sessionCreatedAt <= FRESH_SESSION_MS;
  const ip = request.headers.get('cf-connecting-ip');
  const center = await handleCenterRoute(env, db, request, url, path, { userId: admin.userId, role: admin.role, ip, fresh });
  if (center) return center;

  const c: AdminCtx = { env, db, request, url, path, method, admin, actor: { userId: admin.userId, ip }, fresh };
  for (const table of [SETTINGS_ROUTES, SECRETS_ROUTES, BILLING_ROUTES, PLAN_ROUTES, ORG_ROUTES]) {
    const out = await runAdminTable(table, c);
    if (out) return out;
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

/**
 * Webhooks: plan payments into the platform's own account (billing.ts), and
 * each organization's Razorpay events, authenticated by its own signing
 * secret rather than a session. A failure answers 500, so Razorpay retries
 * and the retry finishes the work.
 */
async function handleWebhook(env: Env, db: D1Database, request: Request, path: string, hooks: PlatformHooks): Promise<Response | null> {
  const hook = /^\/webhooks\/razorpay\/([A-Za-z0-9-]{1,64})$/.exec(path);
  if (path !== '/webhooks/billing/razorpay' && !hook) return null;
  if (request.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST');
  try {
    if (!hook) {
      const out = await receiveBillingWebhook(env, db, request);
      return reply(out.body, out.status);
    }
    const out = await receiveRazorpayWebhook(env, db, hook[1], request);
    if (out.status === 200 && out.event !== undefined) await hooks.onPaymentEvent?.(hook[1], out.event);
    return reply(out.body, out.status);
  } catch (e) {
    console.error(hook ? 'razorpay webhook failed' : 'billing webhook failed', e);
    return fail(500, 'internal', 'Something went wrong.');
  }
}

const cachedFor = (res: Response, header: string): Response => { res.headers.set('Cache-Control', header); return res; };

/** Pages anyone may read: branding, logos, public plans and the login methods. */
async function handlePublic(env: Env, db: D1Database, request: Request, path: string, methods: LoginMethods): Promise<Response | null> {
  if (request.method !== 'GET') return null;
  if (path === '/public/branding') return cachedFor(reply(await publicBranding(db)), 'public, max-age=60');
  if (path === '/public/branding/logo') return serveLogo(env, db);
  const orgLogo = /^\/public\/orgs\/([A-Za-z0-9-]{1,64})\/logo$/.exec(path);
  if (orgLogo) return serveOrgLogo(env, db, orgLogo[1]);
  // Public: only published, public plans, and only what a price card needs.
  if (path === '/public/plans') return cachedFor(reply({ plans: await publicPlans(db) }), 'public, max-age=60');
  if (path === '/public/login-methods') return reply({ emailPassword: methods.emailPassword, google: methods.google });
  return null;
}

/** The signed-in person's own things: their organizations and their devices. */
async function handleMe(db: D1Database, auth: PlatformAuth, request: Request, path: string): Promise<Response | null> {
  try {
    if (path === '/me/orgs' && request.method === 'GET') {
      const organizations = await listMyOrganizations(db, auth, request) as { id: string }[];
      const logos = await orgLogoUrls(db, organizations.map(o => o.id));
      return reply({ organizations: organizations.map(o => ({ ...o, logoUrl: logos.get(o.id) ?? null })) });
    }
    if (path === '/me/sessions' && request.method === 'GET') return reply({ sessions: await listMySessions(db, auth, request) });
    if (path === '/me/sessions/signout' && request.method === 'POST') {
      const b = await jsonBody(request);
      const id = typeof b.id === 'string' && b.id ? b.id : undefined;
      return reply({ signedOut: await signOutMySessions(db, auth, request, id) });
    }
  } catch (e) {
    if (e instanceof OrgAccessError) return fail(e.status, e.code, e.message);
    throw e;
  }
  return null;
}

/**
 * An organization's own business data. resolveOrgContext checks the session,
 * the membership and the organization's status before any database is
 * opened; it never falls back to another organization.
 */
async function handleOrgData(env: Env, db: D1Database, auth: PlatformAuth, request: Request, path: string, url: URL): Promise<Response | null> {
  const org = /^\/org\/([A-Za-z0-9-]{1,64})(\/.*)?$/.exec(path);
  if (!org) return null;
  try {
    const ctx = await resolveOrgContext(env, db, auth, request, org[1]);
    return reply(await handleOrgRequest(ctx, request, org[2] ?? '', url));
  } catch (e) {
    if (e instanceof OrgAccessError) return fail(e.status, e.code, e.message);
    throw e;
  }
}

/** Everything that needs the sign-in layer, in order. */
async function handleSignedInArea(env: Env, db: D1Database, request: Request, url: URL, path: string, origin: string): Promise<Response> {
  const methods = await getEffectiveLoginMethods(env, db);
  const auth = await getAuth(env, db, origin, methods);
  if (path.startsWith('/auth/')) return cachedFor(await auth.handler(request), 'no-store');
  const pub = await handlePublic(env, db, request, path, methods);
  if (pub) return pub;
  if (path.startsWith('/admin/')) return handleAdmin(env, db, auth, request, url, path);
  const apply = await handleApplyRoute(db, auth, request, path, { requireVerifiedEmail: emailConfigured(env) });
  if (apply) return apply;
  const invitation = await handleInvitationRoute(env, db, auth, request, path);
  if (invitation) return invitation;
  return (await handleMe(db, auth, request, path))
    ?? (await handleOrgData(env, db, auth, request, path, url))
    ?? fail(404, 'not_found', 'Not found');
}

async function routePlatformRequest(request: Request, env: Env, hooks: PlatformHooks): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/v2/')) return null;
  const path = url.pathname.slice('/api/v2'.length);

  const db = env.PLATFORM_DB;
  if (!db || !env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) {
    return fail(503, 'platform_unavailable', 'The platform is not configured in this environment.');
  }
  const webhook = await handleWebhook(env, db, request, path, hooks);
  if (webhook) return webhook;

  const origin = resolveAuthOrigin(env, url);
  if (!origin) return fail(403, 'unknown_origin', 'This address is not allowed to sign in.');
  try {
    return await handleSignedInArea(env, db, request, url, path, origin);
  } catch (e) {
    console.error('platform request failed', url.pathname, e);
    return fail(500, 'internal', 'Something went wrong. Please try again.');
  }
}
