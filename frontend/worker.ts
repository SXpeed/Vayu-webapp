import { getOrCreateVapidKeys, sendWebPush, type StoredPushSubscription } from './webpush';
import {
  ADMIN_PERMISSIONS, ADMIN_ROLE_ID, BUILT_IN_ROLES, STAFF_DEFAULT_PERMISSIONS, STAFF_ROLE_ID,
  atLeast, normalizePermissions, type AccessLevel, type Permissions, type RoleDef, type SectionId,
} from './permissions';

interface Env {
  VAYU_KV: KVNamespace;
  VAYU_R2: R2Bucket;
  VAYU_DB: D1Database;
  // Razorpay credentials — set via `wrangler secret put <NAME>`.
  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
  RAZORPAY_WEBHOOK_SECRET?: string;
  // Calendarific (Indian public holidays & festivals) — set via `wrangler secret put`.
  CALENDARIFIC_API_KEY?: string;
}

type FormField = File | string | null;

interface StoredUser {
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
}

interface PublicUser {
  id: string;
  name: string;
  email: string;
  phone?: string;
  address?: string;
  role: string;
  createdAt: number;
  isOnline?: boolean;
  lastSeen?: number;
  notificationsEnabled?: boolean;
}

interface SessionData {
  userId: string;
  email: string;
  name: string;
  /** Refreshed from the user record on every request (see getSession). */
  role: string;
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
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
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
  return Uint8Array.from(atob(s), c => c.codePointAt(0) ?? 0);
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

function bearerToken(request: Request): string | null {
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
function getSession(request: Request, kv: KVNamespace): Promise<SessionData | null> {
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

async function getRoles(kv: KVNamespace): Promise<RoleDef[]> {
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

async function saveRoles(kv: KVNamespace, roles: RoleDef[]): Promise<void> {
  const toStore = roles
    .filter(r => r.id !== ADMIN_ROLE_ID)
    .map(r => ({ id: r.id, name: r.name, permissions: r.permissions }));
  await kv.put(ROLES_KEY, JSON.stringify(toStore));
  rolesCache = null;
}

/** A role that no longer exists grants nothing. */
function permissionsFor(roles: RoleDef[], roleId: string): Permissions {
  if (roleId === ADMIN_ROLE_ID) return ADMIN_PERMISSIONS;
  return roles.find(r => r.id === roleId)?.permissions ?? normalizePermissions({});
}

async function sessionCan(ctx: Ctx, session: SessionData, section: SectionId, level: AccessLevel): Promise<boolean> {
  if (session.role === ADMIN_ROLE_ID) return true;
  return atLeast(permissionsFor(await getRoles(ctx.env.VAYU_KV), session.role)[section], level);
}

/** Public user plus what the app needs to decide what to show. */
async function withAccess(ctx: Ctx, user: StoredUser): Promise<PublicUser & { roleName: string; permissions: Permissions }> {
  const roles = await getRoles(ctx.env.VAYU_KV);
  return {
    ...stripPassword(user),
    roleName: roles.find(r => r.id === user.role)?.name || 'No role',
    permissions: permissionsFor(roles, user.role),
  };
}

interface AccessRule {
  section: SectionId;
  level: AccessLevel;
  /** For reads only: other sections whose screens need this data too. */
  readableBy?: SectionId[];
}

/**
 * Which section guards a route. GET needs "view"; anything that changes data
 * needs "edit". Routes not listed (auth, uploads, files, push, presence,
 * settings, deleted items) have no section: their handlers do their own
 * checks.
 */
function accessRule(path: string, method: string): AccessRule | null {
  const read = method === 'GET';
  const level: AccessLevel = read ? 'view' : 'edit';
  const under = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`);

  if (under('/artworks')) {
    // Collections, catalogs, inquiries and invoices all show artworks.
    return { section: 'inventory', level, readableBy: read ? ['collections', 'catalogs', 'inquiries', 'invoices'] : undefined };
  }
  if (under('/collections')) return { section: 'collections', level };
  if (under('/catalogs')) return { section: 'catalogs', level };
  if (under('/contacts')) return { section: 'contacts', level, readableBy: read ? ['inquiries', 'invoices', 'payments'] : undefined };
  if (under('/inquiries') || under('/inquiry-messages')) return { section: 'inquiries', level };
  if (under('/payments/webhook')) return null; // Razorpay calls this, no session
  if (under('/payments')) return { section: 'payments', level };
  if (under('/events') || under('/holidays')) return { section: 'calendar', level };
  if (under('/conversations') || under('/messages')) return { section: 'messages', level };
  if (under('/activity-logs')) return read ? { section: 'activity', level: 'view' } : null;
  if (under('/attendance')) {
    // Own check-in/out and history need "view"; managing the team and stores needs "edit".
    const own = path === '/attendance/me' || path === '/attendance/check-in' || path === '/attendance/check-out'
      || (read && (path === '/attendance/stores' || path === '/attendance/records'));
    return { section: 'attendance', level: own ? 'view' : 'edit' };
  }
  return null;
}

/** Router gate: a 403 response when the caller's role doesn't allow this route. */
async function checkAccess(ctx: Ctx): Promise<Response | null> {
  const rule = accessRule(ctx.path, ctx.method);
  if (!rule) return null;
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return null; // handlers answer 401 themselves
  if (session.role === ADMIN_ROLE_ID) return null;
  const perms = permissionsFor(await getRoles(ctx.env.VAYU_KV), session.role);
  if (atLeast(perms[rule.section], rule.level)) return null;
  if (rule.readableBy?.some(s => atLeast(perms[s], 'view'))) return null;
  return err("Your role doesn't have access to this", 403);
}

function stripPassword(user: StoredUser): PublicUser {
  const pub: Partial<StoredUser> = { ...user };
  delete pub.hashedPassword;
  return pub as PublicUser;
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
    artist: (row.artist as string) || undefined,
    artworkYear: (row.artwork_year as string) || undefined,
    descriptionTitle: (row.description_title as string) || undefined,
    plusGst: !!row.plus_gst,
  };
}

function rowToCollection(row: Record<string, unknown>): any {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string,
    artworkIds: JSON.parse(row.artwork_ids as string),
    coverImageUrl: (row.cover_image_url as string) || undefined,
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
    pdfUrl: (row.pdf_url as string) || undefined,
    source: (row.source as string) || undefined,
    createdAt: row.created_at as number,
  };
}

// The catalogs table predates pdf_url/source — add them lazily (once per
// isolate) so no manual D1 migration is required.
let catalogsColumnsPromise: Promise<void> | null = null;
function ensureCatalogsColumns(db: D1Database): Promise<void> {
  catalogsColumnsPromise ??= (async () => {
    try { await db.prepare('ALTER TABLE catalogs ADD COLUMN pdf_url TEXT').run(); } catch { /* already exists */ }
    try { await db.prepare(`ALTER TABLE catalogs ADD COLUMN source TEXT NOT NULL DEFAULT 'generated'`).run(); } catch { /* already exists */ }
  })();
  return catalogsColumnsPromise;
}

function rowToInquiry(row: Record<string, unknown>): any {
  return {
    id: row.id as string,
    inquiryNumber: row.inquiry_number as string,
    customerName: row.customer_name as string,
    customerPhone: row.customer_phone as string,
    customerEmail: row.customer_email as string,
    customerAddress: (row.customer_address as string) || undefined,
    artworkIds: JSON.parse(row.artwork_ids as string),
    notes: row.notes as string,
    source: row.source as string,
    status: row.status as string,
    catalogShared: !!row.catalog_shared,
    date: row.date as number,
    createdBy: (row.created_by as string) || undefined,
    createdByName: (row.created_by_name as string) || undefined,
    imageUrls: row.image_urls ? JSON.parse(row.image_urls as string) : [],
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
    const groupName = conv.group_name as string;
    const title = conv.is_group && groupName ? `${senderName} · ${groupName}` : senderName;
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
    let label = 'Inquiry';
    if (inq) {
      const inquiryNumber = (inq.inquiry_number as string) || '';
      const customerName = inq.customer_name as string;
      const suffix = customerName ? ` · ${customerName}` : '';
      label = `Inquiry ${inquiryNumber}${suffix}`.trim();
    }
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
    const customerSuffix = inq.customerName ? ` — ${inq.customerName}` : '';
    await sendPushToAllExcept(env, session.userId, {
      title: `New inquiry${customerSuffix}`,
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
  const body = await ctx.request.json<{
    endpoint?: string; keys?: { p256dh?: string; auth?: string };
  }>();
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
  const body = await ctx.request.json<{ endpoint?: string }>();
  if (!body.endpoint) return err('endpoint is required');
  const id = await endpointHash(body.endpoint);
  await ctx.env.VAYU_KV.delete(`push:sub:${session.userId}:${id}`);
  return json({ success: true });
}

// ── Razorpay payment links ──────────────────────────────────────────────────
// Links are created via the Razorpay Payment Links API and tracked in KV
// under `payment:link:<plinkId>`. Razorpay calls POST /payments/webhook when
// a link is paid; we verify the HMAC signature, mark the record paid, and
// push-notify the whole team.

interface StoredPaymentLink {
  id: string;
  shortUrl: string;
  amount: number; // paise
  description: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  status: string; // created | paid | partially_paid | expired | cancelled
  createdAt: number;
  createdBy: string;
  createdByName: string;
  paidAt?: number;
  paymentId?: string;
  paymentMethod?: string;
}

function formatRupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function basicAuthHeader(username: string, password: string): string {
  const credentials = btoa(`${username}:${password}`);
  return `Basic ${credentials}`;
}

async function handlePaymentLinkCreate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json<{
    amount?: number; description?: string;
    customerName?: string; customerPhone?: string; customerEmail?: string;
    notifySms?: boolean; notifyEmail?: boolean;
  }>();
  const amountPaise = Math.round(Number(body.amount) * 100);
  if (!Number.isFinite(amountPaise) || amountPaise < 100) {
    return err('A valid amount of at least ₹1 is required');
  }
  if (!body.customerName?.trim()) return err('Customer name is required');

  const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = ctx.env;
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    return err('Razorpay is not configured. Ask your admin to set the RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET secrets.', 503);
  }

  const customer: Record<string, string> = { name: body.customerName.trim() };
  if (body.customerPhone?.trim()) customer.contact = body.customerPhone.trim();
  if (body.customerEmail?.trim()) customer.email = body.customerEmail.trim();

  const res = await fetch('https://api.razorpay.com/v1/payment_links', {
    method: 'POST',
    headers: {
      'Authorization': basicAuthHeader(RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: amountPaise,
      currency: 'INR',
      description: body.description?.trim() || 'Vayu Design',
      customer,
      notify: {
        sms: !!body.notifySms && !!customer.contact,
        email: !!body.notifyEmail && !!customer.email,
      },
      reminder_enable: true,
      notes: { created_by: session.name, app: 'vayu-webapp' },
    }),
  });

  const data = await res.json() as any;
  if (!res.ok) {
    const reason = data?.error?.description || `Razorpay error (${res.status})`;
    return err(reason, 502);
  }

  const record: StoredPaymentLink = {
    id: data.id,
    shortUrl: data.short_url,
    amount: amountPaise,
    description: body.description?.trim() || '',
    customerName: customer.name,
    customerPhone: customer.contact || '',
    customerEmail: customer.email || '',
    status: data.status || 'created',
    createdAt: Date.now(),
    createdBy: session.userId,
    createdByName: session.name,
  };
  await ctx.env.VAYU_KV.put(`payment:link:${record.id}`, JSON.stringify(record));
  await logActivity(ctx.env.VAYU_DB, session.userId, session.name, 'created', 'payment link', record.id,
    `Created payment link of ${formatRupees(amountPaise)} for "${record.customerName}"`);
  return json(record, 201);
}

async function handlePaymentLinksList(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const list = await ctx.env.VAYU_KV.list({ prefix: 'payment:link:' });
  const links: StoredPaymentLink[] = [];
  for (const key of list.keys) {
    const raw = await ctx.env.VAYU_KV.get(key.name);
    if (raw) links.push(JSON.parse(raw));
  }
  links.sort((a, b) => b.createdAt - a.createdAt);
  return json(links);
}

/** Constant-time hex string comparison. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a.codePointAt(i) ?? 0) ^ (b.codePointAt(i) ?? 0);
  return diff === 0;
}

async function verifyRazorpaySignature(rawBody: string, signature: string, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody)));
  const expected = Array.from(mac).map(b => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqualHex(expected, signature);
}

async function handlePaymentWebhook(ctx: Ctx): Promise<Response> {
  const secret = ctx.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return err('Webhook not configured', 503);
  const signature = ctx.request.headers.get('x-razorpay-signature');
  if (!signature) return err('Missing signature', 400);
  const rawBody = await ctx.request.text();
  if (!await verifyRazorpaySignature(rawBody, signature, secret)) {
    return err('Invalid signature', 401);
  }

  const event = JSON.parse(rawBody);
  const plink = event?.payload?.payment_link?.entity;
  if (!plink?.id) return json({ received: true });

  const kvKey = `payment:link:${plink.id}`;
  const raw = await ctx.env.VAYU_KV.get(kvKey);
  const record: StoredPaymentLink | null = raw ? JSON.parse(raw) : null;

  const statusByEvent: Record<string, string> = {
    'payment_link.paid': 'paid',
    'payment_link.partially_paid': 'partially_paid',
    'payment_link.expired': 'expired',
    'payment_link.cancelled': 'cancelled',
  };
  const newStatus = statusByEvent[event.event];
  if (!newStatus) return json({ received: true });

  // Razorpay retries webhooks — don't re-notify a link we already marked paid.
  const alreadyPaid = record?.status === 'paid';

  // Links created outside the app (e.g. Razorpay dashboard) still get a
  // record on payment, so the history stays complete.
  const updated: StoredPaymentLink = record ?? {
    id: plink.id,
    shortUrl: plink.short_url || '',
    amount: plink.amount || 0,
    description: plink.description || '',
    customerName: plink.customer?.name || '',
    customerPhone: plink.customer?.contact || '',
    customerEmail: plink.customer?.email || '',
    status: newStatus,
    createdAt: plink.created_at ? plink.created_at * 1000 : Date.now(),
    createdBy: '',
    createdByName: '',
  };
  updated.status = newStatus;
  if (event.event === 'payment_link.paid') {
    const payment = event?.payload?.payment?.entity;
    updated.paidAt = Date.now();
    updated.paymentId = payment?.id || '';
    updated.paymentMethod = payment?.method || '';
  }
  await ctx.env.VAYU_KV.put(kvKey, JSON.stringify(updated));

  if (event.event === 'payment_link.paid' && !alreadyPaid) {
    const amount = updated.amount;
    const name = updated.customerName || 'customer';
    const descriptionSuffix = record?.description ? ` — ${record.description}` : '';
    ctx.execCtx.waitUntil(Promise.all([
      sendPushToAllExcept(ctx.env, '', {
        title: 'Payment received ✓',
        body: `${formatRupees(amount)} from ${name}${descriptionSuffix}`,
        tag: `payment-${plink.id}`,
        data: { view: 'payments', paymentLinkId: plink.id },
      }),
      logActivity(ctx.env.VAYU_DB, 'razorpay', 'Razorpay', 'received', 'payment', plink.id,
        `Payment of ${formatRupees(amount)} received from "${name}"`),
    ]));
  }

  return json({ received: true });
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
  return json({ needsSetup: !count || Number.parseInt(count, 10) === 0 });
}

async function handleAuthSetup(ctx: Ctx): Promise<Response> {
  const count = await ctx.env.VAYU_KV.get('auth:count');
  if (count && Number.parseInt(count, 10) > 0) return err('Setup already complete', 403);
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
  return json({ token, user: await withAccess(ctx, user) });
}

async function handleAuthMe(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const raw = await ctx.env.VAYU_KV.get(`auth:user:${session.userId}`);
  if (!raw) return err('User not found', 404);
  return json(await withAccess(ctx, JSON.parse(raw)));
}

/** Trimmed, length-capped string field; undefined when the value isn't a string. */
function profileText(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : undefined;
}

// Lets any signed-in user edit their own name and contact details. Email and
// role stay admin-managed (PUT /auth/users/:id) since email is the login.
async function handleAuthMeUpdate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const userKey = `auth:user:${session.userId}`;
  const raw = await ctx.env.VAYU_KV.get(userKey);
  if (!raw) return err('User not found', 404);
  const existing: StoredUser = JSON.parse(raw);
  const body = await ctx.request.json<{ name?: unknown; phone?: unknown; address?: unknown }>();
  const updated: StoredUser = {
    ...existing,
    name: profileText(body.name, 100) || existing.name,
    phone: profileText(body.phone, 40) ?? existing.phone,
    address: profileText(body.address, 500) ?? existing.address,
  };
  await ctx.env.VAYU_KV.put(userKey, JSON.stringify(updated));

  // Keep this device's session in step so records it creates carry the new name.
  const token = bearerToken(ctx.request);
  if (token && updated.name !== session.name) {
    await ctx.env.VAYU_KV.put(`auth:session:${token}`, JSON.stringify({ ...session, name: updated.name }), {
      expiration: Math.floor(session.expiresAt / 1000),
    });
  }
  logEntityChange(ctx, session, 'updated', 'user', updated.id, `Updated own profile (${updated.name})`);
  return json(stripPassword(updated));
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
  const pushSubs = await ctx.env.VAYU_KV.list({ prefix: 'push:sub:' });
  const usersWithPush = new Set<string>();
  for (const key of pushSubs.keys) {
    const parts = key.name.split(':');
    if (parts.length >= 3) usersWithPush.add(parts[2]);
  }

  const users: PublicUser[] = [];
  for (const key of list.keys) {
    const raw = await ctx.env.VAYU_KV.get(key.name);
    if (raw) {
      const pub = stripPassword(JSON.parse(raw));
      pub.notificationsEnabled = usersWithPush.has(pub.id);
      users.push(pub);
    }
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
  const roles = await getRoles(ctx.env.VAYU_KV);
  const roleId = role && roles.some(r => r.id === role) ? role : STAFF_ROLE_ID;
  const id = `user_${Date.now()}`;
  const user: StoredUser = {
    id, name, email: email.toLowerCase().trim(),
    hashedPassword: await hashPassword(password),
    role: roleId,
    createdAt: Date.now(),
  };
  await ctx.env.VAYU_KV.put(`auth:user:${id}`, JSON.stringify(user));
  await ctx.env.VAYU_KV.put(emailKey, id);
  const countRaw = await ctx.env.VAYU_KV.get('auth:count');
  await ctx.env.VAYU_KV.put('auth:count', String((countRaw ? Number.parseInt(countRaw, 10) : 0) + 1));
  await logActivity(ctx.env.VAYU_DB, session.userId, session.name, 'created', 'user', id, `Created user "${name}" (${email}) with role "${roles.find(r => r.id === roleId)?.name ?? roleId}"`);
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
  if (countRaw) await ctx.env.VAYU_KV.put('auth:count', String(Math.max(0, Number.parseInt(countRaw, 10) - 1)));
  await logActivity(ctx.env.VAYU_DB, session.userId, session.name, 'deleted', 'user', userId, `Deleted user "${user.name}" (${user.email})`);
  // Full user (incl. password hash) so an admin undo fully restores the login.
  archiveDeletedAsync(ctx, session, 'user', userId, `User "${user.name}" (${user.email})`, user);
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
  const { name, email, role, password, storeId } = editBody as {
    name?: string; email?: string; role?: string; password?: string; storeId?: string;
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
  if (role !== undefined && role !== existing.role) {
    const roles = await getRoles(ctx.env.VAYU_KV);
    if (!roles.some(r => r.id === role)) return err('That role does not exist', 400);
    if (userId === session.userId && existing.role === ADMIN_ROLE_ID) {
      return err("You can't remove your own admin role", 400);
    }
    resolvedRole = role;
  }
  const updated: StoredUser = {
    ...existing,
    name: name || existing.name,
    email: newEmail,
    role: resolvedRole,
    storeId: typeof storeId === 'string' ? storeId : existing.storeId,
    hashedPassword: password ? await hashPassword(password) : existing.hashedPassword,
  };
  await ctx.env.VAYU_KV.put(`auth:user:${userId}`, JSON.stringify(updated));
  await logActivity(ctx.env.VAYU_DB, session.userId, session.name, 'updated', 'user', userId, `Updated user "${updated.name}" (${updated.email})`);
  return json(stripPassword(updated));
}

// ── Roles (admin only) ─────────────────────────────────────────────────────

async function requireAdmin(ctx: Ctx): Promise<SessionData | Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  if (session.role !== ADMIN_ROLE_ID) return err('Forbidden', 403);
  return session;
}

function readRoleName(value: unknown, roles: RoleDef[], exceptId?: string): string | Response {
  const name = typeof value === 'string' ? value.trim().slice(0, 40) : '';
  if (!name) return err('Give the role a name', 400);
  if (roles.some(r => r.id !== exceptId && r.name.toLowerCase() === name.toLowerCase())) {
    return err('A role with that name already exists', 409);
  }
  return name;
}

async function handleRolesList(ctx: Ctx): Promise<Response> {
  const session = await requireAdmin(ctx);
  if (session instanceof Response) return session;
  return json(await getRoles(ctx.env.VAYU_KV));
}

async function handleRolesCreate(ctx: Ctx): Promise<Response> {
  const session = await requireAdmin(ctx);
  if (session instanceof Response) return session;
  const body = await ctx.request.json() as { name?: unknown; permissions?: unknown };
  const roles = await getRoles(ctx.env.VAYU_KV);
  const name = readRoleName(body.name, roles);
  if (name instanceof Response) return name;
  const role: RoleDef = {
    id: `role_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`,
    name,
    permissions: normalizePermissions(body.permissions),
  };
  await saveRoles(ctx.env.VAYU_KV, [...roles, role]);
  logEntityChange(ctx, session, 'created', 'role', role.id, `Created role "${name}"`);
  return json(role, 201);
}

async function handleRolesUpdate(ctx: Ctx): Promise<Response> {
  const session = await requireAdmin(ctx);
  if (session instanceof Response) return session;
  const roleId = ctx.path.slice('/auth/roles/'.length);
  if (roleId === ADMIN_ROLE_ID) return err('The Admin role always has full access and can’t be changed', 400);
  const roles = await getRoles(ctx.env.VAYU_KV);
  const existing = roles.find(r => r.id === roleId);
  if (!existing) return err('Role not found', 404);
  const body = await ctx.request.json() as { name?: unknown; permissions?: unknown };
  const name = body.name === undefined ? existing.name : readRoleName(body.name, roles, roleId);
  if (name instanceof Response) return name;
  const updated: RoleDef = {
    ...existing,
    name,
    permissions: body.permissions === undefined ? existing.permissions : normalizePermissions(body.permissions),
  };
  await saveRoles(ctx.env.VAYU_KV, roles.map(r => (r.id === roleId ? updated : r)));
  logEntityChange(ctx, session, 'updated', 'role', roleId, `Updated role "${name}"`);
  return json(updated);
}

async function handleRolesDelete(ctx: Ctx): Promise<Response> {
  const session = await requireAdmin(ctx);
  if (session instanceof Response) return session;
  const roleId = ctx.path.slice('/auth/roles/'.length);
  const roles = await getRoles(ctx.env.VAYU_KV);
  const role = roles.find(r => r.id === roleId);
  if (!role) return err('Role not found', 404);
  if (role.builtIn) return err('Built-in roles can’t be deleted', 400);
  // Refuse while anyone still has it: they'd silently lose all access.
  const list = await ctx.env.VAYU_KV.list({ prefix: 'auth:user:' });
  let members = 0;
  for (const key of list.keys) {
    const raw = await ctx.env.VAYU_KV.get(key.name);
    if (raw && (JSON.parse(raw) as StoredUser).role === roleId) members += 1;
  }
  if (members > 0) {
    return err(`${members} ${members === 1 ? 'person has' : 'people have'} this role. Move them to another role first.`, 409);
  }
  await saveRoles(ctx.env.VAYU_KV, roles.filter(r => r.id !== roleId));
  logEntityChange(ctx, session, 'deleted', 'role', roleId, `Deleted role "${role.name}"`);
  return json({ success: true });
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
  if (!await sessionCan(ctx, session, 'activity', 'view')) return err('Forbidden', 403);
  const limit = Math.min(Number.parseInt(ctx.url.searchParams.get('limit') || '100', 10), 500);
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
  const key = formData.get('key');
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
  if (!Array.isArray(conv.participantIds) || (!conv.participantIds.includes(session.userId) && session.role !== ADMIN_ROLE_ID)) {
    return err('You can only start chats you are part of', 403);
  }
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
  const conv = await ctx.env.VAYU_DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(convId).first();
  const msgCount = await ctx.env.VAYU_DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').bind(convId).first<{ n: number }>();
  await ctx.env.VAYU_DB.prepare('DELETE FROM messages WHERE conversation_id = ?').bind(convId).run();
  await ctx.env.VAYU_DB.prepare('DELETE FROM conversations WHERE id = ?').bind(convId).run();
  if (conv) {
    const raw = conv as Record<string, unknown>;
    const label = String(raw.group_name || raw.title || 'conversation');
    archiveDeletedAsync(ctx, session, 'conversation', convId,
      `Conversation "${label}" (${msgCount?.n || 0} messages)`,
      { conversation: conv, messageCount: msgCount?.n || 0 });
    logEntityChange(ctx, session, 'deleted', 'conversation', convId, `Deleted conversation "${label}" (${msgCount?.n || 0} messages)`);
  }
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
  // The chat must exist and the sender must be in it. Messages used to be
  // stored into missing chats (or chats the sender wasn't part of), then
  // never returned to anyone, so they silently vanished from the app.
  const convRow = await ctx.env.VAYU_DB.prepare('SELECT participant_ids FROM conversations WHERE id = ?')
    .bind(msg.conversationId).first();
  if (!convRow) return err('This chat no longer exists on the server — start a new one', 404);
  let members: string[] = [];
  try { members = JSON.parse(convRow.participant_ids as string); } catch { /* malformed row */ }
  if (!members.includes(session.userId) && session.role !== ADMIN_ROLE_ID) {
    return err("You're not a member of this chat", 403);
  }
  // Sender is whoever is signed in — never trust the id the app sends.
  msg.senderId = session.userId;
  msg.senderName = session.name;
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

// ── Schema migrations ───────────────────────────────────────────────────────
// Databases created from an older schema.sql lack columns added since. Each
// table's missing columns are added once per isolate, before its first write.

const COLUMN_MIGRATIONS = {
  artworks: {
    artist: "TEXT DEFAULT ''",
    artwork_year: "TEXT DEFAULT ''",
    description_title: "TEXT DEFAULT ''",
    plus_gst: 'INTEGER DEFAULT 0',
  },
  collections: {
    cover_image_url: "TEXT DEFAULT ''",
  },
  inquiries: {
    customer_address: "TEXT DEFAULT ''",
    created_by: "TEXT DEFAULT ''",
    created_by_name: "TEXT DEFAULT ''",
    image_urls: "TEXT DEFAULT '[]'",
  },
} as const;

type MigratedTable = keyof typeof COLUMN_MIGRATIONS;

const migratedTables = new Map<MigratedTable, Promise<void>>();

function ensureColumns(db: D1Database, table: MigratedTable): Promise<void> {
  let pending = migratedTables.get(table);
  if (!pending) {
    pending = addMissingColumns(db, table).catch((e) => {
      migratedTables.delete(table);
      throw e;
    });
    migratedTables.set(table, pending);
  }
  return pending;
}

async function addMissingColumns(db: D1Database, table: MigratedTable): Promise<void> {
  const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  const existing = new Set(results.map(c => c.name));
  for (const [column, definition] of Object.entries(COLUMN_MIGRATIONS[table])) {
    if (existing.has(column)) continue;
    try {
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    } catch (e) {
      // Another isolate may have added it concurrently.
      if (!/duplicate column/i.test((e as Error).message)) throw e;
    }
  }
}

/** Deletes uploaded files (and their thumbnails) behind /api/files/ URLs. */
async function deleteUploadedFiles(r2: R2Bucket, urls: string[]): Promise<void> {
  const keys = urls
    .filter(url => url.startsWith('/api/files/'))
    .flatMap((url) => {
      const key = decodeURIComponent(url.slice('/api/files/'.length));
      return [key, `${key}__thumb`];
    });
  if (keys.length === 0) return;
  try {
    await r2.delete(keys);
  } catch (e) {
    console.error('R2 cleanup failed:', e);
  }
}

/** Records a create/update/delete in the admin activity log without delaying the response. */
function logEntityChange(ctx: Ctx, session: SessionData, action: string, entity: string, entityId: string, details: string): void {
  ctx.execCtx.waitUntil(logActivity(ctx.env.VAYU_DB, session.userId, session.name, action, entity, entityId, details));
}

// ── Deleted Items archive ───────────────────────────────────────────────────
// Every destructive delete snapshots the record into `deleted_items` so admins
// can audit what was removed, by whom and when (Admin → Deleted).

let deletedItemsTablePromise: Promise<void> | null = null;
function ensureDeletedItemsTable(db: D1Database): Promise<void> {
  deletedItemsTablePromise ??= db.prepare(`
      CREATE TABLE IF NOT EXISTS deleted_items (
        id TEXT PRIMARY KEY,
        entity TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        payload TEXT,
        deleted_at INTEGER NOT NULL DEFAULT 0,
        deleted_by TEXT,
        deleted_by_name TEXT
      )
    `).run().then(() => undefined);
  return deletedItemsTablePromise;
}

/** Archives a snapshot of a just-deleted record. Fire-and-forget — never blocks the response. */
function archiveDeletedAsync(ctx: Ctx, session: SessionData, entity: string, entityId: string, summary: string, payload: unknown): void {
  ctx.execCtx.waitUntil(archiveDeleted(ctx.env.VAYU_DB, session, entity, entityId, summary, payload));
}

async function archiveDeleted(db: D1Database, session: SessionData, entity: string, entityId: string, summary: string, payload: unknown): Promise<void> {
  try {
    await ensureDeletedItemsTable(db);
    await db.prepare(
      'INSERT INTO deleted_items (id, entity, entity_id, summary, payload, deleted_at, deleted_by, deleted_by_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      crypto.randomUUID(),
      entity,
      entityId,
      summary,
      payload ? JSON.stringify(payload) : null,
      Date.now(),
      session.userId,
      session.name
    ).run();
  } catch (e) {
    console.error('Failed to archive deleted item:', e);
  }
}

async function handleDeletedItemsList(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  if (session.role !== 'admin') return err('Forbidden', 403);
  await ensureDeletedItemsTable(ctx.env.VAYU_DB);
  const results = await ctx.env.VAYU_DB.prepare(
    'SELECT * FROM deleted_items ORDER BY deleted_at DESC LIMIT 200'
  ).all();
  const items = (results.results || []).map((row: Record<string, unknown>) => {
    let payload: unknown = null;
    try { payload = row.payload ? JSON.parse(row.payload as string) : null; } catch { payload = null; }
    return {
      id: row.id as string,
      entity: row.entity as string,
      entityId: row.entity_id as string,
      summary: (row.summary as string) || '',
      payload,
      deletedAt: row.deleted_at as number,
      deletedBy: row.deleted_by as string | undefined,
      deletedByName: (row.deleted_by_name as string) || undefined,
    };
  });
  return json(items);
}

/** Removes R2 files belonging to an archived record — only called on permanent purge. */
async function cleanupArchivedFiles(r2: R2Bucket, entity: string, payload: Record<string, unknown> | null): Promise<void> {
  try {
    if (!payload) return;
    if (entity === 'artwork' && typeof payload.image_urls === 'string') {
      await deleteUploadedFiles(r2, JSON.parse(payload.image_urls || '[]'));
    } else if (entity === 'catalog' && typeof payload.cover_image_url === 'string' && payload.cover_image_url) {
      await deleteUploadedFiles(r2, [payload.cover_image_url]);
    } else if (entity === 'inquiry' && typeof payload.image_urls === 'string') {
      await deleteUploadedFiles(r2, JSON.parse(payload.image_urls || '[]'));
    }
  } catch (e) {
    console.error('Failed to clean up archived files:', e);
  }
}

const RESTORABLE_TABLES: Record<string, string> = {
  artwork: 'artworks',
  collection: 'collections',
  catalog: 'catalogs',
  inquiry: 'inquiries',
  event: 'events',
  contact: 'contacts',
  conversation: 'conversations',
};

/** POST /deleted-items/:id/restore — puts an archived record back into its table. Admin only. */
async function handleDeletedItemsRestore(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  if (session.role !== 'admin') return err('Forbidden', 403);
  await ensureDeletedItemsTable(ctx.env.VAYU_DB);
  const id = ctx.path.slice('/deleted-items/'.length).replace(/\/restore$/, '');
  if (!id) return err('Archived item not found', 404);

  const row = await ctx.env.VAYU_DB.prepare('SELECT * FROM deleted_items WHERE id = ?').bind(id).first();
  if (!row) return err('Archived item not found', 404);
  const entity = row.entity as string;
  let payload: Record<string, unknown> | null = null;
  try { payload = row.payload ? JSON.parse(row.payload as string) : null; } catch { payload = null; }
  if (!payload) return err('Archived item has no restorable snapshot');

  if (entity === 'user') {
    // KV-backed users: restore the login and email lookup.
    const userId = String(payload.id || '');
    if (!userId || !payload.email) return err('Archived user snapshot is incomplete');
    const emailKey = `auth:email:${payload.email}`;
    const existingForEmail = await ctx.env.VAYU_KV.get(emailKey);
    if (existingForEmail) return err('A user with this email already exists', 409);
    const existingUser = await ctx.env.VAYU_KV.get(`auth:user:${userId}`);
    if (existingUser) return err('This user already exists', 409);
    await ctx.env.VAYU_KV.put(`auth:user:${userId}`, JSON.stringify(payload));
    await ctx.env.VAYU_KV.put(emailKey, userId);
    const countRaw = await ctx.env.VAYU_KV.get('auth:count');
    await ctx.env.VAYU_KV.put('auth:count', String((countRaw ? Number.parseInt(countRaw, 10) : 0) + 1));
  } else {
    const table = RESTORABLE_TABLES[entity];
    if (!table) return err(`Cannot restore entity type "${entity}"`);
    const cols = Object.keys(payload).filter(k => typeof payload![k] !== 'object' || payload![k] === null);
    if (cols.length === 0 || !payload.id) return err('Archived snapshot is incomplete');
    const existing = await ctx.env.VAYU_DB.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(String(payload.id)).first();
    if (existing) return err('An item with this id already exists — restore aborted', 409);
    await ctx.env.VAYU_DB.prepare(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
    ).bind(...cols.map(c => (payload![c] === undefined ? null : payload![c]) as string | number | null)).run();
  }

  await ctx.env.VAYU_DB.prepare('DELETE FROM deleted_items WHERE id = ?').bind(id).run();
  logEntityChange(ctx, session, 'updated', entity, String(payload.id || id), `Restored deleted ${entity} from archive`);
  return json({ success: true });
}

/** Purges archived items: DELETE /deleted-items (all) or DELETE /deleted-items/:id (one). Admin only. */
async function handleDeletedItemsPurge(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  if (session.role !== 'admin') return err('Forbidden', 403);
  await ensureDeletedItemsTable(ctx.env.VAYU_DB);
  const id = ctx.path.slice('/deleted-items'.length).replace(/^\//, '');
  if (id) {
    const row = await ctx.env.VAYU_DB.prepare('SELECT * FROM deleted_items WHERE id = ?').bind(id).first();
    if (row) {
      let payload: Record<string, unknown> | null = null;
      try { payload = row.payload ? JSON.parse(row.payload as string) : null; } catch { payload = null; }
      // Permanent removal — now the uploaded files go too.
      await cleanupArchivedFiles(ctx.env.VAYU_R2, row.entity as string, payload);
    }
    await ctx.env.VAYU_DB.prepare('DELETE FROM deleted_items WHERE id = ?').bind(id).run();
    logEntityChange(ctx, session, 'deleted', 'deleted item', id, 'Permanently purged an archived item');
  } else {
    const rows = await ctx.env.VAYU_DB.prepare('SELECT * FROM deleted_items').all();
    for (const row of (rows.results || []) as Record<string, unknown>[]) {
      let payload: Record<string, unknown> | null = null;
      try { payload = row.payload ? JSON.parse(row.payload as string) : null; } catch { payload = null; }
      await cleanupArchivedFiles(ctx.env.VAYU_R2, row.entity as string, payload);
    }
    await ctx.env.VAYU_DB.prepare('DELETE FROM deleted_items').run();
    logEntityChange(ctx, session, 'deleted', 'deleted items', '', 'Purged the entire deleted-items archive');
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

/** Column values shared by artwork INSERT and UPDATE, in column order. */
function artworkValues(art: any): unknown[] {
  return [
    art.customId || '',
    art.title || '',
    art.artist || '',
    art.artworkYear || '',
    art.descriptionTitle || '',
    art.description || '',
    art.dimensions || '',
    art.medium || '',
    art.status || 'Available',
    art.location || '',
    art.price || 0,
    art.plusGst ? 1 : 0,
    JSON.stringify(art.imageUrls || []),
  ];
}

const artworkLabel = (art: { title?: string; customId?: string; id?: string }) =>
  `"${art.title || art.customId || art.id}"`;

async function handleArtworksCreate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json();
  const art = body as any;
  if (!art.id) return err('id is required');
  await ensureColumns(ctx.env.VAYU_DB, 'artworks');
  // Re-syncs of existing artworks shouldn't show up as new in the activity log.
  const alreadyExists = await ctx.env.VAYU_DB.prepare(
    'SELECT 1 FROM artworks WHERE id = ?'
  ).bind(art.id).first();
  await ctx.env.VAYU_DB.prepare(
    `INSERT OR REPLACE INTO artworks
     (id, custom_id, title, artist, artwork_year, description_title, description,
      dimensions, medium, status, location, price, plus_gst, image_urls, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(art.id, ...artworkValues(art), art.createdAt || Date.now()).run();
  if (!alreadyExists) {
    logEntityChange(ctx, session, 'created', 'artwork', art.id, `Added artwork ${artworkLabel(art)}`);
  }
  return json(art, 201);
}

async function handleArtworksUpdate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json();
  const art = body as any;
  const artId = ctx.path.slice('/artworks/'.length);
  await ensureColumns(ctx.env.VAYU_DB, 'artworks');
  await ctx.env.VAYU_DB.prepare(
    `UPDATE artworks SET
       custom_id = ?, title = ?, artist = ?, artwork_year = ?, description_title = ?,
       description = ?, dimensions = ?, medium = ?, status = ?, location = ?,
       price = ?, plus_gst = ?, image_urls = ?
     WHERE id = ?`
  ).bind(...artworkValues(art), artId).run();
  logEntityChange(ctx, session, 'updated', 'artwork', artId, `Updated artwork ${artworkLabel({ ...art, id: artId })}`);
  return json(art);
}

async function handleArtworksDelete(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const artId = ctx.path.slice('/artworks/'.length);

  // Snapshot the full row so the admin can restore it later. R2 files are NOT
  // deleted here — they are only removed on permanent purge, so an undo keeps images.
  const result = await ctx.env.VAYU_DB.prepare(
    'SELECT * FROM artworks WHERE id = ?'
  ).bind(artId).first();

  await ctx.env.VAYU_DB.prepare('DELETE FROM artworks WHERE id = ?').bind(artId).run();
  if (result) {
    archiveDeletedAsync(ctx, session, 'artwork', artId,
      `Artwork ${artworkLabel({ title: (result as any).title, customId: (result as any).custom_id, id: artId })}`,
      result);
    logEntityChange(ctx, session, 'deleted', 'artwork', artId,
      `Deleted artwork ${artworkLabel({ title: (result as any).title, customId: (result as any).custom_id, id: artId })}`);
  }
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
  await ensureColumns(ctx.env.VAYU_DB, 'collections');
  const alreadyExists = await ctx.env.VAYU_DB.prepare(
    'SELECT 1 FROM collections WHERE id = ?'
  ).bind(col.id).first();
  await ctx.env.VAYU_DB.prepare(
    `INSERT OR REPLACE INTO collections
     (id, name, description, artwork_ids, cover_image_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    col.id,
    col.name || '',
    col.description || '',
    JSON.stringify(col.artworkIds || []),
    col.coverImageUrl || '',
    col.createdAt || Date.now()
  ).run();
  if (!alreadyExists) {
    logEntityChange(ctx, session, 'created', 'collection', col.id, `Created collection "${col.name || col.id}"`);
  }
  return json(col, 201);
}

async function handleCollectionsUpdate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json();
  const col = body as any;
  const colId = ctx.path.slice('/collections/'.length);
  await ensureColumns(ctx.env.VAYU_DB, 'collections');
  await ctx.env.VAYU_DB.prepare(
    `UPDATE collections SET
       name = ?, description = ?, artwork_ids = ?, cover_image_url = ?
     WHERE id = ?`
  ).bind(
    col.name || '',
    col.description || '',
    JSON.stringify(col.artworkIds || []),
    col.coverImageUrl || '',
    colId
  ).run();
  logEntityChange(ctx, session, 'updated', 'collection', colId, `Updated collection "${col.name || colId}"`);
  return json(col);
}

async function handleCollectionsDelete(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const colId = ctx.path.slice('/collections/'.length);
  const result = await ctx.env.VAYU_DB.prepare(
    'SELECT * FROM collections WHERE id = ?'
  ).bind(colId).first();
  await ctx.env.VAYU_DB.prepare('DELETE FROM collections WHERE id = ?').bind(colId).run();
  if (result) {
    archiveDeletedAsync(ctx, session, 'collection', colId, `Collection "${(result as any).name || colId}"`, result);
    logEntityChange(ctx, session, 'deleted', 'collection', colId, `Deleted collection "${(result as any).name || colId}"`);
  }
  return json({ success: true });
}

// ── Catalog route handlers ──────────────────────────────────────────────────

async function handleCatalogsList(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  await ensureCatalogsColumns(ctx.env.VAYU_DB);
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
  await ensureCatalogsColumns(ctx.env.VAYU_DB);
  const alreadyExists = await ctx.env.VAYU_DB.prepare(
    'SELECT 1 FROM catalogs WHERE id = ?'
  ).bind(cat.id).first();
  await ctx.env.VAYU_DB.prepare(
    `INSERT OR REPLACE INTO catalogs
     (id, name, description, artwork_ids, cover_image_url, pdf_url, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    cat.id,
    cat.name || '',
    cat.description || '',
    JSON.stringify(cat.artworkIds || []),
    cat.coverImageUrl || '',
    cat.pdfUrl || null,
    cat.source || 'generated',
    cat.createdAt || Date.now()
  ).run();
  if (!alreadyExists) {
    logEntityChange(ctx, session, 'created', 'catalog', cat.id, `Created catalog "${cat.name || cat.id}"`);
  }
  return json(cat, 201);
}

async function handleCatalogsUpdate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json();
  const cat = body as any;
  const catId = ctx.path.slice('/catalogs/'.length);
  await ensureCatalogsColumns(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.prepare(
    `UPDATE catalogs SET
       name = ?, description = ?, artwork_ids = ?, cover_image_url = ?, pdf_url = ?, source = ?
     WHERE id = ?`
  ).bind(
    cat.name || '',
    cat.description || '',
    JSON.stringify(cat.artworkIds || []),
    cat.coverImageUrl || '',
    cat.pdfUrl || null,
    cat.source || 'generated',
    catId
  ).run();
  logEntityChange(ctx, session, 'updated', 'catalog', catId, `Updated catalog "${cat.name || catId}"`);
  return json(cat);
}

async function handleCatalogsDelete(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const catId = ctx.path.slice('/catalogs/'.length);

  // Full-row snapshot for undo; R2 cleanup is deferred to permanent purge.
  const result = await ctx.env.VAYU_DB.prepare(
    'SELECT * FROM catalogs WHERE id = ?'
  ).bind(catId).first();

  await ctx.env.VAYU_DB.prepare('DELETE FROM catalogs WHERE id = ?').bind(catId).run();
  if (result) {
    archiveDeletedAsync(ctx, session, 'catalog', catId, `Catalog "${(result as any).name || catId}"`, result);
    logEntityChange(ctx, session, 'deleted', 'catalog', catId, `Deleted catalog "${(result as any).name || catId}"`);
  }
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

function inquiryLabel(inq: { inquiryNumber?: string; customerName?: string; id?: string }): string {
  const number = inq.inquiryNumber || inq.id || '';
  return inq.customerName ? `${number} (${inq.customerName})` : number;
}

async function handleInquiriesCreate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json();
  const inq = body as any;
  if (!inq.id) return err('id is required');
  await ensureColumns(ctx.env.VAYU_DB, 'inquiries');
  // Detect re-syncs/migrations of existing inquiries so they don't re-notify
  // and keep their original creator.
  const existing = await ctx.env.VAYU_DB.prepare(
    'SELECT created_by, created_by_name FROM inquiries WHERE id = ?'
  ).bind(inq.id).first<{ created_by: string | null; created_by_name: string | null }>();
  // The creator comes from the session, never from the request body.
  const createdBy = existing ? existing.created_by || '' : session.userId;
  const createdByName = existing ? existing.created_by_name || '' : session.name;
  await ctx.env.VAYU_DB.prepare(
    `INSERT OR REPLACE INTO inquiries
     (id, inquiry_number, customer_name, customer_phone, customer_email, customer_address,
      artwork_ids, notes, source, status, catalog_shared, date,
      created_by, created_by_name, image_urls)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    inq.id,
    inq.inquiryNumber || '',
    inq.customerName || '',
    inq.customerPhone || '',
    inq.customerEmail || '',
    inq.customerAddress || '',
    JSON.stringify(inq.artworkIds || []),
    inq.notes || '',
    inq.source || 'Other',
    inq.status || 'New',
    inq.catalogShared ? 1 : 0,
    inq.date || Date.now(),
    createdBy,
    createdByName,
    JSON.stringify(inq.imageUrls || [])
  ).run();

  if (!existing) {
    ctx.execCtx.waitUntil(notifyNewInquiry(ctx.env, inq, session));
    logEntityChange(ctx, session, 'created', 'inquiry', inq.id, `Added inquiry ${inquiryLabel(inq)}`);
  }

  return json({ ...inq, createdBy: createdBy || undefined, createdByName: createdByName || undefined }, 201);
}

async function handleInquiriesUpdate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json();
  const inq = body as any;
  const inqId = ctx.path.slice('/inquiries/'.length);
  await ensureColumns(ctx.env.VAYU_DB, 'inquiries');
  // created_by is deliberately not updatable.
  await ctx.env.VAYU_DB.prepare(
    `UPDATE inquiries SET
       inquiry_number = ?, customer_name = ?, customer_phone = ?,
       customer_email = ?, customer_address = ?, artwork_ids = ?, notes = ?, source = ?,
       status = ?, catalog_shared = ?, image_urls = ?
     WHERE id = ?`
  ).bind(
    inq.inquiryNumber || '',
    inq.customerName || '',
    inq.customerPhone || '',
    inq.customerEmail || '',
    inq.customerAddress || '',
    JSON.stringify(inq.artworkIds || []),
    inq.notes || '',
    inq.source || 'Other',
    inq.status || 'New',
    inq.catalogShared ? 1 : 0,
    JSON.stringify(inq.imageUrls || []),
    inqId
  ).run();
  logEntityChange(ctx, session, 'updated', 'inquiry', inqId, `Updated inquiry ${inquiryLabel({ ...inq, id: inqId })}`);
  return json(inq);
}

async function handleInquiriesDelete(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const inqId = ctx.path.slice('/inquiries/'.length);
  const result = await ctx.env.VAYU_DB.prepare(
    'SELECT * FROM inquiries WHERE id = ?'
  ).bind(inqId).first();
  // Also delete associated inquiry messages and uploaded photos
  await ctx.env.VAYU_DB.prepare('DELETE FROM inquiry_messages WHERE inquiry_id = ?').bind(inqId).run();
  await ctx.env.VAYU_DB.prepare('DELETE FROM inquiries WHERE id = ?').bind(inqId).run();
  if (result) {
    const inq = rowToInquiry(result);
    archiveDeletedAsync(ctx, session, 'inquiry', inqId, `Inquiry ${inquiryLabel(inq)}`, result);
    logEntityChange(ctx, session, 'deleted', 'inquiry', inqId, `Deleted inquiry ${inquiryLabel(inq)}`);
  }
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

// ── Public holidays route handler ───────────────────────────────────────────
// Indian public holidays & festivals via Calendarific, cached per year in KV
// (they don't change) so the provider is called at most a few times a year.

async function handleHolidaysGet(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const year = Number.parseInt(ctx.url.searchParams.get('year') || String(new Date().getFullYear()), 10);
  if (!Number.isInteger(year) || year < 1970 || year > 2100) return err('Invalid year');

  const cacheKey = `holidays:in:${year}`;
  const cached = await ctx.env.VAYU_KV.get(cacheKey);
  if (cached) return json(JSON.parse(cached));

  const apiKey = ctx.env.CALENDARIFIC_API_KEY;
  if (!apiKey) return json([]); // not configured yet — calendar works without holidays

  const res = await fetch(
    `https://calendarific.com/api/v2/holidays?api_key=${encodeURIComponent(apiKey)}&country=IN&year=${year}`
  );
  const data = await res.json() as {
    response?: { holidays?: Array<{ date?: { iso?: string }; name?: string; local_name?: string }> };
  };
  const list = data?.response?.holidays;
  if (!Array.isArray(list)) return err('Holiday provider error', 502);

  const holidays = list
    .filter(h => h?.date?.iso && (h.name || h.local_name))
    .map(h => ({ date: h.date!.iso as string, name: (h.name || h.local_name) as string }));

  await ctx.env.VAYU_KV.put(cacheKey, JSON.stringify(holidays), { expirationTtl: 60 * 60 * 24 * 30 });
  return json(holidays);
}

// ── Calendar event route handlers ───────────────────────────────────────────

function rowToEvent(row: Record<string, unknown>): any {
  let todos: any[] = [];
  try { todos = row.todos ? JSON.parse(row.todos as string) : []; } catch { todos = []; }
  return {
    id: row.id as string,
    title: (row.title as string) || '',
    date: row.event_date as number,
    endDate: (row.end_date as number) || undefined,
    notes: row.notes || undefined,
    color: (row.color as string) || undefined,
    todos,
    createdAt: row.created_at as number,
    createdBy: row.created_by || undefined,
    createdByName: row.created_by_name || undefined,
  };
}

// The events table is created lazily (once per isolate) so no manual D1
// migration is required before first use. Column ALTERs handle tables created
// before end_date/todos existed.
let eventsTablePromise: Promise<void> | null = null;
function ensureEventsTable(db: D1Database): Promise<void> {
  eventsTablePromise ??= db.prepare(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        event_date INTEGER NOT NULL DEFAULT 0,
        end_date INTEGER,
        todos TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '',
        color TEXT,
        created_at INTEGER NOT NULL DEFAULT 0,
        created_by TEXT,
        created_by_name TEXT
      )
    `).run().then(async () => {
      // Migration for tables created before end_date/todos/color were added —
      // ALTER fails harmlessly when the column already exists.
      try { await db.prepare('ALTER TABLE events ADD COLUMN end_date INTEGER').run(); } catch { /* already exists */ }
      try { await db.prepare(`ALTER TABLE events ADD COLUMN todos TEXT NOT NULL DEFAULT '[]'`).run(); } catch { /* already exists */ }
      try { await db.prepare('ALTER TABLE events ADD COLUMN color TEXT').run(); } catch { /* already exists */ }
    });
  return eventsTablePromise;
}

async function handleEventsList(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  await ensureEventsTable(ctx.env.VAYU_DB);
  const results = await ctx.env.VAYU_DB.prepare(
    'SELECT * FROM events ORDER BY event_date ASC'
  ).all();
  const events = (results.results || []).map(rowToEvent);
  return json(events);
}

async function handleEventsCreate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json();
  const ev = body as any;
  if (!ev.id) return err('id is required');
  if (!ev.title || !String(ev.title).trim()) return err('title is required');
  if (!ev.date) return err('date is required');
  await ensureEventsTable(ctx.env.VAYU_DB);
  // Preserve the original creator on re-syncs/migrations, mirroring inquiries.
  const existing = await ctx.env.VAYU_DB.prepare(
    'SELECT created_by, created_by_name FROM events WHERE id = ?'
  ).bind(ev.id).first<{ created_by: string | null; created_by_name: string | null }>();
  const createdBy = existing ? existing.created_by || '' : session.userId;
  const createdByName = existing ? existing.created_by_name || '' : session.name;
  await ctx.env.VAYU_DB.prepare(
    `INSERT OR REPLACE INTO events
     (id, title, event_date, end_date, todos, notes, color, created_at, created_by, created_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    ev.id,
    String(ev.title).trim(),
    ev.date,
    ev.endDate ?? null,
    JSON.stringify(ev.todos || []),
    ev.notes || '',
    ev.color || null,
    ev.createdAt || Date.now(),
    createdBy,
    createdByName
  ).run();
  if (!existing) {
    logEntityChange(ctx, session, 'created', 'event', ev.id, `Added event "${String(ev.title).trim()}"`);
  }
  return json({ ...ev, createdBy: createdBy || undefined, createdByName: createdByName || undefined }, 201);
}

async function handleEventsUpdate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const evId = ctx.path.slice('/events/'.length);
  if (!evId) return err('Event not found', 404);
  const body = await ctx.request.json() as any;
  if (!body.date) return err('date is required');
  await ensureEventsTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.prepare(
    `UPDATE events SET
       title = ?, event_date = ?, end_date = ?, notes = ?, todos = ?, color = ?
     WHERE id = ?`
  ).bind(
    String(body.title || '').trim(),
    body.date,
    body.endDate ?? null,
    body.notes || '',
    JSON.stringify(body.todos || []),
    body.color || null,
    evId
  ).run();
  logEntityChange(ctx, session, 'updated', 'event', evId, `Updated event "${String(body.title || '').trim()}"`);
  return json(body);
}

async function handleEventsDelete(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const evId = ctx.path.slice('/events/'.length);
  if (!evId) return err('Event not found', 404);
  await ensureEventsTable(ctx.env.VAYU_DB);
  const result = await ctx.env.VAYU_DB.prepare(
    'SELECT * FROM events WHERE id = ?'
  ).bind(evId).first();
  await ctx.env.VAYU_DB.prepare('DELETE FROM events WHERE id = ?').bind(evId).run();
  if (result) {
    const ev = rowToEvent(result);
    archiveDeletedAsync(ctx, session, 'event', evId, `Event "${ev.title}"`, result);
    logEntityChange(ctx, session, 'deleted', 'event', evId, `Deleted event "${ev.title}"`);
  }
  return json({ success: true });
}

// ── Contact route handlers ──────────────────────────────────────────────────
// Manual + imported contacts. Contacts derived from inquiries are computed
// client-side and never stored here.

function rowToContact(row: Record<string, unknown>): any {
  return {
    id: row.id as string,
    name: (row.name as string) || '',
    phone: (row.phone as string) || '',
    email: row.email || undefined,
    notes: row.notes || undefined,
    source: (row.source as string) || 'manual',
    createdAt: row.created_at as number,
    createdBy: row.created_by || undefined,
    createdByName: row.created_by_name || undefined,
  };
}

// The contacts table is created lazily (once per isolate) so no manual D1
// migration is required before first use.
let contactsTablePromise: Promise<void> | null = null;
function ensureContactsTable(db: D1Database): Promise<void> {
  contactsTablePromise ??= db.prepare(`
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'manual',
        created_at INTEGER NOT NULL DEFAULT 0,
        created_by TEXT,
        created_by_name TEXT
      )
    `).run().then(() => undefined);
  return contactsTablePromise;
}

async function handleContactsList(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  await ensureContactsTable(ctx.env.VAYU_DB);
  const results = await ctx.env.VAYU_DB.prepare(
    'SELECT * FROM contacts ORDER BY created_at DESC'
  ).all();
  const contacts = (results.results || []).map(rowToContact);
  return json(contacts);
}

async function handleContactsCreate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json();
  const c = body as any;
  if (!c.id) return err('id is required');
  if (!c.name || !String(c.name).trim()) return err('name is required');
  await ensureContactsTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.prepare(
    `INSERT OR REPLACE INTO contacts
     (id, name, phone, email, notes, source, created_at, created_by, created_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    c.id,
    String(c.name).trim(),
    c.phone || '',
    c.email || '',
    c.notes || '',
    c.source || 'manual',
    c.createdAt || Date.now(),
    session.userId,
    session.name
  ).run();
  logEntityChange(ctx, session, 'created', 'contact', c.id, `Added contact "${String(c.name).trim()}"`);
  return json({ ...c, createdBy: session.userId, createdByName: session.name }, 201);
}

async function handleContactsImport(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json() as any;
  const list = Array.isArray(body?.contacts) ? body.contacts : [];
  if (list.length === 0) return err('contacts array is required');
  if (list.length > 500) return err('Too many contacts (max 500 per import)');
  await ensureContactsTable(ctx.env.VAYU_DB);
  const stmts = list.map((c: any) => ctx.env.VAYU_DB.prepare(
    `INSERT OR REPLACE INTO contacts
     (id, name, phone, email, notes, source, created_at, created_by, created_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    c.id,
    String(c.name || '').trim(),
    c.phone || '',
    c.email || '',
    c.notes || '',
    c.source || 'import',
    c.createdAt || Date.now(),
    session.userId,
    session.name
  ));
  await ctx.env.VAYU_DB.batch(stmts);
  logEntityChange(ctx, session, 'created', 'contact', 'import', `Imported ${stmts.length} contact(s)`);
  return json({ imported: stmts.length }, 201);
}

async function handleContactsDelete(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const contactId = ctx.path.slice('/contacts/'.length);
  if (!contactId) return err('Contact not found', 404);
  await ensureContactsTable(ctx.env.VAYU_DB);
  const result = await ctx.env.VAYU_DB.prepare(
    'SELECT * FROM contacts WHERE id = ?'
  ).bind(contactId).first();
  await ctx.env.VAYU_DB.prepare('DELETE FROM contacts WHERE id = ?').bind(contactId).run();
  if (result) {
    const c = rowToContact(result);
    archiveDeletedAsync(ctx, session, 'contact', contactId, `Contact "${c.name}"`, result);
    logEntityChange(ctx, session, 'deleted', 'contact', contactId, `Deleted contact "${c.name}"`);
  }
  return json({ success: true });
}

async function handleContactsUpdate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const contactId = ctx.path.slice('/contacts/'.length);
  if (!contactId) return err('Contact not found', 404);
  const body = await ctx.request.json() as any;
  if (!body.name || !String(body.name).trim()) return err('name is required');
  await ensureContactsTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.prepare(
    'UPDATE contacts SET name = ?, phone = ?, email = ?, notes = ? WHERE id = ?'
  ).bind(
    String(body.name).trim(),
    body.phone || '',
    body.email || '',
    body.notes || '',
    contactId
  ).run();
  const updated = await ctx.env.VAYU_DB.prepare('SELECT * FROM contacts WHERE id = ?').bind(contactId).first();
  logEntityChange(ctx, session, 'updated', 'contact', contactId, `Updated contact "${String(body.name).trim()}"`);
  return json(updated ? rowToContact(updated) : { id: contactId });
}

// ── Attendance: stores & check-in/out ───────────────────────────────────────
// Geofenced employee attendance. ALL validation happens here on the server:
// GPS radius check (haversine), GPS accuracy gate, per-store Wi-Fi strategy
// (toggleable via the store's wifi_required flag without touching this flow),
// and every timestamp is the SERVER clock — the phone's clock is never trusted.

const MAX_GPS_ACCURACY = 100; // meters — reject fixes worse than this

function rowToStore(row: Record<string, unknown>): any {
  return {
    id: row.id as string,
    name: (row.name as string) || '',
    latitude: row.latitude as number,
    longitude: row.longitude as number,
    gpsRadius: row.gps_radius as number,
    wifiRequired: !!(row.wifi_required),
    wifiSsid: (row.wifi_ssid as string) || '',
    createdAt: row.created_at as number,
  };
}

function rowToAttendance(row: Record<string, unknown>): any {
  return {
    id: row.id as string,
    employeeId: row.employee_id as string,
    employeeName: (row.employee_name as string) || '',
    storeId: row.store_id as string,
    checkInAt: row.check_in_at as number | null,
    checkInLat: row.check_in_lat as number | null,
    checkInLng: row.check_in_lng as number | null,
    checkInAccuracy: row.check_in_accuracy as number | null,
    checkOutAt: row.check_out_at as number | null,
    checkOutLat: row.check_out_lat as number | null,
    checkOutLng: row.check_out_lng as number | null,
    checkOutAccuracy: row.check_out_accuracy as number | null,
    connectionType: (row.connection_type as string) || 'unknown',
    status: row.status as string,
    createdAt: row.created_at as number,
  };
}

/** Great-circle distance between two points, in meters. */
function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

let storesTablePromise: Promise<void> | null = null;
function ensureStoresTable(db: D1Database): Promise<void> {
  storesTablePromise ??= db.prepare(`
      CREATE TABLE IF NOT EXISTS stores (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        latitude REAL NOT NULL DEFAULT 0,
        longitude REAL NOT NULL DEFAULT 0,
        gps_radius INTEGER NOT NULL DEFAULT 150,
        wifi_required INTEGER NOT NULL DEFAULT 0,
        wifi_ssid TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL DEFAULT 0
      )
    `).run().then(() => undefined);
  return storesTablePromise;
}

let attendanceTablePromise: Promise<void> | null = null;
function ensureAttendanceTable(db: D1Database): Promise<void> {
  attendanceTablePromise ??= db.prepare(`
      CREATE TABLE IF NOT EXISTS attendance (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL,
        employee_name TEXT DEFAULT '',
        store_id TEXT NOT NULL,
        check_in_at INTEGER,
        check_in_lat REAL,
        check_in_lng REAL,
        check_in_accuracy REAL,
        check_out_at INTEGER,
        check_out_lat REAL,
        check_out_lng REAL,
        check_out_accuracy REAL,
        connection_type TEXT DEFAULT 'unknown',
        status TEXT NOT NULL DEFAULT 'checked-in',
        created_at INTEGER NOT NULL DEFAULT 0
      )
    `).run().then(() => undefined);
  return attendanceTablePromise;
}

/** Shared pre-flight validation for check-in AND check-out. */
async function validateAttendanceContext(
  ctx: Ctx,
  session: SessionData,
  body: { storeId?: unknown; lat?: unknown; lng?: unknown; accuracy?: unknown; connectionType?: unknown; wifiSsid?: unknown }
): Promise<{ ok: true; store: any } | { ok: false; response: Response }> {
  const storeId = typeof body.storeId === 'string' ? body.storeId : '';
  if (!storeId) return { ok: false, response: err('Store is required', 400) };
  const lat = typeof body.lat === 'number' ? body.lat : Number.NaN;
  const lng = typeof body.lng === 'number' ? body.lng : Number.NaN;
  const accuracy = typeof body.accuracy === 'number' ? body.accuracy : Number.NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { ok: false, response: err('GPS coordinates are required — enable location and retry', 422) };
  }
  if (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > MAX_GPS_ACCURACY) {
    return { ok: false, response: err('GPS accuracy too low — move to an open area and retry', 422) };
  }

  await ensureStoresTable(ctx.env.VAYU_DB);
  await ensureAttendanceTable(ctx.env.VAYU_DB);
  const storeRow = await ctx.env.VAYU_DB.prepare('SELECT * FROM stores WHERE id = ?').bind(storeId).first();
  if (!storeRow) return { ok: false, response: err('Store not found', 404) };
  const store = rowToStore(storeRow);

  // Assigned-store enforcement: employee identity comes from the session, and
  // their assigned store (if any) is read from the server-side user record.
  const userRaw = await ctx.env.VAYU_KV.get(`auth:user:${session.userId}`);
  const assignedStoreId = userRaw ? ((JSON.parse(userRaw) as StoredUser).storeId || '') : '';
  if (assignedStoreId && assignedStoreId !== storeId) {
    return { ok: false, response: err('You can only check in at your assigned store', 403) };
  }

  // GPS geofence — computed server-side from the submitted coordinates.
  const distance = haversineMeters(lat, lng, store.latitude, store.longitude);
  if (distance > store.gpsRadius) {
    return { ok: false, response: err('You are outside the store', 422) };
  }

  // Wi-Fi strategy — per-store toggle. OFF: GPS + internet is enough (mobile
  // data allowed). ON: the employee must be on the approved store Wi-Fi.
  if (store.wifiRequired) {
    if (body.connectionType !== 'wifi') {
      return { ok: false, response: err('Please connect to the store Wi-Fi before checking in', 422) };
    }
    const approved = store.wifiSsid.trim().toLowerCase();
    const reported = String(body.wifiSsid || '').trim().toLowerCase();
    if (!approved || reported !== approved) {
      return { ok: false, response: err('You are not on the approved store Wi-Fi network', 422) };
    }
  }

  return { ok: true, store };
}

async function handleStoresList(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  await ensureStoresTable(ctx.env.VAYU_DB);
  const results = await ctx.env.VAYU_DB.prepare('SELECT * FROM stores ORDER BY name ASC').all();
  return json((results.results || []).map(rowToStore));
}

function readStoreBody(body: Record<string, unknown>): { error: Response } | { data: { name: string; latitude: number; longitude: number; gpsRadius: number; wifiRequired: number; wifiSsid: string } } {
  const name = String(body.name || '').trim();
  const latitude = typeof body.latitude === 'number' ? body.latitude : Number.parseFloat(String(body.latitude));
  const longitude = typeof body.longitude === 'number' ? body.longitude : Number.parseFloat(String(body.longitude));
  const gpsRadius = Number.parseInt(String(body.gpsRadius ?? 150), 10);
  if (!name) return { error: err('Store name is required', 400) };
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return { error: err('Valid store latitude and longitude are required', 400) };
  if (!Number.isFinite(gpsRadius) || gpsRadius < 20 || gpsRadius > 5000) return { error: err('GPS radius must be between 20 and 5000 meters', 400) };
  return {
    data: {
      name,
      latitude,
      longitude,
      gpsRadius,
      wifiRequired: body.wifiRequired ? 1 : 0,
      wifiSsid: String(body.wifiSsid || '').trim(),
    },
  };
}

async function handleStoresCreate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  if (!await sessionCan(ctx, session, 'attendance', 'edit')) return err('Forbidden', 403);
  await ensureStoresTable(ctx.env.VAYU_DB);
  const parsed = readStoreBody(await ctx.request.json() as Record<string, unknown>);
  if ('error' in parsed) return parsed.error;
  const { data } = parsed;
  const id = `store_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  await ctx.env.VAYU_DB.prepare(
    'INSERT INTO stores (id, name, latitude, longitude, gps_radius, wifi_required, wifi_ssid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, data.name, data.latitude, data.longitude, data.gpsRadius, data.wifiRequired, data.wifiSsid, Date.now()).run();
  logEntityChange(ctx, session, 'created', 'store', id, `Created store "${data.name}"`);
  return json(rowToStore({ id, ...data, created_at: Date.now() }), 201);
}

async function handleStoresUpdate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  if (!await sessionCan(ctx, session, 'attendance', 'edit')) return err('Forbidden', 403);
  const storeId = ctx.path.slice('/attendance/stores/'.length);
  await ensureStoresTable(ctx.env.VAYU_DB);
  const parsed = readStoreBody(await ctx.request.json() as Record<string, unknown>);
  if ('error' in parsed) return parsed.error;
  const { data } = parsed;
  const result = await ctx.env.VAYU_DB.prepare(
    'UPDATE stores SET name = ?, latitude = ?, longitude = ?, gps_radius = ?, wifi_required = ?, wifi_ssid = ? WHERE id = ?'
  ).bind(data.name, data.latitude, data.longitude, data.gpsRadius, data.wifiRequired, data.wifiSsid, storeId).run();
  if (!result.meta.changes) return err('Store not found', 404);
  logEntityChange(ctx, session, 'updated', 'store', storeId, `Updated store "${data.name}"`);
  return json(rowToStore({ id: storeId, ...data, created_at: Date.now() }));
}

async function handleStoresDelete(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  if (!await sessionCan(ctx, session, 'attendance', 'edit')) return err('Forbidden', 403);
  const storeId = ctx.path.slice('/attendance/stores/'.length);
  await ensureStoresTable(ctx.env.VAYU_DB);
  const result = await ctx.env.VAYU_DB.prepare('DELETE FROM stores WHERE id = ?').bind(storeId).run();
  if (!result.meta.changes) return err('Store not found', 404);
  logEntityChange(ctx, session, 'deleted', 'store', storeId, 'Deleted a store');
  return json({ success: true });
}

/** GET /attendance/me — the caller's open record + recent history. */
async function handleAttendanceMe(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  await ensureStoresTable(ctx.env.VAYU_DB);
  await ensureAttendanceTable(ctx.env.VAYU_DB);
  const openRow = await ctx.env.VAYU_DB.prepare(
    "SELECT * FROM attendance WHERE employee_id = ? AND status = 'checked-in' ORDER BY check_in_at DESC LIMIT 1"
  ).bind(session.userId).first();
  const recent = await ctx.env.VAYU_DB.prepare(
    'SELECT * FROM attendance WHERE employee_id = ? ORDER BY check_in_at DESC LIMIT 10'
  ).bind(session.userId).all();
  const userRaw = await ctx.env.VAYU_KV.get(`auth:user:${session.userId}`);
  const assignedStoreId = userRaw ? ((JSON.parse(userRaw) as StoredUser).storeId || '') : '';
  return json({
    open: openRow ? rowToAttendance(openRow) : null,
    recent: (recent.results || []).map(rowToAttendance),
    assignedStoreId: assignedStoreId || null,
  });
}

async function handleAttendanceCheckIn(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json() as Record<string, unknown>;
  const validated = await validateAttendanceContext(ctx, session, body);
  if (!validated.ok) return validated.response;
  const { store } = validated;
  await ensureAttendanceTable(ctx.env.VAYU_DB);
  const open = await ctx.env.VAYU_DB.prepare(
    "SELECT id FROM attendance WHERE employee_id = ? AND status = 'checked-in'"
  ).bind(session.userId).first();
  if (open) return err('You are already checked in', 409);

  const id = `att_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const serverNow = Date.now(); // SERVER timestamp — the phone clock is never trusted
  const record: Record<string, unknown> = {
    id, employee_id: session.userId, employee_name: session.name, store_id: store.id,
    check_in_at: serverNow, check_in_lat: body.lat as number, check_in_lng: body.lng as number, check_in_accuracy: body.accuracy as number,
    check_out_at: null, check_out_lat: null, check_out_lng: null, check_out_accuracy: null,
    connection_type: String(body.connectionType || 'unknown'), status: 'checked-in', created_at: serverNow,
  };
  await ctx.env.VAYU_DB.prepare(
    `INSERT INTO attendance
     (id, employee_id, employee_name, store_id, check_in_at, check_in_lat, check_in_lng, check_in_accuracy, check_out_at, check_out_lat, check_out_lng, check_out_accuracy, connection_type, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, 'checked-in', ?)`
  ).bind(
    id, session.userId, session.name, store.id,
    serverNow, body.lat, body.lng, body.accuracy,
    String(body.connectionType || 'unknown'), serverNow
  ).run();
  logEntityChange(ctx, session, 'created', 'attendance', id, `Checked in at "${store.name}"`);
  return json({ record: rowToAttendance(record), message: 'Check-in successful' }, 201);
}

