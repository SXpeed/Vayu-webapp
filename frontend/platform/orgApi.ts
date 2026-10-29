// The signed-in person's organizations (GET /api/v2/me/orgs), and the error
// the /me routes answer with.

import type { PlatformAuth } from './auth';

export class OrgAccessError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/** Organizations the signed-in person can open, for the workspace switcher. */
export async function listMyOrganizations(db: D1Database, auth: PlatformAuth, request: Request) {
  const session = await auth.api.getSession({ headers: request.headers, query: { disableRefresh: true } });
  if (!session) throw new OrgAccessError(401, 'unauthenticated', 'Sign in first.');
  const { results } = await db.prepare(
    `SELECT o.id, o.name, o.slug, o.business_type, o.status, o.country, m.role
     FROM memberships m JOIN organizations o ON o.id = m.org_id
     WHERE m.user_id = ? AND m.status = 'active' AND o.status <> 'closed'
     ORDER BY o.name`,
  ).bind(session.user.id).all();
  return results;
}
