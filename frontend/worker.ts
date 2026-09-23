import { getOrCreateVapidKeys, sendWebPush, type StoredPushSubscription } from './webpush';
import {
  ADMIN_ROLE_ID, STAFF_ROLE_ID, atLeast, normalizePermissions,
  type AccessLevel, type Permissions, type RoleDef, type SectionId,
} from './permissions';
import {
  CORS, json, err, normalizeRoute, rowToConversation, rowToMessage, rowToArtwork,
  rowToCollection, rowToCatalog, rowToInquiry, rowToInquiryMessage, rowToEvent,
  rowToContact, rowToStore, rowToAttendance, runSetupOnce,
} from './rows';
import {
  rawRealtimeSecret, realtimeEnabled, requestMetrics, resolveRealtimeSecret,
  trackedEnv, workspaceId,
  type ChangeEvent, type Ctx, type Env, type SessionData,
} from './workerEnv';
import {
  bearerToken, getSession, getRoles, permissionsFor, saveRoles, SESSION_TTL_DAYS,
  type StoredUser,
} from './workerRoles';
import {
  ackStatus, changeLogStmt, changeLogStmts, ensureChangeLogTable, handleSync, queueHubNotify,
  statusUpgradeStmts,
} from './deltaSync';
import { signTicket, TICKET_TTL_MS } from './realtimeTickets';
import {
  fileAccessAllowed, fileAuthEnabled, fileCacheHeaders, fileCookieClearHeaders,
  fileCookieToken, fileCookieValid, forgetFileToken, issueFileCookie,
} from './fileAuth';
import { SyncHub } from './realtime';
import { SNIFF_BYTES, delivery, downloadName, isRasterImage, safeExtension, storedContentType } from './fileTypes';
import { APP_ORIGIN } from './brand';
import {
  conversationScope, ensurePrivateRoomColumns, mayManageRoom, mayUseConversation, roomAccessOf, type RoomAccess,
} from './privateRooms';
import {
  EXPIRY_DAY_CHOICES, MAX_ROOM_ARTWORKS, ROOM_TOKEN_RE, VIEWING_ROOMS_TABLE_SQL, cleanIds, cleanText,
  clientArtwork, hashPasscode, issuePass, newPasscode, newRoomToken, newSecretHex, passValid, passcodeMatches,
  looksLikeEmail, roomImageKeys, roomStatus, staffRoom,
} from './viewingRooms';
import { handlePlatformRequest } from './platform/routes';
import { OrgStore } from './platform/orgStore';
import {
  deviceLimit, enforceDeviceLimit, forgetAllDevices, forgetDevice, listDevices,
  parseMaxDevices, registerDevice, revokedReason, signOutDevices, touchDevice, type DeviceSummary,
} from './deviceSessions';

// Durable Object classes must be exported from the entry module.
export { SyncHub, OrgStore };

type FormField = File | string | null;

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
  maxDevices?: number;
  /** Effective limit (null = unlimited); admin user list only. */
  deviceLimit?: number | null;
  devices?: DeviceSummary[];
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
const PRESENCE_TTL_SECONDS = 7 * 60; // Five-minute heartbeat with two minutes of grace

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

