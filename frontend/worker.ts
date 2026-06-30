interface Env {
  VAYU_KV: KVNamespace;
  VAYU_R2: R2Bucket;
  VAYU_DB: D1Database;
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

// ── D1 row → Conversation mapper ───────────────────────────────────────────

function rowToConversation(row: Record<string, unknown>): any {
  return {
    id: row.id as string,
    participantIds: JSON.parse(row.participant_ids as string),
    participantNames: JSON.parse(row.participant_names as string),
    lastMessage: row.last_message as string,
    lastMessageTime: row.last_message_time as number,
    unreadCount: row.unread_count as number,
    title: row.title || undefined,
    reason: row.reason || undefined,
    note: row.note || undefined,
    isGroup: !!row.is_group,
    groupName: row.group_name || undefined,
    isPinned: !!row.is_pinned,
    isArchived: !!row.is_archived,
  };
}

// ── D1 row → Message mapper ────────────────────────────────────────────────

function rowToMessage(row: Record<string, unknown>): any {
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    senderId: row.sender_id as string,
    senderName: row.sender_name as string,
    text: row.text as string,
    tags: JSON.parse(row.tags as string),
    timestamp: row.timestamp as number,
    status: row.status as string,
    replyTo: row.reply_to ? JSON.parse(row.reply_to as string) : undefined,
    attachment: row.attachment ? JSON.parse(row.attachment as string) : undefined,
  };
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

      // ── GET /auth/team — list all users (any authenticated user) ──
      // Used by messaging to show team members
      if (path === '/auth/team' && method === 'GET') {
        const session = await getSession(request, env.VAYU_KV);
        if (!session) return err('Unauthorized', 401);
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

      // ── POST /upload — upload file to R2 (auth required) ───────────
      if (path === '/upload' && method === 'POST') {
        const session = await getSession(request, env.VAYU_KV);
        if (!session) return err('Unauthorized', 401);
        const formData = await request.formData();
        const file = formData.get('file') as File | string | null;
        if (!file || typeof file === 'string') return err('No file provided');
        if (file.size > 100 * 1024 * 1024) return err('File too large (max 100MB)');
        const ext = file.name.split('.').pop()?.toLowerCase() || '';
        const key = `uploads/${session.userId}/${Date.now()}-${crypto.randomUUID()}${ext ? '.' + ext : ''}`;
        await env.VAYU_R2.put(key, file.stream(), {
          httpMetadata: { contentType: file.type || 'application/octet-stream' },
        });
        return json({ key, url: `/api/files/${key}` });
      }

      // ── GET /files/:key — serve file from R2 (public) ──────────────
      if (path.startsWith('/files/') && method === 'GET') {
        const key = decodeURIComponent(path.slice('/files/'.length));
        if (!key) return err('File not found', 404);
        const obj = await env.VAYU_R2.get(key);
        if (!obj) return err('File not found', 404);
        const headers = new Headers();
        obj.writeHttpMetadata(headers);
        headers.set('Cache-Control', 'public, max-age=31536000, immutable');
        headers.set('Access-Control-Allow-Origin', '*');
        return new Response(obj.body, { status: 200, headers });
      }

      // ── DELETE /files/:key — delete file from R2 (auth required) ───
      if (path.startsWith('/files/') && method === 'DELETE') {
        const session = await getSession(request, env.VAYU_KV);
        if (!session) return err('Unauthorized', 401);
        const key = decodeURIComponent(path.slice('/files/'.length));
        if (!key) return err('File not found', 404);
        const obj = await env.VAYU_R2.head(key);
        if (!obj) return err('File not found', 404);
        await env.VAYU_R2.delete(key);
        return json({ success: true });
      }

      // ════════════════════════════════════════════════════════════════════
      // ── MESSAGING ENDPOINTS (D1-backed) ──────────────────────────────
      // ════════════════════════════════════════════════════════════════════

      // ── GET /conversations — list conversations for the logged-in user ──
      if (path === '/conversations' && method === 'GET') {
        const session = await getSession(request, env.VAYU_KV);
        if (!session) return err('Unauthorized', 401);
        const results = await env.VAYU_DB.prepare(
          'SELECT * FROM conversations ORDER BY is_pinned DESC, last_message_time DESC'
        ).all();
        const rows = results.results || [];
        // Filter to conversations where the user is a participant
        const convos = rows
          .map(rowToConversation)
          .filter(c => c.participantIds.includes(session.userId));
        return json(convos);
      }

      // ── POST /conversations — create a conversation ─────────────────
      if (path === '/conversations' && method === 'POST') {
        const session = await getSession(request, env.VAYU_KV);
        if (!session) return err('Unauthorized', 401);
        const body = await request.json();
        const conv = body as any;
        if (!conv.id || !conv.participantIds) return err('id and participantIds are required');
        await env.VAYU_DB.prepare(
          `INSERT OR REPLACE INTO conversations
           (id, participant_ids, participant_names, last_message, last_message_time,
            unread_count, title, reason, note, is_group, group_name, is_pinned, is_archived, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          conv.id,
          JSON.stringify(conv.participantIds),
          JSON.stringify(conv.participantNames || []),
          conv.lastMessage || '',
          conv.lastMessageTime || Date.now(),
          conv.unreadCount || 0,
          conv.title || null,
          conv.reason || null,
          conv.note || null,
          conv.isGroup ? 1 : 0,
          conv.groupName || null,
          conv.isPinned ? 1 : 0,
          conv.isArchived ? 1 : 0,
          Date.now()
        ).run();
        return json(conv, 201);
      }

      // ── PUT /conversations/:id — update conversation (pin, archive, details) ──
      if (path.startsWith('/conversations/') && method === 'PUT') {
        const session = await getSession(request, env.VAYU_KV);
        if (!session) return err('Unauthorized', 401);
        const convId = path.slice('/conversations/'.length);
        const body = await request.json();
        const conv = body as any;
        await env.VAYU_DB.prepare(
          `UPDATE conversations SET
             participant_ids = ?, participant_names = ?, last_message = ?,
             last_message_time = ?, unread_count = ?, title = ?, reason = ?,
             note = ?, is_group = ?, group_name = ?, is_pinned = ?, is_archived = ?
           WHERE id = ?`
        ).bind(
          JSON.stringify(conv.participantIds),
          JSON.stringify(conv.participantNames || []),
          conv.lastMessage || '',
          conv.lastMessageTime || Date.now(),
          conv.unreadCount || 0,
          conv.title || null,
          conv.reason || null,
          conv.note || null,
          conv.isGroup ? 1 : 0,
          conv.groupName || null,
          conv.isPinned ? 1 : 0,
          conv.isArchived ? 1 : 0,
          convId
        ).run();
        return json(conv);
      }

      // ── GET /messages — fetch messages (optionally by conversation) ──
      if (path === '/messages' && method === 'GET') {
        const session = await getSession(request, env.VAYU_KV);
        if (!session) return err('Unauthorized', 401);
        const conversationId = url.searchParams.get('conversationId');
        let results;
        if (conversationId) {
          results = await env.VAYU_DB.prepare(
            'SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC'
          ).bind(conversationId).all();
        } else {
          // Fetch all messages for conversations the user is part of
          const convResults = await env.VAYU_DB.prepare('SELECT id, participant_ids FROM conversations').all();
          const convRows = convResults.results || [];
          const userConvIds = convRows
            .filter(r => {
              try { return JSON.parse(r.participant_ids as string).includes(session.userId); }
              catch { return false; }
            })
            .map(r => r.id as string);
          if (userConvIds.length === 0) return json([]);
          const placeholders = userConvIds.map(() => '?').join(',');
          results = await env.VAYU_DB.prepare(
            `SELECT * FROM messages WHERE conversation_id IN (${placeholders}) ORDER BY timestamp ASC`
          ).bind(...userConvIds).all();
        }
        const messages = (results.results || []).map(rowToMessage);
        return json(messages);
      }

      // ── POST /messages — store a new message ────────────────────────
      if (path === '/messages' && method === 'POST') {
        const session = await getSession(request, env.VAYU_KV);
        if (!session) return err('Unauthorized', 401);
        const body = await request.json();
        const msg = body as any;
        if (!msg.id || !msg.conversationId) return err('id and conversationId are required');
        await env.VAYU_DB.prepare(
          `INSERT OR REPLACE INTO messages
           (id, conversation_id, sender_id, sender_name, text, tags, timestamp,
            status, reply_to, attachment, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          msg.id,
          msg.conversationId,
          msg.senderId,
          msg.senderName || '',
          msg.text || '',
          JSON.stringify(msg.tags || []),
          msg.timestamp || Date.now(),
          msg.status || 'sent',
          msg.replyTo ? JSON.stringify(msg.replyTo) : null,
          msg.attachment ? JSON.stringify(msg.attachment) : null,
          Date.now()
        ).run();

        // Update conversation's last message info
        const lastMsgPreview = msg.attachment
          ? (msg.attachment.type === 'image' ? '📷 Photo' : `📎 ${msg.attachment.name}`)
          : msg.text;
        await env.VAYU_DB.prepare(
          `UPDATE conversations SET last_message = ?, last_message_time = ? WHERE id = ?`
        ).bind(lastMsgPreview, msg.timestamp || Date.now(), msg.conversationId).run();

        return json(msg, 201);
      }

      // ── PUT /messages/:id/status — update message delivery/read status ──
      if (path.startsWith('/messages/') && path.endsWith('/status') && method === 'PUT') {
        const session = await getSession(request, env.VAYU_KV);
        if (!session) return err('Unauthorized', 401);
        const msgId = path.slice('/messages/'.length, -'/status'.length);
        const body = await request.json();
        const { status } = body as { status?: string };
        if (!status) return err('status is required');
        await env.VAYU_DB.prepare(
          'UPDATE messages SET status = ? WHERE id = ?'
        ).bind(status, msgId).run();
        return json({ success: true });
      }

      // ── PUT /messages/status-batch — bulk update message status ─────
      if (path === '/messages/status-batch' && method === 'PUT') {
        const session = await getSession(request, env.VAYU_KV);
        if (!session) return err('Unauthorized', 401);
        const body = await request.json();
        const { messageIds, status } = body as { messageIds?: string[]; status?: string };
        if (!messageIds || !status) return err('messageIds and status are required');
        for (const id of messageIds) {
          await env.VAYU_DB.prepare(
            'UPDATE messages SET status = ? WHERE id = ?'
          ).bind(status, id).run();
        }
        return json({ success: true });
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  },
};