async function handleAttendanceCheckOut(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json() as Record<string, unknown>;
  const validated = await validateAttendanceContext(ctx, session, body);
  if (!validated.ok) return validated.response;
  const { store } = validated;
  await ensureAttendanceTable(ctx.env.VAYU_DB);
  const openRow = await ctx.env.VAYU_DB.prepare(
    "SELECT * FROM attendance WHERE employee_id = ? AND status = 'checked-in' ORDER BY check_in_at DESC LIMIT 1"
  ).bind(session.userId).first();
  if (!openRow) return err('You are not checked in', 409);
  const open = openRow as Record<string, unknown>;
  if ((open.store_id as string) !== store.id) {
    return err('You must check out from the same store you checked in at', 422);
  }

  const serverNow = Date.now(); // SERVER timestamp
  const record: Record<string, unknown> = {
    ...open,
    check_out_at: serverNow, check_out_lat: body.lat as number, check_out_lng: body.lng as number, check_out_accuracy: body.accuracy as number,
    connection_type: String(body.connectionType || 'unknown'), status: 'checked-out',
  };
  await ctx.env.VAYU_DB.prepare(
    `UPDATE attendance SET
       check_out_at = ?, check_out_lat = ?, check_out_lng = ?, check_out_accuracy = ?, connection_type = ?, status = 'checked-out'
     WHERE id = ?`
  ).bind(serverNow, body.lat, body.lng, body.accuracy, String(body.connectionType || 'unknown'), open.id as string).run();
  logEntityChange(ctx, session, 'updated', 'attendance', open.id as string, `Checked out from "${store.name}"`);
  return json({ record: rowToAttendance(record), message: 'Check-out successful' });
}