/** New and changed passwords; existing ones keep working until changed. */
const MIN_PASSWORD_LENGTH = 10;
const PASSWORD_TOO_SHORT = `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;

/**
 * A well-formed stored hash that matches no password. Checking against it
 * costs the same as a real check, so a sign-in for an email with no account
 * takes as long as one with a wrong password — the timing no longer tells
 * which emails have accounts.
 */
const NO_ACCOUNT_HASH = `${'A'.repeat(22)}==.${'A'.repeat(43)}=`;

/**
 * True while `key` is under its limit. Fails open: if the limiter itself is
 * missing or errors, requests are served rather than refused.
 */
async function underLimit(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key })).success;
  } catch {
    return true;
  }
}

function tooMany(message: string): Response {
  const res = json({ error: message }, 429);
  res.headers.set('Retry-After', '60');
  return res;
}

function generateToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── Roles & access ──────────────────────────────────────────────────────────
// Sessions and role storage live in ./workerRoles; this section keeps the
// route-level access decisions.

/** A role that no longer exists grants nothing. */
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
  // Private viewing rooms are shared catalogs. (/viewing/:token is the
  // client's side: no account, checked by its own handlers.)
  if (under('/viewing-rooms')) return { section: 'catalogs', level };
  if (under('/contacts')) return { section: 'contacts', level, readableBy: read ? ['inquiries', 'invoices', 'payments'] : undefined };
  if (under('/inquiries') || under('/inquiry-messages')) return { section: 'inquiries', level };
  if (under('/invoices')) return { section: 'invoices', level };
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

// ── Row mappers moved to ./rows (shared with the delta-sync endpoint) ──────

// The catalogs table predates pdf_url/source — add them lazily (once per
// isolate) so no manual D1 migration is required.
/**
 * Run a table's one-time schema setup (CREATE TABLE / ALTER TABLE) at most
 * once per isolate — remembering only a *completed* setup.
 *
 * These used to cache the in-flight promise in a module variable and share
 * it with later requests. On Workers, I/O belongs to the request that started
 * it: when that first request was cancelled (the app closed mid-load), its
 * database calls were cancelled too, the shared promise never settled, and
 * every later request awaiting it hung forever on that isolate — which is
 * how GET /catalogs and /events stopped answering. Now each request does its
 * own (idempotent) setup until one finishes.
 */
function ensureCatalogsColumns(db: D1Database): Promise<void> {
  return runSetupOnce('catalogsColumns', () => (async () => {
    try { await db.prepare('ALTER TABLE catalogs ADD COLUMN pdf_url TEXT').run(); } catch { /* already exists */ }
    try { await db.prepare(`ALTER TABLE catalogs ADD COLUMN source TEXT NOT NULL DEFAULT 'generated'`).run(); } catch { /* already exists */ }
  })());
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
    // Payment links live in KV, which cannot share a D1 transaction with the
    // change log — so the webhook sends a signal-only hub event instead, and
    // clients refetch /payments/links. A lost signal only delays the next
    // scheduled refresh; the KV record is already committed.
    queueHubNotify(ctx, [{ entity: 'payments', id: plink.id, op: 'put' }]);
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
  if (password.length < MIN_PASSWORD_LENGTH) return err(PASSWORD_TOO_SHORT);
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
  const emailKey = email.toLowerCase().trim();
  // Password guessing: a few tries a minute per address and per account.
  const ip = ctx.request.headers.get('cf-connecting-ip') ?? 'local';
  if (!(await underLimit(ctx.env.LOGIN_IP_LIMITER, `ip:${ip}`))
    || !(await underLimit(ctx.env.LOGIN_EMAIL_LIMITER, `email:${emailKey}`))) {
    return tooMany('Too many sign-in attempts. Wait a minute and try again.');
  }
  const userId = await ctx.env.VAYU_KV.get(`auth:email:${emailKey}`);
  const raw = userId ? await ctx.env.VAYU_KV.get(`auth:user:${userId}`) : null;
  if (!raw) {
    await verifyPassword(password, NO_ACCOUNT_HASH);
    return err('Invalid email or password', 401);
  }
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
  // Over the device limit: the device used longest ago is signed out. Its
  // hub socket closes too (the others reconnect with fresh tickets).
  const signedOut = await registerDevice(ctx.env.VAYU_KV, user, token, session.expiresAt, ctx.request.headers.get('User-Agent'));
  if (signedOut > 0) revokeHubAsync(ctx, user.id);
  const body = { token, user: await withAccess(ctx, user) };
  if (!fileAuthEnabled(ctx)) return json(body);
  // Same-origin HttpOnly capability cookie so <img>/jsPDF loads (which cannot
  // send headers) still authenticate. Unrelated to the bearer token.
  const res = json(body);
  res.headers.append('Set-Cookie', await issueFileCookie(ctx, user.id));
  return res;
}

async function handleAuthMe(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const raw = await ctx.env.VAYU_KV.get(`auth:user:${session.userId}`);
  if (!raw) return err('User not found', 404);
  const res = json(await withAccess(ctx, JSON.parse(raw)));
  const meToken = bearerToken(ctx.request);
  if (meToken) {
    ctx.execCtx.waitUntil(touchDevice(ctx.env.VAYU_KV, session.userId, meToken, ctx.request.headers.get('User-Agent'))
      .catch(e => console.error('touchDevice failed:', e)));
  }
  // Re-issue only when the cookie is missing or its KV token expired — the
  // bearer session is always valid here, so it can't be the test.
  if (fileAuthEnabled(ctx) && !(await fileCookieValid(ctx))) {
    res.headers.append('Set-Cookie', await issueFileCookie(ctx, session.userId));
  }
  return res;
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

/** GET /auth/devices — the devices the caller is signed in on, and their limit. */
async function handleAuthDevices(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const raw = await ctx.env.VAYU_KV.get(`auth:user:${session.userId}`);
  if (!raw) return err('User not found', 404);
  const user: StoredUser = JSON.parse(raw);
  const token = bearerToken(ctx.request);
  const devices = await listDevices(ctx.env.VAYU_KV, session.userId, token);
  // A session created in a lost race may be missing from the index; the
  // caller is certainly signed in here, so never show an empty list.
  if (token && !devices.some(d => d.current)) {
    await touchDevice(ctx.env.VAYU_KV, session.userId, token, ctx.request.headers.get('User-Agent'));
    return json({ limit: deviceLimit(user), devices: await listDevices(ctx.env.VAYU_KV, session.userId, token) });
  }
  return json({ limit: deviceLimit(user), devices });
}

/**
 * POST /auth/devices/signout { id } — sign one of your other devices out.
 * POST /auth/devices/signout-others — sign out every device but this one.
 */
async function handleAuthDevicesSignOut(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const token = bearerToken(ctx.request);
  let only: string | undefined;
  if (ctx.path === '/auth/devices/signout') {
    const body = await ctx.request.json().catch(() => ({})) as { id?: unknown };
    if (typeof body.id !== 'string' || !/^[0-9a-f]{24}$/.test(body.id)) return err('Device id is required');
    only = body.id;
  }
  const signedOut = await signOutDevices(ctx.env.VAYU_KV, session.userId, token, only);
  if (only !== undefined && signedOut === 0) return err('That device is not signed in (or is this device)', 404);
  // Their live connections drop; this device's socket reconnects on its own.
  if (signedOut > 0) revokeHubAsync(ctx, session.userId);
  logEntityChange(ctx, session, 'updated', 'user', session.userId,
    only === undefined ? `Signed out ${signedOut} other device(s)` : 'Signed out another device');
  return json({ signedOut });
}

/**
 * POST /auth/users/:id/devices/signout { id? } — admin: sign out one of a
 * person's devices, or (no id) all of them. On their own account an admin
 * never signs out the device they're using.
 */
async function handleAuthUserDevicesSignOut(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  if (session.role !== ADMIN_ROLE_ID) return err('Forbidden', 403);
  const userId = decodeURIComponent(ctx.path.slice('/auth/users/'.length, -'/devices/signout'.length));
  const raw = await ctx.env.VAYU_KV.get(`auth:user:${userId}`);
  if (!raw) return err('User not found', 404);
  const user: StoredUser = JSON.parse(raw);
  const body = await ctx.request.json().catch(() => ({})) as { id?: unknown };
  let only: string | undefined;
  if (body.id !== undefined) {
    if (typeof body.id !== 'string' || !/^[0-9a-f]{24}$/.test(body.id)) return err('Invalid device id');
    only = body.id;
  }
  const keep = userId === session.userId ? bearerToken(ctx.request) : null;
  const signedOut = await signOutDevices(ctx.env.VAYU_KV, userId, keep, only, 'signed-out-by-admin');
  if (only !== undefined && signedOut === 0) return err('That device is no longer signed in', 404);
  if (signedOut > 0) revokeHubAsync(ctx, userId);
  logEntityChange(ctx, session, 'updated', 'user', userId,
    only === undefined
      ? `Signed out all devices of "${user.name}" (${signedOut})`
      : `Signed out a device of "${user.name}"`);
  return json({ signedOut, devices: await listDevices(ctx.env.VAYU_KV, userId, keep) });
}

async function handleAuthLogout(ctx: Ctx): Promise<Response> {
  const auth = ctx.request.headers.get('Authorization');
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (auth?.startsWith('Bearer ')) {
    const logoutToken = auth.slice(7).trim();
    await ctx.env.VAYU_KV.delete(`auth:session:${logoutToken}`);
    if (session) await forgetDevice(ctx.env.VAYU_KV, session.userId, logoutToken);
  }
  // Drop the file capability token and revoke any live hub connection.
  if (session) {
    const fileToken = fileCookieToken(ctx);
    if (fileToken) {
      forgetFileToken(fileToken);
      await ctx.env.VAYU_KV.delete(`auth:filetoken:${fileToken}`);
    }
    revokeHubAsync(ctx, session.userId);
  }
  const res = json({ success: true });
  if (fileAuthEnabled(ctx)) {
    for (const [name, value] of Object.entries(fileCookieClearHeaders())) {
      res.headers.append(name, value);
    }
  }
  return res;
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
      const stored: StoredUser = JSON.parse(raw);
      const pub = stripPassword(stored);
      pub.notificationsEnabled = usersWithPush.has(pub.id);
      pub.deviceLimit = deviceLimit(stored);
      pub.devices = await listDevices(ctx.env.VAYU_KV, pub.id, pub.id === session.userId ? bearerToken(ctx.request) : null);
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
  const presenceMap = await combinedPresence(ctx);
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
  const { name, email, password, role, maxDevices } = addBody as {
    name?: string; email?: string; password?: string; role?: string; maxDevices?: unknown;
  };
  if (!name || !email || !password) return err('name, email and password are required');
  const createLimit = parseMaxDevices(maxDevices);
  if (!createLimit.ok) return err('Max devices must be a whole number from 1 to 10');
  if (password.length < MIN_PASSWORD_LENGTH) return err(PASSWORD_TOO_SHORT);
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
    ...(typeof createLimit.value === 'number' ? { maxDevices: createLimit.value } : {}),
  };
  await ctx.env.VAYU_KV.put(`auth:user:${id}`, JSON.stringify(user));
  await ctx.env.VAYU_KV.put(emailKey, id);
  const countRaw = await ctx.env.VAYU_KV.get('auth:count');
  await ctx.env.VAYU_KV.put('auth:count', String((countRaw ? Number.parseInt(countRaw, 10) : 0) + 1));
  await logActivity(ctx.env.VAYU_DB, session.userId, session.name, 'created', 'user', id, `Created user "${name}" (${email}) with role "${roles.find(r => r.id === roleId)?.name ?? roleId}"`);
  return json({ ...stripPassword(user), deviceLimit: deviceLimit(user), devices: [] }, 201);
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
  // Every device they're signed in on is signed out, and open hub
  // connections close immediately.
  await forgetAllDevices(ctx.env.VAYU_KV, userId);
  revokeHubAsync(ctx, userId);
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
  const { name, email, role, password, storeId, maxDevices } = editBody as {
    name?: string; email?: string; role?: string; password?: string; storeId?: string; maxDevices?: unknown;
  };
  const editLimit = parseMaxDevices(maxDevices);
  if (!editLimit.ok) return err('Max devices must be a whole number from 1 to 10');
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
  if (password && password.length < MIN_PASSWORD_LENGTH) return err(PASSWORD_TOO_SHORT);
  const updated: StoredUser = {
    ...existing,
    name: name || existing.name,
    email: newEmail,
    role: resolvedRole,
    storeId: typeof storeId === 'string' ? storeId : existing.storeId,
    hashedPassword: password ? await hashPassword(password) : existing.hashedPassword,
  };
  if (editLimit.value === null) delete updated.maxDevices;
  else if (editLimit.value !== undefined) updated.maxDevices = editLimit.value;
  await ctx.env.VAYU_KV.put(`auth:user:${userId}`, JSON.stringify(updated));
  // A lower limit (or a role change away from admin) applies right away.
  if (deviceLimit(updated) !== deviceLimit(existing)) {
    const signedOut = await enforceDeviceLimit(ctx.env.VAYU_KV, updated);
    if (signedOut > 0) revokeHubAsync(ctx, userId);
  }
  await logActivity(ctx.env.VAYU_DB, session.userId, session.name, 'updated', 'user', userId, `Updated user "${updated.name}" (${updated.email})`);
  const pub = stripPassword(updated);
  pub.deviceLimit = deviceLimit(updated);
  pub.devices = await listDevices(ctx.env.VAYU_KV, userId);
  return json(pub);
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
  return json(await combinedPresence(ctx));
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
  // The server records activity itself as things change; the app never
  // posts here. Letting anyone write entries would let them pad or muddy
  // the history, so only an admin may add one by hand.
  if (session.role !== ADMIN_ROLE_ID) return err('Activity is recorded automatically', 403);
  const body = await ctx.request.json();
  const { action, entity, entityId, details } = body as {
    action?: string; entity?: string; entityId?: string; details?: string;
  };
  if (!action || !entity) return err('action and entity are required');
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  await logActivity(ctx.env.VAYU_DB, session.userId, session.name, text(action, 100), text(entity, 50), text(entityId, 128), text(details, 2000));
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
  // The type is judged from the file's own bytes, not from what the browser
  // claims (see fileTypes.ts): a file that would run in a browser must never
  // be stored as something that is shown.
  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  const ext = safeExtension(file.name);
  const key = `uploads/${session.userId}/${Date.now()}-${crypto.randomUUID()}${ext ? '.' + ext : ''}`;
  await ctx.env.VAYU_R2.put(key, file.stream(), {
    httpMetadata: { contentType: storedContentType(file.type, head) },
  });

  // Optional small preview generated client-side, stored alongside the
  // original under a derivable key so grids can load it without schema changes.
  // Only a real image is accepted as one.
  const thumb = formData.get('thumb') as FormField;
  if (thumb && typeof thumb !== 'string') {
    const thumbHead = new Uint8Array(await thumb.slice(0, SNIFF_BYTES).arrayBuffer());
    if (isRasterImage(thumbHead)) {
      await ctx.env.VAYU_R2.put(`${key}__thumb`, thumb.stream(), {
        httpMetadata: { contentType: storedContentType(thumb.type, thumbHead) },
      });
    }
  }

  return json({ key, url: `/api/files/${key}`, thumbUrl: `/api/files/${key}__thumb` });
}

async function handleFileGet(ctx: Ctx): Promise<Response> {
  const key = decodeURIComponent(ctx.path.slice('/files/'.length));
  if (!key) return err('File not found', 404);
  // FILE_AUTH=on: an unguessable R2 key is not authorization — require the
  // file capability cookie (img/PDF flows) or a bearer session (fetch flows).
  if (fileAuthEnabled(ctx) && !(await fileAccessAllowed(ctx))) {
    return err('Unauthorized', 401);
  }
  let obj = await ctx.env.VAYU_R2.get(key);
  // Thumbnail requested but none exists (older uploads): serve the original.
  if (!obj && key.endsWith('__thumb')) {
    obj = await ctx.env.VAYU_R2.get(key.slice(0, -'__thumb'.length));
  }
  if (!obj) return err('File not found', 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  // Never let a stored file run as the app: whatever type it was saved
  // under (older uploads kept the uploader's claim), only images, PDFs and
  // plain text are shown; everything else downloads inside a sandbox.
  const how = delivery(obj.httpMetadata?.contentType);
  headers.set('Content-Type', how.contentType);
  headers.set('Content-Disposition', `${how.disposition}; filename="${downloadName(key)}"`);
  headers.set('X-Content-Type-Options', 'nosniff');
  if (how.csp) headers.set('Content-Security-Policy', how.csp);
  if (fileAuthEnabled(ctx)) {
    // Private: this browser may reuse it, no shared cache may. Repeat views
    // then cost no Worker request, no R2 read and no CPU.
    headers.set('Cache-Control', fileCacheHeaders());
  } else {
    // Legacy behaviour while the flag is off (rollback path).
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  }
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(obj.body, { status: 200, headers });
}

// ── Who may change a stored file ─────────────────────────────────────────────
// Uploads live under uploads/<uploaderId>/. Nothing else in the bucket (the
// platform logo, for one) can be removed or overwritten through these routes.

const UPLOADS_PREFIX = 'uploads/';

const isUploadKey = (key: string) => key.startsWith(UPLOADS_PREFIX) && !key.includes('..');
const ownsUpload = (session: SessionData, key: string) => key.startsWith(`${UPLOADS_PREFIX}${session.userId}/`);

/**
 * Removing an upload: its uploader, an admin, or anyone who may edit the
 * inventory (artwork photos are shared work: removing one from an artwork
 * someone else photographed is part of editing it).
 */
async function mayRemoveUpload(ctx: Ctx, session: SessionData, key: string): Promise<boolean> {
  if (!isUploadKey(key)) return false;
  if (session.role === ADMIN_ROLE_ID || ownsUpload(session, key)) return true;
  return sessionCan(ctx, session, 'inventory', 'edit');
}

// Backfill support: originals uploaded before thumbnails existed. Each person
// sees (and backfills) only their own uploads; an admin sees all of them.
async function handleFilesMissingThumbs(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const prefix = session.role === ADMIN_ROLE_ID ? UPLOADS_PREFIX : `${UPLOADS_PREFIX}${session.userId}/`;

  const originals: string[] = [];
  const thumbs = new Set<string>();
  let cursor: string | undefined;
  do {
    const res = await ctx.env.VAYU_R2.list({ prefix, cursor, limit: 1000 });
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
  // Only the uploader (or an admin) may replace a file's thumbnail.
  if (!isUploadKey(key) || (session.role !== ADMIN_ROLE_ID && !ownsUpload(session, key))) {
    return err('You can only add thumbnails to your own files', 403);
  }
  // Only attach thumbnails to files that actually exist, and only images.
  const original = await ctx.env.VAYU_R2.head(key);
  if (!original) return err('File not found', 404);
  const thumbHead = new Uint8Array(await thumb.slice(0, SNIFF_BYTES).arrayBuffer());
  if (!isRasterImage(thumbHead)) return err('A thumbnail must be an image');
  await ctx.env.VAYU_R2.put(`${key}__thumb`, thumb.stream(), {
    httpMetadata: { contentType: storedContentType(thumb.type, thumbHead) },
  });
  return json({ success: true });
}

async function handleFileDelete(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const key = decodeURIComponent(ctx.path.slice('/files/'.length));
  if (!key) return err('File not found', 404);
  if (!(await mayRemoveUpload(ctx, session, key))) return err("You can't remove this file", 403);
  const obj = await ctx.env.VAYU_R2.head(key);
  if (!obj) return err('File not found', 404);
  // Delete the thumbnail variant too (no-op when none exists).
  await ctx.env.VAYU_R2.delete([key, `${key}__thumb`]);
  return json({ success: true });
}

// ── Messaging route handlers ────────────────────────────────────────────────

/**
 * A conversation's members, privacy and creator, or null when there is no
 * such conversation. Every read or change of a single conversation checks
 * this: knowing its id is not permission (ids used to be a bare timestamp, so
 * they could be guessed). SELECT * keeps working before the private-room
 * columns exist.
 */
async function conversationAccess(db: D1Database, id: string): Promise<RoomAccess | null> {
  const row = await db.prepare('SELECT * FROM conversations WHERE id = ?').bind(id).first<Record<string, unknown>>();
  return row ? roomAccessOf(row) : null;
}

/** Members may use a conversation; admins may use any except a private room they are not in. */
function inConversation(session: SessionData, room: RoomAccess): boolean {
  return mayUseConversation(session.userId, session.role === ADMIN_ROLE_ID, room);
}

/** Rename, change members, delete: for a private room, only its managers (privateRooms.ts). */
function managesConversation(session: SessionData, room: RoomAccess): boolean {
  return mayManageRoom(session.userId, session.role === ADMIN_ROLE_ID, room);
}

const NOT_A_MANAGER = "Only the room's creator or an admin in it can change this private room";

const NOT_A_MEMBER = 'You are not part of this conversation';

async function handleConversationsList(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const showAll = ctx.url.searchParams.get('all') === 'true' && session.role === 'admin';
  const results = await ctx.env.VAYU_DB.prepare(
    'SELECT * FROM conversations ORDER BY is_pinned DESC, last_message_time DESC'
  ).all();
  const rows = results.results || [];
  const convos = rows.map(rowToConversation);
  // Admin advance view: every conversation except private rooms the admin is
  // not in; otherwise the user's own conversations.
  if (showAll) return json(convos.filter(c => !c.isPrivate || c.participantIds.includes(session.userId)));
  return json(convos.filter(c => c.participantIds.includes(session.userId)));
}

async function handleConversationsCreate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json();
  const conv = body as any;
  if (!conv.id || !conv.participantIds) return err('id and participantIds are required');
  if (typeof conv.id !== 'string' || conv.id.length > 128) return err('Invalid conversation id');
  if (!Array.isArray(conv.participantIds) || (!conv.participantIds.includes(session.userId) && session.role !== ADMIN_ROLE_ID)) {
    return err('You can only start chats you are part of', 403);
  }
  // This is an upsert, so an id that already exists belongs to that
  // conversation: only its own members may write it again (a retried
  // create). Anyone else would replace it and make themselves a member.
  const existing = await conversationAccess(ctx.env.VAYU_DB, conv.id);
  if (existing && !inConversation(session, existing)) return err(NOT_A_MEMBER, 403);
  // A private room is created by an admin, as a group they are in. Once it
  // exists, it stays private with the same creator, and only its managers
  // may write it again (privateRooms.ts).
  const isPrivate = existing ? existing.isPrivate : conv.isPrivate === true;
  if (isPrivate && !existing) {
    if (session.role !== ADMIN_ROLE_ID) return err('Only admins can create private rooms', 403);
    if (!conv.isGroup) return err('A private room is a group conversation');
    if (!conv.participantIds.includes(session.userId)) return err('You must be in the private room you create');
  }
  if (existing?.isPrivate && !managesConversation(session, existing)) return err(NOT_A_MANAGER, 403);
  const createdBy = existing ? existing.createdBy : session.userId;
  await ensurePrivateRoomColumns(ctx.env.VAYU_DB);
  await ensureChangeLogTable(ctx.env.VAYU_DB);
  // Conversation write + change-log row commit atomically.
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare(
      `INSERT OR REPLACE INTO conversations
       (id, participant_ids, participant_names, last_message, last_message_time,
        unread_count, title, reason, note, is_group, group_name, is_pinned, is_archived, created_at,
        is_private, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      Date.now(),
      isPrivate ? 1 : 0,
      createdBy,
    ),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'conversation', conv.id, 'put',
      { scope: conversationScope(conv.participantIds, isPrivate), actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [{ entity: 'conversation', id: conv.id, op: 'put', conversationId: conv.id }]);
  return json({ ...conv, isPrivate, createdBy: createdBy ?? undefined }, 201);
}

