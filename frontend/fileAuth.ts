// Private file delivery.
//
// /api/files/* used to serve every R2 object to anyone with no auth at all and
// a `public, immutable` cache header — an unguessable path was the only
// protection. With FILE_AUTH=on, private files require either the caller's
// bearer session (fetch flows) or a short-lived HttpOnly capability cookie
// (img/PDF flows, which cannot send headers).
//
// The cookie is issued on login and on GET /auth/me when missing, stored in KV
// with a 7-day TTL, and deleted on logout together with a Clear-Site-Data
// header so shared devices stop holding both the cookie and cached copies.
//
// Deliberate design notes:
//  - The R2 key alone is never authorization; an unguessable path proves
//    nothing (the old behaviour).
//  - Responses are `private, max-age=...`: the browser may reuse them, no
//    shared/edge cache may. This saves Worker invocations AND R2 reads AND
//    CPU for repeat views. A blanket public Cache Rule for /api/files/* must
//    NOT be created (see docs/DEPLOYMENT.md).
//  - Uploads under uploads/<userId>/... are all treated private. There is no
//    deliberately-public class yet; if one is needed, add an explicit allow
//    list here rather than a cache rule.

import { getSession } from './workerRoles';
import { flagEnabled, type Ctx } from './workerEnv';

const FILE_COOKIE = 'vayu_files';
const FILE_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
// Path=/api (not /api/files): /auth/me and /auth/logout must receive the
// cookie too, to re-issue a missing one and to delete its KV token.
const FILE_COOKIE_RE = new RegExp(String.raw`(?:^|;\s*)${FILE_COOKIE}=([a-f0-9]{64})`);

/** The capability token carried by this request's cookie, if any. */
export function fileCookieToken(ctx: Ctx): string | null {
  const match = (ctx.request.headers.get('Cookie') ?? '').match(FILE_COOKIE_RE);
  return match ? match[1] : null;
}

/** True when the request carries a file cookie backed by a live KV token. */
export async function fileCookieValid(ctx: Ctx): Promise<boolean> {
  const token = fileCookieToken(ctx);
  return token !== null && (await fileTokenUser(ctx, token)) !== null;
}

/** True when private-file authorization is enforced. */
export function fileAuthEnabled(ctx: Ctx): boolean {
  return flagEnabled(ctx.env.FILE_AUTH);
}

/**
 * Issue (or reuse) this user's file capability token and return the
 * Set-Cookie header value. Tokens are random, unrelated to the session token
 * (a leaked session token must not unlock files after logout) and scoped to
 * the user so several devices each have their own.
 */
export async function issueFileCookie(ctx: Ctx, userId: string): Promise<string> {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  await ctx.env.VAYU_KV.put(
    `auth:filetoken:${token}`,
    JSON.stringify({ userId, issuedAt: Date.now() }),
    { expirationTtl: FILE_TOKEN_TTL_SECONDS },
  );
  return `${FILE_COOKIE}=${token}; Path=/api; HttpOnly; Secure; SameSite=Lax; Max-Age=${FILE_TOKEN_TTL_SECONDS}`;
}

const fileTokenMemo = new Map<string, { at: number; userId: string | null }>();

export function forgetFileToken(token: string): void {
  fileTokenMemo.delete(token);
}

async function fileTokenUser(ctx: Ctx, token: string): Promise<string | null> {
  const cached = fileTokenMemo.get(token);
  if (cached && Date.now() - cached.at < 60_000) return cached.userId;
  const raw = await ctx.env.VAYU_KV.get(`auth:filetoken:${token}`);
  const userId = raw ? (JSON.parse(raw) as { userId?: string }).userId ?? null : null;
  if (fileTokenMemo.size > 500) fileTokenMemo.clear();
  fileTokenMemo.set(token, { at: Date.now(), userId });
  return userId;
}

/**
 * Authorization for GET /files/:key when FILE_AUTH is on: a valid file cookie
 * for a known user, or the caller's own bearer session.
 */
export async function fileAccessAllowed(ctx: Ctx): Promise<boolean> {
  if (await fileCookieValid(ctx)) return true;
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  return !!session;
}

/** Cache headers for private files: reusable by this browser only. */
export function fileCacheHeaders(): string {
  return 'private, max-age=86400';
}

/** Expire the capability cookie and wipe cached copies on shared devices. */
export function fileCookieClearHeaders(): HeadersInit {
  return {
    'Set-Cookie': `${FILE_COOKIE}=; Path=/api; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    'Clear-Site-Data': '"cache"',
  };
}