/**
 * GET /attendance/records — attendance managers see everyone; others their own.
 * Optional filters: storeId, employeeId (admins), and from / to (epoch ms,
 * matched against check-in time) so a month or custom range isn't cut off
 * by the row limit.
 */
async function handleAttendanceRecords(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  await ensureAttendanceTable(ctx.env.VAYU_DB);
  const params = ctx.url.searchParams;
  const where: string[] = [];
  const binds: (string | number)[] = [];
  const canManage = await sessionCan(ctx, session, 'attendance', 'edit');
  if (canManage) {
    const storeId = params.get('storeId');
    const employeeId = params.get('employeeId');
    if (storeId) { where.push('store_id = ?'); binds.push(storeId); }
    if (employeeId) { where.push('employee_id = ?'); binds.push(employeeId); }
  } else {
    where.push('employee_id = ?');
    binds.push(session.userId);
  }
  const from = Number(params.get('from'));
  const to = Number(params.get('to'));
  if (params.get('from') && Number.isFinite(from)) { where.push('check_in_at >= ?'); binds.push(from); }
  if (params.get('to') && Number.isFinite(to)) { where.push('check_in_at < ?'); binds.push(to); }
  const limit = canManage ? 1000 : 300;
  const sql = `SELECT * FROM attendance${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY check_in_at DESC LIMIT ${limit}`;
  const results = await ctx.env.VAYU_DB.prepare(sql).bind(...binds).all();
  return json((results.results || []).map(rowToAttendance));
}

