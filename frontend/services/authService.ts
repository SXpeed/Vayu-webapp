export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'user';
  createdAt: number;
  isOnline?: boolean;
  lastSeen?: number;
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

export interface PresenceMap {
  [userId: string]: { isOnline: boolean; lastSeen: number };
}

import { apiCall as call, authHeaders } from './apiClient';

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
    try {
      await fetch('/api/auth/logout', { method: 'POST', headers: authHeaders() });
    } finally {
      localStorage.removeItem(TOKEN_KEY);
    }
  },

  async getMe(): Promise<AuthUser | null> {
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

  async getUsers(): Promise<AuthUser[]> {
    return call<AuthUser[]>('/auth/users');
  },

  async getTeamMembers(): Promise<AuthUser[]> {
    return call<AuthUser[]>('/auth/team');
  },

  async addUser(name: string, email: string, password: string, role: 'admin' | 'user' = 'user'): Promise<AuthUser> {
    const user = await call<AuthUser>('/auth/users', {
      method: 'POST',
      body: JSON.stringify({ name, email, password, role }),
    });
    broadcastSync();
    return user;
  },

  async updateUser(id: string, data: { name?: string; email?: string; role?: 'admin' | 'user'; password?: string }): Promise<AuthUser> {
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