async function handleConversationsUpdate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const convId = ctx.path.slice('/conversations/'.length);
  const current = await ctx.env.VAYU_DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(convId).first<Record<string, unknown>>();
  if (!current) return err('Conversation not found', 404);
  const room = roomAccessOf(current);
  if (!inConversation(session, room)) return err(NOT_A_MEMBER, 403);
  const body = await ctx.request.json();
  const conv = body as any;
  let participantIds: string[] = Array.isArray(conv.participantIds) ? conv.participantIds : room.members;
  // Members pin, archive and bump the last message through this route too.
  // In a private room only its managers may change who is in it or its name:
  // for everyone else those fields stay as stored. Privacy and creator are
  // never changed here.
  if (room.isPrivate && !managesConversation(session, room)) {
    participantIds = room.members;
    let storedNames: unknown = [];
    try { storedNames = JSON.parse(String(current.participant_names ?? '[]')); } catch { /* malformed row */ }
    conv.participantNames = storedNames;
    conv.groupName = current.group_name ?? undefined;
  }
  if (room.isPrivate) conv.isGroup = true;
  await ensureChangeLogTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare(
      `UPDATE conversations SET
         participant_ids = ?, participant_names = ?, last_message = ?,
         last_message_time = ?, unread_count = ?, title = ?, reason = ?,
         note = ?, is_group = ?, group_name = ?, is_pinned = ?, is_archived = ?
       WHERE id = ?`
    ).bind(
      JSON.stringify(participantIds),
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
    ),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'conversation', convId, 'put',
      { scope: conversationScope(participantIds, room.isPrivate), actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [{ entity: 'conversation', id: convId, op: 'put', conversationId: convId }]);
  return json({ ...conv, participantIds, isPrivate: room.isPrivate, createdBy: room.createdBy ?? undefined });
}

