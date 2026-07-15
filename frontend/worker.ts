import { getOrCreateVapidKeys, sendWebPush, type StoredPushSubscription } from './webpush';

interface Env {
  VAYU_KV: KVNamespace;
  VAYU_R2: R2Bucket;
  VAYU_DB: D1Database;
}

type FormField = File | string | null;

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
  isOnline?: boolean;
  lastSeen?: number;
}

interface SessionData {
  userId: string;
  email: string;
  name: string;
  role: 'admin' | 'user';
  expiresAt: number;
}

interface ActivityLog {
  id: string;
  userId: string;
  userName: string;
  action: string;
  entity: string;
  entityId: string;
  details: string;
  timestamp: number;
}

// ── Presence helpers ──────────────────────────────────────────────────────
// Presence is stored in KV with a short TTL. Keys: presence:<userId>
const PRESENCE_TTL_SECONDS = 45; // Heartbeat every 30s; TTL 45s gives grace

async function setPresence(kv: KVNamespace, userId: string): Promise<void> {
  await kv.put(`presence:${userId}`, JSON.stringify({ lastSeen: Date.now() }), {
    expirationTtl: PRESENCE_TTL_SECONDS,
  });
}

async function getPresenceMap(kv: KVNamespace): Promise<Record<string, { isOnline: boolean; lastSeen: number }>> {
  const list = await kv.list({ prefix: 'presence:' });
  const map: Record<string, { isOnline: boolean; lastSeen: number }> = {};
  for (const key of list.keys) {
    const userId = key.name.slice('presence:'.length);
    const raw = await kv.get(key.name);
    if (raw) {
      const data = JSON.parse(raw);
      map[userId] = { isOnline: true, lastSeen: data.lastSeen || Date.now() };
    }
  }
  return map;
}

