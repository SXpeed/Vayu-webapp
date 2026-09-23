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

export interface ApplyOptions {
  /** With email sending set up, an application can only be sent from a confirmed address. */
  requireVerifiedEmail: boolean;
}

export async function handleApplyRoute(db: D1Database, auth: PlatformAuth, request: Request, path: string, opts: ApplyOptions): Promise<Response | null> {
  if (path !== '/apply' && !path.startsWith('/apply/')) return null;
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return fail(401, 'unauthenticated', 'Sign in first.');
  const emailVerified = !!session.user.emailVerified;
  if (path === '/apply/submit' && request.method === 'POST' && opts.requireVerifiedEmail && !emailVerified) {
    return fail(403, 'email_not_verified', 'Confirm your email address first: open the link we sent you, or ask for a new one on this page.');
  }
  try {
    const work = applyAction(db, session.user, request, path);
    if (!work) return fail(404, 'not_found', 'Not found');
    // Every answer says whether the address is confirmed, so the page can ask for it.
    return reply({ ...await work, emailVerified, emailRequired: opts.requireVerifiedEmail });
  } catch (e) {
    if (e instanceof OrgError) return fail(e.status, e.code, e.message);
    throw e;
  }
}

function applyAction(db: D1Database, user: { id: string; email: string }, request: Request, path: string): Promise<object> | null {
  const route = `${request.method} ${path}`;
  if (route === 'GET /apply') return getMyApplication(db, user.id);
  if (route === 'PUT /apply') return jsonBody(request).then(body => saveMyApplication(db, user.id, body));
  if (route === 'POST /apply/submit') return submitMyApplication(db, user.id, user.email);
  if (route === 'POST /apply/withdraw') return withdrawMyApplication(db, user.id);
  return null;
}