async function handleConversationsDelete(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const convId = ctx.path.slice('/conversations/'.length);
  const conv = await ctx.env.VAYU_DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(convId).first<Record<string, unknown>>();
  const room = conv ? roomAccessOf(conv) : null;
  if (room) {
    if (!inConversation(session, room)) return err(NOT_A_MEMBER, 403);
    if (!managesConversation(session, room)) return err(NOT_A_MANAGER, 403);
  }
  const isPrivate = room?.isPrivate ?? false;
  const msgRows = (await ctx.env.VAYU_DB.prepare(
    'SELECT id FROM messages WHERE conversation_id = ?'
  ).bind(convId).all<{ id: string }>()).results ?? [];
  const msgCount = { n: msgRows.length };
  const messageIds = msgRows.map(r => r.id);
  let participants: string[] = [];
  try { participants = conv ? JSON.parse((conv as Record<string, unknown>).participant_ids as string) : []; } catch { /* malformed row */ }
  await ensureChangeLogTable(ctx.env.VAYU_DB);
  // Conversation delete, its messages, and every tombstone commit atomically.
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare('DELETE FROM messages WHERE conversation_id = ?').bind(convId),
    ctx.env.VAYU_DB.prepare('DELETE FROM conversations WHERE id = ?').bind(convId),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'conversation', convId, 'delete',
      { scope: conversationScope(participants, isPrivate), actorId: session.userId }),
    ...changeLogStmts(ctx.env.VAYU_DB, ctx.env, 'message', messageIds, 'delete',
      { scope: conversationScope(participants, isPrivate), actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [
    { entity: 'conversation', id: convId, op: 'delete', conversationId: convId },
    ...messageIds.map(id => ({ entity: 'message', id, op: 'delete' as const, conversationId: convId })),
  ]);
  if (conv && isPrivate) {
    // The archive and activity log are for admins, who must not see into a
    // private room: nothing of it is kept, and the log names no room.
    logEntityChange(ctx, session, 'deleted', 'conversation', convId, 'Deleted a private room');
  } else if (conv) {
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
    const room = await conversationAccess(ctx.env.VAYU_DB, conversationId);
    if (!room) return json([]);
    if (!inConversation(session, room)) return err(NOT_A_MEMBER, 403);
    results = await ctx.env.VAYU_DB.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC'
    ).bind(conversationId).all();
  } else if (showAll) {
    // Admin advance view: every message except those in private rooms the
    // admin is not in (messages whose chat is gone stay visible, as before).
    await ensurePrivateRoomColumns(ctx.env.VAYU_DB);
    results = await ctx.env.VAYU_DB.prepare(
      `SELECT m.* FROM messages m LEFT JOIN conversations c ON c.id = m.conversation_id
       WHERE c.id IS NULL OR IFNULL(c.is_private, 0) = 0
          OR EXISTS (SELECT 1 FROM json_each(c.participant_ids) p WHERE p.value = ?)
       ORDER BY m.timestamp ASC`
    ).bind(session.userId).all();
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
  const room = await conversationAccess(ctx.env.VAYU_DB, msg.conversationId);
  if (!room) return err('This chat no longer exists on the server — start a new one', 404);
  if (!inConversation(session, room)) return err("You're not a member of this chat", 403);
  const members = room.members;
  const scope = conversationScope(members, room.isPrivate);
  // Sender is whoever is signed in — never trust the id the app sends.
  msg.senderId = session.userId;
  msg.senderName = session.name;
  // Detect re-syncs/migrations of existing messages so they don't re-notify.
  const alreadyExists = await ctx.env.VAYU_DB.prepare(
    'SELECT 1 FROM messages WHERE id = ?'
  ).bind(msg.id).first();
  // Update conversation's last message info
  const attachmentPreview = msg.attachment?.type === 'image' ? '📷 Photo' : `📎 ${msg.attachment?.name}`;
  const lastMsgPreview = msg.attachment ? attachmentPreview : msg.text;
  await ensureChangeLogTable(ctx.env.VAYU_DB);
  // Message insert, conversation bump and both change-log rows commit atomically.
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare(
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
    ),
    ctx.env.VAYU_DB.prepare(
      `UPDATE conversations SET last_message = ?, last_message_time = ? WHERE id = ?`
    ).bind(lastMsgPreview, msg.timestamp || Date.now(), msg.conversationId),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'message', msg.id, 'put',
      { scope, actorId: session.userId }),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'conversation', msg.conversationId, 'put',
      { scope, actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [
    { entity: 'message', id: msg.id, op: 'put', conversationId: msg.conversationId },
    { entity: 'conversation', id: msg.conversationId, op: 'put', conversationId: msg.conversationId },
  ]);

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
  await applyMessageStatus(ctx, session, [msgId], status);
  return json({ success: true });
}

async function handleMessageStatusBatch(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json();
  const { messageIds, status } = body as { messageIds?: string[]; status?: string };
  if (!messageIds || !status) return err('messageIds and status are required');
  await applyMessageStatus(ctx, session, messageIds, status);
  return json({ success: true });
}

/**
 * Forward-only status upgrades for chat messages, with the change-log row in
 * the same atomic batch. Idempotent: re-sending an ack changes nothing and
 * announces nothing, so status flows can't loop.
 */
async function applyMessageStatus(ctx: Ctx, session: SessionData, messageIds: string[], status: string): Promise<void> {
  const to = ackStatus(status);
  const ids = uniqueIds(messageIds);
  if (!to || ids.length === 0) return;
  const db = ctx.env.VAYU_DB;
  await ensureChangeLogTable(db);
  await ensurePrivateRoomColumns(db);
  // Receipts come from conversation participants; admins may act on any
  // conversation except a private room they are not in.
  const who = session.role === ADMIN_ROLE_ID ? { adminId: session.userId } : { memberId: session.userId };
  const results = await db.batch(ids.flatMap(id =>
    statusUpgradeStmts(db, ctx.env, 'messages', id, to, { actorId: session.userId, ...who })));
  // Only rows that actually changed get a change-log entry and a hub signal.
  const events: ChangeEvent[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (const row of (results[i * 2].results ?? []) as { id: string; conversation_id: string }[]) {
      events.push({ entity: 'message', id: row.id, op: 'put', conversationId: row.conversation_id });
    }
  }
  queueHubNotify(ctx, events);
}

/** Receipt batches are bounded so one request's D1 batch stays small. */
const MAX_STATUS_IDS = 100;

/** String ids only, deduplicated and capped. */
function uniqueIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const valid = ids.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128);
  return [...new Set(valid)].slice(0, MAX_STATUS_IDS);
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

/**
 * Adds a table's missing columns at most once per isolate, remembering only a
 * finished setup (runSetupOnce). It used to share the in-flight promise with
 * later requests, the pattern that hung GET /catalogs and /events: a request
 * cancelled mid-setup left it unsettled, and every later request awaiting it
 * on that isolate hung.
 */
function ensureColumns(db: D1Database, table: MigratedTable): Promise<void> {
  return runSetupOnce(`columns:${table}`, () => addMissingColumns(db, table));
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

function ensureDeletedItemsTable(db: D1Database): Promise<void> {
  return runSetupOnce('deletedItemsTable', () => db.prepare(`
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
    `).run().then(() => undefined));
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
  invoice: 'invoices',
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
    await ctx.env.VAYU_DB.batch([
      ctx.env.VAYU_DB.prepare(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
      ).bind(...cols.map(c => (payload![c] === undefined ? null : payload![c]) as string | number | null)),
      changeLogStmt(ctx.env.VAYU_DB, ctx.env, entity, String(payload.id), 'put', { actorId: session.userId }),
    ]);
    queueHubNotify(ctx, [{ entity, id: String(payload.id), op: 'put' }]);
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
  await ensureChangeLogTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare(
      `INSERT OR REPLACE INTO artworks
       (id, custom_id, title, artist, artwork_year, description_title, description,
        dimensions, medium, status, location, price, plus_gst, image_urls, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(art.id, ...artworkValues(art), art.createdAt || Date.now()),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'artwork', art.id, 'put', { actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [{ entity: 'artwork', id: art.id, op: 'put' }]);
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
  await ensureChangeLogTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare(
      `UPDATE artworks SET
         custom_id = ?, title = ?, artist = ?, artwork_year = ?, description_title = ?,
         description = ?, dimensions = ?, medium = ?, status = ?, location = ?,
         price = ?, plus_gst = ?, image_urls = ?
       WHERE id = ?`
    ).bind(...artworkValues(art), artId),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'artwork', artId, 'put', { actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [{ entity: 'artwork', id: artId, op: 'put' }]);
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

  await ensureChangeLogTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare('DELETE FROM artworks WHERE id = ?').bind(artId),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'artwork', artId, 'delete', { actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [{ entity: 'artwork', id: artId, op: 'delete' }]);
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
  await ensureChangeLogTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare(
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
    ),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'collection', col.id, 'put', { actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [{ entity: 'collection', id: col.id, op: 'put' }]);
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
  await ensureChangeLogTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare(
      `UPDATE collections SET
         name = ?, description = ?, artwork_ids = ?, cover_image_url = ?
       WHERE id = ?`
    ).bind(
      col.name || '',
      col.description || '',
      JSON.stringify(col.artworkIds || []),
      col.coverImageUrl || '',
      colId
    ),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'collection', colId, 'put', { actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [{ entity: 'collection', id: colId, op: 'put' }]);
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
  await ensureChangeLogTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare('DELETE FROM collections WHERE id = ?').bind(colId),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'collection', colId, 'delete', { actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [{ entity: 'collection', id: colId, op: 'delete' }]);
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
  await ensureChangeLogTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare(
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
    ),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'catalog', cat.id, 'put', { actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [{ entity: 'catalog', id: cat.id, op: 'put' }]);
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
  await ensureChangeLogTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare(
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
    ),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'catalog', catId, 'put', { actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [{ entity: 'catalog', id: catId, op: 'put' }]);
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

  await ensureChangeLogTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare('DELETE FROM catalogs WHERE id = ?').bind(catId),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'catalog', catId, 'delete', { actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [{ entity: 'catalog', id: catId, op: 'delete' }]);
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
  await ensureChangeLogTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare(
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
    ),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'inquiry', inq.id, 'put', { actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [{ entity: 'inquiry', id: inq.id, op: 'put' }]);

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
  await ensureChangeLogTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare(
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
    ),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'inquiry', inqId, 'put', { actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [{ entity: 'inquiry', id: inqId, op: 'put' }]);
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
  const inquiryMessageIds = (await ctx.env.VAYU_DB.prepare(
    'SELECT id FROM inquiry_messages WHERE inquiry_id = ?'
  ).bind(inqId).all<{ id: string }>()).results?.map(r => r.id) ?? [];
  await ensureChangeLogTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare('DELETE FROM inquiry_messages WHERE inquiry_id = ?').bind(inqId),
    ctx.env.VAYU_DB.prepare('DELETE FROM inquiries WHERE id = ?').bind(inqId),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'inquiry', inqId, 'delete', { actorId: session.userId }),
    ...changeLogStmts(ctx.env.VAYU_DB, ctx.env, 'inquiry_message', inquiryMessageIds, 'delete',
      { actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [
    { entity: 'inquiry', id: inqId, op: 'delete' },
    ...inquiryMessageIds.map(id => ({ entity: 'inquiry_message', id, op: 'delete' as const })),
  ]);
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
  await ensureChangeLogTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare(
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
    ),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'inquiry_message', msg.id, 'put', { actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [{ entity: 'inquiry_message', id: msg.id, op: 'put' }]);

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
  await applyInquiryMessageStatus(ctx, session, [msgId], status);
  return json({ success: true });
}

async function handleInquiryMessageStatusBatch(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json();
  const { messageIds, status } = body as { messageIds?: string[]; status?: string };
  if (!messageIds || !status) return err('messageIds and status are required');
  await applyInquiryMessageStatus(ctx, session, messageIds, status);
  return json({ success: true });
}

/** Forward-only inquiry-message status upgrades; same contract as chat acks. */
async function applyInquiryMessageStatus(ctx: Ctx, session: SessionData, messageIds: string[], status: string): Promise<void> {
  const to = ackStatus(status);
  const ids = uniqueIds(messageIds);
  if (!to || ids.length === 0) return;
  const db = ctx.env.VAYU_DB;
  await ensureChangeLogTable(db);
  const results = await db.batch(ids.flatMap(id =>
    statusUpgradeStmts(db, ctx.env, 'inquiry_messages', id, to, { actorId: session.userId })));
  const changed = ids.filter((_, i) => (results[i * 2].results?.length ?? 0) > 0);
  queueHubNotify(ctx, changed.map(id => ({ entity: 'inquiry_message', id, op: 'put' as const })));
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


// The events table is created lazily (once per isolate) so no manual D1
// migration is required before first use. Column ALTERs handle tables created
// before end_date/todos existed.
function ensureEventsTable(db: D1Database): Promise<void> {
  return runSetupOnce('eventsTable', () => db.prepare(`
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
    }));
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
  await ensureChangeLogTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare(
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
    ),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'event', ev.id, 'put', { actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [{ entity: 'event', id: ev.id, op: 'put' }]);
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
  await ensureChangeLogTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare(
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
    ),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'event', evId, 'put', { actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [{ entity: 'event', id: evId, op: 'put' }]);
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
  await ensureChangeLogTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare('DELETE FROM events WHERE id = ?').bind(evId),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'event', evId, 'delete', { actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [{ entity: 'event', id: evId, op: 'delete' }]);
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


