export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'user';
  createdAt: number;
}

const TOKEN_KEY = 'vayu_token';

function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  const base: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) base['Authorization'] = `Bearer ${token}`;
  return base;
}

async function call<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { ...authHeaders(), ...(options?.headers ?? {}) },
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Request failed');
  return data as T;
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
    } catch {
      localStorage.removeItem(TOKEN_KEY);
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

  async removeUser(id: string): Promise<void> {
    await call(`/auth/users/${id}`, { method: 'DELETE' });
    broadcastSync();
  },
};