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

export async function handleCenterRoute(env: Env, db: D1Database, request: Request, url: URL, path: string, admin: CenterAdmin): Promise<Response | null> {
  const method = request.method;
  const actor = { userId: admin.userId, ip: admin.ip };
  const needFresh = () => fail(403, 'reauth_required', 'Sign in again to do this.');
  let m: RegExpExecArray | null;

  try {
    if (path === '/admin/overview' && method === 'GET') return reply(await overview(env, db));
    if (path === '/admin/health' && method === 'GET') return reply(await systemHealth(env, db));

    // Applications
    if (path === '/admin/applications' && method === 'GET') return reply(await listApplications(db, url.searchParams));
    if ((m = new RegExp(`^/admin/applications/${ID}$`).exec(path)) && method === 'GET') return reply(await getApplication(db, m[1]));
    if ((m = new RegExp(`^/admin/applications/${ID}/(approve|reject|request-info|change-plan)$`).exec(path)) && method === 'POST') {
      const body = await jsonBody(request);
      switch (m[2]) {
        case 'approve':
          if (!admin.fresh) return needFresh();
          return reply(await approveApplication(env, db, m[1], body, actor));
        case 'reject': return reply(await rejectApplication(db, m[1], body, actor));
        case 'request-info': return reply(await requestInformation(db, m[1], body, actor));
        case 'change-plan': return reply(await changeRequestedPlan(db, m[1], body, actor));
      }
    }

    // Accounts (people who can sign in)
    if (path === '/admin/accounts' && method === 'GET') return reply({ accounts: await listUsers(db, url.searchParams) });
    if ((m = new RegExp(`^/admin/accounts/${ID}$`).exec(path)) && method === 'GET') return reply(await getUser(db, m[1]));
    if ((m = new RegExp(`^/admin/accounts/${ID}/(status|revoke-sessions|reset-password)$`).exec(path)) && method === 'POST') {
      if (!admin.fresh) return needFresh();
      const body = await jsonBody(request);
      if (m[2] === 'status') return reply(await setUserStatus(db, m[1], body, actor));
      if (m[2] === 'revoke-sessions') return reply(await revokeSessions(db, m[1], actor));
      return reply(await resetPassword(db, m[1], body, actor));
    }

    // Provider administrators
    if (path === '/admin/admins' && method === 'GET') return reply({ admins: await listAdmins(db) });
    if (path === '/admin/admins' && method === 'POST') {
      if (!admin.fresh) return needFresh();
      return reply({ admins: await addAdmin(db, await jsonBody(request), { ...actor, role: admin.role }) });
    }
    if ((m = new RegExp(`^/admin/admins/${ID}$`).exec(path)) && method === 'PATCH') {
      if (!admin.fresh) return needFresh();
      return reply({ admins: await updateAdmin(db, m[1], await jsonBody(request), { ...actor, role: admin.role }) });
    }

    // Notifications
    if (path === '/admin/notifications' && method === 'GET') return reply(await listOutbox(db, url.searchParams));
    if ((m = new RegExp(`^/admin/notifications/${ID}/(retry|cancel)$`).exec(path)) && method === 'POST') {
      if (m[2] === 'retry') await retryNotification(db, m[1], actor);
      else await cancelNotification(db, m[1], actor);
      return reply(await listOutbox(db, url.searchParams));
    }
    if (path === '/admin/settings/notifications' && method === 'GET') return reply({ ...await getNotificationSettings(db), emailConfigured: emailConfigured(env) });
    if (path === '/admin/settings/notifications' && method === 'PUT') {
      return reply(await updateNotificationSettings(db, await jsonBody(request), actor));
    }
  } catch (e) {
    if (e instanceof OrgError) return fail(e.status, e.code, e.message);
    throw e;
  }
  return null;
}
