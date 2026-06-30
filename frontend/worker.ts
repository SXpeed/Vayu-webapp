interface Env {
  VAYU_KV: KVNamespace;
  VAYU_R2: R2Bucket;
}

interface StoredUser {
  id: string;
  name: string;
  email: string;
  hashedPassword: string;
  role: 'admin' | 'user';
  createdAt: number;
}

interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'user';
  createdAt: number;
}

interface SessionData {
  userId: string;
  email: string;
  name: string;
  role: 'admin' | 'user';
  expiresAt: number;
}

const CORS: HeadersInit = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const SESSION_TTL_DAYS = 30;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

// ── Crypto helpers ─────────────────────────────────────────────────────────

function b64(arr: Uint8Array): string {
  return btoa(String.fromCodePoint(...arr));
}

function fromB64(s: string): Uint8Array {
  return new Uint8Array(atob(s).split('').map(c => c.codePointAt(0)!));
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 },
    key, 256
  );
  return `${b64(salt)}.${b64(new Uint8Array(bits))}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltB64, hashB64] = stored.split('.');
  const salt = fromB64(saltB64);
  const expected = fromB64(hashB64);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 },
    key, 256
  );
  const actual = new Uint8Array(bits);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

function generateToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── Session helpers ────────────────────────────────────────────────────────

async function getSession(request: Request, kv: KVNamespace): Promise<SessionData | null> {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  const raw = await kv.get(`auth:session:${token}`);
  if (!raw) return null;
  const session: SessionData = JSON.parse(raw);
  if (session.expiresAt < Date.now()) {
    await kv.delete(`auth:session:${token}`);
    return null;
  }
  return session;
}

function stripPassword(user: StoredUser): PublicUser {
  const { hashedPassword: _h, ...pub } = user;
  return pub as PublicUser;
}

// ── Main handler ───────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, '');
    const method = request.method;

    try {
      // ── GET /auth/status — is first-run setup needed? ──────────────
      if (path === '/auth/status' && method === 'GET') {
        const count = await env.VAYU_KV.get('auth:count');
        return json({ needsSetup: !count || Number.parseInt(count) === 0 });
      }

      // ── POST /auth/setup — create first admin (one-time) ───────────
      if (path === '/auth/setup' && method === 'POST') {
        const count = await env.VAYU_KV.get('auth:count');
        if (count && Number.parseInt(count) > 0) return err('Setup already complete', 403);
        const body = await request.json();
        const { name, email, password } = body as { name?: string; email?: string; password?: string };
        if (!name || !email || !password) return err('name, email and password are required');
        if (password.length < 6) return err('Password must be at least 6 characters');
        const id = `admin_${Date.now()}`;
        const user: StoredUser = {
          id, name, email: email.toLowerCase().trim(),
          hashedPassword: await hashPassword(password),
          role: 'admin', createdAt: Date.now(),
        };
        await env.VAYU_KV.put(`auth:user:${id}`, JSON.stringify(user));
        await env.VAYU_KV.put(`auth:email:${user.email}`, id);
        await env.VAYU_KV.put('auth:count', '1');
        return json({ success: true });
      }

      // ── POST /auth/login ───────────────────────────────────────────
      if (path === '/auth/login' && method === 'POST') {
        const loginBody = await request.json();
        const { email, password } = loginBody as { email?: string; password?: string };
        if (!email || !password) return err('email and password are required');
        const userId = await env.VAYU_KV.get(`auth:email:${email.toLowerCase().trim()}`);
        if (!userId) return err('Invalid email or password', 401);
        const raw = await env.VAYU_KV.get(`auth:user:${userId}`);
        if (!raw) return err('Invalid email or password', 401);
        const user: StoredUser = JSON.parse(raw);
        if (!await verifyPassword(password, user.hashedPassword)) return err('Invalid email or password', 401);
        const token = generateToken();
        const session: SessionData = {
          userId: user.id, email: user.email, name: user.name,
          role: user.role, expiresAt: Date.now() + SESSION_TTL_DAYS * 86_400_000,
        };
        await env.VAYU_KV.put(`auth:session:${token}`, JSON.stringify(session), {
          expirationTtl: SESSION_TTL_DAYS * 86_400,
        });
        return json({ token, user: stripPassword(user) });
      }

      // ── GET /auth/me ───────────────────────────────────────────────
      if (path === '/auth/me' && method === 'GET') {
        const session = await getSession(request, env.VAYU_KV);
        if (!session) return err('Unauthorized', 401);
        const raw = await env.VAYU_KV.get(`auth:user:${session.userId}`);
        if (!raw) return err('User not found', 404);
        return json(stripPassword(JSON.parse(raw)));
      }

      // ── POST /auth/logout ──────────────────────────────────────────
      if (path === '/auth/logout' && method === 'POST') {
        const auth = request.headers.get('Authorization');
        if (auth?.startsWith('Bearer ')) {
          await env.VAYU_KV.delete(`auth:session:${auth.slice(7).trim()}`);
        }
        return json({ success: true });
      }

      // ── GET /auth/users — list users (admin only) ──────────────────
      if (path === '/auth/users' && method === 'GET') {
        const session = await getSession(request, env.VAYU_KV);
        if (!session) return err('Unauthorized', 401);
        if (session.role !== 'admin') return err('Forbidden', 403);
        const list = await env.VAYU_KV.list({ prefix: 'auth:user:' });
        const users: PublicUser[] = [];
        for (const key of list.keys) {
          const raw = await env.VAYU_KV.get(key.name);
          if (raw) users.push(stripPassword(JSON.parse(raw)));
        }
        users.sort((a, b) => a.createdAt - b.createdAt);
        return json(users);
      }

      // ── POST /auth/users — add user (admin only) ───────────────────
      if (path === '/auth/users' && method === 'POST') {
        const session = await getSession(request, env.VAYU_KV);
        if (!session) return err('Unauthorized', 401);
        if (session.role !== 'admin') return err('Forbidden', 403);
        const addBody = await request.json();
        const { name, email, password, role } = addBody as {
          name?: string; email?: string; password?: string; role?: string;
        };
        if (!name || !email || !password) return err('name, email and password are required');
        if (password.length < 6) return err('Password must be at least 6 characters');
        const emailKey = `auth:email:${email.toLowerCase().trim()}`;
        if (await env.VAYU_KV.get(emailKey)) return err('A user with this email already exists', 409);
        const id = `user_${Date.now()}`;
        const user: StoredUser = {
          id, name, email: email.toLowerCase().trim(),
          hashedPassword: await hashPassword(password),
          role: role === 'admin' ? 'admin' : 'user',
          createdAt: Date.now(),
        };
        await env.VAYU_KV.put(`auth:user:${id}`, JSON.stringify(user));
        await env.VAYU_KV.put(emailKey, id);
        const countRaw = await env.VAYU_KV.get('auth:count');
        await env.VAYU_KV.put('auth:count', String((countRaw ? Number.parseInt(countRaw) : 0) + 1));
        return json(stripPassword(user), 201);
      }

      // ── DELETE /auth/users/:id — remove user (admin only) ─────────
      if (path.startsWith('/auth/users/') && method === 'DELETE') {
        const session = await getSession(request, env.VAYU_KV);
        if (!session) return err('Unauthorized', 401);
        if (session.role !== 'admin') return err('Forbidden', 403);
        const userId = path.slice('/auth/users/'.length);
        if (userId === session.userId) return err('Cannot delete your own account', 400);
        const raw = await env.VAYU_KV.get(`auth:user:${userId}`);
        if (!raw) return err('User not found', 404);
        const user: StoredUser = JSON.parse(raw);
        await env.VAYU_KV.delete(`auth:user:${userId}`);
        await env.VAYU_KV.delete(`auth:email:${user.email}`);
        const countRaw = await env.VAYU_KV.get('auth:count');
        if (countRaw) await env.VAYU_KV.put('auth:count', String(Math.max(0, Number.parseInt(countRaw) - 1)));
        return json({ success: true });
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  },
};
