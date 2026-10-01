import { getOrCreateVapidKeys, sendWebPush, type StoredPushSubscription } from './webpush';
import {
  ADMIN_ROLE_ID, STAFF_ROLE_ID, atLeast, normalizePermissions, withoutSections,
  type AccessLevel, type Permissions, type RoleDef, type SectionId,
} from './permissions';
import { staffRosterRoutes } from './staffRoster';
import { salesRoutes } from './sales';
import {
  CORS, json, err, normalizeRoute, rowToConversation, rowToMessage, rowToArtwork,
  rowToCollection, rowToCatalog, rowToInquiry, rowToInquiryMessage, rowToEvent,
  rowToContact, rowToStore, rowToAttendance, runSetupOnce,
} from './rows';
import {
  fileKeyFromUrl, fileUrl, rawRealtimeSecret, realtimeEnabled, requestMetrics, resolveRealtimeSecret,
  trackedEnv, workspaceId,
  type ChangeEvent, type Ctx, type Env, type SessionData,
} from './workerEnv';
import {
  bearerToken, getSession, getRoles, permissionsFor, primeSession, saveRoles, SESSION_TTL_DAYS,
  type StoredUser,
} from './workerRoles';
import { originalSignInOpen } from './platform/originalSignIn';
import { ORG_PATH, forgetPlanActive, openOrgRequest, orgMemberDevices, orgMemberRecords, orgStorageEnv, signOutOrgMemberDevices } from './orgApp';
import { orgAccountRoutes } from './orgTeam';
import { OrgAppDb } from './orgAppDb';
import { orgKvPrefix } from './orgStorage';
import { sectionRecipients, staleRegistration, type PushOwner } from './pushRules';
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
import { ensureMessageColumns, reactionStmts, readReceiptStmts } from './messageReceipts';
import { isReactionEmoji } from './chatReactions';
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
import { razorpayApiBase, razorpayCredentials, verifiedRazorpayKeys } from './platform/payments';
import { runRotationBatch } from './platform/secretRotation';
import { maskKeyId, secretsConfigured } from './platform/secrets';
import {
  AUTH_KIND_HEADER, clearedSessionCookies, cookieNames, csrfProblem, normalizeAuth, readCookie, sessionCookies, trustedOrigins, type AuthKind,
} from './sessionCookies';
import { costlyGroup, limitKeys } from './rateLimits';
import { recordProcessed, recordProcessingFailure, recordReconcile, recordRejection, recordVerified, safeError, type ReconcileOutcome } from './platform/webhookHealth';
import {
  CURRENCY, amountProblem, idempotencyKey, invoiceTotals, maxPaise, outstandingPaise, overrideNeeded, overrideReason,
  nextLinkStatus, referenceIdFor, testModeRefusal, requestFingerprint, requestedPaise, type InvoiceLike, type InvoiceTotals, type OverrideKind,
} from './paymentLinkPolicy';
import { toPaymentDetail, type PaymentDetail } from './platform/razorpayDetails';
import {
  billingOptions, confirmCheckout, listOrgPayments, orgNameOf, paymentView, recheckOrgPayment, startCheckout, type Reconciled,
} from './platform/billing';
import { OrgError } from './platform/orgs';
import { planAndUsage } from './planUsage';
import { OrgStore } from './platform/orgStore';
import { deliverOutbox } from './platform/notify';
import { recordRun, runJob } from './platform/jobs';
import { emailConfigured } from './platform/email';
import {
  deviceLimit, enforceDeviceLimit, forgetAllDevices, forgetDevice, listDevices,
  parseMaxDevices, registerDevice, revokedReason, signOutDevices, touchDevice, type DeviceSummary,
} from './deviceSessions';

// Durable Object classes must be exported from the entry module.
export { SyncHub, OrgStore, OrgAppDb };

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
  const res = json({ error: message, code: 'rate_limited' }, 429);
  res.headers.set('Retry-After', '60');
  return res;
}

/**
 * Public webhook addresses, per client IP and before any signature or
 * database work: a flood from one address is refused (429) without costing
 * anything. Generous, because Razorpay retries whatever it can't deliver for
 * 24 hours, so a refusal delays an event rather than losing it. Deliberately
 * NOT per organization: an attacker could otherwise use up an organization's
 * allowance and block its real payment notices.
 */
async function webhookIngressLimit(request: Request, env: Env): Promise<Response | null> {
  if (request.method !== 'POST') return null;
  const path = new URL(request.url).pathname;
  if (!/^\/api\/(v2\/webhooks\/|payments\/webhook$)/.test(path)) return null;
  const ip = request.headers.get('cf-connecting-ip') ?? 'local';
  return (await underLimit(env.WEBHOOK_INGRESS_LIMITER, `webhook:${ip}`)) ? null : tooMany('Too many requests.');
}

/**
 * Costly routes (rateLimits.ts): a limit per person and per workspace, after
 * the access check has read the (memoised) session and before the handler
 * does any real work. Null when the request may go ahead.
 */
async function costlyLimit(ctx: Ctx, env: Env): Promise<Response | null> {
  const group = costlyGroup(ctx.method, ctx.path);
  if (!group) return null;
  const session = await getSession(ctx.request, env.VAYU_KV);
  if (!session) return null; // the handler answers 401
  const keys = limitKeys(group, session.userId, env.ORG_ID);
  const personal = group === 'payment_link' ? env.PAYMENT_LINK_LIMITER : env.COSTLY_USER_LIMITER;
  if (!(await underLimit(personal, keys.user)) || !(await underLimit(env.COSTLY_ORG_LIMITER, keys.org))) {
    return tooMany('Too many of these in a short time. Wait a minute and try again.');
  }
  return null;
}

function generateToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── Roles & access ──────────────────────────────────────────────────────────
// Sessions and role storage live in ./workerRoles; this section keeps the
// route-level access decisions.

/** Left out by the workspace's plan: closed to everyone, admins included. */
const sectionOff = (ctx: Ctx, section: SectionId): boolean => !!ctx.env.SECTIONS_OFF?.includes(section);

/** A role that no longer exists grants nothing. */
async function sessionCan(ctx: Ctx, session: SessionData, section: SectionId, level: AccessLevel): Promise<boolean> {
  if (sectionOff(ctx, section)) return false;
  if (session.role === ADMIN_ROLE_ID) return true;
  return atLeast(permissionsFor(await getRoles(ctx.env.VAYU_KV), session.role)[section], level);
}

/** Public user plus what the app needs to decide what to show. */
async function withAccess(ctx: Ctx, user: StoredUser): Promise<PublicUser & { roleName: string; permissions: Permissions; sectionsOff: SectionId[] }> {
  const roles = await getRoles(ctx.env.VAYU_KV);
  const sectionsOff = ctx.env.SECTIONS_OFF ?? [];
  return {
    ...stripPassword(user),
    roleName: roles.find(r => r.id === user.role)?.name || 'No role',
    permissions: withoutSections(permissionsFor(roles, user.role), sectionsOff),
    // Admins' permissions are "everything" on the app's side; this tells it what the plan leaves out.
    sectionsOff,
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
/** Attendance: your own check-in/out and history need "view"; managing the team and stores needs "edit". */
const ATTENDANCE_OWN = new Set(['/attendance/me', '/attendance/check-in', '/attendance/check-out']);
const ATTENDANCE_OWN_READS = new Set(['/attendance/stores', '/attendance/records']);

type AccessEntry =
  | { prefixes: string[]; section: SectionId; readableBy?: SectionId[] }
  | { prefixes: string[]; rule: (path: string, method: string) => AccessRule | null };

/**
 * Route prefixes and the section that guards them; the first match wins, so
 * a longer prefix comes before a shorter one. `readableBy`: other sections
 * whose screens read this data too. A few routes have a rule of their own.
 */
const ACCESS_TABLE: AccessEntry[] = [
  // Collections, catalogs, inquiries, invoices and sales all show artworks.
  { prefixes: ['/artworks'], section: 'inventory', readableBy: ['collections', 'catalogs', 'inquiries', 'invoices', 'sales'] },
  { prefixes: ['/collections'], section: 'collections' },
  // Staff roster: asking for (or withdrawing) your own leave only needs
  // "view"; deciding on leave and everything else that changes it, "edit".
  { prefixes: ['/staff-roster/leaves'], rule: (_path, method) => ({ section: 'schedule', level: method === 'PATCH' ? 'edit' : 'view' }) },
  { prefixes: ['/staff-roster'], section: 'schedule' },
  { prefixes: ['/catalogs'], section: 'catalogs' },
  // Private viewing rooms are shared catalogs. (/viewing/:token is the
  // client's side: no account, checked by its own handlers.)
  { prefixes: ['/viewing-rooms'], section: 'catalogs' },
  { prefixes: ['/contacts'], section: 'contacts', readableBy: ['inquiries', 'invoices', 'payments'] },
  { prefixes: ['/inquiries', '/inquiry-messages'], section: 'inquiries' },
  { prefixes: ['/invoices'], section: 'invoices' },
  { prefixes: ['/payments/webhook'], rule: () => null }, // Razorpay calls this, no session
  { prefixes: ['/payments'], section: 'payments' },
  { prefixes: ['/sales'], section: 'sales' },
  { prefixes: ['/events', '/holidays'], section: 'calendar' },
  { prefixes: ['/conversations', '/messages'], section: 'messages' },
  { prefixes: ['/activity-logs'], rule: (_path, method) => (method === 'GET' ? { section: 'activity', level: 'view' } : null) },
  {
    prefixes: ['/attendance'],
    rule: (path, method) => {
      const own = ATTENDANCE_OWN.has(path) || (method === 'GET' && ATTENDANCE_OWN_READS.has(path));
      return { section: 'attendance', level: own ? 'view' : 'edit' };
    },
  },
];

function accessRule(path: string, method: string): AccessRule | null {
  const under = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`);
  const entry = ACCESS_TABLE.find(e => e.prefixes.some(under));
  if (!entry) return null;
  if ('rule' in entry) return entry.rule(path, method);
  const read = method === 'GET';
  return { section: entry.section, level: read ? 'view' : 'edit', readableBy: read ? entry.readableBy : undefined };
}

/** Router gate: a 403 response when the caller's role doesn't allow this route. */
async function checkAccess(ctx: Ctx): Promise<Response | null> {
  const rule = accessRule(ctx.path, ctx.method);
  if (!rule) return null;
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return null; // handlers answer 401 themselves
  if (sectionOff(ctx, rule.section)) {
    return json({ error: "This workspace's plan doesn't include this. Ask the owner about upgrading.", code: 'module_off' }, 403);
  }
  if (session.role === ADMIN_ROLE_ID) return null;
  const perms = withoutSections(permissionsFor(await getRoles(ctx.env.VAYU_KV), session.role), ctx.env.SECTIONS_OFF);
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
  return runSetupOnce(db, 'catalogsColumns', () => (async () => {
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
  await Promise.allSettled(subs.map(async ({ key, sub }) => {
    try {
      // Addressed to its person: a device now signed in as someone else (or
      // signed out) does not show it (sw.js).
      const body = JSON.stringify({ ...payload, data: { ...payload.data, to: sub.userId } });
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

/** The people among these who still have an account here, with their role. */
async function currentMembers(env: Env, userIds: Iterable<string>): Promise<Map<string, string>> {
  const roles = new Map<string, string>();
  await Promise.all([...new Set(userIds)].map(async id => {
    const raw = await env.VAYU_KV.get(`auth:user:${id}`);
    if (raw) roles.set(id, (JSON.parse(raw) as StoredUser).role);
  }));
  return roles;
}

/** These people's devices; someone removed from the team gets nothing. */
async function sendPushToUsers(env: Env, userIds: string[], payload: PushPayload): Promise<void> {
  const members = await currentMembers(env, userIds);
  const subs: Array<{ key: string; sub: StoredPushSubscription }> = [];
  for (const userId of members.keys()) {
    subs.push(...await collectSubs(env, `push:sub:${userId}:`));
  }
  await deliverPush(env, subs, payload);
}

/**
 * Everyone whose role can see `section` (inquiries, payments), except one
 * person. It used to go to every subscribed device, so people without
 * access to inquiries or payments were told about them too.
 */
async function sendPushToSection(env: Env, section: SectionId, exceptUserId: string, payload: PushPayload): Promise<void> {
  const all = await collectSubs(env, 'push:sub:');
  const members = await currentMembers(env, all.map(({ sub }) => sub.userId));
  const chosen = new Set(sectionRecipients(all.map(({ sub }) => sub), members, await getRoles(env.VAYU_KV), section, exceptUserId));
  await deliverPush(env, all.filter(({ sub }) => chosen.has(sub)), payload);
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
    await sendPushToSection(env, 'inquiries', senderId, {
      title: `${senderName} — ${label}`,
      body: attachmentPreviewText(msg),
      tag: `inquiry-${msg.inquiryId}`,
      data: { view: 'inquiry', inquiryId: msg.inquiryId, chat: true },
    });
  } catch (e) {
    console.error('Push notify (inquiry message) failed:', e);
  }
}

/** Notify the rest of the team when a new inquiry is logged. */
async function notifyNewInquiry(env: Env, inq: any, session: SessionData): Promise<void> {
  try {
    const customerSuffix = inq.customerName ? ` — ${inq.customerName}` : '';
    await sendPushToSection(env, 'inquiries', session.userId, {
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
  // …and in every other organization too: each keeps its own list, so a
  // phone that moved to another workspace (or another person signed in
  // there) used to go on getting the old one's notifications.
  await claimPushDevice(ctx.env, id, session.userId);
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
  await releasePushDevice(ctx.env, id, session.userId);
  return json({ success: true });
}

/** Where this request's push subscriptions live in the shared KV: an organization's own slice, or the top level. */
function pushScope(env: Env): string {
  return env.ORG_STORAGE === 'own' && env.ORG_ID ? orgKvPrefix(env.ORG_ID) : '';
}

/**
 * Records that this device now belongs to this person in this workspace,
 * and removes the device from whoever held it before, wherever that was.
 */
async function claimPushDevice(env: Env, deviceId: string, userId: string): Promise<void> {
  const shared = env.SHARED_KV ?? env.VAYU_KV;
  const ownerKey = `push:owner:${deviceId}`;
  const scope = pushScope(env);
  const raw = await shared.get(ownerKey);
  const stale = staleRegistration(raw ? JSON.parse(raw) as PushOwner : null, { scope, userId }, deviceId);
  if (stale) await shared.delete(stale);
  await shared.put(ownerKey, JSON.stringify({ scope, userId } satisfies PushOwner));
}

/** Signed out, or notifications turned off: the device belongs to no one. */
async function releasePushDevice(env: Env, deviceId: string, userId: string): Promise<void> {
  const shared = env.SHARED_KV ?? env.VAYU_KV;
  const ownerKey = `push:owner:${deviceId}`;
  const raw = await shared.get(ownerKey);
  const owner = raw ? JSON.parse(raw) as PushOwner : null;
  if (owner && owner.scope === pushScope(env) && owner.userId === userId) await shared.delete(ownerKey);
}

// ── Razorpay payment links ──────────────────────────────────────────────────
// Links are created via the Razorpay Payment Links API and tracked in KV
// under `payment:link:<plinkId>`. Which Razorpay account creates them is
// chosen in the control centre (appRazorpayAccount): an organization's own
// account, or the shared one. When a link is paid, that account's webhook
// arrives (the shared account's at POST /payments/webhook, an organization's
// at /api/v2/webhooks/razorpay/<orgId>); we verify its signature, mark the
// record paid and push-notify the whole team (applyPaymentLinkEvent).

type PaymentMode = 'test' | 'live';

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
  /** The Razorpay account it was created in: an organization id, or 'shared'. */
  account?: string;
  /** The organization it belongs to (null: the original app, before organizations). Set on links made since the 2026-09 hardening. */
  orgId?: string | null;
  /**
   * Test or live, from the keys it was made with. Missing on older links
   * until a status check with that account's keys proves which (a test key
   * can't read live links and the other way round); until then it counts as
   * unknown and stays out of live totals.
   */
  mode?: PaymentMode;
  currency?: string;
  /** "rzp_live_…WXYZ": which key made it, for audits. */
  keyIdHint?: string;
  /** Razorpay's reference_id: unique per request (idempotency), used to find a link whose creation answer was lost. */
  referenceId?: string;
  /** The proforma invoice it collects against, if any. */
  invoiceId?: string;
  /** What was approved when it was made (amount, invoice totals, any override and who made it). Never changed afterwards. */
  approved?: ApprovedAmount;
  /** What customers have paid on it, in paise (Razorpay's amount_paid). */
  amountPaid?: number;
  /** Consecutive failed status checks (the scheduled job backs off). */
  checkFailures?: number;
  /** Last time its refunds were asked of Razorpay. */
  refundsCheckedAt?: number;
  /** When the link stops accepting payment (Razorpay's expire_by); unset: Razorpay's default. */
  expiresAt?: number;
  /** Last time the app asked Razorpay for this link's status (see reconcilePaymentLinks). */
  checkedAt?: number;
  /** What Razorpay recorded for each payment on the link, as last fetched (see /details). */
  payments?: PaymentDetail[];
}

/** Links that can still be paid. */
const OPEN_LINK_STATUSES = new Set(['created', 'partially_paid']);
/** Razorpay wants expire_by at least 15 minutes ahead; the app offers up to six months. */
const MIN_LINK_VALIDITY_MS = 20 * 60_000;
const MAX_LINK_VALIDITY_MS = 180 * 86_400_000;

/** A requested expiry: undefined when none was asked for, null when it is out of range. */
function parseLinkExpiry(value: unknown): number | null | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const at = Number(value);
  const ahead = at - Date.now();
  if (!Number.isFinite(at) || ahead < MIN_LINK_VALIDITY_MS || ahead > MAX_LINK_VALIDITY_MS) return null;
  return Math.floor(at);
}

/**
 * The keys of the Razorpay account a link was made in — needed to cancel it,
 * change it or read its status. Links from before accounts were recorded
 * were all made in the shared account.
 */
async function linkAccountKeys(env: Env, link: Pick<StoredPaymentLink, 'account' | 'mode'>): Promise<{ keyId: string; keySecret: string; mode: PaymentMode | null } | null> {
  const account = link.account;
  let keys: { keyId: string; keySecret: string; mode: PaymentMode | null } | null = null;
  if (!account || account === 'shared') {
    keys = env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET ? { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET, mode: keyMode(env.RAZORPAY_KEY_ID) } : null;
  } else if (env.PLATFORM_DB) {
    try {
      keys = await razorpayCredentials(env, env.PLATFORM_DB, account);
    } catch (e) {
      console.error(JSON.stringify({ event: 'payment_keys_unavailable', account: account.slice(0, 64), reason: (e as Error).name }));
      keys = null;
    }
  }
  // The account's keys now are for the other mode (test keys replaced by
  // live ones, say): they can't see this link, and must not be used as if
  // they could. The link keeps its mode and account.
  if (keys && link.mode && keys.mode && keys.mode !== link.mode) return null;
  return keys;
}

/**
 * An older link's mode, proven by reading it with its account's keys: test
 * and live are separate at Razorpay, so a successful read settles it.
 */
function noteProvenMode(link: StoredPaymentLink, keys: { mode: PaymentMode | null }): void {
  if (!link.mode && keys.mode) link.mode = keys.mode;
}

/** One payment, from Razorpay's Payments API, with the given account's keys. */
async function razorpayPayment(env: Env, keys: { keyId: string; keySecret: string }, paymentId: string): Promise<any | null> {
  const res = await fetch(`${razorpayApiBase(env)}/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { 'Authorization': basicAuthHeader(keys.keyId, keys.keySecret) },
  });
  return res.ok ? res.json().catch(() => null) : null;
}

