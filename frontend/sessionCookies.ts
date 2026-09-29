// The original sign-in's session, in an HttpOnly cookie instead of a token
// kept by JavaScript (docs/PAYMENT_SECURITY.md, issue 1).
//
// Every browser page calls the API on its own address (the site Workers pass
// /api to the API Worker unchanged, docs/HOSTING.md), so the cookies are
// host-only on that address: `__Host-` prefixed, Secure, Path=/, no Domain.
// app.ateliersupport.com and api.ateliersupport.com are different origins and
// share no cookie; nothing here relies on them being one.
//
// CSRF: a request signed in by the cookie that changes anything must come
// from a trusted origin (Origin header, or Sec-Fetch-Site: same-origin) AND
// carry X-CSRF-Token: a value derived from the session token, which the page
// reads from a second, readable cookie. Another site can't read that cookie,
// and can't make a browser send the header.
//
// HttpOnly keeps a script from reading the session token; it does not stop a
// script injected into our own pages from acting as the signed-in person.

import type { Env } from './workerEnv';

export type AuthKind = 'cookie' | 'bearer' | 'none';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Our own marker, set only after stripping any copy a caller sent. */
export const AUTH_KIND_HEADER = 'X-Vayu-Auth';

const isHttps = (request: Request) => new URL(request.url).protocol === 'https:';

/** `__Host-` names need Secure, which needs https; local http development uses plain names. */
export function cookieNames(request: Request): { session: string; csrf: string } {
  return isHttps(request)
    ? { session: '__Host-vayu_session', csrf: '__Host-vayu_csrf' }
    : { session: 'vayu_session', csrf: 'vayu_csrf' };
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }
  return null;
}

async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message)));
  return [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** The CSRF value for a session: derived from its (secret) token, so it needs no storage. */
export const csrfFor = (sessionToken: string) => hmacHex(sessionToken, 'vayu-csrf-v1');

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a.codePointAt(i) ?? 0) ^ (b.codePointAt(i) ?? 0);
  return diff === 0;
}

/** The two cookies for a new session: the HttpOnly session, and the readable CSRF value. */
export async function sessionCookies(request: Request, token: string, maxAgeSeconds: number): Promise<string[]> {
  const { session, csrf } = cookieNames(request);
  const secure = isHttps(request) ? '; Secure' : '';
  return [
    `${session}=${token}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=${maxAgeSeconds}`,
    `${csrf}=${await csrfFor(token)}; Path=/${secure}; SameSite=Lax; Max-Age=${maxAgeSeconds}`,
  ];
}

/** Clears both, with the same attributes they were set with. */
export function clearedSessionCookies(request: Request): string[] {
  const { session, csrf } = cookieNames(request);
  const secure = isHttps(request) ? '; Secure' : '';
  return [
    `${session}=; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=0`,
    `${csrf}=; Path=/${secure}; SameSite=Lax; Max-Age=0`,
  ];
}

/**
 * Whether a bearer token (the old, JavaScript-kept sign-in) is still
 * accepted: only until LEGACY_BEARER_UNTIL (an ISO date). Unset or past: no.
 * The exchange route is where such a token is swapped for a cookie.
 */
export function legacyBearerAllowed(env: Pick<Env, 'LEGACY_BEARER_UNTIL'>, now = Date.now()): boolean {
  const until = Date.parse(env.LEGACY_BEARER_UNTIL ?? '');
  return Number.isFinite(until) && now < until;
}

/**
 * The request as the app's routes read it: the session token (from the
 * cookie, or a still-allowed bearer token) in the Authorization header, and
 * how it signed in in AUTH_KIND_HEADER. A bearer token past its cutoff is
 * dropped, so the request is simply signed out.
 */
export function normalizeAuth(request: Request, env: Pick<Env, 'LEGACY_BEARER_UNTIL'>): { request: Request; kind: AuthKind; token: string | null } {
  const headers = new Headers(request.headers);
  headers.delete(AUTH_KIND_HEADER);
  const cookieToken = readCookie(request, cookieNames(request).session);
  const auth = headers.get('Authorization');
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  let kind: AuthKind = 'none';
  let token: string | null = null;
  if (cookieToken) {
    kind = 'cookie'; token = cookieToken;
    headers.set('Authorization', `Bearer ${cookieToken}`);
  } else if (bearer && legacyBearerAllowed(env)) {
    kind = 'bearer'; token = bearer;
  } else {
    headers.delete('Authorization');
  }
  headers.set(AUTH_KIND_HEADER, kind);
  return { request: new Request(request, { headers }), kind, token };
}

/** The addresses whose pages may change things: this one, and AUTH_ORIGINS. */
export function trustedOrigins(request: Request, env: Pick<Env, 'AUTH_ORIGINS'>): Set<string> {
  const listed = (env.AUTH_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return new Set([new URL(request.url).origin, ...listed]);
}

/** A state-changing request from a page we trust: its Origin, or (no Origin) the browser's Sec-Fetch-Site. */
export function fromTrustedPage(request: Request, env: Pick<Env, 'AUTH_ORIGINS'>): boolean {
  if (SAFE_METHODS.has(request.method)) return true;
  const origin = request.headers.get('Origin');
  if (origin) return trustedOrigins(request, env).has(origin);
  return request.headers.get('Sec-Fetch-Site') === 'same-origin';
}

/**
 * Why a cookie-signed request that changes something is refused (CSRF), or
 * null. Requests signed with a bearer token or not signed in are not
 * CSRF-prone: a browser never adds those on its own.
 */
export async function csrfProblem(request: Request, env: Pick<Env, 'AUTH_ORIGINS'>, kind: AuthKind, token: string | null): Promise<{ code: string; error: string } | null> {
  if (kind !== 'cookie' || !token || SAFE_METHODS.has(request.method)) return null;
  if (!fromTrustedPage(request, env)) return { code: 'csrf_origin', error: 'This request came from a page that is not allowed.' };
  const sent = request.headers.get('X-CSRF-Token') ?? '';
  if (!sent || !sameText(sent, await csrfFor(token))) return { code: 'csrf_token', error: 'This page is out of date. Reload it and try again.' };
  return null;
}
