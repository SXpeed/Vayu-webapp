// Session and role lookups shared by worker.ts and the delta-sync endpoint.
// Extracted from worker.ts so frontend/deltaSync.ts can reuse them without a
// circular import.

import {
  ADMIN_PERMISSIONS, ADMIN_ROLE_ID, BUILT_IN_ROLES, STAFF_DEFAULT_PERMISSIONS,
  STAFF_ROLE_ID, normalizePermissions, type Permissions, type RoleDef,
} from './permissions';
import { permissionsForRoles } from './entityAccess';
import type { SessionData } from './workerEnv';

export const SESSION_TTL_DAYS = 30;

export interface StoredUser {
  id: string;
  name: string;
  storeId?: string;
  email: string;
  phone?: string;
  address?: string;
  hashedPassword: string;
  /** Role id: 'admin', 'user' (Staff) or a custom role's id. */
  role: string;
  createdAt: number;
  /** Max devices signed in at once; unset = default. Ignored for admins. */
  maxDevices?: number;
}

export function bearerToken(request: Request): string | null {
  const auth = request.headers.get('Authorization');
  return auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null;
}

const sessionMemo = new WeakMap<Request, Promise<SessionData | null>>();

/**
 * The caller's session, or null. Memoised per request, so the access check
 * in the router and the handler share one lookup. The role is re-read from
 * the user record every time: a session used to keep the role it had at
 * login, so a demoted admin kept admin rights until the session expired. A
 * deleted user's sessions stop working at once for the same reason.
 */
/**
 * Sets this request's session up front: requests for an organization are
 * signed in with a platform account (frontend/orgApp.ts), not a bearer token.
 */
export function primeSession(request: Request, session: SessionData | null): void {
  sessionMemo.set(request, Promise.resolve(session));
}

export function getSession(request: Request, kv: KVNamespace): Promise<SessionData | null> {
  let pending = sessionMemo.get(request);
  if (!pending) {
    pending = loadSession(request, kv);
    sessionMemo.set(request, pending);
  }
  return pending;
}

async function loadSession(request: Request, kv: KVNamespace): Promise<SessionData | null> {
  const token = bearerToken(request);
  if (!token) return null;
  const raw = await kv.get(`auth:session:${token}`);
  if (!raw) return null;
  const session: SessionData = JSON.parse(raw);
  if (session.expiresAt < Date.now()) {
    await kv.delete(`auth:session:${token}`);
    return null;
  }
  const userRaw = await kv.get(`auth:user:${session.userId}`);
  if (!userRaw) return null;
  session.role = (JSON.parse(userRaw) as StoredUser).role;
  return session;
}

// ── Roles & access ──────────────────────────────────────────────────────────
// Custom roles live in KV under one key. "admin" always has everything and is
// never stored; "user" (Staff) is built in but its permissions are editable.

const ROLES_KEY = 'auth:roles';
const ROLES_CACHE_MS = 15_000;
let rolesCache: { at: number; roles: RoleDef[] } | null = null;

export async function getRoles(kv: KVNamespace): Promise<RoleDef[]> {
  if (rolesCache && Date.now() - rolesCache.at < ROLES_CACHE_MS) return rolesCache.roles;
  const raw = await kv.get(ROLES_KEY);
  const stored: RoleDef[] = raw ? JSON.parse(raw) : [];
  const staff = stored.find(r => r.id === STAFF_ROLE_ID);
  const roles: RoleDef[] = [
    { ...BUILT_IN_ROLES[0], permissions: ADMIN_PERMISSIONS },
    {
      ...BUILT_IN_ROLES[1],
      name: staff?.name || BUILT_IN_ROLES[1].name,
      permissions: staff ? normalizePermissions(staff.permissions) : STAFF_DEFAULT_PERMISSIONS,
    },
    ...stored
      .filter(r => r.id !== ADMIN_ROLE_ID && r.id !== STAFF_ROLE_ID)
      .map(r => ({ id: r.id, name: r.name, permissions: normalizePermissions(r.permissions) })),
  ];
  rolesCache = { at: Date.now(), roles };
  return roles;
}

export async function saveRoles(kv: KVNamespace, roles: RoleDef[]): Promise<void> {
  const toStore = roles
    .filter(r => r.id !== ADMIN_ROLE_ID)
    .map(r => ({ id: r.id, name: r.name, permissions: r.permissions }));
  await kv.put(ROLES_KEY, JSON.stringify(toStore));
  rolesCache = null;
}

export function permissionsFor(roles: RoleDef[], roleId: string): Permissions {
  return permissionsForRoles(roles, roleId);
}