// The contacts table is created lazily (once per isolate) so no manual D1
// migration is required before first use.
function ensureContactsTable(db: D1Database): Promise<void> {
  return runSetupOnce('contactsTable', () => db.prepare(`
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
    `).run().then(() => undefined));
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
  await ensureChangeLogTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare(
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
    ),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'contact', c.id, 'put', { actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [{ entity: 'contact', id: c.id, op: 'put' }]);
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
  await ensureChangeLogTable(ctx.env.VAYU_DB);
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
  // Import rows and their change-log entries commit in one atomic batch.
  await ctx.env.VAYU_DB.batch([
    ...stmts,
    ...changeLogStmts(ctx.env.VAYU_DB, ctx.env, 'contact', list.map((c: any) => String(c.id)), 'put',
      { actorId: session.userId }),
  ]);
  queueHubNotify(ctx, list.map((c: any) => ({ entity: 'contact', id: String(c.id), op: 'put' as const })));
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
  await ensureChangeLogTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare('DELETE FROM contacts WHERE id = ?').bind(contactId),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'contact', contactId, 'delete', { actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [{ entity: 'contact', id: contactId, op: 'delete' }]);
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
  await ensureChangeLogTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare(
      'UPDATE contacts SET name = ?, phone = ?, email = ?, notes = ? WHERE id = ?'
    ).bind(
      String(body.name).trim(),
      body.phone || '',
      body.email || '',
      body.notes || '',
      contactId
    ),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'contact', contactId, 'put', { actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [{ entity: 'contact', id: contactId, op: 'put' }]);
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

function ensureStoresTable(db: D1Database): Promise<void> {
  return runSetupOnce('storesTable', () => db.prepare(`
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
    `).run().then(() => undefined));
}

function ensureAttendanceTable(db: D1Database): Promise<void> {
  return runSetupOnce('attendanceTable', () => db.prepare(`
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
    `).run().then(() => undefined));
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
  await ensureChangeLogTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare(
      'INSERT INTO stores (id, name, latitude, longitude, gps_radius, wifi_required, wifi_ssid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, data.name, data.latitude, data.longitude, data.gpsRadius, data.wifiRequired, data.wifiSsid, Date.now()),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'store', id, 'put', { actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [{ entity: 'store', id, op: 'put' }]);
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
  await ensureChangeLogTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.batch([
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'store', storeId, 'put', { actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [{ entity: 'store', id: storeId, op: 'put' }]);
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
  await ensureChangeLogTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.batch([
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'store', storeId, 'delete', { actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [{ entity: 'store', id: storeId, op: 'delete' }]);
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
  await ensureChangeLogTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare(
      `INSERT INTO attendance
       (id, employee_id, employee_name, store_id, check_in_at, check_in_lat, check_in_lng, check_in_accuracy, check_out_at, check_out_lat, check_out_lng, check_out_accuracy, connection_type, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, 'checked-in', ?)`
    ).bind(
      id, session.userId, session.name, store.id,
      serverNow, body.lat, body.lng, body.accuracy,
      String(body.connectionType || 'unknown'), serverNow
    ),
    // Scoped to the employee: only they (and attendance managers) see the row
    // through sync — see the attendance rule in deltaSync.
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'attendance', id, 'put',
      { scope: [session.userId], actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [{ entity: 'attendance', id, op: 'put' }]);
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
  await ensureChangeLogTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare(
      `UPDATE attendance SET
         check_out_at = ?, check_out_lat = ?, check_out_lng = ?, check_out_accuracy = ?, connection_type = ?, status = 'checked-out'
       WHERE id = ?`
    ).bind(serverNow, body.lat, body.lng, body.accuracy, String(body.connectionType || 'unknown'), open.id as string),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'attendance', open.id as string, 'put',
      { scope: [session.userId], actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [{ entity: 'attendance', id: open.id as string, op: 'put' }]);
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
  const filter = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const sql = `SELECT * FROM attendance${filter} ORDER BY check_in_at DESC LIMIT ${limit}`;
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
  await ensureChangeLogTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare(
      "UPDATE attendance SET check_out_at = ?, check_out_lat = NULL, check_out_lng = NULL, check_out_accuracy = NULL, status = 'checked-out' WHERE id = ?"
    ).bind(checkOutAt, recordId),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'attendance', recordId, 'put',
      { scope: [rec.employee_id as string], actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [{ entity: 'attendance', id: recordId, op: 'put' }]);
  logEntityChange(ctx, session, 'updated', 'attendance', recordId,
    `Closed ${(rec.employee_name as string) || 'an employee'}'s open check-in (check-out set by admin)`);
  return json(rowToAttendance({ ...rec, check_out_at: checkOutAt, check_out_lat: null, check_out_lng: null, check_out_accuracy: null, status: 'checked-out' }));
}

// ── Proforma invoices ──────────────────────────────────────────────────────
// Used to live only in each device's localStorage, so they never synced
// between phones. The whole invoice is stored as JSON (its shape is owned by
// the app), with a few columns alongside for ordering and the archive.

function ensureInvoicesTable(db: D1Database): Promise<void> {
  return runSetupOnce('invoicesTable', () => db.prepare(`
      CREATE TABLE IF NOT EXISTS invoices (
        id TEXT PRIMARY KEY,
        invoice_number TEXT NOT NULL DEFAULT '',
        customer_name TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'Draft',
        date INTEGER NOT NULL DEFAULT 0,
        data TEXT NOT NULL DEFAULT '{}',
        created_by TEXT,
        created_by_name TEXT,
        updated_at INTEGER NOT NULL DEFAULT 0
      )
    `).run());
}

async function handleInvoicesList(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  await ensureInvoicesTable(ctx.env.VAYU_DB);
  const results = await ctx.env.VAYU_DB.prepare('SELECT data FROM invoices ORDER BY date DESC').all();
  const invoices = (results.results || []).map(row => {
    try { return JSON.parse(row.data as string); } catch { return null; }
  }).filter(Boolean);
  return json(invoices);
}

/** PUT /invoices/:id — create or update (the app assigns ids). */
async function handleInvoicesSave(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const invoiceId = decodeURIComponent(ctx.path.slice('/invoices/'.length));
  const inv = await ctx.request.json() as Record<string, unknown>;
  if (!invoiceId || inv.id !== invoiceId) return err('Invoice id mismatch', 400);
  if (typeof inv.invoiceNumber !== 'string' || !Array.isArray(inv.items)) return err('Invalid invoice', 400);
  await ensureInvoicesTable(ctx.env.VAYU_DB);
  const existing = await ctx.env.VAYU_DB.prepare('SELECT created_by, created_by_name FROM invoices WHERE id = ?')
    .bind(invoiceId).first<{ created_by: string | null; created_by_name: string | null }>();
  await ensureChangeLogTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare(
      `INSERT OR REPLACE INTO invoices
       (id, invoice_number, customer_name, status, date, data, created_by, created_by_name, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      invoiceId,
      inv.invoiceNumber,
      String(inv.customerName || ''),
      String(inv.status || 'Draft'),
      Number(inv.date) || Date.now(),
      JSON.stringify(inv),
      existing ? existing.created_by : session.userId,
      existing ? existing.created_by_name : session.name,
      Date.now(),
    ),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'invoice', invoiceId, 'put', { actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [{ entity: 'invoice', id: invoiceId, op: 'put' }]);
  logEntityChange(ctx, session, existing ? 'updated' : 'created', 'invoice', invoiceId,
    `${existing ? 'Updated' : 'Created'} proforma ${inv.invoiceNumber} (${String(inv.customerName || '')})`);
  return json(inv, existing ? 200 : 201);
}

async function handleInvoicesDelete(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const invoiceId = decodeURIComponent(ctx.path.slice('/invoices/'.length));
  await ensureInvoicesTable(ctx.env.VAYU_DB);
  const row = await ctx.env.VAYU_DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(invoiceId).first();
  await ensureChangeLogTable(ctx.env.VAYU_DB);
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare('DELETE FROM invoices WHERE id = ?').bind(invoiceId),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, 'invoice', invoiceId, 'delete', { actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [{ entity: 'invoice', id: invoiceId, op: 'delete' }]);
  if (row) {
    archiveDeletedAsync(ctx, session, 'invoice', invoiceId, `Proforma ${row.invoice_number as string}`, row);
    logEntityChange(ctx, session, 'deleted', 'invoice', invoiceId, `Deleted proforma ${row.invoice_number as string}`);
  }
  return json({ success: true });
}

// ── Private viewing rooms ───────────────────────────────────────────────────
// A curated set of artworks shared with one client on a secret link with a
// passcode and an expiry (viewingRooms.ts has the security model). Staff
// routes sit under the Catalogs permission (accessRule); the client's routes
// under /viewing/:token need no account and check the room themselves.

function ensureViewingRoomsTable(db: D1Database): Promise<void> {
  return runSetupOnce('viewingRoomsTable', async () => {
    await db.prepare(VIEWING_ROOMS_TABLE_SQL).run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_viewing_rooms_created ON viewing_rooms(created_at DESC)').run();
  });
}

/** Artwork rows for these ids, in the order given; missing (deleted) ones are skipped. */
async function artworksByIds(db: D1Database, ids: string[]): Promise<ReturnType<typeof rowToArtwork>[]> {
  if (ids.length === 0) return [];
  await ensureColumns(db, 'artworks');
  const found = new Map<string, ReturnType<typeof rowToArtwork>>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const res = await db.prepare(`SELECT * FROM artworks WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
    for (const row of res.results || []) found.set(String(row.id), rowToArtwork(row));
  }
  return ids.map(id => found.get(id)).filter((a): a is ReturnType<typeof rowToArtwork> => !!a);
}

interface RoomInput {
  name: string; clientName: string; clientPhone: string; clientEmail: string; message: string;
  artworkIds: string[]; showPrices: boolean;
}

/** Validates the staff form; returns an error message or the cleaned input. */
async function readRoomInput(db: D1Database, body: Record<string, unknown>): Promise<RoomInput | string> {
  const input: RoomInput = {
    name: cleanText(body.name, 120),
    clientName: cleanText(body.clientName, 120),
    clientPhone: cleanText(body.clientPhone, 40),
    clientEmail: cleanText(body.clientEmail, 200),
    message: cleanText(body.message, 2000),
    artworkIds: cleanIds(body.artworkIds),
    showPrices: body.showPrices === true,
  };
  if (!input.name) return 'Give the room a name';
  if (input.clientEmail && !looksLikeEmail(input.clientEmail)) return 'That email address does not look right';
  if (input.artworkIds.length === 0) return 'Choose at least one artwork';
  if (input.artworkIds.length > MAX_ROOM_ARTWORKS) return `A room can hold up to ${MAX_ROOM_ARTWORKS} artworks`;
  const existing = await artworksByIds(db, input.artworkIds);
  if (existing.length !== input.artworkIds.length) return 'Some of those artworks no longer exist';
  return input;
}

function expiryFrom(days: unknown, now = Date.now()): number | null {
  const n = Number(days);
  return (EXPIRY_DAY_CHOICES as readonly number[]).includes(n) ? now + n * 86_400_000 : null;
}

/** A fresh passcode and the columns that store it (salt, hash, and a new grant key that cancels old passes). */
async function passcodeColumns(): Promise<{ passcode: string; hash: string; salt: string; grantKey: string }> {
  const passcode = newPasscode();
  const salt = newSecretHex(16);
  return { passcode, salt, hash: await hashPasscode(passcode, salt), grantKey: newSecretHex(32) };
}

async function handleViewingRoomsList(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  await ensureViewingRoomsTable(ctx.env.VAYU_DB);
  const res = await ctx.env.VAYU_DB.prepare('SELECT * FROM viewing_rooms ORDER BY created_at DESC LIMIT 500').all();
  return json((res.results || []).map(row => staffRoom(row)));
}

async function handleViewingRoomsCreate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const db = ctx.env.VAYU_DB;
  await ensureViewingRoomsTable(db);
  const body = await ctx.request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return err('Send the room as JSON');
  const input = await readRoomInput(db, body);
  if (typeof input === 'string') return err(input);
  const now = Date.now();
  const expiresAt = expiryFrom(body.expiresInDays, now);
  if (!expiresAt) return err(`Choose how long the link works: ${EXPIRY_DAY_CHOICES.join(', ')} days`);
  const secret = await passcodeColumns();
  const id = `vr_${crypto.randomUUID()}`;
  const token = newRoomToken();
  await db.prepare(
    `INSERT INTO viewing_rooms (id, token, name, client_name, client_phone, client_email, message, artwork_ids,
       show_prices, passcode_hash, passcode_salt, grant_key, expires_at, is_active, created_by, created_by_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  ).bind(id, token, input.name, input.clientName, input.clientPhone, input.clientEmail, input.message,
    JSON.stringify(input.artworkIds), input.showPrices ? 1 : 0, secret.hash, secret.salt, secret.grantKey,
    expiresAt, session.userId, session.name, now, now).run();
  logEntityChange(ctx, session, 'created', 'viewing_room', id,
    `Created private room "${input.name}"${input.clientName ? ` for ${input.clientName}` : ''} (${input.artworkIds.length} artworks)`);
  const row = await db.prepare('SELECT * FROM viewing_rooms WHERE id = ?').bind(id).first();
  // The passcode is only ever shown now (and when a new one is made).
  return json({ ...staffRoom(row!), passcode: secret.passcode }, 201);
}

async function handleViewingRoomsUpdate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const db = ctx.env.VAYU_DB;
  await ensureViewingRoomsTable(db);
  const id = decodeURIComponent(ctx.path.slice('/viewing-rooms/'.length));
  const row = await db.prepare('SELECT * FROM viewing_rooms WHERE id = ?').bind(id).first();
  if (!row) return err('Private room not found', 404);
  const body = await ctx.request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return err('Send the change as JSON');
  const now = Date.now();
  const sets: string[] = [];
  const binds: unknown[] = [];
  const changes: string[] = [];
  if (body.details) {
    const input = await readRoomInput(db, body.details as Record<string, unknown>);
    if (typeof input === 'string') return err(input);
    sets.push('name = ?', 'client_name = ?', 'client_phone = ?', 'client_email = ?', 'message = ?', 'artwork_ids = ?', 'show_prices = ?');
    binds.push(input.name, input.clientName, input.clientPhone, input.clientEmail, input.message, JSON.stringify(input.artworkIds), input.showPrices ? 1 : 0);
    changes.push('details');
  }
  if (typeof body.isActive === 'boolean') {
    sets.push('is_active = ?');
    binds.push(body.isActive ? 1 : 0);
    changes.push(body.isActive ? 'switched on' : 'switched off');
  }
  if (body.expiresInDays !== undefined) {
    const expiresAt = expiryFrom(body.expiresInDays, now);
    if (!expiresAt) return err(`Choose how long the link works: ${EXPIRY_DAY_CHOICES.join(', ')} days`);
    sets.push('expires_at = ?');
    binds.push(expiresAt);
    changes.push(`link valid ${body.expiresInDays} more days`);
  }
  let passcode: string | undefined;
  if (body.newPasscode === true) {
    const secret = await passcodeColumns();
    passcode = secret.passcode;
    sets.push('passcode_hash = ?', 'passcode_salt = ?', 'grant_key = ?');
    binds.push(secret.hash, secret.salt, secret.grantKey);
    changes.push('new passcode');
  }
  if (sets.length === 0) return err('Nothing to change');
  sets.push('updated_at = ?');
  binds.push(now, id);
  await db.prepare(`UPDATE viewing_rooms SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  logEntityChange(ctx, session, 'updated', 'viewing_room', id, `Private room "${String(row.name)}": ${changes.join(', ')}`);
  const updated = await db.prepare('SELECT * FROM viewing_rooms WHERE id = ?').bind(id).first();
  return json({ ...staffRoom(updated!), ...(passcode ? { passcode } : {}) });
}

async function handleViewingRoomsDelete(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const db = ctx.env.VAYU_DB;
  await ensureViewingRoomsTable(db);
  const id = decodeURIComponent(ctx.path.slice('/viewing-rooms/'.length));
  const row = await db.prepare('SELECT name FROM viewing_rooms WHERE id = ?').bind(id).first<{ name: string }>();
  if (!row) return err('Private room not found', 404);
  await db.prepare('DELETE FROM viewing_rooms WHERE id = ?').bind(id).run();
  logEntityChange(ctx, session, 'deleted', 'viewing_room', id, `Deleted private room "${row.name}"`);
  return json({ success: true });
}

// ── The client's side (no account) ──

const ROOM_UNAVAILABLE = 'This private room is no longer available. Please contact the gallery for a new link.';

/** The room behind a link, when it exists and is on and unexpired. */
async function openRoomByToken(ctx: Ctx, token: string): Promise<Record<string, unknown> | Response> {
  if (!ROOM_TOKEN_RE.test(token)) return err(ROOM_UNAVAILABLE, 404);
  await ensureViewingRoomsTable(ctx.env.VAYU_DB);
  const row = await ctx.env.VAYU_DB.prepare('SELECT * FROM viewing_rooms WHERE token = ?').bind(token).first();
  if (!row || roomStatus({ is_active: Number(row.is_active), expires_at: Number(row.expires_at) }) !== 'active') {
    return err(ROOM_UNAVAILABLE, 404);
  }
  return row;
}

function viewingTokenOf(path: string, suffix: string): string {
  return path.slice('/viewing/'.length, path.length - suffix.length);
}

/**
 * POST /viewing/:token/open { passcode } | { pass } — the room and a (new)
 * pass for its photos. Re-opening with a still-valid pass (a page reload)
 * needs no passcode and is not rate limited; passcode tries are.
 */
async function handleViewingOpen(ctx: Ctx): Promise<Response> {
  const token = viewingTokenOf(ctx.path, '/open');
  const body = await ctx.request.json().catch(() => null) as { passcode?: unknown; pass?: unknown } | null;
  const heldPass = typeof body?.pass === 'string' ? body.pass : null;
  if (!heldPass) {
    // Guessing: at most a few tries a minute per room and per address.
    const ip = ctx.request.headers.get('cf-connecting-ip') ?? 'local';
    if (!(await underLimit(ctx.env.LOGIN_EMAIL_LIMITER, `room:${token}`)) || !(await underLimit(ctx.env.LOGIN_IP_LIMITER, `room-ip:${ip}`))) {
      return tooMany('Too many tries. Wait a minute and try again.');
    }
  }
  const found = await openRoomByToken(ctx, token);
  if (found instanceof Response) return found;
  const row = found;
  if (heldPass) {
    if (!(await passValid(heldPass, String(row.grant_key), token))) return err('Enter the passcode again', 401);
  } else {
    const passcode = typeof body?.passcode === 'string' ? body.passcode.replace(/\s/g, '') : '';
    if (!(await passcodeMatches(passcode, row as { passcode_hash: string; passcode_salt: string }))) {
      return err("That passcode doesn't match. Check the message you received.", 403);
    }
  }
  let artworkIds: string[] = [];
  try { artworkIds = JSON.parse(String(row.artwork_ids)); } catch { /* malformed */ }
  const artworks = await artworksByIds(ctx.env.VAYU_DB, artworkIds);
  const { pass, expiresAt } = await issuePass(String(row.grant_key), token);
  const showPrices = Number(row.show_prices) === 1;
  ctx.execCtx.waitUntil(ctx.env.VAYU_DB.prepare(
    'UPDATE viewing_rooms SET view_count = view_count + 1, last_viewed_at = ? WHERE id = ?',
  ).bind(Date.now(), row.id).run().catch(() => { /* a missed view count is fine */ }));
  const res = json({
    room: {
      name: String(row.name),
      clientName: String(row.client_name ?? ''),
      message: String(row.message ?? ''),
      sharedBy: String(row.created_by_name ?? ''),
      showPrices,
      expiresAt: Number(row.expires_at),
    },
    artworks: artworks.map(art => clientArtwork(art, token, pass, showPrices)),
    pass,
    passExpiresAt: expiresAt,
  });
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

/** GET /viewing/:token/image?k=<R2 key>&p=<pass> — one of the room's own photos. */
async function handleViewingImage(ctx: Ctx): Promise<Response> {
  const token = viewingTokenOf(ctx.path, '/image');
  const found = await openRoomByToken(ctx, token);
  if (found instanceof Response) return found;
  const row = found;
  if (!(await passValid(ctx.url.searchParams.get('p'), String(row.grant_key), token))) return err('Open the room again', 401);
  const key = ctx.url.searchParams.get('k') ?? '';
  let artworkIds: string[] = [];
  try { artworkIds = JSON.parse(String(row.artwork_ids)); } catch { /* malformed */ }
  if (!roomImageKeys(await artworksByIds(ctx.env.VAYU_DB, artworkIds)).has(key)) return err('Not found', 404);
  let obj = await ctx.env.VAYU_R2.get(key);
  if (!obj && key.endsWith('__thumb')) obj = await ctx.env.VAYU_R2.get(key.slice(0, -'__thumb'.length));
  if (!obj) return err('Not found', 404);
  const how = delivery(obj.httpMetadata?.contentType);
  // Photos only: anything else stays behind the staff app.
  if (!how.contentType.startsWith('image/') || how.disposition !== 'inline') return err('Not found', 404);
  const headers = new Headers();
  headers.set('Content-Type', how.contentType);
  headers.set('X-Content-Type-Options', 'nosniff');
  if (how.csp) headers.set('Content-Security-Policy', how.csp);
  headers.set('Cache-Control', 'private, max-age=3600');
  return new Response(obj.body, { status: 200, headers });
}

/** POST /viewing/:token/interest — the client's "I'm interested", recorded as an inquiry. */
async function handleViewingInterest(ctx: Ctx): Promise<Response> {
  const token = viewingTokenOf(ctx.path, '/interest');
  const ip = ctx.request.headers.get('cf-connecting-ip') ?? 'local';
  if (!(await underLimit(ctx.env.LOGIN_IP_LIMITER, `room-interest:${ip}`))) {
    return tooMany('Too many requests. Wait a minute and try again.');
  }
  const found = await openRoomByToken(ctx, token);
  if (found instanceof Response) return found;
  const row = found;
  const body = await ctx.request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || !(await passValid(typeof body.pass === 'string' ? body.pass : null, String(row.grant_key), token))) {
    return err('Open the room again', 401);
  }
  const name = cleanText(body.name, 120);
  const phone = cleanText(body.phone, 40);
  const email = cleanText(body.email, 200);
  const message = cleanText(body.message, 2000);
  if (!name) return err('Please add your name');
  if (!phone && !email) return err('Please add a phone number or an email address so we can reply');
  if (email && !looksLikeEmail(email)) return err('That email address does not look right');
  let roomArtworkIds: string[] = [];
  try { roomArtworkIds = JSON.parse(String(row.artwork_ids)); } catch { /* malformed */ }
  const artworkIds = cleanIds(body.artworkIds).filter(id => roomArtworkIds.includes(id));
  if (artworkIds.length === 0) return err('Choose at least one artwork you are interested in');

  const db = ctx.env.VAYU_DB;
  await ensureColumns(db, 'inquiries');
  await ensureChangeLogTable(db);
  const now = Date.now();
  const inquiry = {
    id: `inq_${now}_${crypto.randomUUID()}`,
    inquiryNumber: makeInquiryNumber(),
    customerName: name,
    customerPhone: phone,
    customerEmail: email,
    artworkIds,
    notes: [`From private room "${String(row.name)}".`, message].filter(Boolean).join('\n\n'),
    source: 'Private room',
    status: 'New',
    date: now,
  };
  const actorName = `${name} (private room)`;
  await db.batch([
    db.prepare(
      `INSERT INTO inquiries (id, inquiry_number, customer_name, customer_phone, customer_email, customer_address,
         artwork_ids, notes, source, status, catalog_shared, date, created_by, created_by_name, image_urls)
       VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, 0, ?, ?, ?, '[]')`,
    ).bind(inquiry.id, inquiry.inquiryNumber, name, phone, email, JSON.stringify(artworkIds), inquiry.notes,
      inquiry.source, inquiry.status, now, String(row.created_by ?? ''), actorName),
    changeLogStmt(db, ctx.env, 'inquiry', inquiry.id, 'put', { actorId: 'viewing-room' }),
    db.prepare('UPDATE viewing_rooms SET inquiry_count = inquiry_count + 1 WHERE id = ?').bind(row.id),
  ]);
  queueHubNotify(ctx, [{ entity: 'inquiry', id: inquiry.id, op: 'put' }]);
  ctx.execCtx.waitUntil(sendPushToAllExcept(ctx.env, '', {
    title: `New inquiry — ${name}`,
    body: `From private room "${String(row.name)}": ${artworkIds.length} artwork${artworkIds.length === 1 ? '' : 's'}`,
    tag: `inquiry-${inquiry.id}`,
    data: { view: 'inquiry', inquiryId: inquiry.id },
  }).catch(e => console.error('Push notify (room inquiry) failed:', e)));
  ctx.execCtx.waitUntil(logActivity(db, 'viewing-room', actorName, 'created', 'inquiry', inquiry.id,
    `Inquiry ${inquiry.inquiryNumber} from private room "${String(row.name)}"`));
  return json({ success: true }, 201);
}

/** "INQ-2026-042", the same shape the app gives inquiries (services/documentNumber.ts). */
function makeInquiryNumber(): string {
  const [random] = crypto.getRandomValues(new Uint32Array(1));
  return `INQ-${new Date().getFullYear()}-${String(random % 1000).padStart(3, '0')}`;
}

// ── Route table ─────────────────────────────────────────────────────────────

const isExact = (p: string) => (path: string) => path === p;
const isPrefix = (p: string) => (path: string) => path.startsWith(p);

const routes: Route[] = [
  { method: 'GET', match: isExact('/viewing-rooms'), handler: handleViewingRoomsList },
  { method: 'POST', match: isExact('/viewing-rooms'), handler: handleViewingRoomsCreate },
  { method: 'PATCH', match: isPrefix('/viewing-rooms/'), handler: handleViewingRoomsUpdate },
  { method: 'DELETE', match: isPrefix('/viewing-rooms/'), handler: handleViewingRoomsDelete },
  { method: 'POST', match: (p) => p.startsWith('/viewing/') && p.endsWith('/open'), handler: handleViewingOpen },
  { method: 'GET', match: (p) => p.startsWith('/viewing/') && p.endsWith('/image'), handler: handleViewingImage },
  { method: 'POST', match: (p) => p.startsWith('/viewing/') && p.endsWith('/interest'), handler: handleViewingInterest },
  // Auth
  { method: 'GET', match: isExact('/auth/status'), handler: handleAuthStatus },
  { method: 'POST', match: isExact('/auth/setup'), handler: handleAuthSetup },
  { method: 'POST', match: isExact('/auth/login'), handler: handleAuthLogin },
  { method: 'GET', match: isExact('/auth/me'), handler: handleAuthMe },
  { method: 'PUT', match: isExact('/auth/me'), handler: handleAuthMeUpdate },
  { method: 'POST', match: isExact('/auth/logout'), handler: handleAuthLogout },
  { method: 'GET', match: isExact('/auth/users'), handler: handleAuthUsersList },
  { method: 'GET', match: isExact('/auth/devices'), handler: handleAuthDevices },
  { method: 'POST', match: isExact('/auth/devices/signout'), handler: handleAuthDevicesSignOut },
  { method: 'POST', match: isExact('/auth/devices/signout-others'), handler: handleAuthDevicesSignOut },
  { method: 'GET', match: isExact('/auth/team'), handler: handleAuthTeam },
  { method: 'GET', match: isExact('/auth/roles'), handler: handleRolesList },
  { method: 'POST', match: isExact('/auth/roles'), handler: handleRolesCreate },
  { method: 'PUT', match: isPrefix('/auth/roles/'), handler: handleRolesUpdate },
  { method: 'DELETE', match: isPrefix('/auth/roles/'), handler: handleRolesDelete },
  { method: 'POST', match: isExact('/auth/users'), handler: handleAuthUsersCreate },
  { method: 'POST', match: (p) => /^\/auth\/users\/[^/]+\/devices\/signout$/.test(p), handler: handleAuthUserDevicesSignOut },
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
  { method: 'GET', match: isExact('/invoices'), handler: handleInvoicesList },
  { method: 'PUT', match: isPrefix('/invoices/'), handler: handleInvoicesSave },
  { method: 'DELETE', match: isPrefix('/invoices/'), handler: handleInvoicesDelete },
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

  // Delta sync + realtime hub
  { method: 'GET', match: isExact('/sync'), handler: handleSync },
  { method: 'POST', match: isExact('/realtime/ticket'), handler: handleRealtimeTicket },
  { method: 'GET', match: isExact('/realtime/ws'), handler: handleRealtimeWs },
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

// ── Realtime hub plumbing ───────────────────────────────────────────────

function hubStub(env: Env): DurableObjectStub | null {
  if (!env.SYNC_HUB) return null;
  return env.SYNC_HUB.get(env.SYNC_HUB.idFromName(workspaceId(env)));
}

/** Ask the hub to close every connection of a user (logout, removal). */
function revokeHubAsync(ctx: Ctx, userId: string): void {
  const stub = hubStub(ctx.env);
  if (!stub || !realtimeEnabled(ctx.env)) return;
  ctx.execCtx.waitUntil(stub.fetch('https://hub.internal/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-key': rawRealtimeSecret(ctx.env) },
    body: JSON.stringify({ userId }),
  }).catch(() => undefined));
}

/** Connection-based presence from the hub, or null when unavailable. */
async function hubPresence(ctx: Ctx): Promise<Record<string, { isOnline: boolean; lastSeen: number }> | null> {
  const stub = hubStub(ctx.env);
  if (!stub || !realtimeEnabled(ctx.env)) return null;
  const res = await stub.fetch('https://hub.internal/presence', {
    headers: { 'x-hub-key': rawRealtimeSecret(ctx.env) },
  });
  if (!res.ok) return null;
  const body = await res.json<{ presence?: Record<string, { isOnline: boolean; lastSeen: number }> }>();
  return body.presence ?? null;
}

/**
 * Who is online: anyone with a live hub socket OR a recent KV heartbeat.
 * Both are needed while clients are mixed — app versions from before realtime
 * (and clients whose socket is down) only send heartbeats, and must not show
 * as offline just because the hub is up.
 */
async function combinedPresence(ctx: Ctx): Promise<Record<string, { isOnline: boolean; lastSeen: number }>> {
  const [hub, kv] = await Promise.all([
    hubPresence(ctx).catch(() => null),
    getPresenceMap(ctx.env.VAYU_KV),
  ]);
  if (!hub) return kv;
  const merged = { ...kv };
  for (const [userId, entry] of Object.entries(hub)) {
    merged[userId] = { isOnline: true, lastSeen: Math.max(entry.lastSeen, kv[userId]?.lastSeen ?? 0) };
  }
  return merged;
}

/** POST /realtime/ticket — a short-lived single-use connection ticket. */
async function handleRealtimeTicket(ctx: Ctx): Promise<Response> {
  if (!realtimeEnabled(ctx.env)) return err('Not found', 404);
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const now = Date.now();
  const ticket = await signTicket({
    jti: crypto.randomUUID(),
    uid: session.userId,
    wid: workspaceId(ctx.env),
    role: session.role,
    name: session.name,
    iat: now,
    exp: now + TICKET_TTL_MS,
  }, await resolveRealtimeSecret(ctx.env));
  return json({ ticket, ttlMs: TICKET_TTL_MS });
}

/**
 * GET /realtime/ws?ticket=... — upgrade into the workspace hub after Origin
 * validation. Browsers cannot set an Authorization header on a WebSocket
 * handshake, which is why the credential is the single-use ticket (never the
 * bearer token).
 */
async function handleRealtimeWs(ctx: Ctx): Promise<Response> {
  if (!realtimeEnabled(ctx.env)) return err('Not found', 404);
  if (ctx.request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return err('WebSocket upgrade required', 426);
  }
  // Origin check: same host, or an explicitly configured allowed origin.
  const origin = ctx.request.headers.get('Origin');
  if (!origin) return err('Origin required', 403);
  const allowed = new Set<string>([ctx.url.origin]);
  for (const extra of (ctx.env.REALTIME_ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean)) {
    allowed.add(extra);
  }
  if (!allowed.has(origin)) return err('Origin not allowed', 403);
  const ticket = ctx.url.searchParams.get('ticket') ?? '';
  if (!ticket) return err('ticket is required', 401);
  const stub = hubStub(ctx.env)!;
  return stub.fetch(`https://hub.internal/connect?ticket=${encodeURIComponent(ticket)}`, {
    headers: {
      'Upgrade': 'websocket',
      'x-hub-key': rawRealtimeSecret(ctx.env),
      'Origin': origin,
    },
  });
}

/**
 * This Worker is the API only; the pages are other Workers (docs/HOSTING.md).
 * A browser opening a page on one of its own addresses (api., or the old
 * workers.dev address of the app) is sent to the app.
 */
function pageVisit(request: Request): Response | null {
  if (request.headers.get('Sec-Fetch-Mode') !== 'navigate') return null;
  const page = new URL(request.url);
  if (/^\/api(\/|$)/.test(page.pathname)) return null;
  return Response.redirect(APP_ORIGIN + page.pathname + page.search, 302);
}

// ── Analytics Engine instrumentation ────────────────────────────────────
// One data point per request, written inside the request (no extra browser
// telemetry call). Records the normalized route — never tokens, cookies,
// bodies, emails or query strings. Wall-clock duration, which is deliberately
// different from Worker CPU time. Telemetry failure never fails the request.

function writeAnalytics(
  env: Env, execCtx: ExecutionContext, request: Request, route: string,
  status: number, durationMs: number, isWebSocket: boolean,
): void {
  if (!env.ANALYTICS) return;
  try {
    const metrics = requestMetrics(request);
    env.ANALYTICS.writeDataPoint({
      blobs: [route, request.method, workspaceId(env), isWebSocket ? 'ws' : 'http'],
      doubles: [
        status,
        durationMs,
        metrics.d1RowsRead,
        metrics.d1RowsWritten,
        metrics.kvOps,
      ],
    });
  } catch {
    /* telemetry must never break the request */
  }
}

export default {
  async fetch(request: Request, env: Env, execCtx: ExecutionContext): Promise<Response> {
    const startedAt = Date.now();
    // Platform (SaaS) API. Handled first so the legacy wildcard CORS below
    // never applies to cookie-authenticated routes.
    const early = pageVisit(request) ?? await handlePlatformRequest(request, env);
    if (early) return early;
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, '');
    // Per-request bindings view that counts KV ops and D1 rows as handlers
    // use them; everything downstream keeps using ctx.env unchanged.
    const tracked = trackedEnv(request, env);
    const ctx: Ctx = { request, env: tracked, url, path, method: request.method, execCtx };

    let response = json({ error: 'Internal error' }, 500);
    let route = 'unmatched';
    try {
      let matched = false;
      for (const r of routes) {
        if (r.method === ctx.method && r.match(path)) {
          route = normalizeRoute(path);
          matched = true;
          // Floods and enumeration from one device: far above normal use.
          const device = bearerToken(request);
          if (device && !(await underLimit(env.API_LIMITER, `device:${device.slice(0, 32)}`))) {
            response = tooMany('Too many requests. Slow down and try again in a minute.');
            break;
          }
          const denied = await checkAccess(ctx);
          if (denied) { response = denied; break; }
          response = await r.handler(ctx);
          break;
        }
      }
      if (!matched) {
        route = normalizeRoute(path);
        response = json({ error: 'Not found' }, 404);
      }
    } catch (e) {
      // The details go to the logs, not to the caller: internal messages can
      // reveal table names, queries or other internals.
      console.error(`Unhandled error on ${request.method} ${route}:`, e);
      response = json({ error: 'Something went wrong. Please try again.' }, 500);
    }
    // A device signed out by the device limit learns why, so the app can
    // say so instead of failing with a bare "Unauthorized".
    if (response.status === 401) {
      const token = bearerToken(request);
      const reason = token ? await revokedReason(env.VAYU_KV, token).catch(() => null) : null;
      if (reason) response = json({ error: 'Unauthorized', reason }, 401);
    }
    // 101 marks the WebSocket upgrade; everything else is an ordinary call.
    execCtx.waitUntil(Promise.resolve().then(() =>
      writeAnalytics(env, execCtx, request, route, response.status, Date.now() - startedAt, response.status === 101),
    ));
    return response;
  },
};
