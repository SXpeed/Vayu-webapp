// Applicant routes: a signed-in person working on THEIR OWN application.
//
//   GET   /apply            my application, its status and messages
//   PUT   /apply            save (creates the draft on first save)
//   POST  /apply/submit     send for review (repeating it changes nothing)
//   POST  /apply/withdraw
//
// The application is always found from the session, never from an id in the
// request, so nobody can read or change someone else's application.
// Applicants get no access to any organization until one is approved and
// provisioned; organization routes check memberships, which do not exist
// before that.

import type { PlatformAuth } from './auth';
import { fail, jsonBody, reply } from './http';
import { OrgError } from './orgs';
import { getMyApplication, saveMyApplication, submitMyApplication, withdrawMyApplication } from './applications';

export async function handleApplyRoute(db: D1Database, auth: PlatformAuth, request: Request, path: string): Promise<Response | null> {
  if (path !== '/apply' && !path.startsWith('/apply/')) return null;
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return fail(401, 'unauthenticated', 'Sign in first.');
  const userId = session.user.id;
  const method = request.method;
  try {
    if (path === '/apply' && method === 'GET') return reply(await getMyApplication(db, userId));
    if (path === '/apply' && method === 'PUT') return reply(await saveMyApplication(db, userId, await jsonBody(request)));
    if (path === '/apply/submit' && method === 'POST') return reply(await submitMyApplication(db, userId, session.user.email));
    if (path === '/apply/withdraw' && method === 'POST') return reply(await withdrawMyApplication(db, userId));
  } catch (e) {
    if (e instanceof OrgError) return fail(e.status, e.code, e.message);
    throw e;
  }
  return fail(404, 'not_found', 'Not found');
}
