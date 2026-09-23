import type { Permissions, RoleDef } from '../permissions';
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

import { apiCall as call, authHeaders } from './apiClient';
import { db } from './db';
import { apiBase, authClient, isPlatformSession, setWorkspace, type Workspace } from './workspace';

type DeviceInfo = { id: string; label: string; createdAt: number; lastUsedAt: number; current?: boolean };

const BROWSERS: [RegExp, string][] = [[/Edg\//, 'Edge'], [/OPR\//, 'Opera'], [/Chrome\//, 'Chrome'], [/Firefox\//, 'Firefox'], [/Safari\//, 'Safari']];
const SYSTEMS: [RegExp, string][] = [[/iPhone|iPad/, 'iPhone or iPad'], [/Android/, 'Android'], [/Windows/, 'Windows'], [/Mac OS X/, 'Mac'], [/Linux/, 'Linux']];

/** "Chrome on Windows" from a browser's user agent string. */
function deviceLabel(userAgent: string | null | undefined): string {
  const ua = userAgent ?? '';
  const pick = (list: [RegExp, string][], fallback: string) => list.find(([pattern]) => pattern.test(ua))?.[1] ?? fallback;
  return `${pick(BROWSERS, 'A browser')} on ${pick(SYSTEMS, 'an unknown system')}`;
}

const TOKEN_KEY = 'vayu_token';

function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
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
      const devToken = 'dev-token';
      localStorage.setItem(TOKEN_KEY, devToken);
      return devUser;
    }
    const data = await call<{ token: string; user: AuthUser }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    localStorage.setItem(TOKEN_KEY, data.token);
    return data.user;
  },

  async logout(): Promise<void> {
    if (isPlatformSession()) {
      // Close this workspace's live connection and file access, remove its
      // offline copy from the device, then end the platform sign-in.
      try { await fetch(`${apiBase()}/auth/logout`, { method: 'POST', headers: authHeaders() }); } catch { /* signing out anyway */ }
      db.clearWorkspaceCopy();
      try { await authClient.signOut(); } finally { setWorkspace(null); }
      return;
    }
    try {
      await fetch('/api/auth/logout', { method: 'POST', headers: authHeaders() });
    } finally {
      localStorage.removeItem(TOKEN_KEY);
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
      setWorkspace(null);
      const status = (e as { status?: number }).status;
      if (status === 404) throw new Error(`You're no longer a member of ${workspace.name}.`);
      throw e;
    }
  },

  /** Drop this device's token without calling the server (already signed out there). */
  clearLocalSession(): void {
    localStorage.removeItem(TOKEN_KEY);
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
    if (!getToken()) return null;
    try {
      return await call<AuthUser>('/auth/me');
    } catch (err) {
      // Only remove the token on a genuine 401 Unauthorized (invalid/expired
      // session). Transient errors (network, 500, etc.) should NOT log the
      // user out — they may just be a momentary blip on hard refresh.
      const msg = (err as Error).message || '';
      if (msg.includes('Unauthorized')) {
        localStorage.removeItem(TOKEN_KEY);
      }
      return null;
    }
  },

  /** Devices the signed-in person is signed in on, and their limit (null = unlimited). */
  async getMyDevices(): Promise<{ limit: number | null; devices: DeviceInfo[] }> {
    if (isPlatformSession()) {
      // Every device signed in to this account (website, app, control centre).
      const [{ data: sessions }, { data: current }] = await Promise.all([authClient.listSessions(), authClient.getSession()]);
      const devices = (sessions ?? []).map(s => ({
        id: s.token,
        label: deviceLabel(s.userAgent),
        createdAt: new Date(s.createdAt).getTime(),
        lastUsedAt: new Date(s.updatedAt).getTime(),
        current: s.token === current?.session.token,
      }));
      return { limit: null, devices };
    }
    return call('/auth/devices');
  },

  /** Sign out one of your other devices. */
  async signOutDevice(id: string): Promise<void> {
    if (isPlatformSession()) {
      const { error } = await authClient.revokeSession({ token: id });
      if (error) throw new Error(error.message || 'Could not sign that device out.');
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
      const before = (await authClient.listSessions()).data?.length ?? 1;
      const { error } = await authClient.revokeOtherSessions();
      if (error) throw new Error(error.message || 'Could not sign the other devices out.');
      return Math.max(before - 1, 0);
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