/** One Razorpay Payment Links API call with the given account's keys. */
async function razorpayLinkCall(
  env: Env, keys: { keyId: string; keySecret: string }, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown,
): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(`${razorpayApiBase(env)}/v1/payment_links${path}`, {
    method,
    headers: { 'Authorization': basicAuthHeader(keys.keyId, keys.keySecret), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/** Copy Razorpay's view of a link onto the record; true when the status changed to paid. */
function applyRazorpayLinkState(record: StoredPaymentLink, entity: any): boolean {
  const wasPaid = record.status === 'paid';
  if (typeof entity?.status === 'string') record.status = entity.status;
  if (Number(entity?.expire_by) > 0) record.expiresAt = Number(entity.expire_by) * 1000;
  if (Number.isSafeInteger(entity?.amount_paid) && entity.amount_paid >= 0) record.amountPaid = entity.amount_paid;
  const payment = Array.isArray(entity?.payments) ? entity.payments.find((p: any) => p?.status === 'captured') ?? entity.payments[0] : null;
  if (record.status === 'paid' && payment) {
    record.paidAt ??= Number(payment.created_at) > 0 ? Number(payment.created_at) * 1000 : Date.now();
    record.paymentId ||= payment.payment_id || '';
    record.paymentMethod ||= payment.method || '';
  }
  return !wasPaid && record.status === 'paid';
}

/** A Razorpay key id's mode, or null when it isn't a Razorpay key id. */
function keyMode(keyId: string | undefined): PaymentMode | null {
  const m = /^rzp_(test|live)_/.exec(keyId ?? '');
  return m ? m[1] as PaymentMode : null;
}

/** The account a new payment link is made in, or why none may be. */
type LinkAccount = {
  keyId: string; keySecret: string;
  /** 'shared' (the original business, before organizations) or the organization id. */
  account: string; orgId: string | null;
  mode: PaymentMode;
  /** Test-mode links are allowed for this account in this environment. */
  testAllowed: boolean;
};
type LinkAccountRefusal = { error: string; code: string; status: number };

/** Local development and tests: test-mode keys need no extra permission there. */
const isDevelopment = (env: Env) => env.PLATFORM_ENV === 'development';

/**
 * The Razorpay account a NEW payment link is made in. Explicit, never chosen
 * by a global setting:
 *   - a request for an organization (/api/o/<org>/…): that organization's own
 *     verified account, and nothing else, whichever storage it uses;
 *   - the original app on its own (/api, no organization): only the shared
 *     account in the RAZORPAY_* secrets, and only while LEGACY_PAYMENT_LINKS
 *     is on (docs/PAYMENT_SECURITY.md has the cutoff).
 * A business's money must never land in another business's account, so
 * there is no fallback from one to the other.
 */
async function linkAccountFor(env: Env): Promise<LinkAccount | LinkAccountRefusal> {
  if (env.ORG_ID) {
    const own = env.PLATFORM_DB ? await verifiedRazorpayKeys(env, env.PLATFORM_DB, env.ORG_ID) : null;
    if (!own) {
      return { status: 503, code: 'account_not_ready', error: "This business's Razorpay account isn't connected and verified yet. Ask us to connect it; no payment link was created." };
    }
    return {
      keyId: own.keyId, keySecret: own.keySecret, account: env.ORG_ID, orgId: env.ORG_ID, mode: own.mode,
      testAllowed: isDevelopment(env) || own.allowTestLinks,
    };
  }
  if (env.LEGACY_PAYMENT_LINKS !== 'on') {
    return { status: 410, code: 'legacy_route_retired', error: 'Payment links are now made from your workspace. Sign out, sign in with your workspace account, and try again.' };
  }
  const mode = keyMode(env.RAZORPAY_KEY_ID);
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET || !mode) {
    return { status: 503, code: 'account_not_ready', error: 'Razorpay is not configured. Ask your admin to set the RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET secrets.' };
  }
  return {
    keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET, account: 'shared', orgId: null, mode,
    testAllowed: isDevelopment(env) || env.SHARED_RAZORPAY_ALLOW_TEST === 'on',
  };
}

function formatRupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function basicAuthHeader(username: string, password: string): string {
  const credentials = btoa(`${username}:${password}`);
  return `Basic ${credentials}`;
}

/** GET /plan — the organization's plan and its usage of each limit (admins; Admin → Plan). */
async function handlePlanUsage(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  if (session.role !== ADMIN_ROLE_ID) return err('Forbidden', 403);
  // The original app on its own (no organization) has no plan.
  if (ctx.env.ORG_ID) await ensureInvoicesTable(ctx.env.VAYU_DB).catch(() => undefined);
  return json((await planAndUsage(ctx.env)) ?? { plan: null, usage: [] });
}

// ── Plan payments (Admin → Plan → Upgrade) ─────────────────────────────────
// The organization pays the platform for its plan, into the platform's own
// Razorpay account (platform/billing.ts). Owners and admins only; reachable
// even when the plan has lapsed, so a blocked workspace can pay to reopen.

async function billingCaller(ctx: Ctx): Promise<{ session: SessionData; db: D1Database; orgId: string } | Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  if (!ctx.env.ORG_ID || !ctx.env.PLATFORM_DB) return err('This workspace has no plan to pay for.', 404);
  if (session.orgRole !== 'owner' && session.orgRole !== 'admin') {
    return json({ error: "Only the workspace's owners and admins can change or pay for the plan.", code: 'billing_forbidden' }, 403);
  }
  return { session, db: ctx.env.PLATFORM_DB, orgId: ctx.env.ORG_ID };
}

/** Runs a billing call, turning its refusals into the app's error shape. */
async function billingReply(work: () => Promise<unknown>, status = 200): Promise<Response> {
  try {
    return json(await work(), status);
  } catch (e) {
    if (e instanceof OrgError) return json({ error: e.message, code: e.code }, e.status);
    throw e;
  }
}

function reconciledReply(out: Reconciled) {
  if (out.applied) forgetPlanActive(out.payment.org_id);
  return { payment: paymentView(out.payment, 'org'), checked: out.checked, applied: out.applied, reason: out.reason ?? null };
}

/** GET /billing — plans that can be paid for, and this workspace's plan payments. */
async function handleBillingGet(ctx: Ctx): Promise<Response> {
  const caller = await billingCaller(ctx);
  if (caller instanceof Response) return caller;
  return billingReply(async () => ({
    ...await billingOptions(ctx.env, caller.db, caller.orgId),
    orgName: await orgNameOf(caller.db, caller.orgId),
    payments: await listOrgPayments(caller.db, caller.orgId),
  }));
}

/** POST /billing/checkout { planKey, period } — a Razorpay order to open the checkout with. */
async function handleBillingCheckout(ctx: Ctx): Promise<Response> {
  const caller = await billingCaller(ctx);
  if (caller instanceof Response) return caller;
  const body = await ctx.request.json<Record<string, unknown>>().catch(() => ({}));
  const { session } = caller;
  return billingReply(() => startCheckout(ctx.env, caller.db, caller.orgId, body, {
    userId: session.platformUserId ?? session.userId, name: session.name, email: session.email,
    ip: ctx.request.headers.get('cf-connecting-ip'),
  }), 201);
}

/** POST /billing/confirm — Razorpay checkout's signed result; the plan changes once Razorpay agrees. */
async function handleBillingConfirm(ctx: Ctx): Promise<Response> {
  const caller = await billingCaller(ctx);
  if (caller instanceof Response) return caller;
  const body = await ctx.request.json<Record<string, unknown>>().catch(() => ({}));
  return billingReply(async () => reconciledReply(await confirmCheckout(ctx.env, caller.db, caller.orgId, body)));
}

const BILLING_RECHECK_PATH = /^\/billing\/payments\/([A-Za-z0-9-]{1,64})\/recheck$/;

/** POST /billing/payments/:id/recheck — ask Razorpay again about one plan payment. */
async function handleBillingRecheck(ctx: Ctx): Promise<Response> {
  const caller = await billingCaller(ctx);
  if (caller instanceof Response) return caller;
  const id = BILLING_RECHECK_PATH.exec(ctx.path)?.[1] ?? '';
  return billingReply(async () => reconciledReply(await recheckOrgPayment(ctx.env, caller.db, caller.orgId, id)));
}

/** A refusal as the API's usual error shape, with a machine-readable code. */
const refuse = (r: { error: string; code: string; status: number }) => json({ error: r.error, code: r.code }, r.status);

/**
 * This workspace's payment-link requests by idempotency key: a double click,
 * a retry after a timeout, or two tabs sending the same request make one
 * link, not several.
 */
function ensurePaymentLinkRequests(db: D1Database): Promise<void> {
  return runSetupOnce(db, 'paymentLinkRequests', () => db.prepare(`
      CREATE TABLE IF NOT EXISTS payment_link_requests (
        scope TEXT NOT NULL,
        idem_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        reference_id TEXT NOT NULL,
        status TEXT NOT NULL,
        link_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, idem_key)
      )
    `).run());
}

/** Every payment link stored for this workspace. */
async function storedLinks(ctx: Ctx): Promise<StoredPaymentLink[]> {
  const list = await ctx.env.VAYU_KV.list({ prefix: 'payment:link:' });
  const links: StoredPaymentLink[] = [];
  for (const key of list.keys) {
    const raw = await ctx.env.VAYU_KV.get(key.name);
    if (raw) links.push(JSON.parse(raw));
  }
  return links;
}

/** The immutable record of what was approved when a link was made. */
interface ApprovedAmount {
  amountPaise: number;
  currency: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  invoiceTotalPaise: number | null;
  taxRate: number | null;
  taxPaise: number | null;
  outstandingBeforePaise: number | null;
  settlesInFull: boolean;
  override: { kind: OverrideKind; reason: string } | null;
  approvedBy: string;
  approvedByName: string;
  approvedAt: number;
}

interface LinkRequestBody {
  amountPaise?: unknown; amount?: unknown; currency?: unknown; description?: string;
  customerName?: string; customerPhone?: string; customerEmail?: string;
  notifySms?: boolean; notifyEmail?: boolean;
  /** When the link stops accepting payment (ms); omitted: Razorpay's default. */
  expiresAt?: number;
  /** 'test' confirms a test-mode link (refused for live accounts). */
  mode?: unknown;
  /** Pay against this proforma invoice: the amount defaults to what's outstanding. */
  invoiceId?: unknown;
  /** With invoiceId: this (smaller) amount settles the invoice. An override. */
  settlesInFull?: unknown;
  overrideReason?: unknown;
}

/**
 * The amount for a new link, worked out on the server: for an invoice, from
 * the invoice's own items and tax and what is still outstanding; otherwise
 * the amount asked for. Overrides (more than outstanding, or a discount)
 * need the workspace admin role and a reason.
 */
/** This workspace's invoice and its recomputed totals (another business's invoice isn't in this database). */
async function linkInvoice(ctx: Ctx, invoiceId: unknown): Promise<{ id: string; invoice: InvoiceLike; totals: InvoiceTotals } | Response> {
  const notFound = json({ error: 'Invoice not found', code: 'invoice_not_found' }, 404);
  if (typeof invoiceId !== 'string' || invoiceId.length > 128) return notFound;
  await ensureInvoicesTable(ctx.env.VAYU_DB);
  const row = await ctx.env.VAYU_DB.prepare('SELECT data FROM invoices WHERE id = ?').bind(invoiceId).first<{ data: string }>();
  let invoice: InvoiceLike | null = null;
  try { invoice = row ? JSON.parse(row.data) as InvoiceLike : null; } catch { invoice = null; }
  if (!invoice) return notFound;
  if (invoice.status === 'Paid') return json({ error: 'This invoice is already marked paid.', code: 'invoice_paid' }, 409);
  const totals = invoiceTotals(invoice);
  if (!totals) return json({ error: "This invoice's total doesn't match its items and tax. Open it, check it and save it again.", code: 'invoice_total_mismatch' }, 409);
  return { id: invoiceId, invoice, totals };
}

/** An override's record, or why it isn't allowed: workspace admins only, with a reason. */
function approveOverride(session: SessionData, kind: OverrideKind, reasonText: unknown): { kind: OverrideKind; reason: string } | Response {
  if (session.role !== ADMIN_ROLE_ID) {
    const what = kind === 'above_outstanding' ? 'more than is outstanding' : 'less than the invoice as full settlement';
    return json({ error: `Only a workspace admin can ask for ${what}.`, code: 'override_forbidden' }, 403);
  }
  const reason = overrideReason(reasonText);
  if (!reason) return json({ error: 'Give a reason for the change (at least 5 characters); it is kept with the link.', code: 'override_reason_required' }, 400);
  return { kind, reason };
}

const noInvoice = { invoiceId: null, invoiceNumber: null, invoiceTotalPaise: null, taxRate: null, taxPaise: null, outstandingBeforePaise: null, settlesInFull: false, override: null };

/**
 * The amount for a new link, worked out on the server: for an invoice, from
 * the invoice's own items and tax and what is still outstanding; otherwise
 * the amount asked for. Overrides (more than outstanding, or a discount)
 * need the workspace admin role and a reason.
 */
async function approveAmount(ctx: Ctx, session: SessionData, body: LinkRequestBody, mode: PaymentMode): Promise<ApprovedAmount | Response> {
  if (body.currency !== undefined && body.currency !== CURRENCY) return json({ error: 'Payment links are in rupees (INR) only.', code: 'unsupported_currency' }, 400);
  const asked = requestedPaise(body);
  if (asked.problem) return json(asked.problem, 400);
  const base = { currency: CURRENCY, approvedBy: session.userId, approvedByName: session.name, approvedAt: Date.now() };
  const settlesInFull = body.settlesInFull === true;
  if (body.invoiceId === undefined || body.invoiceId === null || body.invoiceId === '') {
    if (asked.paise === null) return json({ error: 'Enter the amount.', code: 'invalid_amount' }, 400);
    if (settlesInFull) return json({ error: 'Only a link for an invoice can settle it.', code: 'invalid_request' }, 400);
    return { ...base, ...noInvoice, amountPaise: asked.paise };
  }
  const found = await linkInvoice(ctx, body.invoiceId);
  if (found instanceof Response) return found;
  const { totals } = found;
  const outstanding = outstandingPaise(totals.totalPaise, found.id, await storedLinks(ctx), mode);
  const paise = asked.paise ?? outstanding;
  if (paise === 0) return json({ error: 'Nothing is outstanding on this invoice: its links already cover the total.', code: 'nothing_outstanding' }, 409);
  const kind = overrideNeeded(paise, outstanding, settlesInFull);
  const override = kind ? approveOverride(session, kind, body.overrideReason) : null;
  if (override instanceof Response) return override;
  return {
    ...base, amountPaise: paise, invoiceId: found.id, invoiceNumber: typeof found.invoice.invoiceNumber === 'string' ? found.invoice.invoiceNumber : null,
    invoiceTotalPaise: totals.totalPaise, taxRate: totals.taxRate, taxPaise: totals.taxPaise, outstandingBeforePaise: outstanding, settlesInFull, override,
  };
}

/** The link Razorpay made for a reference, if it made one. */
async function linkByReference(env: Env, keys: { keyId: string; keySecret: string }, referenceId: string): Promise<any | null> {
  const res = await razorpayLinkCall(env, keys, 'GET', `?reference_id=${encodeURIComponent(referenceId)}`).catch(() => null);
  if (!res?.ok) return null;
  const found = (Array.isArray(res.data?.payment_links) ? res.data.payment_links : []) as { reference_id?: string }[];
  return found.find(l => l?.reference_id === referenceId) ?? null;
}

type Claim = { kind: 'go' } | { kind: 'done'; linkId: string } | { kind: 'refused'; response: Response };

/** Takes the idempotency key for this request, or says why not / what it already made. */
async function claimLinkRequest(db: D1Database, scope: string, key: string, fingerprint: string, referenceId: string): Promise<Claim> {
  await ensurePaymentLinkRequests(db);
  const now = Date.now();
  const inserted = await db.prepare(
    `INSERT INTO payment_link_requests (scope, idem_key, fingerprint, reference_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT DO NOTHING`,
  ).bind(scope, key, fingerprint, referenceId, now, now).run();
  if ((inserted.meta?.changes ?? 0) > 0) return { kind: 'go' };
  const existing = await db.prepare('SELECT fingerprint, status, link_id, updated_at FROM payment_link_requests WHERE scope = ? AND idem_key = ?')
    .bind(scope, key).first<{ fingerprint: string; status: string; link_id: string | null; updated_at: number }>();
  if (!existing) return { kind: 'go' };
  if (existing.fingerprint !== fingerprint) {
    return { kind: 'refused', response: json({ error: 'This request key was already used for a different payment link.', code: 'idempotency_key_reused' }, 422) };
  }
  if (existing.status === 'done' && existing.link_id) return { kind: 'done', linkId: existing.link_id };
  if (existing.status === 'pending' && now - existing.updated_at < 60_000) {
    return { kind: 'refused', response: json({ error: 'This payment link is still being made. Wait a moment.', code: 'request_in_progress' }, 409) };
  }
  // An earlier attempt failed or was cut off: take it over (only one taker wins).
  const retaken = await db.prepare(
    "UPDATE payment_link_requests SET status = 'pending', updated_at = ? WHERE scope = ? AND idem_key = ? AND updated_at = ?",
  ).bind(now, scope, key, existing.updated_at).run();
  return (retaken.meta?.changes ?? 0) > 0
    ? { kind: 'go' }
    : { kind: 'refused', response: json({ error: 'This payment link is still being made. Wait a moment.', code: 'request_in_progress' }, 409) };
}

const finishLinkRequest = (db: D1Database, scope: string, key: string, linkId: string | null) =>
  db.prepare('UPDATE payment_link_requests SET status = ?, link_id = ?, updated_at = ? WHERE scope = ? AND idem_key = ?')
    .bind(linkId ? 'done' : 'failed', linkId, Date.now(), scope, key).run();

/**
 * Makes the link at Razorpay with a reference unique to this request. When
 * the answer is lost (timeout, network, a 5xx) or Razorpay says the
 * reference was already used, the link is looked up by that reference
 * instead of being made again.
 */
async function createAtRazorpay(env: Env, account: LinkAccount, payload: Record<string, unknown>, referenceId: string): Promise<{ entity: any } | { error: string; status: number }> {
  let res: Response | null = null;
  try {
    res = await fetch(`${razorpayApiBase(env)}/v1/payment_links`, {
      method: 'POST',
      headers: { 'Authorization': basicAuthHeader(account.keyId, account.keySecret), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, reference_id: referenceId }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    res = null;
  }
  const data = res ? await res.json().catch(() => ({})) as any : null;
  if (res?.ok && data?.id) return { entity: data };
  const description = String(data?.error?.description ?? '');
  const ambiguous = !res || res.status >= 500 || /reference/i.test(description);
  if (ambiguous) {
    const found = await linkByReference(env, account, referenceId);
    if (found?.id) return { entity: found };
    return { status: 502, error: "Razorpay didn't confirm the link. Try again: the same request won't make a second link." };
  }
  return { status: 502, error: description || `Razorpay error (${res?.status ?? 'no answer'})` };
}

/**
 * GET /payments/account — which account new links are made in and its mode,
 * so the Payments screen can say so before anyone makes a link. Never a key.
 */
async function handlePaymentAccount(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const account = await linkAccountFor(ctx.env);
  if ('error' in account) return json({ ready: false, code: account.code, error: account.error });
  return json({
    ready: account.mode === 'live' || account.testAllowed,
    account: account.orgId ? 'organization' : 'shared',
    mode: account.mode,
    testAllowed: account.testAllowed,
    keyIdHint: maskKeyId(account.keyId),
  });
}

/** The customer, description and validity of a new link, checked. */
function linkDetails(body: LinkRequestBody): { customer: Record<string, string>; description: string; expiresAt: number | undefined } | Response {
  if (!body.customerName?.trim()) return err('Customer name is required');
  const expiresAt = parseLinkExpiry(body.expiresAt);
  if (expiresAt === null) return err('The link must stay valid for at least 20 minutes and at most 6 months');
  const customer: Record<string, string> = { name: body.customerName.trim().slice(0, 100) };
  if (body.customerPhone?.trim()) customer.contact = body.customerPhone.trim().slice(0, 20);
  if (body.customerEmail?.trim()) customer.email = body.customerEmail.trim().slice(0, 120);
  return { customer, description: body.description?.trim().slice(0, 240) || '', expiresAt };
}

/** Null to go ahead and make the link; otherwise the answer (the link made earlier, or a refusal). */
async function replayOrClaim(ctx: Ctx, scope: string, key: string, fingerprint: string, referenceId: string): Promise<Response | null> {
  const claim = await claimLinkRequest(ctx.env.VAYU_DB, scope, key, fingerprint, referenceId);
  if (claim.kind === 'refused') return claim.response;
  if (claim.kind === 'done') {
    const raw = await ctx.env.VAYU_KV.get(`payment:link:${claim.linkId}`);
    if (raw) return json({ ...JSON.parse(raw), replayed: true }, 200);
  }
  return null;
}

/** What Razorpay is asked to make: the approved amount, the customer, and how long it stays valid. */
function razorpayLinkPayload(approved: ApprovedAmount, body: LinkRequestBody, details: { customer: Record<string, string>; description: string; expiresAt: number | undefined }, createdBy: string): Record<string, unknown> {
  const { customer, description, expiresAt } = details;
  const notes: Record<string, string> = { created_by: createdBy.slice(0, 100), app: 'vayu-webapp' };
  if (approved.invoiceNumber) notes.invoice = approved.invoiceNumber.slice(0, 100);
  return {
    amount: approved.amountPaise,
    currency: CURRENCY,
    description: description || 'Payment',
    customer,
    notify: { sms: !!body.notifySms && !!customer.contact, email: !!body.notifyEmail && !!customer.email },
    reminder_enable: true,
    ...(expiresAt ? { expire_by: Math.floor(expiresAt / 1000) } : {}),
    notes,
  };
}

/** The activity entries for a new link, and a separate one for an override with its reason. */
async function logLinkCreated(ctx: Ctx, session: SessionData, record: StoredPaymentLink, approved: ApprovedAmount): Promise<void> {
  const testNote = record.mode === 'test' ? ' (TEST mode)' : '';
  const invoiceNote = approved.invoiceNumber ? ` against invoice ${approved.invoiceNumber}` : '';
  await logActivity(ctx.env.VAYU_DB, session.userId, session.name, 'created', 'payment link', record.id,
    `Created payment link of ${formatRupees(approved.amountPaise)} for "${record.customerName}"${invoiceNote}${testNote}`);
  if (approved.override) {
    await logActivity(ctx.env.VAYU_DB, session.userId, session.name, 'updated', 'payment link', record.id,
      `Amount override (${approved.override.kind === 'above_outstanding' ? 'more than outstanding' : 'settles for less'}): ${formatRupees(approved.amountPaise)} of ${formatRupees(approved.outstandingBeforePaise ?? 0)} outstanding. Reason: ${approved.override.reason}`);
  }
}

/**
 * POST /payments/link — a payment link, in the account this request is
 * attributed to (linkAccountFor), for an amount the server has approved
 * (approveAmount), at most once per Idempotency-Key.
 */
async function handlePaymentLinkCreate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json<LinkRequestBody>().catch(() => null);
  if (!body || typeof body !== 'object') return err('Invalid request');

  const account = await linkAccountFor(ctx.env);
  if ('error' in account) return refuse(account);
  const modeRefusal = testModeRefusal(account, body.mode);
  if (modeRefusal) return refuse(modeRefusal);

  const approved = await approveAmount(ctx, session, body, account.mode);
  if (approved instanceof Response) return approved;
  const bounds = amountProblem(approved.amountPaise, maxPaise(ctx.env.PAYMENT_LINK_MAX_PAISE));
  if (bounds) return json(bounds, 400);
  const details = linkDetails(body);
  if (details instanceof Response) return details;
  const { customer, description, expiresAt } = details;

  // One link per request key: the client sends the same key when it retries.
  const scope = `${account.account}|${session.userId}`;
  const key = idempotencyKey(ctx.request.headers.get('Idempotency-Key')) ?? crypto.randomUUID();
  const fingerprint = await requestFingerprint({
    account: account.account, mode: account.mode, amountPaise: approved.amountPaise, invoiceId: approved.invoiceId,
    settlesInFull: approved.settlesInFull, customer, description, expiresAt: expiresAt ?? null,
  });
  const referenceId = await referenceIdFor(scope, key);
  const earlier = await replayOrClaim(ctx, scope, key, fingerprint, referenceId);
  if (earlier) return earlier;

  const made = await createAtRazorpay(ctx.env, account, razorpayLinkPayload(approved, body, details, session.name), referenceId);
  if ('error' in made) {
    await finishLinkRequest(ctx.env.VAYU_DB, scope, key, null);
    return json({ error: made.error, code: 'provider_error' }, made.status);
  }

  const data = made.entity;
  const record: StoredPaymentLink = {
    id: data.id,
    shortUrl: data.short_url,
    amount: approved.amountPaise,
    description,
    customerName: customer.name,
    customerPhone: customer.contact || '',
    customerEmail: customer.email || '',
    status: data.status || 'created',
    createdAt: Date.now(),
    createdBy: session.userId,
    createdByName: session.name,
    account: account.account,
    orgId: account.orgId,
    mode: account.mode,
    currency: CURRENCY,
    keyIdHint: maskKeyId(account.keyId),
    referenceId,
    invoiceId: approved.invoiceId ?? undefined,
    approved,
    expiresAt: Number(data.expire_by) > 0 ? Number(data.expire_by) * 1000 : expiresAt,
  };
  await ctx.env.VAYU_KV.put(`payment:link:${record.id}`, JSON.stringify(record));
  await finishLinkRequest(ctx.env.VAYU_DB, scope, key, record.id);
  await logLinkCreated(ctx, session, record, approved);
  queueHubNotify(ctx, [{ entity: 'payments', id: record.id, op: 'put' }]);
  return json(record, 201);
}

// ── Refunds ─────────────────────────────────────────────────────────────────
// Kept in the workspace's own database, keyed by Razorpay's refund id and
// scoped to the account it came from. Status only moves forward: pending
// (refund.created is NOT a completed refund) → processed or failed, which are
// final. Totals count processed refunds only, from these rows.

type RefundStatus = 'pending' | 'processed' | 'failed';

function ensureRefundsTable(db: D1Database): Promise<void> {
  return runSetupOnce(db, 'paymentRefunds', () => db.prepare(`
      CREATE TABLE IF NOT EXISTS payment_refunds (
        refund_id TEXT PRIMARY KEY,
        account TEXT NOT NULL,
        payment_id TEXT NOT NULL,
        link_id TEXT,
        mode TEXT,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `).run());
}

interface RefundRow { refund_id: string; account: string; payment_id: string; link_id: string | null; mode: string | null; amount: number; currency: string; status: RefundStatus; created_at: number }

const REFUND_STATUS_BY_EVENT: Record<string, RefundStatus> = {
  'refund.created': 'pending',
  'refund.processed': 'processed',
  'refund.failed': 'failed',
};

/** A refund as Razorpay describes it, checked; null when it isn't one. */
function refundFrom(entity: any, status: RefundStatus): { id: string; paymentId: string; amount: number; currency: string; status: RefundStatus; createdAt: number } | null {
  const id = typeof entity?.id === 'string' ? entity.id : '';
  const paymentId = typeof entity?.payment_id === 'string' ? entity.payment_id : '';
  const amount = Number(entity?.amount);
  const currency = typeof entity?.currency === 'string' ? entity.currency.toUpperCase().slice(0, 3) : '';
  if (!/^rfnd_\w{6,40}$/.test(id) || !/^pay_\w{6,40}$/.test(paymentId) || !Number.isSafeInteger(amount) || amount <= 0 || currency.length !== 3) return null;
  return { id, paymentId, amount, currency, status, createdAt: Number(entity?.created_at) > 0 ? Number(entity.created_at) * 1000 : Date.now() };
}

/** Razorpay's refund status from its API ('pending' | 'processed' | 'failed'), else null. */
const apiRefundStatus = (s: unknown): RefundStatus | null => (s === 'pending' || s === 'processed' || s === 'failed' ? s : null);

/** Remembers which link a payment belongs to, so a refund can find it. */
async function indexLinkPayments(env: Env, link: StoredPaymentLink): Promise<void> {
  const ids = new Set<string>();
  if (link.paymentId) ids.add(link.paymentId);
  for (const p of link.payments ?? []) if (p.status === 'captured' || p.status === 'refunded') ids.add(p.id);
  await Promise.all([...ids].map(id => env.VAYU_KV.put(`payment:pay:${id}`, link.id)));
}

/** Saves a link, and the payment → link index. */
async function saveLink(env: Env, link: StoredPaymentLink): Promise<void> {
  await env.VAYU_KV.put(`payment:link:${link.id}`, JSON.stringify(link));
  await indexLinkPayments(env, link);
}

/** The link a payment was made on, in this workspace; older links are found by scanning. */
async function linkForPayment(env: Env, paymentId: string): Promise<StoredPaymentLink | null> {
  const linkId = await env.VAYU_KV.get(`payment:pay:${paymentId}`);
  if (linkId) {
    const raw = await env.VAYU_KV.get(`payment:link:${linkId}`);
    if (raw) return JSON.parse(raw) as StoredPaymentLink;
  }
  const list = await env.VAYU_KV.list({ prefix: 'payment:link:' });
  for (const key of list.keys) {
    const raw = await env.VAYU_KV.get(key.name);
    const link = raw ? JSON.parse(raw) as StoredPaymentLink : null;
    if (link && (link.paymentId === paymentId || link.payments?.some(p => p.id === paymentId))) return link;
  }
  return null;
}

/**
 * Records one refund (insert, or move its status forward). Atomic: one
 * statement, and a row from another account is never touched. Returns
 * whether anything changed.
 */
async function recordRefund(env: Env, account: string, refund: NonNullable<ReturnType<typeof refundFrom>>, link: StoredPaymentLink | null): Promise<'new' | 'advanced' | 'unchanged' | 'other_account'> {
  const db = env.VAYU_DB;
  await ensureRefundsTable(db);
  const before = await db.prepare('SELECT account, status FROM payment_refunds WHERE refund_id = ?').bind(refund.id).first<{ account: string; status: RefundStatus }>();
  if (before && before.account !== account) {
    console.warn(JSON.stringify({ event: 'refund_account_mismatch', refund: refund.id, account: account.slice(0, 64) }));
    return 'other_account';
  }
  const now = Date.now();
  await db.prepare(
    `INSERT INTO payment_refunds (refund_id, account, payment_id, link_id, mode, amount, currency, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(refund_id) DO UPDATE SET
       status = CASE WHEN payment_refunds.status IN ('processed', 'failed') THEN payment_refunds.status ELSE excluded.status END,
       link_id = COALESCE(payment_refunds.link_id, excluded.link_id),
       mode = COALESCE(payment_refunds.mode, excluded.mode),
       updated_at = excluded.updated_at
     WHERE payment_refunds.account = excluded.account`,
  ).bind(refund.id, account, refund.paymentId, link?.id ?? null, link?.mode ?? null, refund.amount, refund.currency, refund.status, refund.createdAt, now).run();
  if (!before) return 'new';
  const after = await db.prepare('SELECT status FROM payment_refunds WHERE refund_id = ?').bind(refund.id).first<{ status: RefundStatus }>();
  return after?.status === before.status ? 'unchanged' : 'advanced';
}

/** A verified refund.* event for this account. */
async function applyRefundEvent(ctx: Ctx, event: any, account: string): Promise<void> {
  const status = REFUND_STATUS_BY_EVENT[event?.event];
  const refund = status ? refundFrom(event?.payload?.refund?.entity, status) : null;
  if (!refund) return;
  const found = await linkForPayment(ctx.env, refund.paymentId);
  // A payment id belongs to one account; a link from another account is never matched.
  const link = found && (found.account ?? 'shared') === account ? found : null;
  const outcome = await recordRefund(ctx.env, account, refund, link);
  if (link && (outcome === 'new' || outcome === 'advanced')) queueHubNotify(ctx, [{ entity: 'payments', id: link.id, op: 'put' }]);
}

/** Any verified event for an account: payment links, or refunds. */
async function applyAccountEvent(ctx: Ctx, event: any, account: string): Promise<void> {
  if (typeof event?.event === 'string' && event.event.startsWith('refund.')) return applyRefundEvent(ctx, event, account);
  return applyPaymentLinkEvent(ctx, event, account);
}

/** Every refund in this workspace, by link id. */
async function refundsByLink(db: D1Database): Promise<Map<string, RefundRow[]>> {
  await ensureRefundsTable(db);
  const { results } = await db.prepare('SELECT * FROM payment_refunds WHERE link_id IS NOT NULL').all<RefundRow>();
  const map = new Map<string, RefundRow[]>();
  for (const r of results) map.set(r.link_id!, [...(map.get(r.link_id!) ?? []), r]);
  return map;
}

/** A link with its refunds summed: processed (refunded) and pending, in paise. */
function withRefunds(link: StoredPaymentLink, refunds: RefundRow[] | undefined) {
  if (!refunds?.length) return link;
  const sum = (s: RefundStatus) => refunds.filter(r => r.status === s && r.currency === (link.currency ?? CURRENCY)).reduce((a, r) => a + r.amount, 0);
  return { ...link, refundedPaise: sum('processed'), refundPendingPaise: sum('pending'), refunds: refunds.map(r => ({ id: r.refund_id, amount: r.amount, status: r.status, createdAt: r.created_at })) };
}

/** What a link actually collected: Razorpay's amount_paid when known, else the full amount once paid. */
const collectedPaise = (l: StoredPaymentLink): number => l.amountPaid ?? (l.status === 'paid' ? l.amount : 0);

async function handlePaymentLinksList(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const links = await storedLinks(ctx);
  links.sort((a, b) => b.createdAt - a.createdAt);
  const refunds = await refundsByLink(ctx.env.VAYU_DB);
  // Read-only: checking with Razorpay is POST /payments/links/refresh and the scheduled job.
  // Past its expiry but not yet confirmed by Razorpay: show it as expired.
  const now = Date.now();
  return json(links.map(l => withRefunds(OPEN_LINK_STATUSES.has(l.status) && l.expiresAt && l.expiresAt < now ? { ...l, status: 'expired' } : l, refunds.get(l.id))));
}

/**
 * GET /payments/summary?from=&to= (ms) — collected, refunded and net, for
 * LIVE links only, by when each was paid. Test links and links whose mode
 * isn't proven yet are counted separately, never in the money figures.
 * Collected is what customers paid; refunded is processed refunds; neither
 * is an accounting or tax figure.
 */
async function handlePaymentSummary(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const from = Number(ctx.url.searchParams.get('from')) || 0;
  const to = Number(ctx.url.searchParams.get('to')) || Number.MAX_SAFE_INTEGER;
  const summary = summarizeLinks(await storedLinks(ctx), await refundsByLink(ctx.env.VAYU_DB), from, to);
  return json({ currency: CURRENCY, from, to: to === Number.MAX_SAFE_INTEGER ? null : to, ...summary });
}

/** A link's processed and pending refunds in rupees (other currencies left out). */
function refundTotals(refunds: RefundRow[] | undefined): { processed: number; pending: number } {
  const out = { processed: 0, pending: 0 };
  for (const r of refunds ?? []) {
    if (r.currency !== CURRENCY) continue;
    if (r.status === 'processed') out.processed += r.amount;
    else if (r.status === 'pending') out.pending += r.amount;
  }
  return out;
}

/** Collected, refunded and net over live links paid in [from, to]; test and unproven links only counted. */
function summarizeLinks(links: StoredPaymentLink[], refunds: Map<string, RefundRow[]>, from: number, to: number) {
  let collected = 0; let refunded = 0; let pendingRefunds = 0; let paidCount = 0; let testLinks = 0; let unknownMode = 0;
  for (const l of links) {
    if (!l.paidAt || l.paidAt < from || l.paidAt > to || collectedPaise(l) === 0) continue;
    if (l.mode === 'test') { testLinks++; continue; }
    if (l.mode !== 'live' || (l.currency ?? CURRENCY) !== CURRENCY) { unknownMode++; continue; }
    paidCount++;
    collected += collectedPaise(l);
    const r = refundTotals(refunds.get(l.id));
    refunded += r.processed;
    pendingRefunds += r.pending;
  }
  return {
    live: { paidCount, collectedPaise: collected, refundedPaise: refunded, pendingRefundPaise: pendingRefunds, netPaise: collected - refunded },
    excluded: { testLinks, unknownMode },
  };
}

// ── Reconciliation ──────────────────────────────────────────────────────────
// Webhooks are the fast path. The scheduled job (every 10 minutes, every
// workspace) and POST /payments/links/refresh ask Razorpay about open links
// and recently paid ones (for refunds), within a budget of API calls, backing
// off from links that keep failing. Anything found that no webhook delivered
// counts as "missed" in the account's webhook health.

const MINUTE = 60_000;
const RECONCILE_CALLS_PER_RUN = 40;
const REFUND_CHECK_WINDOW_MS = 90 * 86_400_000;
const REFUND_CHECK_EVERY_MS = 24 * 3_600_000;

/** How long to wait between checks of an open link: soon after it's made, then less often, and backing off after failures. */
function checkInterval(link: StoredPaymentLink, now: number): number {
  const age = now - link.createdAt;
  let base = 6 * 60 * MINUTE;
  if (age < 86_400_000) base = 10 * MINUTE;
  else if (age < 7 * 86_400_000) base = 60 * MINUTE;
  return base * 2 ** Math.min(link.checkFailures ?? 0, 5);
}

type Outcomes = Map<string, ReconcileOutcome>;
const outcomeFor = (o: Outcomes, account: string): ReconcileOutcome => {
  let x = o.get(account);
  if (!x) { x = { checked: 0, missed: 0, failures: 0, error: null }; o.set(account, x); }
  return x;
};

/** One open link against Razorpay. True when its status changed. */
async function reconcileOpenLink(ctx: Ctx, link: StoredPaymentLink, out: ReconcileOutcome): Promise<boolean> {
  const keys = await linkAccountKeys(ctx.env, link);
  const res = keys ? await razorpayLinkCall(ctx.env, keys, 'GET', `/${encodeURIComponent(link.id)}`).catch(() => null) : null;
  link.checkedAt = Date.now();
  if (!keys || !res?.ok) {
    link.checkFailures = (link.checkFailures ?? 0) + 1;
    out.failures++;
    out.error = keys ? `link check answered ${res?.status ?? 'nothing'}` : 'account keys unavailable';
    await ctx.env.VAYU_KV.put(`payment:link:${link.id}`, JSON.stringify(link));
    return false;
  }
  out.checked++;
  link.checkFailures = 0;
  const before = `${link.status}|${link.expiresAt}|${link.amountPaid ?? ''}`;
  noteProvenMode(link, keys);
  const nowPaid = applyRazorpayLinkState(link, res.data);
  await saveLink(ctx.env, link);
  if (nowPaid) { out.missed++; await announcePaymentReceived(ctx, link); }
  return before !== `${link.status}|${link.expiresAt}|${link.amountPaid ?? ''}`;
}

/** A paid link's refunds against Razorpay. True when a refund was new or moved on. */
async function reconcileRefunds(ctx: Ctx, link: StoredPaymentLink, out: ReconcileOutcome): Promise<boolean> {
  const keys = await linkAccountKeys(ctx.env, link);
  const res = keys && link.paymentId
    ? await fetch(`${razorpayApiBase(ctx.env)}/v1/payments/${encodeURIComponent(link.paymentId)}/refunds`, { headers: { Authorization: basicAuthHeader(keys.keyId, keys.keySecret) } }).catch(() => null)
    : null;
  link.refundsCheckedAt = Date.now();
  if (!res?.ok) {
    out.failures++;
    out.error = `refund check answered ${res?.status ?? 'nothing'}`;
    await ctx.env.VAYU_KV.put(`payment:link:${link.id}`, JSON.stringify(link));
    return false;
  }
  out.checked++;
  const items = ((await res.json().catch(() => ({}))) as { items?: unknown[] }).items ?? [];
  let changed = false;
  for (const item of items.slice(0, 50)) {
    const status = apiRefundStatus((item as { status?: unknown })?.status);
    const refund = status ? refundFrom(item, status) : null;
    if (!refund || refund.paymentId !== link.paymentId) continue;
    const outcome = await recordRefund(ctx.env, link.account ?? 'shared', refund, link);
    if (outcome === 'new' || outcome === 'advanced') { changed = true; out.missed++; }
  }
  await ctx.env.VAYU_KV.put(`payment:link:${link.id}`, JSON.stringify(link));
  return changed;
}

/** Checks this workspace's due links, spending from the shared budget. */
async function reconcileWorkspace(ctx: Ctx, budget: { left: number }, outcomes: Outcomes): Promise<void> {
  const now = Date.now();
  const links = await storedLinks(ctx);
  const open = links.filter(l => OPEN_LINK_STATUSES.has(l.status) && now - (l.checkedAt ?? 0) > checkInterval(l, now));
  const paid = links.filter(l => (l.status === 'paid' || l.status === 'partially_paid') && l.paymentId
    && now - (l.paidAt ?? 0) < REFUND_CHECK_WINDOW_MS && now - (l.refundsCheckedAt ?? 0) > REFUND_CHECK_EVERY_MS);
  const changed: string[] = [];
  for (const link of open) {
    if (budget.left <= 0) break;
    budget.left--;
    if (await reconcileOpenLink(ctx, link, outcomeFor(outcomes, link.account ?? 'shared'))) changed.push(link.id);
  }
  for (const link of paid) {
    if (budget.left <= 0) break;
    budget.left--;
    if (await reconcileRefunds(ctx, link, outcomeFor(outcomes, link.account ?? 'shared'))) changed.push(link.id);
  }
  if (changed.length) queueHubNotify(ctx, changed.map(id => ({ entity: 'payments' as const, id, op: 'put' as const })));
}

async function saveOutcomes(env: Env, outcomes: Outcomes): Promise<void> {
  if (!env.PLATFORM_DB) return;
  for (const [account, o] of outcomes) await recordReconcile(env.PLATFORM_DB, account, o);
}

/** POST /payments/links/refresh — check this workspace's due links now (the Payments screen's refresh). */
async function handlePaymentLinksRefresh(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const outcomes: Outcomes = new Map();
  await reconcileWorkspace(ctx, { left: 10 }, outcomes);
  ctx.execCtx.waitUntil(saveOutcomes(ctx.env, outcomes));
  let checked = 0;
  for (const o of outcomes.values()) checked += o.checked;
  return json({ checked });
}

/**
 * The scheduled job: every workspace (the original one and each organization
 * with its own storage), starting at a different one each run so all get a
 * turn, until the run's budget of Razorpay calls is spent.
 */
async function reconcileAllWorkspaces(env: Env, execCtx: ExecutionContext): Promise<void> {
  const spaces: Env[] = [env];
  if (env.PLATFORM_DB) {
    const { results } = await env.PLATFORM_DB.prepare("SELECT id, app_storage FROM organizations WHERE status = 'active' AND app_storage = 'own' ORDER BY id")
      .all<{ id: string; app_storage: 'own' | 'original' }>();
    spaces.push(...results.map(o => orgStorageEnv(env, o)));
  }
  const start = Math.floor(Date.now() / (10 * MINUTE)) % spaces.length;
  const budget = { left: RECONCILE_CALLS_PER_RUN };
  const outcomes: Outcomes = new Map();
  for (let i = 0; i < spaces.length && budget.left > 0; i++) {
    const space = spaces[(start + i) % spaces.length];
    const url = new URL('https://scheduled.invalid/api/payments/reconcile');
    const ctx: Ctx = { request: new Request(url, { method: 'POST' }), env: space, url, path: '/payments/reconcile', method: 'POST', execCtx };
    try {
      await reconcileWorkspace(ctx, budget, outcomes);
    } catch (e) {
      console.error(JSON.stringify({ event: 'reconcile_workspace_failed', org: space.ORG_ID ?? 'original', reason: safeError(e) }));
    }
  }
  await saveOutcomes(env, outcomes);
}

/** Asks Razorpay about one link, and its payments. Saves (and announces) only when `persist`. */
async function freshLinkDetails(ctx: Ctx, link: StoredPaymentLink, persist: boolean): Promise<Response> {
  const keys = await linkAccountKeys(ctx.env, link);
  if (!keys) return json({ link, checked: false, reason: "The Razorpay account this link was made in isn't connected." });
  const res = await razorpayLinkCall(ctx.env, keys, 'GET', `/${encodeURIComponent(link.id)}`).catch(() => null);
  if (!res?.ok) return json({ link, checked: false, reason: "Couldn't reach Razorpay. Showing what was last recorded." });

  noteProvenMode(link, keys);
  const nowPaid = applyRazorpayLinkState(link, res.data);
  const paymentIds: string[] = (Array.isArray(res.data?.payments) ? res.data.payments : [])
    .map((p: any) => p?.payment_id).filter((v: unknown): v is string => typeof v === 'string' && !!v).slice(0, 10);
  const fetched = await Promise.all(paymentIds.map(pid => razorpayPayment(ctx.env, keys, pid).catch(() => null)));
  const payments = fetched.filter(Boolean).map(toPaymentDetail);
  if (payments.length) link.payments = payments;
  // The payment that settled it: its own time and method, not our record's guess.
  const settled = payments.find(p => p.status === 'captured' || p.status === 'refunded');
  if (link.status === 'paid' && settled) {
    link.paidAt = settled.createdAt || link.paidAt;
    link.paymentId = settled.id;
    link.paymentMethod = settled.method;
  }
  link.checkedAt = Date.now();
  if (persist) {
    await saveLink(ctx.env, link);
    if (nowPaid) {
      ctx.execCtx.waitUntil(announcePaymentReceived(ctx, link));
      queueHubNotify(ctx, [{ entity: 'payments', id: link.id, op: 'put' }]);
    }
  }
  const refunds = await refundsByLink(ctx.env.VAYU_DB);
  return json({ link: withRefunds(link, refunds.get(link.id)), checked: true, checkedAt: link.checkedAt });
}

const LINK_DETAILS_PATH = /^\/payments\/links\/(plink_\w{6,40})\/(details|recheck)$/;

/**
 * GET /payments/links/:id/details — Razorpay's current view of one link and
 * every payment on it (references, time, method, what the customer entered),
 * without changing anything. POST /payments/links/:id/recheck does the same
 * and saves it: a link found paid is marked paid and announced like a webhook.
 */
async function handlePaymentLinkDetails(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const id = LINK_DETAILS_PATH.exec(ctx.path)?.[1];
  if (!id) return err('Payment link not found', 404);
  const raw = await ctx.env.VAYU_KV.get(`payment:link:${id}`);
  if (!raw) return err('Payment link not found', 404);
  return freshLinkDetails(ctx, JSON.parse(raw) as StoredPaymentLink, ctx.method === 'POST');
}

/** Push and activity entry for a payment, once (the caller knows it just turned paid). */
async function announcePaymentReceived(ctx: Ctx, link: StoredPaymentLink): Promise<void> {
  const name = link.customerName || 'customer';
  const descriptionSuffix = link.description ? ` — ${link.description}` : '';
  await Promise.all([
    sendPushToSection(ctx.env, 'payments', '', {
      title: 'Payment received ✓',
      body: `${formatRupees(link.amount)} from ${name}${descriptionSuffix}`,
      tag: `payment-${link.id}`,
      data: { view: 'payments', paymentLinkId: link.id },
    }),
    logActivity(ctx.env.VAYU_DB, 'razorpay', 'Razorpay', 'received', 'payment', link.id,
      `Payment of ${formatRupees(link.amount)} received from "${name}"`),
  ]);
}

const PAYMENT_LINK_PATH = /^\/payments\/links\/(plink_\w{6,40})$/;

async function loadPaymentLink(ctx: Ctx): Promise<StoredPaymentLink | Response> {
  const id = PAYMENT_LINK_PATH.exec(ctx.path)?.[1];
  if (!id) return err('Payment link not found', 404);
  const raw = await ctx.env.VAYU_KV.get(`payment:link:${id}`);
  return raw ? JSON.parse(raw) as StoredPaymentLink : err('Payment link not found', 404);
}

/**
 * DELETE /payments/links/:id — remove a link from the app. One that can still
 * be paid is cancelled at Razorpay first, so a customer can't pay a link the
 * team no longer sees; if it was paid in the meantime it is kept. A paid
 * link's payment stays in Razorpay; only the app's record goes.
 */
/**
 * Cancels a link that can still be paid, so nobody pays it after it is
 * gone. A refusal comes back as the response to send (and nothing is
 * deleted); null means the link can go.
 */
async function cancelOpenLink(ctx: Ctx, link: StoredPaymentLink): Promise<Response | null> {
  if (!OPEN_LINK_STATUSES.has(link.status)) return null;
  const keys = await linkAccountKeys(ctx.env, link);
  if (!keys) return err("The Razorpay account this link was made in isn't connected, so it can't be cancelled. Nothing was deleted.", 503);
  const cancel = await razorpayLinkCall(ctx.env, keys, 'POST', `/${encodeURIComponent(link.id)}/cancel`);
  if (cancel.ok) return null;
  // Already paid, expired or cancelled at Razorpay? Then it can't be cancelled.
  const current = await razorpayLinkCall(ctx.env, keys, 'GET', `/${encodeURIComponent(link.id)}`);
  if (!current.ok) return err(cancel.data?.error?.description || `Razorpay couldn't cancel the link (${cancel.status}). Nothing was deleted.`, 502);
  const nowPaid = applyRazorpayLinkState(link, current.data);
  if (link.status === 'paid' || link.status === 'partially_paid') {
    await ctx.env.VAYU_KV.put(`payment:link:${link.id}`, JSON.stringify(link));
    if (nowPaid) await announcePaymentReceived(ctx, link);
    queueHubNotify(ctx, [{ entity: 'payments', id: link.id, op: 'put' }]);
    return err('This link has just been paid, so it was kept.', 409);
  }
  if (OPEN_LINK_STATUSES.has(link.status)) {
    return err(cancel.data?.error?.description || "Razorpay couldn't cancel the link. Nothing was deleted.", 502);
  }
  return null;
}

async function handlePaymentLinkDelete(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const link = await loadPaymentLink(ctx);
  if (link instanceof Response) return link;
  const refused = await cancelOpenLink(ctx, link);
  if (refused) return refused;

  await ctx.env.VAYU_KV.delete(`payment:link:${link.id}`);
  await logActivity(ctx.env.VAYU_DB, session.userId, session.name, 'deleted', 'payment link', link.id,
    `Deleted the payment link of ${formatRupees(link.amount)} for "${link.customerName}"${link.status === 'paid' ? ' (paid; the payment stays in Razorpay)' : ''}`);
  queueHubNotify(ctx, [{ entity: 'payments', id: link.id, op: 'delete' }]);
  return json({ deleted: true });
}

/** PATCH /payments/links/:id { expiresAt } — change how long an unpaid link stays valid. */
async function handlePaymentLinkUpdate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const link = await loadPaymentLink(ctx);
  if (link instanceof Response) return link;
  const body = await ctx.request.json<{ expiresAt?: unknown }>().catch(() => ({} as { expiresAt?: unknown }));
  const expiresAt = parseLinkExpiry(body.expiresAt);
  if (!expiresAt) return err('The link must stay valid for at least 20 minutes and at most 6 months');
  if (!OPEN_LINK_STATUSES.has(link.status)) return err('Only a link that is still waiting for payment can be changed', 409);
  const keys = await linkAccountKeys(ctx.env, link);
  if (!keys) return err("The Razorpay account this link was made in isn't connected.", 503);
  const res = await razorpayLinkCall(ctx.env, keys, 'PATCH', `/${encodeURIComponent(link.id)}`, { expire_by: Math.floor(expiresAt / 1000) });
  if (!res.ok) return err(res.data?.error?.description || `Razorpay couldn't change the link (${res.status})`, 502);
  applyRazorpayLinkState(link, res.data);
  link.expiresAt = Number(res.data?.expire_by) > 0 ? Number(res.data.expire_by) * 1000 : expiresAt;
  link.checkedAt = Date.now();
  await ctx.env.VAYU_KV.put(`payment:link:${link.id}`, JSON.stringify(link));
  await logActivity(ctx.env.VAYU_DB, session.userId, session.name, 'updated', 'payment link', link.id,
    `Changed the payment link for "${link.customerName}" to stay valid until ${new Date(link.expiresAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  queueHubNotify(ctx, [{ entity: 'payments', id: link.id, op: 'put' }]);
  return json(link);
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

/** The shared account's webhook secrets: the current one, and during a rotation the previous one until RAZORPAY_WEBHOOK_SECRET_PREVIOUS_UNTIL. */
function sharedWebhookSecrets(env: Env): { secret: string; previous: boolean }[] {
  const out: { secret: string; previous: boolean }[] = [];
  if (env.RAZORPAY_WEBHOOK_SECRET) out.push({ secret: env.RAZORPAY_WEBHOOK_SECRET, previous: false });
  const until = Date.parse(env.RAZORPAY_WEBHOOK_SECRET_PREVIOUS_UNTIL ?? '');
  if (env.RAZORPAY_WEBHOOK_SECRET_PREVIOUS && Number.isFinite(until) && until > Date.now()) {
    out.push({ secret: env.RAZORPAY_WEBHOOK_SECRET_PREVIOUS, previous: true });
  }
  return out;
}

/**
 * POST /payments/webhook — the shared account's Razorpay events. Verified
 * against the exact raw body with the shared secret (or, during a rotation,
 * the previous one); there is no way to skip the check. Rejections are
 * counted for telemetry only; health comes from verified deliveries.
 */
async function handlePaymentWebhook(ctx: Ctx): Promise<Response> {
  const secrets = sharedWebhookSecrets(ctx.env);
  if (!secrets.length) return err('Webhook not configured', 503);
  const signature = ctx.request.headers.get('x-razorpay-signature')?.toLowerCase();
  const platformDb = ctx.env.PLATFORM_DB;
  const reject = async (reason: string, status: number, message: string) => {
    if (platformDb) await recordRejection(platformDb, 'shared', reason);
    return err(message, status);
  };
  if (!signature) return reject('no_signature', 400, 'Missing signature');
  const rawBody = await ctx.request.text();
  if (rawBody.length > 256 * 1024) return reject('too_large', 413, 'Too large');
  let used: { previous: boolean } | null = null;
  for (const s of secrets) {
    if (await verifyRazorpaySignature(rawBody, signature, s.secret)) { used = s; break; }
  }
  if (!used) return reject('bad_signature', 401, 'Invalid signature');
  let event: any;
  try { event = JSON.parse(rawBody); } catch { return err('Invalid JSON', 400); }
  if (platformDb) await recordVerified(platformDb, 'shared', typeof event?.event === 'string' ? event.event : null, used.previous);
  try {
    await applyAccountEvent(ctx, event, 'shared');
  } catch (e) {
    // Verified but not applied: 500, so Razorpay retries it.
    if (platformDb) await recordProcessingFailure(platformDb, 'shared', e);
    throw e;
  }
  if (platformDb) await recordProcessed(platformDb, 'shared');
  return json({ received: true });
}

/**
 * A record for a link created outside the app (e.g. Razorpay's dashboard),
 * so the history stays complete. Its mode is unknown until a status check
 * with this account's keys proves it.
 */
function linkFromEvent(plink: any, status: string, account: string): StoredPaymentLink {
  return {
    id: plink.id,
    shortUrl: plink.short_url || '',
    amount: plink.amount || 0,
    description: plink.description || '',
    customerName: plink.customer?.name || '',
    customerPhone: plink.customer?.contact || '',
    customerEmail: plink.customer?.email || '',
    status,
    createdAt: plink.created_at ? plink.created_at * 1000 : Date.now(),
    createdBy: '',
    createdByName: '',
    account,
    orgId: account === 'shared' ? null : account,
    currency: typeof plink.currency === 'string' ? plink.currency : CURRENCY,
  };
}

/** The payment that paid a link: when, which, how. */
function notePayment(link: StoredPaymentLink, payment: any): void {
  link.paidAt = Date.now();
  link.paymentId = payment?.id || '';
  link.paymentMethod = payment?.method || '';
}

const STATUS_BY_EVENT: Record<string, string> = {
  'payment_link.paid': 'paid',
  'payment_link.partially_paid': 'partially_paid',
  'payment_link.expired': 'expired',
  'payment_link.cancelled': 'cancelled',
};
/**
 * Applies one verified Razorpay event to the app's payment link records:
 * status, and for a payment the paid time, payment id and method, plus one
 * push and activity entry. Idempotent (retries change nothing and notify
 * once), so it can run for every delivery of an event.
 *
 * `receivingAccount` is the account whose webhook secret verified the event
 * ('shared' or an organization id). A record made in any other account is
 * left alone: one account's events never change another's links, and test
 * and live never mix (each is its own account at Razorpay).
 */
async function applyPaymentLinkEvent(ctx: Ctx, event: any, receivingAccount: string): Promise<void> {
  const plink = event?.payload?.payment_link?.entity;
  if (!plink?.id) return;
  const incoming = STATUS_BY_EVENT[event.event];
  if (!incoming) return;

  const kvKey = `payment:link:${plink.id}`;
  const raw = await ctx.env.VAYU_KV.get(kvKey);
  const record: StoredPaymentLink | null = raw ? JSON.parse(raw) : null;
  if (record && (record.account ?? 'shared') !== receivingAccount) {
    console.warn(JSON.stringify({ event: 'payment_event_account_mismatch', link: String(plink.id).slice(0, 40), receivingAccount: receivingAccount.slice(0, 64) }));
    return;
  }

  // Razorpay retries webhooks — don't re-notify a link we already marked paid.
  const alreadyPaid = record?.status === 'paid';

  const updated: StoredPaymentLink = record ?? linkFromEvent(plink, incoming, receivingAccount);
  const newStatus = nextLinkStatus(record?.status, incoming);
  if (record && newStatus === record.status && event.event !== 'payment_link.paid') return;
  updated.status = newStatus;
  if (event.event === 'payment_link.paid' && !alreadyPaid) notePayment(updated, event?.payload?.payment?.entity);
  if (Number.isSafeInteger(plink.amount_paid) && plink.amount_paid >= (updated.amountPaid ?? 0)) updated.amountPaid = plink.amount_paid;
  await saveLink(ctx.env, updated);

  // Payment links live in KV, which cannot share a D1 transaction with the
  // change log — so the webhook sends a signal-only hub event instead, and
  // clients refetch /payments/links. A lost signal only delays the next
  // scheduled refresh; the KV record is already committed.
  queueHubNotify(ctx, [{ entity: 'payments', id: plink.id, op: 'put' }]);
  if (event.event === 'payment_link.paid' && !alreadyPaid) {
    ctx.execCtx.waitUntil(announcePaymentReceived(ctx, updated));
  }
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
  // The session lives in an HttpOnly cookie; the body carries no credential.
  const res = json({ user: await withAccess(ctx, user) });
  for (const c of await sessionCookies(ctx.request, token, SESSION_TTL_DAYS * 86_400)) res.headers.append('Set-Cookie', c);
  // Same-origin HttpOnly capability cookie so <img>/jsPDF loads (which cannot
  // send headers) still authenticate.
  if (fileAuthEnabled(ctx)) res.headers.append('Set-Cookie', await issueFileCookie(ctx, user.id));
  return res;
}

/**
 * POST /auth/session — swaps the old sign-in token (kept by JavaScript, sent
 * as a bearer token) for a cookie session, once: a new token in an HttpOnly
 * cookie, the old one revoked. Only while LEGACY_BEARER_UNTIL allows bearer
 * tokens; afterwards those devices sign in again.
 */
async function handleAuthSessionExchange(ctx: Ctx): Promise<Response> {
  const kind = ctx.request.headers.get(AUTH_KIND_HEADER);
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  const raw = session ? await ctx.env.VAYU_KV.get(`auth:user:${session.userId}`) : null;
  if (!session || !raw) return json({ error: 'Sign in again.', code: 'legacy_token_retired' }, 401);
  const user = JSON.parse(raw) as StoredUser;
  if (kind === 'cookie') return json({ user: await withAccess(ctx, user), exchanged: false });
  if (kind !== 'bearer') return json({ error: 'Sign in again.', code: 'legacy_token_retired' }, 401);
  const oldToken = bearerToken(ctx.request)!;
  const token = generateToken();
  const next: SessionData = { ...session, expiresAt: Date.now() + SESSION_TTL_DAYS * 86_400_000 };
  await ctx.env.VAYU_KV.put(`auth:session:${token}`, JSON.stringify(next), { expirationTtl: SESSION_TTL_DAYS * 86_400 });
  await ctx.env.VAYU_KV.delete(`auth:session:${oldToken}`);
  await forgetDevice(ctx.env.VAYU_KV, user.id, oldToken);
  await registerDevice(ctx.env.VAYU_KV, user, token, next.expiresAt, ctx.request.headers.get('User-Agent'));
  const res = json({ user: await withAccess(ctx, user), exchanged: true });
  for (const c of await sessionCookies(ctx.request, token, SESSION_TTL_DAYS * 86_400)) res.headers.append('Set-Cookie', c);
  if (fileAuthEnabled(ctx)) res.headers.append('Set-Cookie', await issueFileCookie(ctx, user.id));
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
  // A cookie session whose CSRF cookie went missing gets it back (same expiry).
  if (meToken && ctx.request.headers.get(AUTH_KIND_HEADER) === 'cookie' && !readCookie(ctx.request, cookieNames(ctx.request).csrf)) {
    const left = Math.max(Math.floor((session.expiresAt - Date.now()) / 1000), 60);
    for (const c of await sessionCookies(ctx.request, meToken, left)) res.headers.append('Set-Cookie', c);
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
  if (ctx.env.ORG_ID) return signOutWorkspaceMemberDevices(ctx, session, userId);
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

/** The workspace form of the above: members' devices are platform sessions. */
async function signOutWorkspaceMemberDevices(ctx: Ctx, session: SessionData, userId: string): Promise<Response> {
  const body = await ctx.request.json().catch(() => ({})) as { id?: unknown };
  let only: string | undefined;
  if (body.id !== undefined) {
    if (typeof body.id !== 'string' || !/^[\w-]{8,64}$/.test(body.id)) return err('Invalid device id');
    only = body.id;
  }
  const keep = userId === session.userId ? session.platformSessionId : undefined;
  const signedOut = await signOutOrgMemberDevices(ctx.env, userId, keep, only);
  if (signedOut === null) return err('User not found', 404);
  if (only !== undefined && signedOut === 0) return err('That device is no longer signed in', 404);
  if (signedOut > 0) revokeHubAsync(ctx, userId);
  logEntityChange(ctx, session, 'updated', 'user', userId,
    only === undefined ? `Signed out all devices of a team member (${signedOut})` : 'Signed out a device of a team member');
  const devices = (await orgMemberDevices(ctx.env, session.platformSessionId)).get(userId) ?? [];
  return json({ signedOut, devices });
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
  // The session and CSRF cookies go too, cleared with the attributes they were set with.
  for (const c of clearedSessionCookies(ctx.request)) res.headers.append('Set-Cookie', c);
  if (fileAuthEnabled(ctx)) {
    for (const [name, value] of Object.entries(fileCookieClearHeaders())) {
      res.headers.append(name, value);
    }
  }
  return res;
}

/**
 * The people in this workspace: every stored user of the original app, or,
 * inside an organization, its active members (orgApp.ts).
 */
async function userRecords(ctx: Ctx): Promise<StoredUser[]> {
  if (ctx.env.ORG_ID) return orgMemberRecords(ctx.env);
  const list = await ctx.env.VAYU_KV.list({ prefix: 'auth:user:' });
  const users: StoredUser[] = [];
  for (const key of list.keys) {
    const raw = await ctx.env.VAYU_KV.get(key.name);
    if (raw) users.push(JSON.parse(raw) as StoredUser);
  }
  return users;
}

async function handleAuthUsersList(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  if (session.role !== 'admin') return err('Forbidden', 403);

  const records = await userRecords(ctx);
  const pushSubs = await ctx.env.VAYU_KV.list({ prefix: 'push:sub:' });
  const usersWithPush = new Set<string>();
  for (const key of pushSubs.keys) {
    const parts = key.name.split(':');
    if (parts.length >= 3) usersWithPush.add(parts[2]);
  }

  // A workspace's members sign in with platform accounts: their devices are
  // platform sessions, with no per-person limit.
  const orgDevices = ctx.env.ORG_ID ? await orgMemberDevices(ctx.env, session.platformSessionId) : null;
  const users: PublicUser[] = [];
  for (const stored of records) {
    const pub = stripPassword(stored);
    pub.notificationsEnabled = usersWithPush.has(pub.id);
    if (orgDevices) {
      pub.deviceLimit = null;
      pub.devices = orgDevices.get(pub.id) ?? [];
    } else {
      pub.deviceLimit = deviceLimit(stored);
      pub.devices = await listDevices(ctx.env.VAYU_KV, pub.id, pub.id === session.userId ? bearerToken(ctx.request) : null);
    }
    users.push(pub);
  }
  users.sort((a, b) => a.createdAt - b.createdAt);
  return json(users);
}

async function handleAuthTeam(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const records = await userRecords(ctx);
  const presenceMap = await combinedPresence(ctx);
  const users: PublicUser[] = [];
  for (const stored of records) {
    const pub = stripPassword(stored);
    const presence = presenceMap[pub.id];
    pub.isOnline = !!presence?.isOnline;
    pub.lastSeen = presence?.lastSeen;
    users.push(pub);
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

/** A new email for a user, moving the email index; refused if another user has it. */
async function changeUserEmail(kv: KVNamespace, userId: string, current: string, requested: string | undefined): Promise<{ email: string } | Response> {
  const email = requested ? requested.toLowerCase().trim() : current;
  if (email === current) return { email };
  const holder = await kv.get(`auth:email:${email}`);
  if (holder && holder !== userId) return err('A user with this email already exists', 409);
  await kv.delete(`auth:email:${current}`);
  await kv.put(`auth:email:${email}`, userId);
  return { email };
}

/** A new role for a user: it must exist, and an admin can't take their own admin role away. */
async function changeUserRole(kv: KVNamespace, session: SessionData, userId: string, current: string, requested: string | undefined): Promise<{ role: string } | Response> {
  if (requested === undefined || requested === current) return { role: current };
  const roles = await getRoles(kv);
  if (!roles.some(r => r.id === requested)) return err('That role does not exist', 400);
  if (userId === session.userId && current === ADMIN_ROLE_ID) return err("You can't remove your own admin role", 400);
  return { role: requested };
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
  const emailChange = await changeUserEmail(ctx.env.VAYU_KV, userId, existing.email, email);
  if (emailChange instanceof Response) return emailChange;
  const newEmail = emailChange.email;
  const roleChange = await changeUserRole(ctx.env.VAYU_KV, session, userId, existing.role, role);
  if (roleChange instanceof Response) return roleChange;
  const resolvedRole = roleChange.role;
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
  await endOtherSessions(ctx, session, userId, !!password);
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

/** A new password ends that person's other sessions (a security change); the admin's own stays. */
async function endOtherSessions(ctx: Ctx, session: SessionData, userId: string, passwordChanged: boolean): Promise<void> {
  if (!passwordChanged) return;
  const keep = userId === session.userId ? bearerToken(ctx.request) : null;
  if (await signOutDevices(ctx.env.VAYU_KV, userId, keep, undefined, 'signed-out-by-admin') > 0) revokeHubAsync(ctx, userId);
}

// ── Roles (admin only) ─────────────────────────────────────────────────────

async function requireAdmin(ctx: Ctx): Promise<SessionData | Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  if (session.role !== ADMIN_ROLE_ID) return err('Forbidden', 403);
  return session;
}

function readRoleName(value: unknown, roles: RoleDef[], exceptId?: string): { name: string } | Response {
  const name = typeof value === 'string' ? value.trim().slice(0, 40) : '';
  if (!name) return err('Give the role a name', 400);
  if (roles.some(r => r.id !== exceptId && r.name.toLowerCase() === name.toLowerCase())) {
    return err('A role with that name already exists', 409);
  }
  return { name };
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
  const read = readRoleName(body.name, roles);
  if (read instanceof Response) return read;
  const role: RoleDef = {
    id: `role_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`,
    name: read.name,
    permissions: normalizePermissions(body.permissions),
  };
  await saveRoles(ctx.env.VAYU_KV, [...roles, role]);
  logEntityChange(ctx, session, 'created', 'role', role.id, `Created role "${role.name}"`);
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
  const read = body.name === undefined ? { name: existing.name } : readRoleName(body.name, roles, roleId);
  if (read instanceof Response) return read;
  const updated: RoleDef = {
    ...existing,
    name: read.name,
    permissions: body.permissions === undefined ? existing.permissions : normalizePermissions(body.permissions),
  };
  await saveRoles(ctx.env.VAYU_KV, roles.map(r => (r.id === roleId ? updated : r)));
  logEntityChange(ctx, session, 'updated', 'role', roleId, `Updated role "${updated.name}"`);
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
  const members = (await userRecords(ctx)).filter(u => u.role === roleId).length;
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

  return json({ key, url: fileUrl(ctx.env, key), thumbUrl: fileUrl(ctx.env, `${key}__thumb`) });
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

/** A new conversation's id and members: a sane id, and the writer among its members (admins excepted). */
function conversationShapeProblem(session: SessionData, conv: { id?: unknown; participantIds?: unknown }): Response | null {
  if (!conv.id || !conv.participantIds) return err('id and participantIds are required');
  if (typeof conv.id !== 'string' || conv.id.length > 128) return err('Invalid conversation id');
  const members = Array.isArray(conv.participantIds) ? conv.participantIds : null;
  if (!members || (!members.includes(session.userId) && session.role !== ADMIN_ROLE_ID)) {
    return err('You can only start chats you are part of', 403);
  }
  return null;
}

/**
 * A private room is created by an admin, as a group they are in. Once it
 * exists, it stays private with the same creator, and only its managers
 * may write it again (privateRooms.ts).
 */
function privateRoomProblem(
  session: SessionData, conv: { isGroup?: unknown; participantIds: string[] },
  existing: Awaited<ReturnType<typeof conversationAccess>>, isPrivate: boolean,
): Response | null {
  if (existing) return existing.isPrivate && !managesConversation(session, existing) ? err(NOT_A_MANAGER, 403) : null;
  if (!isPrivate) return null;
  if (session.role !== ADMIN_ROLE_ID) return err('Only admins can create private rooms', 403);
  if (!conv.isGroup) return err('A private room is a group conversation');
  if (!conv.participantIds.includes(session.userId)) return err('You must be in the private room you create');
  return null;
}

async function handleConversationsCreate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json();
  const conv = body as any;
  const shapeProblem = conversationShapeProblem(session, conv);
  if (shapeProblem) return shapeProblem;
  // This is an upsert, so an id that already exists belongs to that
  // conversation: only its own members may write it again (a retried
  // create). Anyone else would replace it and make themselves a member.
  const existing = await conversationAccess(ctx.env.VAYU_DB, conv.id);
  if (existing && !inConversation(session, existing)) return err(NOT_A_MEMBER, 403);
  const isPrivate = existing ? existing.isPrivate : conv.isPrivate === true;
  const privateProblem = privateRoomProblem(session, conv, existing, isPrivate);
  if (privateProblem) return privateProblem;
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
    // An upsert, not INSERT OR REPLACE: a re-sent message keeps its read
    // receipts and reactions (messageReceipts.ts), which REPLACE would wipe.
    ctx.env.VAYU_DB.prepare(
      `INSERT INTO messages
       (id, conversation_id, sender_id, sender_name, text, tags, timestamp,
        status, reply_to, attachment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         conversation_id = excluded.conversation_id, sender_id = excluded.sender_id,
         sender_name = excluded.sender_name, text = excluded.text, tags = excluded.tags,
         timestamp = excluded.timestamp, status = excluded.status, reply_to = excluded.reply_to,
         attachment = excluded.attachment, created_at = excluded.created_at`
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
  if (to === 'read') {
    // Reads are recorded per person (who read it, and when), so a group
    // shows exactly who has seen each message.
    await ensureMessageColumns(db);
    const pairs = ids.map(id => readReceiptStmts(db, ctx.env, id, session.userId)).filter(p => p !== null);
    if (pairs.length === 0) return;
    const results = await db.batch(pairs.flat());
    queueHubNotify(ctx, changedMessages(results, pairs.length));
    return;
  }
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

/** The messages an (UPDATE … RETURNING, change_log) pair batch changed, as hub events. */
function changedMessages(results: D1Result[], pairs: number): ChangeEvent[] {
  const events: ChangeEvent[] = [];
  for (let i = 0; i < pairs; i++) {
    for (const row of (results[i * 2].results ?? []) as { id: string; conversation_id: string }[]) {
      events.push({ entity: 'message', id: row.id, op: 'put', conversationId: row.conversation_id });
    }
  }
  return events;
}

/**
 * PUT /messages/:id/reaction { emoji } — sets the signed-in person's
 * reaction (one per person, replacing any earlier one); { emoji: null }
 * removes it. Only members of the conversation can react. Answers with the
 * message as it now stands.
 */
async function handleMessageReaction(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const msgId = ctx.path.slice('/messages/'.length, -'/reaction'.length);
  const body = await ctx.request.json().catch(() => null) as { emoji?: unknown } | null;
  const emoji = body?.emoji ?? null;
  if (emoji !== null && !isReactionEmoji(emoji)) return err('That reaction is not available');
  const db = ctx.env.VAYU_DB;
  await ensureMessageColumns(db);
  const row = await db.prepare('SELECT conversation_id FROM messages WHERE id = ?').bind(msgId).first<{ conversation_id: string }>();
  if (!row) return err('This message no longer exists', 404);
  const room = await conversationAccess(db, row.conversation_id);
  // Members only: an admin reading a chat from outside it doesn't react in it.
  if (!room?.members.includes(session.userId)) return err(NOT_A_MEMBER, 403);
  const pair = reactionStmts(db, ctx.env, msgId, session.userId, emoji);
  if (!pair) return err('Your account cannot react here', 400);
  await ensureChangeLogTable(db);
  await ensurePrivateRoomColumns(db); // the change_log scope SQL reads is_private
  const results = await db.batch(pair);
  queueHubNotify(ctx, changedMessages(results, 1));
  const updated = await db.prepare('SELECT * FROM messages WHERE id = ?').bind(msgId).first<Record<string, unknown>>();
  return json(updated ? rowToMessage(updated) : null);
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
  return runSetupOnce(db, `columns:${table}`, () => addMissingColumns(db, table));
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

/** Deletes uploaded files (and their thumbnails) behind file URLs. */
async function deleteUploadedFiles(r2: R2Bucket, urls: string[]): Promise<void> {
  // The bucket is this organization's own view (orgStorage.ts), so a URL
  // naming another organization can only ever reach this one's files.
  const keys = urls
    .map(fileKeyFromUrl)
    .filter((key): key is string => key !== null)
    .flatMap(key => [key, `${key}__thumb`]);
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
  return runSetupOnce(db, 'deletedItemsTable', () => db.prepare(`
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
/** An archived row's snapshot, or null when it has none (or it can't be read). */
function archivedPayload(row: Record<string, unknown>): Record<string, unknown> | null {
  if (!row.payload) return null;
  try { return JSON.parse(row.payload as string) as Record<string, unknown>; } catch { return null; }
}

/** Puts back a KV-backed user: the login and the email lookup. A refusal comes back as the response. */
async function restoreArchivedUser(kv: KVNamespace, payload: Record<string, unknown>): Promise<Response | null> {
  const userId = String(payload.id || '');
  if (!userId || !payload.email) return err('Archived user snapshot is incomplete');
  const emailKey = `auth:email:${payload.email}`;
  if (await kv.get(emailKey)) return err('A user with this email already exists', 409);
  if (await kv.get(`auth:user:${userId}`)) return err('This user already exists', 409);
  await kv.put(`auth:user:${userId}`, JSON.stringify(payload));
  await kv.put(emailKey, userId);
  const countRaw = await kv.get('auth:count');
  await kv.put('auth:count', String((countRaw ? Number.parseInt(countRaw, 10) : 0) + 1));
  return null;
}

/** Puts back a row into its table. A refusal comes back as the response. */
async function restoreArchivedRow(ctx: Ctx, session: SessionData, entity: string, payload: Record<string, unknown>): Promise<Response | null> {
  const table = RESTORABLE_TABLES[entity];
  if (!table) return err(`Cannot restore entity type "${entity}"`);
  const cols = Object.keys(payload).filter(k => typeof payload[k] !== 'object' || payload[k] === null);
  if (cols.length === 0 || !payload.id) return err('Archived snapshot is incomplete');
  const existing = await ctx.env.VAYU_DB.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(String(payload.id)).first();
  if (existing) return err('An item with this id already exists — restore aborted', 409);
  await ctx.env.VAYU_DB.batch([
    ctx.env.VAYU_DB.prepare(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
    ).bind(...cols.map(c => (payload[c] === undefined ? null : payload[c]) as string | number | null)),
    changeLogStmt(ctx.env.VAYU_DB, ctx.env, entity, String(payload.id), 'put', { actorId: session.userId }),
  ]);
  queueHubNotify(ctx, [{ entity, id: String(payload.id), op: 'put' }]);
  return null;
}

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
  const payload = archivedPayload(row);
  if (!payload) return err('Archived item has no restorable snapshot');
  const refused = entity === 'user'
    ? await restoreArchivedUser(ctx.env.VAYU_KV, payload)
    : await restoreArchivedRow(ctx, session, entity, payload);
  if (refused) return refused;

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
  // Permanent removal: now the uploaded files go too.
  const rows = id
    ? [await ctx.env.VAYU_DB.prepare('SELECT * FROM deleted_items WHERE id = ?').bind(id).first()].filter(r => r !== null)
    : ((await ctx.env.VAYU_DB.prepare('SELECT * FROM deleted_items').all()).results || []);
  for (const row of rows as Record<string, unknown>[]) {
    await cleanupArchivedFiles(ctx.env.VAYU_R2, row.entity as string, archivedPayload(row));
  }
  if (id) {
    await ctx.env.VAYU_DB.prepare('DELETE FROM deleted_items WHERE id = ?').bind(id).run();
    logEntityChange(ctx, session, 'deleted', 'deleted item', id, 'Permanently purged an archived item');
  } else {
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
  return runSetupOnce(db, 'eventsTable', () => db.prepare(`
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
  return runSetupOnce(db, 'contactsTable', () => db.prepare(`
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
  return runSetupOnce(db, 'storesTable', () => db.prepare(`
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
  return runSetupOnce(db, 'attendanceTable', () => db.prepare(`
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
/** The submitted position, if it is a real one and precise enough to check the geofence. */
function gpsFix(body: { lat?: unknown; lng?: unknown; accuracy?: unknown }): { lat: number; lng: number } | Response {
  const lat = typeof body.lat === 'number' ? body.lat : Number.NaN;
  const lng = typeof body.lng === 'number' ? body.lng : Number.NaN;
  const accuracy = typeof body.accuracy === 'number' ? body.accuracy : Number.NaN;
  const onEarth = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  if (!onEarth) return err('GPS coordinates are required — enable location and retry', 422);
  if (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > MAX_GPS_ACCURACY) {
    return err('GPS accuracy too low — move to an open area and retry', 422);
  }
  return { lat, lng };
}

/**
 * Wi-Fi strategy, a per-store toggle. Off: GPS and internet are enough (mobile
 * data allowed). On: the employee must be on the approved store Wi-Fi.
 */
function storeWifiProblem(store: { wifiRequired: boolean; wifiSsid: string }, body: { connectionType?: unknown; wifiSsid?: unknown }): Response | null {
  if (!store.wifiRequired) return null;
  if (body.connectionType !== 'wifi') return err('Please connect to the store Wi-Fi before checking in', 422);
  const approved = store.wifiSsid.trim().toLowerCase();
  const reported = String(body.wifiSsid || '').trim().toLowerCase();
  if (!approved || reported !== approved) return err('You are not on the approved store Wi-Fi network', 422);
  return null;
}

async function validateAttendanceContext(
  ctx: Ctx,
  session: SessionData,
  body: { storeId?: unknown; lat?: unknown; lng?: unknown; accuracy?: unknown; connectionType?: unknown; wifiSsid?: unknown }
): Promise<{ ok: true; store: any } | { ok: false; response: Response }> {
  const storeId = typeof body.storeId === 'string' ? body.storeId : '';
  if (!storeId) return { ok: false, response: err('Store is required', 400) };
  const fix = gpsFix(body);
  if (fix instanceof Response) return { ok: false, response: fix };
  const { lat, lng } = fix;

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

  const wifi = storeWifiProblem(store, body);
  if (wifi) return { ok: false, response: wifi };
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
  return runSetupOnce(db, 'invoicesTable', () => db.prepare(`
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
  return runSetupOnce(db, 'viewingRoomsTable', async () => {
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
    `Created private room "${input.name}"${input.clientName ? ' for ' + input.clientName : ''} (${input.artworkIds.length} artworks)`);
  const row = await db.prepare('SELECT * FROM viewing_rooms WHERE id = ?').bind(id).first();
  // The passcode is only ever shown now (and when a new one is made).
  return json({ ...staffRoom(row!), passcode: secret.passcode }, 201);
}

interface RoomUpdate { sets: string[]; binds: unknown[]; changes: string[] }

/**
 * Adds the requested changes to a private room's UPDATE (columns, values and
 * words for the activity log). Gives the new passcode, if one was made, or
 * the reason a change can't be made.
 */
async function gatherRoomChanges(db: D1Database, body: Record<string, unknown>, now: number, u: RoomUpdate): Promise<{ passcode?: string } | { problem: string }> {
  if (body.details) {
    const input = await readRoomInput(db, body.details as Record<string, unknown>);
    if (typeof input === 'string') return { problem: input };
    u.sets.push('name = ?', 'client_name = ?', 'client_phone = ?', 'client_email = ?', 'message = ?', 'artwork_ids = ?', 'show_prices = ?');
    u.binds.push(input.name, input.clientName, input.clientPhone, input.clientEmail, input.message, JSON.stringify(input.artworkIds), input.showPrices ? 1 : 0);
    u.changes.push('details');
  }
  if (typeof body.isActive === 'boolean') {
    u.sets.push('is_active = ?');
    u.binds.push(body.isActive ? 1 : 0);
    u.changes.push(body.isActive ? 'switched on' : 'switched off');
  }
  if (body.expiresInDays !== undefined) {
    const expiresAt = expiryFrom(body.expiresInDays, now);
    if (!expiresAt) return { problem: `Choose how long the link works: ${EXPIRY_DAY_CHOICES.join(', ')} days` };
    u.sets.push('expires_at = ?');
    u.binds.push(expiresAt);
    u.changes.push(`link valid ${body.expiresInDays} more days`);
  }
  if (body.newPasscode !== true) return {};
  const secret = await passcodeColumns();
  u.sets.push('passcode_hash = ?', 'passcode_salt = ?', 'grant_key = ?');
  u.binds.push(secret.hash, secret.salt, secret.grantKey);
  u.changes.push('new passcode');
  return { passcode: secret.passcode };
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
  const update: RoomUpdate = { sets: [], binds: [], changes: [] };
  const gathered = await gatherRoomChanges(db, body, now, update);
  if ('problem' in gathered) return err(gathered.problem);
  const { passcode } = gathered;
  const { sets, binds, changes } = update;
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
    artworks: artworks.map(art => clientArtwork(art, token, pass, showPrices, ctx.env.ORG_ID ? `/api/o/${ctx.env.ORG_ID}` : '/api')),
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
  ctx.execCtx.waitUntil(sendPushToSection(ctx.env, 'inquiries', '', {
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

// ── Request dispatch ────────────────────────────────────────────────────────

/** Runs the route this request names: rate limit, access check, handler; or 404. */
async function dispatch(ctx: Ctx, env: Env, orgUser: string | null | undefined): Promise<Response> {
  // Inside an organization, its account and team routes come first (orgTeam.ts).
  const route = (env.ORG_ID ? orgAppRoutes : routes).find(r => r.method === ctx.method && r.match(ctx.path));
  if (!route) return json({ error: 'Not found' }, 404);
  // Floods and enumeration from one device: far above normal use.
  const device = bearerToken(ctx.request) ?? orgUser;
  if (device && !(await underLimit(env.API_LIMITER, `device:${device.slice(0, 32)}`))) {
    return tooMany('Too many requests. Slow down and try again in a minute.');
  }
  const denied = await checkAccess(ctx) ?? await costlyLimit(ctx, env);
  return denied ?? route.handler(ctx);
}

/**
 * A device signed out by the device limit learns why, so the app can say so
 * instead of failing with a bare "Unauthorized".
 */
async function explainSignedOut(response: Response, request: Request, env: Env): Promise<Response> {
  if (response.status !== 401) return response;
  const token = bearerToken(request);
  const reason = token ? await revokedReason(env.VAYU_KV, token).catch(() => null) : null;
  return reason ? json({ error: 'Unauthorized', reason }, 401) : response;
}

/**
 * Razorpay events verified with an organization's own webhook secret. They
 * only ever touch links made in that organization's account:
 *   - in its workspace (its own storage, or the original storage when it is
 *     the organization connected to it);
 *   - or, for links made before 2026-09 while the control centre pointed the
 *     original app at this account, in the original storage — found by the
 *     link's own record saying it was made in this account, never by the
 *     old global setting.
 * Unknown links (made on Razorpay's dashboard) are recorded in its workspace.
 */
/**
 * Whether an event's link (or, for a refund, the link its payment was made
 * on) lives in the original storage and was made in this organization's
 * account, rather than in the organization's own workspace.
 */
async function madeInOriginalStorage(env: Env, home: Env, orgId: string, event: any): Promise<boolean> {
  const linkId: unknown = event?.payload?.payment_link?.entity?.id;
  const paymentId: unknown = event?.payload?.refund?.entity?.payment_id;
  if (typeof linkId === 'string') {
    if ((await home.VAYU_KV.get(`payment:link:${linkId}`)) !== null) return false;
    const legacy = await env.VAYU_KV.get(`payment:link:${linkId}`);
    try { return !!legacy && (JSON.parse(legacy) as StoredPaymentLink).account === orgId; } catch { return false; }
  }
  if (typeof paymentId === 'string') {
    if (await linkForPayment(home, paymentId)) return false;
    return (await linkForPayment(env, paymentId))?.account === orgId;
  }
  return false;
}

async function routeOrgPaymentEvent(request: Request, env: Env, execCtx: ExecutionContext, orgId: string, event: unknown): Promise<void> {
  if (!env.PLATFORM_DB) return;
  const url = new URL(request.url);
  const at = (target: Env): Ctx => ({ request, env: target, url, path: url.pathname, method: request.method, execCtx });
  const org = await env.PLATFORM_DB.prepare('SELECT id, app_storage FROM organizations WHERE id = ?')
    .bind(orgId).first<{ id: string; app_storage: 'own' | 'original' }>();
  if (!org) return;
  const home = orgStorageEnv(env, org);
  if (org.app_storage === 'own' && await madeInOriginalStorage(env, home, orgId, event)) {
    await applyAccountEvent(at(env), event, orgId);
    return;
  }
  await applyAccountEvent(at(home), event, orgId);
}

// ── Removed features ────────────────────────────────────────────────────────

/**
 * The Showcase (curated sections of pieces, with favourites) was removed on
 * 2026-09-29, and at the owner's request its saved data goes with it: its two
 * tables, and its sections archived in Deleted items (which nothing can
 * restore any more). Each workspace's database is cleaned on its next
 * request, once per isolate; DROP ... IF EXISTS makes a repeat harmless.
 * Safe to delete once every workspace has been used since.
 */
function eraseShowcaseData(db: D1Database): Promise<void> {
  return runSetupOnce(db, 'showcaseErased', async () => {
    await db.prepare('DROP TABLE IF EXISTS roster_sections').run();
    await db.prepare('DROP TABLE IF EXISTS roster_favorites').run();
    try {
      await db.prepare("DELETE FROM deleted_items WHERE entity = 'roster_section'").run();
    } catch (e) {
      // No archive in this database yet: nothing to remove.
      if (!/no such table/i.test((e as Error).message)) throw e;
    }
  });
}

// ── Route table ─────────────────────────────────────────────────────────────

const isExact = (p: string) => (path: string) => path === p;
const isPrefix = (p: string) => (path: string) => path.startsWith(p);

const routes: Route[] = [
  // Staff roster (staffRoster.ts)
  ...staffRosterRoutes({
    people: userRecords,
    stores: async (ctx) => {
      await ensureStoresTable(ctx.env.VAYU_DB);
      const { results } = await ctx.env.VAYU_DB.prepare('SELECT id, name FROM stores ORDER BY name ASC').all<{ id: string; name: string }>();
      return results.map(r => ({ id: String(r.id), name: String(r.name) }));
    },
    canManage: (ctx, session) => sessionCan(ctx, session, 'schedule', 'edit'),
    push: (ctx, userIds, payload) => ctx.execCtx.waitUntil(sendPushToUsers(ctx.env, userIds, payload).catch(e => console.error('Staff roster push failed:', e))),
    logChange: logEntityChange,
    notify: queueHubNotify,
  }),

  // Sales ledger (sales.ts)
  ...salesRoutes({ logChange: logEntityChange, notify: queueHubNotify }),

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
  { method: 'POST', match: isExact('/auth/session'), handler: handleAuthSessionExchange },
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
  { method: 'PUT', match: (p) => p.startsWith('/messages/') && p.endsWith('/reaction'), handler: handleMessageReaction },
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
  { method: 'GET', match: isExact('/payments/account'), handler: handlePaymentAccount },
  { method: 'GET', match: isExact('/payments/summary'), handler: handlePaymentSummary },
  { method: 'POST', match: isExact('/payments/links/refresh'), handler: handlePaymentLinksRefresh },
  { method: 'POST', match: (p) => /^\/payments\/links\/plink_\w{6,40}\/recheck$/.test(p), handler: handlePaymentLinkDetails },
  { method: 'GET', match: isExact('/payments/links'), handler: handlePaymentLinksList },
  { method: 'GET', match: isExact('/plan'), handler: handlePlanUsage },
  { method: 'GET', match: isExact('/billing'), handler: handleBillingGet },
  { method: 'POST', match: isExact('/billing/checkout'), handler: handleBillingCheckout },
  { method: 'POST', match: isExact('/billing/confirm'), handler: handleBillingConfirm },
  { method: 'POST', match: (p) => BILLING_RECHECK_PATH.test(p), handler: handleBillingRecheck },
  { method: 'GET', match: (p) => /^\/payments\/links\/plink_\w{6,40}\/details$/.test(p), handler: handlePaymentLinkDetails },
  { method: 'DELETE', match: (p) => PAYMENT_LINK_PATH.test(p), handler: handlePaymentLinkDelete },
  { method: 'PATCH', match: (p) => PAYMENT_LINK_PATH.test(p), handler: handlePaymentLinkUpdate },
  { method: 'POST', match: isExact('/payments/webhook'), handler: handlePaymentWebhook },

  // Delta sync + realtime hub
  { method: 'GET', match: isExact('/sync'), handler: handleSync },
  { method: 'POST', match: isExact('/realtime/ticket'), handler: handleRealtimeTicket },
  { method: 'GET', match: isExact('/realtime/ws'), handler: handleRealtimeWs },
];

// Inside an organization: sign-in is the platform account's and the team is
// its memberships, so these replace the original account routes there.
const orgAppRoutes: Route[] = [
  ...orgAccountRoutes({
    publicUser: stripPassword,
    logChange: logEntityChange,
    closeConnections: revokeHubAsync,
    updateMe: handleAuthMeUpdate,
  }),
  ...routes,
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
      // How it signed in: cookie, bearer (the old token, until LEGACY_BEARER_UNTIL), none, or platform.
      blobs: [route, request.method, workspaceId(env), isWebSocket ? 'ws' : 'http', request.headers.get(AUTH_KIND_HEADER) ?? 'platform'],
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

/** Signing in, or swapping the old token: no session to protect yet, so a trusted origin is enough. */
const CSRF_TOKEN_EXEMPT = new Set(['/api/auth/login', '/api/auth/setup', '/api/auth/session']);

async function legacyCsrfProblem(request: Request, env: Env, auth: { kind: AuthKind; token: string | null }): Promise<{ error: string; code: string } | null> {
  // Signing in (no session to ride on yet): a browser always sends Origin on
  // a cross-site POST, so only a present, untrusted Origin is refused.
  // Callers outside a browser send none and are fine.
  if (CSRF_TOKEN_EXEMPT.has(new URL(request.url).pathname)) {
    const origin = request.headers.get('Origin');
    return origin && !trustedOrigins(request, env).has(origin) ? { code: 'csrf_origin', error: 'This request came from a page that is not allowed.' } : null;
  }
  return csrfProblem(request, env, auth.kind, auth.token);
}

/**
 * For /api/o/<id>/…: the request as the app's routes expect it (/api/…), that
 * organization's storage, and the member's session. Other requests pass
 * through unchanged.
 */
async function organizationScope(request: Request, env: Env): Promise<Response | { request: Request; env: Env; orgUser: string | null }> {
  const orgMatch = ORG_PATH.exec(new URL(request.url).pathname);
  if (!orgMatch) return { request, env, orgUser: null };
  let opened: Awaited<ReturnType<typeof openOrgRequest>>;
  try {
    opened = await openOrgRequest(request, env, orgMatch[1], orgMatch[2] ?? '/');
  } catch (e) {
    console.error('Opening an organization failed:', e);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
  if (opened instanceof Response) return opened;
  const inner = new URL(request.url);
  inner.pathname = `/api${orgMatch[2] ?? '/'}`;
  const scoped = new Request(inner, request);
  primeSession(scoped, opened.session);
  return { request: scoped, env: opened.env, orgUser: opened.session ? `${opened.orgId}:${opened.session.userId}` : null };
}

export default {
  async fetch(request: Request, env: Env, execCtx: ExecutionContext): Promise<Response> {
    const startedAt = Date.now();
    const ingress = await webhookIngressLimit(request, env);
    if (ingress) return ingress;
    // Platform (SaaS) API. Handled first so the legacy wildcard CORS below
    // never applies to cookie-authenticated routes.
    const early = pageVisit(request) ?? await handlePlatformRequest(request, env, {
      waitUntil: work => execCtx.waitUntil(work),
      // The organization whose account the app's payment links use: its
      // webhook updates those links, as the shared account's webhook does.
      // Razorpay events for an organization's own account. A payment link
      // lives where it was made: in the organization's own workspace, or, for
      // the organization chosen for the original app's links, in the original
      // storage. Unknown links (made on Razorpay's dashboard) are recorded in
      // the workspace the account belongs to.
      onPaymentEvent: (orgId, event) => routeOrgPaymentEvent(request, env, execCtx, orgId, event),
    });
    if (early) return early;
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // An organization's app: /api/o/<id>/<path> runs the same routes on that
    // organization's storage, signed in with a platform account (orgApp.ts).
    // The original app's sign-in: cookie (or, until the cutoff, the old
    // bearer token), and CSRF checks on cookie-signed changes. Organization
    // requests use the platform session and are checked in openOrgRequest.
    let originalClosed = false;
    if (!ORG_PATH.test(new URL(request.url).pathname)) {
      const auth = normalizeAuth(request, env);
      request = auth.request;
      const problem = await legacyCsrfProblem(request, env, auth);
      if (problem) {
        // Read the refused body first: leaving it unread on a rebuilt request
        // upsets the connection for the caller's next request.
        await request.arrayBuffer().catch(() => undefined);
        return json(problem, 403);
      }
      // Closed from the control centre (platform/originalSignIn.ts): no new
      // original session, and an existing one counts as signed out, so the
      // app shows its sign-in screen, which uses the platform account.
      if (!(await originalSignInOpen(env.PLATFORM_DB))) {
        if (CSRF_TOKEN_EXEMPT.has(new URL(request.url).pathname)) {
          await request.arrayBuffer().catch(() => undefined);
          return json({ error: 'Sign in with your email account on the sign-in screen.', code: 'original_signin_closed' }, 403);
        }
        if (auth.token) {
          primeSession(request, null);
          originalClosed = true;
        }
      }
    }
    const scope = await organizationScope(request, env);
    if (scope instanceof Response) return scope;
    ({ request, env } = scope);
    const orgUser = scope.orgUser;

    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, '');
    // Per-request bindings view that counts KV ops and D1 rows as handlers
    // use them; everything downstream keeps using ctx.env unchanged.
    const tracked = trackedEnv(request, env);
    const ctx: Ctx = { request, env: tracked, url, path, method: request.method, execCtx };
    execCtx.waitUntil(eraseShowcaseData(env.VAYU_DB).catch(e => console.error('Showcase data erase failed:', e)));

    const route = normalizeRoute(path);
    let response: Response;
    try {
      response = await dispatch(ctx, env, orgUser);
      // A refused request whose body nobody read: let it go, so the connection stays usable.
      if (request.body && !request.bodyUsed) await request.arrayBuffer().catch(() => undefined);
    } catch (e) {
      // The details go to the logs, not to the caller: internal messages can
      // reveal table names, queries or other internals.
      console.error(`Unhandled error on ${request.method} ${route}:`, e);
      response = json({ error: 'Something went wrong. Please try again.' }, 500);
    }
    response = originalClosed && response.status === 401
      ? json({ error: 'Unauthorized', reason: 'original-signin-closed' }, 401)
      : await explainSignedOut(response, request, env);
    // 101 marks the WebSocket upgrade; everything else is an ordinary call.
    execCtx.waitUntil(Promise.resolve().then(() =>
      writeAnalytics(env, execCtx, request, route, response.status, Date.now() - startedAt, response.status === 101),
    ));
    return response;
  },

  /**
   * Every 10 minutes: send notices that are due (including earlier failures),
   * and carry on a started payment-key rotation one batch at a time. Each job
   * fails on its own; one failing never stops the others.
   */
  async scheduled(_controller: ScheduledController, env: Env, execCtx: ExecutionContext): Promise<void> {
    const db = env.PLATFORM_DB;
    if (!db) {
      execCtx.waitUntil(reconcileAllWorkspaces(env, execCtx).catch(e => console.error('scheduled payment reconciliation failed', safeError(e))));
      return;
    }
    // Each job's outcome is recorded, shown in System health, and a failure
    // is emailed to the provider (platform/jobs.ts).
    execCtx.waitUntil(recordRun(db));
    if (emailConfigured(env)) {
      execCtx.waitUntil(runJob(db, 'email', async () => {
        const r = await deliverOutbox(env, db, 50);
        if (r.sent || r.failed) console.log(`outbox: ${r.sent} sent, ${r.failed} failed`);
      }));
    }
    if (secretsConfigured(env)) {
      execCtx.waitUntil(runJob(db, 'key-rotation', () => runRotationBatch(env, db, null)));
    }
    execCtx.waitUntil(runJob(db, 'payment-reconciliation', () => reconcileAllWorkspaces(env, execCtx)));
  },
};