// ── Activity log helper ───────────────────────────────────────────────────
async function logActivity(db: D1Database, userId: string, userName: string, action: string, entity: string, entityId: string, details: string): Promise<void> {
  try {
    await db.prepare(
      `INSERT OR REPLACE INTO activity_logs (id, user_id, user_name, action, entity, entity_id, details, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      `log_${Date.now()}_${crypto.randomUUID()}`,
      userId, userName, action, entity, entityId, details, Date.now()
    ).run();
  } catch (e) {
    console.error('Failed to log activity:', e);
  }
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
  return pub;
}

// ── D1 row mappers ──────────────────────────────────────────────────────────

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

function rowToArtwork(row: Record<string, unknown>): any {
  return {
    id: row.id as string,
    customId: row.custom_id as string,
    title: row.title as string,
    description: row.description as string,
    dimensions: row.dimensions as string,
    medium: row.medium as string,
    status: row.status as string,
    location: row.location as string,
    price: row.price as number,
    imageUrls: JSON.parse(row.image_urls as string),
    createdAt: row.created_at as number,
  };
}

function rowToCollection(row: Record<string, unknown>): any {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string,
    artworkIds: JSON.parse(row.artwork_ids as string),
    createdAt: row.created_at as number,
  };
}

function rowToCatalog(row: Record<string, unknown>): any {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string,
    artworkIds: JSON.parse(row.artwork_ids as string),
    coverImageUrl: row.cover_image_url as string,
    createdAt: row.created_at as number,
  };
}

function rowToInquiry(row: Record<string, unknown>): any {
  return {
    id: row.id as string,
    inquiryNumber: row.inquiry_number as string,
    customerName: row.customer_name as string,
    customerPhone: row.customer_phone as string,
    customerEmail: row.customer_email as string,
    artworkIds: JSON.parse(row.artwork_ids as string),
    notes: row.notes as string,
    source: row.source as string,
    status: row.status as string,
    catalogShared: !!row.catalog_shared,
    date: row.date as number,
  };
}

function rowToInquiryMessage(row: Record<string, unknown>): any {
  return {
    id: row.id as string,
    inquiryId: row.inquiry_id as string,
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

// ── Web Push notifications ─────────────────────────────────────────────────
// Subscriptions live in KV under `push:sub:<userId>:<endpointHash>`.
// Turning notifications ON subscribes the device; OFF removes it.

const VAPID_SUBJECT = 'mailto:roshni@viveksahnidesign.com';

interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  data?: { view?: string;[k: string]: unknown };
}

async function endpointHash(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest).slice(0, 12))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function deliverPush(env: Env, subs: Array<{ key: string; sub: StoredPushSubscription }>, payload: PushPayload): Promise<void> {
  if (subs.length === 0) return;
  const vapid = await getOrCreateVapidKeys(env.VAYU_KV);
  const body = JSON.stringify(payload);
  await Promise.allSettled(subs.map(async ({ key, sub }) => {
    try {
      const status = await sendWebPush(sub, body, vapid, VAPID_SUBJECT);
      // 404/410 mean the browser dropped the subscription — clean it up.
      if (status === 404 || status === 410) await env.VAYU_KV.delete(key);
    } catch (e) {
      console.error('Push delivery failed:', e);
    }
  }));
}

async function collectSubs(env: Env, prefix: string): Promise<Array<{ key: string; sub: StoredPushSubscription }>> {
  const list = await env.VAYU_KV.list({ prefix });
  const subs: Array<{ key: string; sub: StoredPushSubscription }> = [];
  for (const key of list.keys) {
    const raw = await env.VAYU_KV.get(key.name);
    if (raw) subs.push({ key: key.name, sub: JSON.parse(raw) });
  }
  return subs;
}

async function sendPushToUsers(env: Env, userIds: string[], payload: PushPayload): Promise<void> {
  const subs: Array<{ key: string; sub: StoredPushSubscription }> = [];
  for (const userId of new Set(userIds)) {
    subs.push(...await collectSubs(env, `push:sub:${userId}:`));
  }
  await deliverPush(env, subs, payload);
}

async function sendPushToAllExcept(env: Env, exceptUserId: string, payload: PushPayload): Promise<void> {
  const all = await collectSubs(env, 'push:sub:');
  const subs = all.filter(({ sub }) => sub.userId !== exceptUserId);
  await deliverPush(env, subs, payload);
}

function attachmentPreviewText(msg: any): string {
  if (!msg.attachment) return msg.text || 'New message';
  return msg.attachment.type === 'image' ? '📷 Photo' : `📎 ${msg.attachment.name || 'Attachment'}`;
}

/** Notify the other participants of a conversation about a new message. */
async function notifyConversationMessage(env: Env, msg: any, session: SessionData): Promise<void> {
  try {
    const conv = await env.VAYU_DB.prepare(
      'SELECT participant_ids, is_group, group_name FROM conversations WHERE id = ?'
    ).bind(msg.conversationId).first();
    if (!conv) return;
    const participantIds: string[] = JSON.parse(conv.participant_ids as string);
    const senderId = msg.senderId || session.userId;
    const recipients = participantIds.filter(id => id !== senderId);
    if (recipients.length === 0) return;
    const senderName = msg.senderName || session.name;
    const title = conv.is_group && conv.group_name ? `${senderName} · ${conv.group_name}` : senderName;
    await sendPushToUsers(env, recipients, {
      title,
      body: attachmentPreviewText(msg),
      tag: `conv-${msg.conversationId}`,
      data: { view: 'messaging', conversationId: msg.conversationId },
    });
  } catch (e) {
    console.error('Push notify (message) failed:', e);
  }
}

/** Notify the rest of the team about a new message on an inquiry. */
async function notifyInquiryMessage(env: Env, msg: any, session: SessionData): Promise<void> {
  try {
    const inq = await env.VAYU_DB.prepare(
      'SELECT inquiry_number, customer_name FROM inquiries WHERE id = ?'
    ).bind(msg.inquiryId).first();
    const label = inq
      ? `Inquiry ${inq.inquiry_number || ''}${inq.customer_name ? ` · ${inq.customer_name}` : ''}`.trim()
      : 'Inquiry';
    const senderName = msg.senderName || session.name;
    const senderId = msg.senderId || session.userId;
    await sendPushToAllExcept(env, senderId, {
      title: `${senderName} — ${label}`,
      body: attachmentPreviewText(msg),
      tag: `inquiry-${msg.inquiryId}`,
      data: { view: 'inquiry', inquiryId: msg.inquiryId },
    });
  } catch (e) {
    console.error('Push notify (inquiry message) failed:', e);
  }
}

/** Notify the rest of the team when a new inquiry is logged. */
async function notifyNewInquiry(env: Env, inq: any, session: SessionData): Promise<void> {
  try {
    await sendPushToAllExcept(env, session.userId, {
      title: `New inquiry${inq.customerName ? ` — ${inq.customerName}` : ''}`,
      body: inq.notes || `Source: ${inq.source || 'Other'}`,
      tag: `inquiry-${inq.id}`,
      data: { view: 'inquiry', inquiryId: inq.id },
    });
  } catch (e) {
    console.error('Push notify (new inquiry) failed:', e);
  }
}

async function handlePushPublicKey(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const vapid = await getOrCreateVapidKeys(ctx.env.VAYU_KV);
  return json({ publicKey: vapid.publicKey });
}

async function handlePushSubscribe(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json() as {
    endpoint?: string; keys?: { p256dh?: string; auth?: string };
  };
  if (!body.endpoint?.startsWith('https://') || !body.keys?.p256dh || !body.keys?.auth) {
    return err('A valid push subscription (endpoint, keys.p256dh, keys.auth) is required');
  }
  const id = await endpointHash(body.endpoint);
  // A device endpoint belongs to whoever is logged in on it — remove any
  // mapping of this endpoint to other users (e.g. after switching accounts).
  const existing = await ctx.env.VAYU_KV.list({ prefix: 'push:sub:' });
  for (const key of existing.keys) {
    if (key.name.endsWith(`:${id}`) && key.name !== `push:sub:${session.userId}:${id}`) {
      await ctx.env.VAYU_KV.delete(key.name);
    }
  }
  const sub: StoredPushSubscription = {
    userId: session.userId,
    endpoint: body.endpoint,
    keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
    createdAt: Date.now(),
  };
  await ctx.env.VAYU_KV.put(`push:sub:${session.userId}:${id}`, JSON.stringify(sub));
  return json({ success: true }, 201);
}

async function handlePushUnsubscribe(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json() as { endpoint?: string };
  if (!body.endpoint) return err('endpoint is required');
  const id = await endpointHash(body.endpoint);
  await ctx.env.VAYU_KV.delete(`push:sub:${session.userId}:${id}`);
  return json({ success: true });
}

// ── Route infrastructure ───────────────────────────────────────────────────

interface Ctx {
  request: Request;
  env: Env;
  url: URL;
  path: string;
  method: string;
  execCtx: ExecutionContext;
}

type RouteHandler = (ctx: Ctx) => Promise<Response>;

interface Route {
  method: string;
  match: (path: string) => boolean;
  handler: RouteHandler;
}

// ── Auth route handlers ─────────────────────────────────────────────────────

async function handleAuthStatus(ctx: Ctx): Promise<Response> {
  const count = await ctx.env.VAYU_KV.get('auth:count');
  return json({ needsSetup: !count || Number.parseInt(count) === 0 });
}

async function handleAuthSetup(ctx: Ctx): Promise<Response> {
  const count = await ctx.env.VAYU_KV.get('auth:count');
  if (count && Number.parseInt(count) > 0) return err('Setup already complete', 403);
  const body = await ctx.request.json();
  const { name, email, password } = body as { name?: string; email?: string; password?: string };
  if (!name || !email || !password) return err('name, email and password are required');
  if (password.length < 6) return err('Password must be at least 6 characters');
  const id = `admin_${Date.now()}`;
  const user: StoredUser = {
    id, name, email: email.toLowerCase().trim(),
    hashedPassword: await hashPassword(password),
    role: 'admin', createdAt: Date.now(),
  };
  await ctx.env.VAYU_KV.put(`auth:user:${id}`, JSON.stringify(user));
  await ctx.env.VAYU_KV.put(`auth:email:${user.email}`, id);
  await ctx.env.VAYU_KV.put('auth:count', '1');
  return json({ success: true });
}

async function handleAuthLogin(ctx: Ctx): Promise<Response> {
  const loginBody = await ctx.request.json();
  const { email, password } = loginBody as { email?: string; password?: string };
  if (!email || !password) return err('email and password are required');
  const userId = await ctx.env.VAYU_KV.get(`auth:email:${email.toLowerCase().trim()}`);
  if (!userId) return err('Invalid email or password', 401);
  const raw = await ctx.env.VAYU_KV.get(`auth:user:${userId}`);
  if (!raw) return err('Invalid email or password', 401);
  const user: StoredUser = JSON.parse(raw);
  if (!await verifyPassword(password, user.hashedPassword)) return err('Invalid email or password', 401);
  const token = generateToken();
  const session: SessionData = {
    userId: user.id, email: user.email, name: user.name,
    role: user.role, expiresAt: Date.now() + SESSION_TTL_DAYS * 86_400_000,
  };
  await ctx.env.VAYU_KV.put(`auth:session:${token}`, JSON.stringify(session), {
    expirationTtl: SESSION_TTL_DAYS * 86_400,
  });
  return json({ token, user: stripPassword(user) });
}

async function handleAuthMe(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const raw = await ctx.env.VAYU_KV.get(`auth:user:${session.userId}`);
  if (!raw) return err('User not found', 404);
  return json(stripPassword(JSON.parse(raw)));
}

async function handleAuthLogout(ctx: Ctx): Promise<Response> {
  const auth = ctx.request.headers.get('Authorization');
  if (auth?.startsWith('Bearer ')) {
    await ctx.env.VAYU_KV.delete(`auth:session:${auth.slice(7).trim()}`);
  }
  return json({ success: true });
}

async function handleAuthUsersList(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  if (session.role !== 'admin') return err('Forbidden', 403);
  const list = await ctx.env.VAYU_KV.list({ prefix: 'auth:user:' });
  const users: PublicUser[] = [];
  for (const key of list.keys) {
    const raw = await ctx.env.VAYU_KV.get(key.name);
    if (raw) users.push(stripPassword(JSON.parse(raw)));
  }
  users.sort((a, b) => a.createdAt - b.createdAt);
  return json(users);
}

async function handleAuthTeam(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const list = await ctx.env.VAYU_KV.list({ prefix: 'auth:user:' });
  const presenceMap = await getPresenceMap(ctx.env.VAYU_KV);
  const users: PublicUser[] = [];
  for (const key of list.keys) {
    const raw = await ctx.env.VAYU_KV.get(key.name);
    if (raw) {
      const pub = stripPassword(JSON.parse(raw));
      const presence = presenceMap[pub.id];
      pub.isOnline = !!presence?.isOnline;
      pub.lastSeen = presence?.lastSeen;
      users.push(pub);
    }
  }
  users.sort((a, b) => a.createdAt - b.createdAt);
  return json(users);
}

async function handleAuthUsersCreate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  if (session.role !== 'admin') return err('Forbidden', 403);
  const addBody = await ctx.request.json();
  const { name, email, password, role } = addBody as {
    name?: string; email?: string; password?: string; role?: string;
  };
  if (!name || !email || !password) return err('name, email and password are required');
  if (password.length < 6) return err('Password must be at least 6 characters');
  const emailKey = `auth:email:${email.toLowerCase().trim()}`;
  if (await ctx.env.VAYU_KV.get(emailKey)) return err('A user with this email already exists', 409);
  const id = `user_${Date.now()}`;
  const user: StoredUser = {
    id, name, email: email.toLowerCase().trim(),
    hashedPassword: await hashPassword(password),
    role: role === 'admin' ? 'admin' : 'user',
    createdAt: Date.now(),
  };
  await ctx.env.VAYU_KV.put(`auth:user:${id}`, JSON.stringify(user));
  await ctx.env.VAYU_KV.put(emailKey, id);
  const countRaw = await ctx.env.VAYU_KV.get('auth:count');
  await ctx.env.VAYU_KV.put('auth:count', String((countRaw ? Number.parseInt(countRaw) : 0) + 1));
  await logActivity(ctx.env.VAYU_DB, session.userId, session.name, 'created', 'user', id, `Created user "${name}" (${email}) with role "${role === 'admin' ? 'admin' : 'user'}"`);
  return json(stripPassword(user), 201);
}

async function handleAuthUsersDelete(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  if (session.role !== 'admin') return err('Forbidden', 403);
  const userId = ctx.path.slice('/auth/users/'.length);
  if (userId === session.userId) return err('Cannot delete your own account', 400);
  const raw = await ctx.env.VAYU_KV.get(`auth:user:${userId}`);
  if (!raw) return err('User not found', 404);
  const user: StoredUser = JSON.parse(raw);
  await ctx.env.VAYU_KV.delete(`auth:user:${userId}`);
  await ctx.env.VAYU_KV.delete(`auth:email:${user.email}`);
  const countRaw = await ctx.env.VAYU_KV.get('auth:count');
  if (countRaw) await ctx.env.VAYU_KV.put('auth:count', String(Math.max(0, Number.parseInt(countRaw) - 1)));
  await logActivity(ctx.env.VAYU_DB, session.userId, session.name, 'deleted', 'user', userId, `Deleted user "${user.name}" (${user.email})`);
  return json({ success: true });
}

async function handleAuthUsersUpdate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  if (session.role !== 'admin') return err('Forbidden', 403);
  const userId = ctx.path.slice('/auth/users/'.length);
  const raw = await ctx.env.VAYU_KV.get(`auth:user:${userId}`);
  if (!raw) return err('User not found', 404);
  const existing: StoredUser = JSON.parse(raw);
  const editBody = await ctx.request.json();
  const { name, email, role, password } = editBody as {
    name?: string; email?: string; role?: string; password?: string;
  };
  // If email is changing, check for conflicts and update the email index
  const newEmail = email ? email.toLowerCase().trim() : existing.email;
  if (newEmail !== existing.email) {
    const existingId = await ctx.env.VAYU_KV.get(`auth:email:${newEmail}`);
    if (existingId && existingId !== userId) return err('A user with this email already exists', 409);
    await ctx.env.VAYU_KV.delete(`auth:email:${existing.email}`);
    await ctx.env.VAYU_KV.put(`auth:email:${newEmail}`, userId);
  }
  let resolvedRole = existing.role;
  if (role === 'admin') {
    resolvedRole = 'admin';
  } else if (role === 'user') {
    resolvedRole = 'user';
  }
  const updated: StoredUser = {
    ...existing,
    name: name || existing.name,
    email: newEmail,
    role: resolvedRole,
    hashedPassword: password ? await hashPassword(password) : existing.hashedPassword,
  };
  await ctx.env.VAYU_KV.put(`auth:user:${userId}`, JSON.stringify(updated));
  await logActivity(ctx.env.VAYU_DB, session.userId, session.name, 'updated', 'user', userId, `Updated user "${updated.name}" (${updated.email})`);
  return json(stripPassword(updated));
}

async function handleAuthPresence(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const presenceMap = await getPresenceMap(ctx.env.VAYU_KV);
  return json(presenceMap);
}

async function handleAuthPresenceHeartbeat(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  await setPresence(ctx.env.VAYU_KV, session.userId);
  return json({ success: true });
}

async function handleAuthPresenceOffline(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  await ctx.env.VAYU_KV.delete(`presence:${session.userId}`);
  return json({ success: true });
}

// ── Activity log route handlers ─────────────────────────────────────────────

async function handleActivityLogsList(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  if (session.role !== 'admin') return err('Forbidden', 403);
  const limit = Math.min(Number.parseInt(ctx.url.searchParams.get('limit') || '100'), 500);
  const results = await ctx.env.VAYU_DB.prepare(
    'SELECT * FROM activity_logs ORDER BY timestamp DESC LIMIT ?'
  ).bind(limit).all();
  const logs = (results.results || []).map((row): ActivityLog => ({
    id: row.id as string,
    userId: row.user_id as string,
    userName: row.user_name as string,
    action: row.action as string,
    entity: row.entity as string,
    entityId: row.entity_id as string,
    details: row.details as string,
    timestamp: row.timestamp as number,
  }));
  return json(logs);
}

async function handleActivityLogsCreate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json();
  const { action, entity, entityId, details } = body as {
    action?: string; entity?: string; entityId?: string; details?: string;
  };
  if (!action || !entity) return err('action and entity are required');
  await logActivity(ctx.env.VAYU_DB, session.userId, session.name, action, entity, entityId || '', details || '');
  return json({ success: true }, 201);
}

// ── Upload & file route handlers ────────────────────────────────────────────

async function handleUpload(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const formData = await ctx.request.formData();
  const file = formData.get('file') as FormField;
  if (!file || typeof file === 'string') return err('No file provided');
  if (file.size > 100 * 1024 * 1024) return err('File too large (max 100MB)');
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  const key = `uploads/${session.userId}/${Date.now()}-${crypto.randomUUID()}${ext ? '.' + ext : ''}`;
  await ctx.env.VAYU_R2.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
  });

  // Optional small preview generated client-side, stored alongside the
  // original under a derivable key so grids can load it without schema changes.
  const thumb = formData.get('thumb') as FormField;
  if (thumb && typeof thumb !== 'string') {
    await ctx.env.VAYU_R2.put(`${key}__thumb`, thumb.stream(), {
      httpMetadata: { contentType: thumb.type || 'image/jpeg' },
    });
  }

  return json({ key, url: `/api/files/${key}`, thumbUrl: `/api/files/${key}__thumb` });
}

async function handleFileGet(ctx: Ctx): Promise<Response> {
  const key = decodeURIComponent(ctx.path.slice('/files/'.length));
  if (!key) return err('File not found', 404);
  let obj = await ctx.env.VAYU_R2.get(key);
  // Thumbnail requested but none exists (older uploads): serve the original.
  if (!obj && key.endsWith('__thumb')) {
    obj = await ctx.env.VAYU_R2.get(key.slice(0, -'__thumb'.length));
  }
  if (!obj) return err('File not found', 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(obj.body, { status: 200, headers });
}

// Backfill support: originals uploaded before thumbnails existed.
async function handleFilesMissingThumbs(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);

  const originals: string[] = [];
  const thumbs = new Set<string>();
  let cursor: string | undefined;
  do {
    const res = await ctx.env.VAYU_R2.list({ prefix: 'uploads/', cursor, limit: 1000 });
    for (const obj of res.objects) {
      if (obj.key.endsWith('__thumb')) thumbs.add(obj.key);
      else originals.push(obj.key);
    }
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);

  const missing = originals.filter(k => !thumbs.has(`${k}__thumb`));
  return json({ missing });
}

async function handleThumbBackfillUpload(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const formData = await ctx.request.formData();
  const key = formData.get('key') as string | null;
  const thumb = formData.get('thumb') as FormField;
  if (!key || typeof key !== 'string' || !thumb || typeof thumb === 'string') {
    return err('key and thumb are required');
  }
  // Only attach thumbnails to files that actually exist.
  const original = await ctx.env.VAYU_R2.head(key);
  if (!original) return err('File not found', 404);
  await ctx.env.VAYU_R2.put(`${key}__thumb`, thumb.stream(), {
    httpMetadata: { contentType: thumb.type || 'image/jpeg' },
  });
  return json({ success: true });
}

async function handleFileDelete(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const key = decodeURIComponent(ctx.path.slice('/files/'.length));
  if (!key) return err('File not found', 404);
  const obj = await ctx.env.VAYU_R2.head(key);
  if (!obj) return err('File not found', 404);
  // Delete the thumbnail variant too (no-op when none exists).
  await ctx.env.VAYU_R2.delete([key, `${key}__thumb`]);
  return json({ success: true });
}

// ── Messaging route handlers ────────────────────────────────────────────────

async function handleConversationsList(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const showAll = ctx.url.searchParams.get('all') === 'true' && session.role === 'admin';
  const results = await ctx.env.VAYU_DB.prepare(
    'SELECT * FROM conversations ORDER BY is_pinned DESC, last_message_time DESC'
  ).all();
  const rows = results.results || [];
  const convos = rows.map(rowToConversation);
  // Admin advance view: return all; otherwise filter to user's conversations
  if (showAll) return json(convos);
  return json(convos.filter(c => c.participantIds.includes(session.userId)));
}

async function handleConversationsCreate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json();
  const conv = body as any;
  if (!conv.id || !conv.participantIds) return err('id and participantIds are required');
  await ctx.env.VAYU_DB.prepare(
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

async function handleConversationsUpdate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const convId = ctx.path.slice('/conversations/'.length);
  const body = await ctx.request.json();
  const conv = body as any;
  await ctx.env.VAYU_DB.prepare(
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

async function handleConversationsDelete(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const convId = ctx.path.slice('/conversations/'.length);
  await ctx.env.VAYU_DB.prepare('DELETE FROM messages WHERE conversation_id = ?').bind(convId).run();
  await ctx.env.VAYU_DB.prepare('DELETE FROM conversations WHERE id = ?').bind(convId).run();
  return json({ success: true });
}

async function handleMessagesList(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const conversationId = ctx.url.searchParams.get('conversationId');
  const showAll = ctx.url.searchParams.get('all') === 'true' && session.role === 'admin';
  let results;
  if (conversationId) {
    results = await ctx.env.VAYU_DB.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC'
    ).bind(conversationId).all();
  } else if (showAll) {
    // Admin advance view: fetch ALL messages
    results = await ctx.env.VAYU_DB.prepare(
      'SELECT * FROM messages ORDER BY timestamp ASC'
    ).all();
  } else {
    // Fetch all messages for conversations the user is part of
    results = await fetchUserMessages(ctx, session.userId);
  }
  const messages = (results.results || []).map(rowToMessage);
  return json(messages);
}

async function fetchUserMessages(ctx: Ctx, userId: string): Promise<{ results: any[] }> {
  const convResults = await ctx.env.VAYU_DB.prepare('SELECT id, participant_ids FROM conversations').all();
  const convRows = convResults.results || [];
  const userConvIds = convRows
    .filter(r => {
      try { return JSON.parse(r.participant_ids as string).includes(userId); }
      catch { return false; }
    })
    .map(r => r.id as string);
  if (userConvIds.length === 0) return { results: [] };
  const placeholders = userConvIds.map(() => '?').join(',');
  return await ctx.env.VAYU_DB.prepare(
    `SELECT * FROM messages WHERE conversation_id IN (${placeholders}) ORDER BY timestamp ASC`
  ).bind(...userConvIds).all();
}

async function handleMessagesCreate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json();
  const msg = body as any;
  if (!msg.id || !msg.conversationId) return err('id and conversationId are required');
  // Detect re-syncs/migrations of existing messages so they don't re-notify.
  const alreadyExists = await ctx.env.VAYU_DB.prepare(
    'SELECT 1 FROM messages WHERE id = ?'
  ).bind(msg.id).first();
  await ctx.env.VAYU_DB.prepare(
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
  const attachmentPreview = msg.attachment?.type === 'image' ? '📷 Photo' : `📎 ${msg.attachment?.name}`;
  const lastMsgPreview = msg.attachment ? attachmentPreview : msg.text;
  await ctx.env.VAYU_DB.prepare(
    `UPDATE conversations SET last_message = ?, last_message_time = ? WHERE id = ?`
  ).bind(lastMsgPreview, msg.timestamp || Date.now(), msg.conversationId).run();

  if (!alreadyExists) {
    ctx.execCtx.waitUntil(notifyConversationMessage(ctx.env, msg, session));
  }

  return json(msg, 201);
}

async function handleMessageStatusUpdate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const msgId = ctx.path.slice('/messages/'.length, -'/status'.length);
  const body = await ctx.request.json();
  const { status } = body as { status?: string };
  if (!status) return err('status is required');
  await ctx.env.VAYU_DB.prepare(
    'UPDATE messages SET status = ? WHERE id = ?'
  ).bind(status, msgId).run();
  return json({ success: true });
}

async function handleMessageStatusBatch(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json();
  const { messageIds, status } = body as { messageIds?: string[]; status?: string };
  if (!messageIds || !status) return err('messageIds and status are required');
  for (const id of messageIds) {
    await ctx.env.VAYU_DB.prepare(
      'UPDATE messages SET status = ? WHERE id = ?'
    ).bind(status, id).run();
  }
  return json({ success: true });
}

// ── Artwork route handlers ──────────────────────────────────────────────────

async function handleArtworksList(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const results = await ctx.env.VAYU_DB.prepare(
    'SELECT * FROM artworks ORDER BY created_at DESC'
  ).all();
  const artworks = (results.results || []).map(rowToArtwork);
  return json(artworks);
}

async function handleArtworksCreate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json();
  const art = body as any;
  if (!art.id) return err('id is required');
  await ctx.env.VAYU_DB.prepare(
    `INSERT OR REPLACE INTO artworks
     (id, custom_id, title, description, dimensions, medium, status,
      location, price, image_urls, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    art.id,
    art.customId || '',
    art.title || '',
    art.description || '',
    art.dimensions || '',
    art.medium || '',
    art.status || 'Available',
    art.location || '',
    art.price || 0,
    JSON.stringify(art.imageUrls || []),
    art.createdAt || Date.now()
  ).run();
  return json(art, 201);
}

async function handleArtworksUpdate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json();
  const art = body as any;
  await ctx.env.VAYU_DB.prepare(
    `UPDATE artworks SET
       custom_id = ?, title = ?, description = ?, dimensions = ?,
       medium = ?, status = ?, location = ?, price = ?, image_urls = ?
     WHERE id = ?`
  ).bind(
    art.customId || '',
    art.title || '',
    art.description || '',
    art.dimensions || '',
    art.medium || '',
    art.status || 'Available',
    art.location || '',
    art.price || 0,
    JSON.stringify(art.imageUrls || []),
    ctx.path.slice('/artworks/'.length)
  ).run();
  return json(art);
}

async function handleArtworksDelete(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const artId = ctx.path.slice('/artworks/'.length);

  // Fetch the artwork to get its image URLs for R2 cleanup
  const result = await ctx.env.VAYU_DB.prepare(
    'SELECT image_urls FROM artworks WHERE id = ?'
  ).bind(artId).first();
  if (result) {
    const imageUrls: string[] = JSON.parse(result.image_urls as string);
    for (const imgUrl of imageUrls) {
      if (imgUrl.startsWith('/api/files/')) {
        const key = decodeURIComponent(imgUrl.slice('/api/files/'.length));
        try { await ctx.env.VAYU_R2.delete(key); } catch { }
      }
    }
  }

  await ctx.env.VAYU_DB.prepare('DELETE FROM artworks WHERE id = ?').bind(artId).run();
  return json({ success: true });
}

// ── Collection route handlers ───────────────────────────────────────────────

async function handleCollectionsList(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const results = await ctx.env.VAYU_DB.prepare(
    'SELECT * FROM collections ORDER BY created_at DESC'
  ).all();
  const collections = (results.results || []).map(rowToCollection);
  return json(collections);
}

async function handleCollectionsCreate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json();
  const col = body as any;
  if (!col.id) return err('id is required');
  await ctx.env.VAYU_DB.prepare(
    `INSERT OR REPLACE INTO collections
     (id, name, description, artwork_ids, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(
    col.id,
    col.name || '',
    col.description || '',
    JSON.stringify(col.artworkIds || []),
    col.createdAt || Date.now()
  ).run();
  return json(col, 201);
}

async function handleCollectionsUpdate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json();
  const col = body as any;
  await ctx.env.VAYU_DB.prepare(
    `UPDATE collections SET
       name = ?, description = ?, artwork_ids = ?
     WHERE id = ?`
  ).bind(
    col.name || '',
    col.description || '',
    JSON.stringify(col.artworkIds || []),
    ctx.path.slice('/collections/'.length)
  ).run();
  return json(col);
}

async function handleCollectionsDelete(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const colId = ctx.path.slice('/collections/'.length);
  await ctx.env.VAYU_DB.prepare('DELETE FROM collections WHERE id = ?').bind(colId).run();
  return json({ success: true });
}

// ── Catalog route handlers ──────────────────────────────────────────────────

async function handleCatalogsList(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const results = await ctx.env.VAYU_DB.prepare(
    'SELECT * FROM catalogs ORDER BY created_at DESC'
  ).all();
  const catalogs = (results.results || []).map(rowToCatalog);
  return json(catalogs);
}

async function handleCatalogsCreate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json();
  const cat = body as any;
  if (!cat.id) return err('id is required');
  await ctx.env.VAYU_DB.prepare(
    `INSERT OR REPLACE INTO catalogs
     (id, name, description, artwork_ids, cover_image_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    cat.id,
    cat.name || '',
    cat.description || '',
    JSON.stringify(cat.artworkIds || []),
    cat.coverImageUrl || '',
    cat.createdAt || Date.now()
  ).run();
  return json(cat, 201);
}

async function handleCatalogsUpdate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json();
  const cat = body as any;
  await ctx.env.VAYU_DB.prepare(
    `UPDATE catalogs SET
       name = ?, description = ?, artwork_ids = ?, cover_image_url = ?
     WHERE id = ?`
  ).bind(
    cat.name || '',
    cat.description || '',
    JSON.stringify(cat.artworkIds || []),
    cat.coverImageUrl || '',
    ctx.path.slice('/catalogs/'.length)
  ).run();
  return json(cat);
}