/**
 * PATCH /attendance/records/:id — admin closes a check-in someone forgot to
 * check out of, with a check-out time the admin sets. Must be after the
 * check-in and not in the future; no location is recorded for it.
 */
async function handleAttendanceRecordClose(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  if (!await sessionCan(ctx, session, 'attendance', 'edit')) return err('Forbidden', 403);
  await ensureAttendanceTable(ctx.env.VAYU_DB);
  const recordId = ctx.path.slice('/attendance/records/'.length);
  const body = await ctx.request.json() as { checkOutAt?: unknown };
  const checkOutAt = typeof body.checkOutAt === 'number' ? body.checkOutAt : Number.NaN;
  const row = await ctx.env.VAYU_DB.prepare('SELECT * FROM attendance WHERE id = ?').bind(recordId).first();
  if (!row) return err('Record not found', 404);
  const rec = row as Record<string, unknown>;
  if (rec.status !== 'checked-in') return err('This record is already checked out', 409);
  const checkInAt = rec.check_in_at as number;
  if (!Number.isFinite(checkOutAt) || checkOutAt <= checkInAt) return err('Check-out time must be after the check-in time', 400);
  if (checkOutAt > Date.now()) return err('Check-out time cannot be in the future', 400);
  await ctx.env.VAYU_DB.prepare(
    "UPDATE attendance SET check_out_at = ?, check_out_lat = NULL, check_out_lng = NULL, check_out_accuracy = NULL, status = 'checked-out' WHERE id = ?"
  ).bind(checkOutAt, recordId).run();
  logEntityChange(ctx, session, 'updated', 'attendance', recordId,
    `Closed ${(rec.employee_name as string) || 'an employee'}'s open check-in (check-out set by admin)`);
  return json(rowToAttendance({ ...rec, check_out_at: checkOutAt, check_out_lat: null, check_out_lng: null, check_out_accuracy: null, status: 'checked-out' }));
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
  { method: 'PUT', match: isExact('/auth/me'), handler: handleAuthMeUpdate },
  { method: 'POST', match: isExact('/auth/logout'), handler: handleAuthLogout },
  { method: 'GET', match: isExact('/auth/users'), handler: handleAuthUsersList },
  { method: 'GET', match: isExact('/auth/team'), handler: handleAuthTeam },
  { method: 'GET', match: isExact('/auth/roles'), handler: handleRolesList },
  { method: 'POST', match: isExact('/auth/roles'), handler: handleRolesCreate },
  { method: 'PUT', match: isPrefix('/auth/roles/'), handler: handleRolesUpdate },
  { method: 'DELETE', match: isPrefix('/auth/roles/'), handler: handleRolesDelete },
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

  // Calendar events
  { method: 'GET', match: isExact('/events'), handler: handleEventsList },
  { method: 'POST', match: isExact('/events'), handler: handleEventsCreate },
  { method: 'PUT', match: isPrefix('/events/'), handler: handleEventsUpdate },
  { method: 'DELETE', match: isPrefix('/events/'), handler: handleEventsDelete },

  // Contacts
  { method: 'GET', match: isExact('/contacts'), handler: handleContactsList },
  { method: 'POST', match: isExact('/contacts'), handler: handleContactsCreate },
  { method: 'POST', match: isExact('/contacts/import'), handler: handleContactsImport },
  { method: 'PUT', match: isPrefix('/contacts/'), handler: handleContactsUpdate },
  { method: 'DELETE', match: isPrefix('/contacts/'), handler: handleContactsDelete },

  // Deleted items archive (admin)
  { method: 'GET', match: isExact('/deleted-items'), handler: handleDeletedItemsList },
  { method: 'POST', match: isPrefix('/deleted-items/'), handler: handleDeletedItemsRestore },
  { method: 'DELETE', match: isPrefix('/deleted-items'), handler: handleDeletedItemsPurge },

  // Settings
  { method: 'GET', match: isExact('/settings'), handler: handleSettingsGet },
  { method: 'POST', match: isExact('/settings'), handler: handleSettingsUpdate },

  // Push notifications
  { method: 'GET', match: isExact('/push/public-key'), handler: handlePushPublicKey },
  { method: 'POST', match: isExact('/push/subscribe'), handler: handlePushSubscribe },
  { method: 'POST', match: isExact('/push/unsubscribe'), handler: handlePushUnsubscribe },

  // Public holidays (India)
  { method: 'GET', match: isExact('/holidays'), handler: handleHolidaysGet },

  // Attendance (geofenced check-in/out)
  { method: 'GET', match: isExact('/attendance/stores'), handler: handleStoresList },
  { method: 'POST', match: isExact('/attendance/stores'), handler: handleStoresCreate },
  { method: 'PUT', match: isPrefix('/attendance/stores/'), handler: handleStoresUpdate },
  { method: 'DELETE', match: isPrefix('/attendance/stores/'), handler: handleStoresDelete },
  { method: 'GET', match: isExact('/attendance/me'), handler: handleAttendanceMe },
  { method: 'POST', match: isExact('/attendance/check-in'), handler: handleAttendanceCheckIn },
  { method: 'POST', match: isExact('/attendance/check-out'), handler: handleAttendanceCheckOut },
  { method: 'GET', match: isExact('/attendance/records'), handler: handleAttendanceRecords },
  { method: 'PATCH', match: isPrefix('/attendance/records/'), handler: handleAttendanceRecordClose },

  // Razorpay payment links
  { method: 'POST', match: isExact('/payments/link'), handler: handlePaymentLinkCreate },
  { method: 'GET', match: isExact('/payments/links'), handler: handlePaymentLinksList },
  { method: 'POST', match: isExact('/payments/webhook'), handler: handlePaymentWebhook },
];

// ── App Settings ──────────────────────────────────────────────────────────

async function handleSettingsGet(ctx: Ctx) {
  const raw = await ctx.env.VAYU_KV.get('global_settings');
  const settings = raw ? JSON.parse(raw) : {};
  return json(settings);
}

async function handleSettingsUpdate(ctx: Ctx) {
  // Shared app settings were writable without signing in.
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
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
          const denied = await checkAccess(ctx);
          if (denied) return denied;
          return await route.handler(ctx);
        }
      }
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  },
};