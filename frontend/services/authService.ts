import type { Permissions, RoleDef, SectionId } from '../permissions';
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  phone?: string;
  address?: string;
  /** Role id: 'admin', 'user' (Staff) or a custom role's id. */
  role: string;
  /** Sent by the server for the signed-in user (login and /auth/me). */
  roleName?: string;
  permissions?: Permissions;
  /** Sections the workspace's plan leaves out (hidden even from admins). */
  sectionsOff?: SectionId[];
  /** Assigned attendance store (geofence target), set by an admin. */
  storeId?: string;
  createdAt: number;
  isOnline?: boolean;
  lastSeen?: number;
  notificationsEnabled?: boolean;
  /** Admin-set device limit; unset = the default. */
  maxDevices?: number;
  /** Effective limit, null = unlimited (admins). Admin user list only. */
  deviceLimit?: number | null;
  /** Devices currently signed in. Admin user list only. */
  devices?: { id: string; label: string; createdAt: number; lastUsedAt: number; current?: boolean }[];
}

export interface ActivityLog {
  id: string;
  userId: string;
  userName: string;
  action: string;
  entity: string;
  entityId: string;
  details: string;
  timestamp: number;
}

export interface Invitation {
  id: string;
  email: string;
  appRole: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  invitedBy?: string | null;
  createdAt: number;
  expiresAt: number;
}

export interface PresenceMap {
  [userId: string]: { isOnline: boolean; lastSeen: number };
}

import { apiCall as call, authHeaders, LEGACY_TOKEN_KEY } from './apiClient';
import { db } from './db';
import { flushPendingSales } from './salesService';
import { apiBase, authClient, isPlatformSession, setWorkspace, type Workspace } from './workspace';

type DeviceInfo = { id: string; label: string; createdAt: number; lastUsedAt: number; current?: boolean };