async function handleCatalogsDelete(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const catId = ctx.path.slice('/catalogs/'.length);

  // Clean up cover image from R2 if it's an uploaded file
  const result = await ctx.env.VAYU_DB.prepare(
    'SELECT cover_image_url FROM catalogs WHERE id = ?'
  ).bind(catId).first();
  if (result?.cover_image_url) {
    const coverUrl = result.cover_image_url as string;
    if (coverUrl.startsWith('/api/files/')) {
      const key = decodeURIComponent(coverUrl.slice('/api/files/'.length));
      try { await ctx.env.VAYU_R2.delete(key); } catch { }
    }
  }

  await ctx.env.VAYU_DB.prepare('DELETE FROM catalogs WHERE id = ?').bind(catId).run();
  return json({ success: true });
}

// ── Inquiry route handlers ──────────────────────────────────────────────────

async function handleInquiriesList(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const results = await ctx.env.VAYU_DB.prepare(
    'SELECT * FROM inquiries ORDER BY date DESC'
  ).all();
  const inquiries = (results.results || []).map(rowToInquiry);
  return json(inquiries);
}

async function handleInquiriesCreate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json();
  const inq = body as any;
  if (!inq.id) return err('id is required');
  // Detect re-syncs/migrations of existing inquiries so they don't re-notify.
  const alreadyExists = await ctx.env.VAYU_DB.prepare(
    'SELECT 1 FROM inquiries WHERE id = ?'
  ).bind(inq.id).first();
  await ctx.env.VAYU_DB.prepare(
    `INSERT OR REPLACE INTO inquiries
     (id, inquiry_number, customer_name, customer_phone, customer_email,
      artwork_ids, notes, source, status, catalog_shared, date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    inq.id,
    inq.inquiryNumber || '',
    inq.customerName || '',
    inq.customerPhone || '',
    inq.customerEmail || '',
    JSON.stringify(inq.artworkIds || []),
    inq.notes || '',
    inq.source || 'Other',
    inq.status || 'New',
    inq.catalogShared ? 1 : 0,
    inq.date || Date.now()
  ).run();

  if (!alreadyExists) {
    ctx.execCtx.waitUntil(notifyNewInquiry(ctx.env, inq, session));
  }

  return json(inq, 201);
}

async function handleInquiriesUpdate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json();
  const inq = body as any;
  await ctx.env.VAYU_DB.prepare(
    `UPDATE inquiries SET
       inquiry_number = ?, customer_name = ?, customer_phone = ?,
       customer_email = ?, artwork_ids = ?, notes = ?, source = ?,
       status = ?, catalog_shared = ?
     WHERE id = ?`
  ).bind(
    inq.inquiryNumber || '',
    inq.customerName || '',
    inq.customerPhone || '',
    inq.customerEmail || '',
    JSON.stringify(inq.artworkIds || []),
    inq.notes || '',
    inq.source || 'Other',
    inq.status || 'New',
    inq.catalogShared ? 1 : 0,
    ctx.path.slice('/inquiries/'.length)
  ).run();
  return json(inq);
}

async function handleInquiriesDelete(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const inqId = ctx.path.slice('/inquiries/'.length);
  // Also delete associated inquiry messages
  await ctx.env.VAYU_DB.prepare('DELETE FROM inquiry_messages WHERE inquiry_id = ?').bind(inqId).run();
  await ctx.env.VAYU_DB.prepare('DELETE FROM inquiries WHERE id = ?').bind(inqId).run();
  return json({ success: true });
}

// ── Inquiry message route handlers ──────────────────────────────────────────

async function handleInquiryMessagesList(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const inquiryId = ctx.url.searchParams.get('inquiryId');
  let results;
  if (inquiryId) {
    results = await ctx.env.VAYU_DB.prepare(
      'SELECT * FROM inquiry_messages WHERE inquiry_id = ? ORDER BY timestamp ASC'
    ).bind(inquiryId).all();
  } else {
    results = await ctx.env.VAYU_DB.prepare(
      'SELECT * FROM inquiry_messages ORDER BY timestamp ASC'
    ).all();
  }
  const messages = (results.results || []).map(rowToInquiryMessage);
  return json(messages);
}

async function handleInquiryMessagesCreate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json();
  const msg = body as any;
  if (!msg.id || !msg.inquiryId) return err('id and inquiryId are required');
  // Detect re-syncs/migrations of existing messages so they don't re-notify.
  const alreadyExists = await ctx.env.VAYU_DB.prepare(
    'SELECT 1 FROM inquiry_messages WHERE id = ?'
  ).bind(msg.id).first();
  await ctx.env.VAYU_DB.prepare(
    `INSERT OR REPLACE INTO inquiry_messages
     (id, inquiry_id, sender_id, sender_name, text, tags, timestamp,
      status, reply_to, attachment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    msg.id,
    msg.inquiryId,
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

  if (!alreadyExists) {
    ctx.execCtx.waitUntil(notifyInquiryMessage(ctx.env, msg, session));
  }

  return json(msg, 201);
}

async function handleInquiryMessageStatusUpdate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const msgId = ctx.path.slice('/inquiry-messages/'.length, -'/status'.length);
  const body = await ctx.request.json();
  const { status } = body as { status?: string };
  if (!status) return err('status is required');
  await ctx.env.VAYU_DB.prepare(
    'UPDATE inquiry_messages SET status = ? WHERE id = ?'
  ).bind(status, msgId).run();
  return json({ success: true });
}

