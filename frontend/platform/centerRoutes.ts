// Control-centre routes (provider admins only; the caller has already passed
// requireProviderAdmin):
//
//   GET    /admin/overview
//   GET    /admin/applications?status=
//   GET    /admin/applications/:id
//   POST   /admin/applications/:id/approve        { planVersionId?, waivePayment?, reason? }
//   POST   /admin/applications/:id/reject         { reason }
//   POST   /admin/applications/:id/request-info   { message }
//   POST   /admin/applications/:id/change-plan    { planKey, reason }
//   GET    /admin/accounts?q=
//   GET    /admin/accounts/:id
//   POST   /admin/accounts/:id/status             { status, reason }
//   POST   /admin/accounts/:id/revoke-sessions
//   POST   /admin/accounts/:id/reset-password     { temporaryPassword }
//   GET    /admin/admins
//   POST   /admin/admins                          { email, role }        owner only
//   PATCH  /admin/admins/:userId                  { role?, status? }     owner only
//   GET    /admin/notifications?status=
//   POST   /admin/notifications/:id/retry | /cancel
//   GET|PUT /admin/settings/notifications         { providerEmail }
//   GET    /admin/health
//
// Changes to accounts, administrators and approvals need a sign-in newer than
// 30 minutes, like the other sensitive settings.

import type { Env } from '../workerEnv';
import { fail, jsonBody, reply } from './http';
import { OrgError } from './orgs';
import { emailConfigured } from './email';
import {
  approveApplication, changeRequestedPlan, getApplication, listApplications,
  rejectApplication, requestInformation,
} from './applications';
import {
  addAdmin, getUser, listAdmins, listUsers, overview, resetPassword, revokeSessions,
  setUserStatus, systemHealth, updateAdmin,
} from './adminCenter';
import {
  cancelNotification, getNotificationSettings, listOutbox, retryNotification, updateNotificationSettings,
} from './notify';

export interface CenterAdmin {
  userId: string;
  role: string;
  ip: string | null;
  fresh: boolean;
}

const ID = '([A-Za-z0-9-]{1,64})';

/** One control-centre request. */
interface CenterCtx {
  env: Env; db: D1Database; request: Request; url: URL; admin: CenterAdmin;
  actor: { userId: string; ip: string | null };
}

/** A route: path (exact, or a pattern whose groups reach `run`), method, and whether it needs a fresh sign-in. */
interface CenterRoute {
  method: string;
  path: string | RegExp;
  fresh?: boolean;
  run: (c: CenterCtx, m: readonly string[]) => Promise<Response>;
}

const route = (method: string, path: string | RegExp, run: CenterRoute['run'], fresh = false): CenterRoute => ({ method, path, run, fresh });
const at = (rest: string) => new RegExp(`^/admin/${rest}$`);
const withRole = (c: CenterCtx) => ({ ...c.actor, role: c.admin.role });

const CENTER_ROUTES: CenterRoute[] = [
  route('GET', '/admin/overview', async c => reply(await overview(c.env, c.db))),
  route('GET', '/admin/health', async c => reply(await systemHealth(c.env, c.db))),

  // Applications
  route('GET', '/admin/applications', async c => reply(await listApplications(c.db, c.url.searchParams))),
  route('GET', at(`applications/${ID}`), async (c, m) => reply(await getApplication(c.db, m[1]))),
  route('POST', at(`applications/${ID}/approve`), async (c, m) => reply(await approveApplication(c.env, c.db, m[1], await jsonBody(c.request), c.actor)), true),
  route('POST', at(`applications/${ID}/reject`), async (c, m) => reply(await rejectApplication(c.db, m[1], await jsonBody(c.request), c.actor))),
  route('POST', at(`applications/${ID}/request-info`), async (c, m) => reply(await requestInformation(c.db, m[1], await jsonBody(c.request), c.actor))),
  route('POST', at(`applications/${ID}/change-plan`), async (c, m) => reply(await changeRequestedPlan(c.db, m[1], await jsonBody(c.request), c.actor))),

  // Accounts (people who can sign in)
  route('GET', '/admin/accounts', async c => reply({ accounts: await listUsers(c.db, c.url.searchParams) })),
  route('GET', at(`accounts/${ID}`), async (c, m) => reply(await getUser(c.db, m[1]))),
  route('POST', at(`accounts/${ID}/status`), async (c, m) => reply(await setUserStatus(c.db, m[1], await jsonBody(c.request), c.actor)), true),
  route('POST', at(`accounts/${ID}/revoke-sessions`), async (c, m) => { await jsonBody(c.request); return reply(await revokeSessions(c.db, m[1], c.actor)); }, true),
  route('POST', at(`accounts/${ID}/reset-password`), async (c, m) => reply(await resetPassword(c.db, m[1], await jsonBody(c.request), c.actor)), true),

  // Provider administrators
  route('GET', '/admin/admins', async c => reply({ admins: await listAdmins(c.db) })),
  route('POST', '/admin/admins', async c => reply({ admins: await addAdmin(c.db, await jsonBody(c.request), withRole(c)) }), true),
  route('PATCH', at(`admins/${ID}`), async (c, m) => reply({ admins: await updateAdmin(c.db, m[1], await jsonBody(c.request), withRole(c)) }), true),

  // Notifications
  route('GET', '/admin/notifications', async c => reply(await listOutbox(c.db, c.url.searchParams))),
  route('POST', at(`notifications/${ID}/(retry|cancel)`), async (c, m) => {
    if (m[2] === 'retry') await retryNotification(c.db, m[1], c.actor);
    else await cancelNotification(c.db, m[1], c.actor);
    return reply(await listOutbox(c.db, c.url.searchParams));
  }),
  route('GET', '/admin/settings/notifications', async c => reply({ ...await getNotificationSettings(c.db), emailConfigured: emailConfigured(c.env) })),
  route('PUT', '/admin/settings/notifications', async c => reply(await updateNotificationSettings(c.db, await jsonBody(c.request), c.actor))),
];

function matchCenterRoute(path: string, method: string): { r: CenterRoute; m: readonly string[] } | null {
  for (const r of CENTER_ROUTES) {
    if (r.method !== method) continue;
    if (typeof r.path === 'string') {
      if (r.path === path) return { r, m: [path] };
      continue;
    }
    const m = r.path.exec(path);
    if (m) return { r, m };
  }
  return null;
}

export async function handleCenterRoute(env: Env, db: D1Database, request: Request, url: URL, path: string, admin: CenterAdmin): Promise<Response | null> {
  const found = matchCenterRoute(path, request.method);
  if (!found) return null;
  if (found.r.fresh && !admin.fresh) return fail(403, 'reauth_required', 'Sign in again to do this.');
  const c: CenterCtx = { env, db, request, url, admin, actor: { userId: admin.userId, ip: admin.ip } };
  try {
    return await found.r.run(c, found.m);
  } catch (e) {
    if (e instanceof OrgError) return fail(e.status, e.code, e.message);
    throw e;
  }
}