const BROWSERS: [RegExp, string][] = [
  [/Edg(A|iOS)?\//, 'Edge'], [/SamsungBrowser\//, 'Samsung Internet'], [/OPR\//, 'Opera'],
  [/Chrome\/|CriOS\//, 'Chrome'], [/Firefox\/|FxiOS\//, 'Firefox'], [/Safari\//, 'Safari'],
];
const SYSTEMS: [RegExp, string][] = [[/iPhone/, 'iPhone'], [/iPad/, 'iPad'], [/Android/, 'Android'], [/Windows/, 'Windows'], [/Mac OS X/, 'Mac'], [/Linux/, 'Linux']];

/** "Chrome on Windows" from a browser's user agent string. */
function deviceLabel(userAgent: string | null | undefined): string {
  const ua = userAgent ?? '';
  const pick = (list: [RegExp, string][]) => list.find(([pattern]) => pattern.test(ua))?.[1];
  const system = pick(SYSTEMS);
  // The installed iPhone/iPad app reports WebKit without a browser name.
  const browser = pick(BROWSERS) ?? (/iPhone|iPad/.test(ua) && /AppleWebKit/.test(ua) ? 'App' : 'A browser');
  return `${browser} on ${system ?? 'an unknown system'}`;
}

/** The platform API (/api/v2), signed in by the platform session cookie. */
async function platformCall<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v2${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(body.error || 'Something went wrong. Please try again.');
  return body;
}

/**
 * Not a credential: only whether this device has signed in with the original
 * sign-in, so starting offline can go straight to the saved copy and a
 * signed-out device doesn't ask the server. The session itself is an
 * HttpOnly cookie that JavaScript can't read.
 */
const SIGNED_IN_KEY = 'vayu_signed_in';

const markSignedIn = () => { try { localStorage.setItem(SIGNED_IN_KEY, '1'); } catch { /* private mode */ } };
const forgetSignIn = () => {
  try { localStorage.removeItem(SIGNED_IN_KEY); localStorage.removeItem(LEGACY_TOKEN_KEY); } catch { /* private mode */ }
};

/**
 * A device still holding the old JavaScript-kept token swaps it for the
 * cookie session, once, and deletes it. Offline: tried again next start.
 */
async function exchangeLegacyToken(): Promise<void> {
  const legacy = localStorage.getItem(LEGACY_TOKEN_KEY);
  if (!legacy) return;
  let res: Response;
  try {
    res = await fetch('/api/auth/session', { method: 'POST', headers: { Authorization: `Bearer ${legacy}` }, signal: AbortSignal.timeout(20_000) });
  } catch {
    return;
  }
  if (res.ok) {
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    markSignedIn();
  } else if (res.status === 401 || res.status === 410) {
    forgetSignIn();
  }
}

function broadcastSync(): void {
  try {
    const ch = new BroadcastChannel('vayu_cloud_sync');
    ch.postMessage({ type: 'SYNC_REQUIRED' });
    ch.close();
  } catch { }
}

export const authService = {
  async needsSetup(): Promise<boolean> {
    const data = await call<{ needsSetup: boolean }>('/auth/status');
    return data.needsSetup;
  },

  async setup(name: string, email: string, password: string): Promise<void> {
    await call('/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
    });
  },

  async login(email: string, password: string): Promise<AuthUser> {
    // Development-mode shortcut: allow a hard‑coded credential set for quick offline testing.
    // This is ONLY active when NODE_ENV is "development" and will be ignored in production builds.
    const DEV_CRED_EMAIL = 'test@dev.com';
    const DEV_CRED_PASSWORD = 'test123';
    if (process.env.NODE_ENV === 'development' && email === DEV_CRED_EMAIL && password === DEV_CRED_PASSWORD) {
      const devUser: AuthUser = {
        id: 'dev-id',
        name: 'Offline Tester',
        email: DEV_CRED_EMAIL,
        role: 'admin',
        createdAt: Date.now(),
        isOnline: true,
        lastSeen: Date.now(),
      };
      return devUser;
    }
    // The server sets the session as an HttpOnly cookie; nothing to keep here.
    const data = await call<{ user: AuthUser }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    markSignedIn();
    return data.user;
  },

  async logout(): Promise<void> {
    if (isPlatformSession()) {
      // Close this workspace's live connection and file access, remove its
      // offline copy from the device, then end the platform sign-in.
      // Sales recorded offline go up first, while this sign-in still works.
      await flushPendingSales().catch(() => undefined);
      try { await fetch(`${apiBase()}/auth/logout`, { method: 'POST', headers: authHeaders() }); } catch { /* signing out anyway */ }
      db.clearWorkspaceCopy();
      try { await authClient.signOut(); } finally { setWorkspace(null); }
      return;
    }
    try {
      // The server ends the session and clears its cookies.
      await fetch('/api/auth/logout', { method: 'POST', headers: authHeaders() });
    } finally {
      forgetSignIn();
    }
  },

  /**
   * Opens a workspace with the platform sign-in: the person's record there,
   * or an error saying why not (not a member any more, paused, plan not active).
   */
  async enterWorkspace(workspace: Workspace): Promise<AuthUser> {
    setWorkspace(workspace);
    try {
      return await call<AuthUser>('/auth/me');
    } catch (e) {
      const status = (e as { status?: number }).status;
      // Plan not active: stay in the workspace, which opens on its plan screen.
      if (status !== 402) setWorkspace(null);
      if (status === 404) throw new Error(`You're no longer a member of ${workspace.name}.`);
      throw e;
    }
  },

  /** Forget this device's sign-in without calling the server (already signed out there). */
  clearLocalSession(): void {
    forgetSignIn();
    setWorkspace(null);
  },

  async getMe(): Promise<AuthUser | null> {
    if (isPlatformSession()) {
      try {
        return await call<AuthUser>('/auth/me');
      } catch (err) {
        // Signed out, or no longer a member: back to sign-in. Anything else
        // (offline, a blip) keeps the workspace for the next try.
        const status = (err as { status?: number }).status;
        if (status === 401 || status === 404) setWorkspace(null);
        return null;
      }
    }
    await exchangeLegacyToken();
    if (!localStorage.getItem(SIGNED_IN_KEY) && !localStorage.getItem(LEGACY_TOKEN_KEY)) return null;
    try {
      return await call<AuthUser>('/auth/me');
    } catch (err) {
      // Only forget the sign-in on a genuine 401 (invalid or expired
      // session). Transient errors (network, 500, etc.) should NOT log the
      // user out — they may just be a momentary blip on hard refresh.
      if ((err as { status?: number }).status === 401) forgetSignIn();
      return null;
    }
  },

  /** Devices the signed-in person is signed in on, and their limit (null = unlimited). */
  async getMyDevices(): Promise<{ limit: number | null; devices: DeviceInfo[] }> {
    if (isPlatformSession()) {
      // Every device signed in to this account (website, app, control centre).
      // Our own endpoint: Better Auth's list-sessions refuses sign-ins older
      // than 30 minutes (freshAge), which emptied this list.
      const { sessions } = await platformCall<{ sessions: { id: string; userAgent: string | null; createdAt: number; lastUsedAt: number; current: boolean }[] }>('/me/sessions');
      const devices = sessions.map(s => ({ ...s, label: deviceLabel(s.userAgent) }));
      return { limit: null, devices };
    }
    return call('/auth/devices');
  },

  /** Sign out one of your other devices. */
  async signOutDevice(id: string): Promise<void> {
    if (isPlatformSession()) {
      await platformCall('/me/sessions/signout', { method: 'POST', body: JSON.stringify({ id }) });
      return;
    }
    await call('/auth/devices/signout', { method: 'POST', body: JSON.stringify({ id }) });
  },

  /** Admin: sign out one of a person's devices, or all of them (no id). */
  async signOutUserDevices(userId: string, deviceId?: string): Promise<{ signedOut: number; devices: { id: string; label: string; createdAt: number; lastUsedAt: number; current?: boolean }[] }> {
    return call(`/auth/users/${encodeURIComponent(userId)}/devices/signout`, {
      method: 'POST',
      body: JSON.stringify(deviceId ? { id: deviceId } : {}),
    });
  },

  /** Sign out every device except this one; returns how many. */
  async signOutOtherDevices(): Promise<number> {
    if (isPlatformSession()) {
      return (await platformCall<{ signedOut: number }>('/me/sessions/signout', { method: 'POST', body: '{}' })).signedOut;
    }
    return (await call<{ signedOut: number }>('/auth/devices/signout-others', { method: 'POST' })).signedOut;
  },

  // ── Team invitations (platform sign-in) ──
  async getInvitations(): Promise<Invitation[]> {
    return call<Invitation[]>('/team/invitations');
  },

  async invite(email: string, role: string): Promise<{ invitation: Invitation; emailSent: boolean; link?: string }> {
    const result = await call<{ invitation: Invitation; emailSent: boolean; link?: string }>('/team/invitations', {
      method: 'POST', body: JSON.stringify({ email, role }),
    });
    broadcastSync();
    return result;
  },

  async withdrawInvitation(id: string): Promise<void> {
    await call(`/team/invitations/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async getUsers(): Promise<AuthUser[]> {
    return call<AuthUser[]>('/auth/users');
  },

  async getTeamMembers(): Promise<AuthUser[]> {
    return call<AuthUser[]>('/auth/team');
  },

  // ── Roles (admin) ──
  async getRoles(): Promise<RoleDef[]> {
    return call<RoleDef[]>('/auth/roles');
  },

  async createRole(name: string, permissions: Permissions): Promise<RoleDef> {
    return call<RoleDef>('/auth/roles', { method: 'POST', body: JSON.stringify({ name, permissions }) });
  },

  async updateRole(id: string, data: { name?: string; permissions?: Permissions }): Promise<RoleDef> {
    return call<RoleDef>(`/auth/roles/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) });
  },

  async deleteRole(id: string): Promise<void> {
    await call<{ success: boolean }>(`/auth/roles/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async addUser(name: string, email: string, password: string, role: string = 'user'): Promise<AuthUser> {
    const user = await call<AuthUser>('/auth/users', {
      method: 'POST',
      body: JSON.stringify({ name, email, password, role }),
    });
    broadcastSync();
    return user;
  },

  async updateUser(id: string, data: { name?: string; email?: string; role?: string; password?: string; storeId?: string; maxDevices?: number | null }): Promise<AuthUser> {
    const user = await call<AuthUser>(`/auth/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    broadcastSync();
    return user;
  },

  async removeUser(id: string): Promise<void> {
    await call(`/auth/users/${id}`, { method: 'DELETE' });
    broadcastSync();
  },

  async getPresence(): Promise<PresenceMap> {
    return call<PresenceMap>('/auth/presence');
  },

  /** Saves the signed-in user's own name and contact details. */
  async updateMe(fields: { name: string; phone: string; address: string }): Promise<AuthUser> {
    return call<AuthUser>('/auth/me', { method: 'PUT', body: JSON.stringify(fields) });
  },

  async heartbeat(): Promise<void> {
    await call('/auth/presence/heartbeat', { method: 'POST' });
  },

  async setOffline(): Promise<void> {
    try {
      await call('/auth/presence/offline', { method: 'POST' });
    } catch { /* silent */ }
  },

  async getActivityLogs(limit = 100): Promise<ActivityLog[]> {
    return call<ActivityLog[]>(`/activity-logs?limit=${limit}`);
  },
};