async function handleInquiryMessageStatusBatch(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json();
  const { messageIds, status } = body as { messageIds?: string[]; status?: string };
  if (!messageIds || !status) return err('messageIds and status are required');
  for (const id of messageIds) {
    await ctx.env.VAYU_DB.prepare(
      'UPDATE inquiry_messages SET status = ? WHERE id = ?'
    ).bind(status, id).run();
  }
  return json({ success: true });
}

// ── Route table ─────────────────────────────────────────────────────────────

const isExact = (p: string) => (path: string) => path === p;
const isPrefix = (p: string) => (path: string) => path.startsWith(p);

const routes: Route[] = [
  // Auth
  { method: 'GET', match: isExact('/auth/status'), handler: handleAuthStatus },
  { method: 'POST', match: isExact('/auth/setup'), handler: handleAuthSetup },
  { method: 'POST', match: isExact('/auth/login'), handler: handleAuthLogin },
  { method: 'GET', match: isExact('/auth/me'), handler: handleAuthMe },
  { method: 'POST', match: isExact('/auth/logout'), handler: handleAuthLogout },
  { method: 'GET', match: isExact('/auth/users'), handler: handleAuthUsersList },
  { method: 'GET', match: isExact('/auth/team'), handler: handleAuthTeam },
  { method: 'POST', match: isExact('/auth/users'), handler: handleAuthUsersCreate },
  { method: 'DELETE', match: isPrefix('/auth/users/'), handler: handleAuthUsersDelete },
  { method: 'PUT', match: isPrefix('/auth/users/'), handler: handleAuthUsersUpdate },
  { method: 'GET', match: isExact('/auth/presence'), handler: handleAuthPresence },
  { method: 'POST', match: isExact('/auth/presence/heartbeat'), handler: handleAuthPresenceHeartbeat },
  { method: 'POST', match: isExact('/auth/presence/offline'), handler: handleAuthPresenceOffline },

  // Activity logs
  { method: 'GET', match: isExact('/activity-logs'), handler: handleActivityLogsList },
  { method: 'POST', match: isExact('/activity-logs'), handler: handleActivityLogsCreate },

  // Upload & files
  { method: 'POST', match: isExact('/upload'), handler: handleUpload },
  { method: 'GET', match: isExact('/files-missing-thumbs'), handler: handleFilesMissingThumbs },
  { method: 'POST', match: isExact('/files-thumbs'), handler: handleThumbBackfillUpload },
  { method: 'GET', match: isPrefix('/files/'), handler: handleFileGet },
  { method: 'DELETE', match: isPrefix('/files/'), handler: handleFileDelete },

  // Messaging
  { method: 'GET', match: isExact('/conversations'), handler: handleConversationsList },
  { method: 'POST', match: isExact('/conversations'), handler: handleConversationsCreate },
  { method: 'PUT', match: isPrefix('/conversations/'), handler: handleConversationsUpdate },
  { method: 'DELETE', match: isPrefix('/conversations/'), handler: handleConversationsDelete },
  { method: 'GET', match: isExact('/messages'), handler: handleMessagesList },
  { method: 'POST', match: isExact('/messages'), handler: handleMessagesCreate },
  { method: 'PUT', match: (p) => p.startsWith('/messages/') && p.endsWith('/status'), handler: handleMessageStatusUpdate },
  { method: 'PUT', match: isExact('/messages/status-batch'), handler: handleMessageStatusBatch },

  // Artworks
  { method: 'GET', match: isExact('/artworks'), handler: handleArtworksList },
  { method: 'POST', match: isExact('/artworks'), handler: handleArtworksCreate },
  { method: 'PUT', match: isPrefix('/artworks/'), handler: handleArtworksUpdate },
  { method: 'DELETE', match: isPrefix('/artworks/'), handler: handleArtworksDelete },

  // Collections
  { method: 'GET', match: isExact('/collections'), handler: handleCollectionsList },
  { method: 'POST', match: isExact('/collections'), handler: handleCollectionsCreate },
  { method: 'PUT', match: isPrefix('/collections/'), handler: handleCollectionsUpdate },
  { method: 'DELETE', match: isPrefix('/collections/'), handler: handleCollectionsDelete },

  // Catalogs
  { method: 'GET', match: isExact('/catalogs'), handler: handleCatalogsList },
  { method: 'POST', match: isExact('/catalogs'), handler: handleCatalogsCreate },
  { method: 'PUT', match: isPrefix('/catalogs/'), handler: handleCatalogsUpdate },
  { method: 'DELETE', match: isPrefix('/catalogs/'), handler: handleCatalogsDelete },

  // Inquiries
  { method: 'GET', match: isExact('/inquiries'), handler: handleInquiriesList },
  { method: 'POST', match: isExact('/inquiries'), handler: handleInquiriesCreate },
  { method: 'PUT', match: isPrefix('/inquiries/'), handler: handleInquiriesUpdate },
  { method: 'DELETE', match: isPrefix('/inquiries/'), handler: handleInquiriesDelete },

  // Inquiry messages
  { method: 'GET', match: isExact('/inquiry-messages'), handler: handleInquiryMessagesList },
  { method: 'POST', match: isExact('/inquiry-messages'), handler: handleInquiryMessagesCreate },
  { method: 'PUT', match: (p) => p.startsWith('/inquiry-messages/') && p.endsWith('/status'), handler: handleInquiryMessageStatusUpdate },
  { method: 'PUT', match: isExact('/inquiry-messages/status-batch'), handler: handleInquiryMessageStatusBatch },

  // Settings
  { method: 'GET', match: isExact('/settings'), handler: handleSettingsGet },
  { method: 'POST', match: isExact('/settings'), handler: handleSettingsUpdate },

  // Push notifications
  { method: 'GET', match: isExact('/push/public-key'), handler: handlePushPublicKey },
  { method: 'POST', match: isExact('/push/subscribe'), handler: handlePushSubscribe },
  { method: 'POST', match: isExact('/push/unsubscribe'), handler: handlePushUnsubscribe },
];

// ── App Settings ──────────────────────────────────────────────────────────

async function handleSettingsGet(ctx: Ctx) {
  const raw = await ctx.env.VAYU_KV.get('global_settings');
  const settings = raw ? JSON.parse(raw) : {};
  return json(settings);
}

async function handleSettingsUpdate(ctx: Ctx) {
  const body: Record<string, any> = await ctx.request.json();
  const raw = await ctx.env.VAYU_KV.get('global_settings');
  const existing = raw ? JSON.parse(raw) : {};
  const updated = { ...existing, ...body };
  await ctx.env.VAYU_KV.put('global_settings', JSON.stringify(updated));
  return json(updated);
}


// ── Main handler ───────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, execCtx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, '');
    const ctx: Ctx = { request, env, url, path, method: request.method, execCtx };

    try {
      for (const route of routes) {
        if (route.method === ctx.method && route.match(path)) {
          return await route.handler(ctx);
        }
      }
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  },
};