// Per-person device limits.
//
// Every login is one "device" (a browser or installed app holding its own
// session token). Each user has an index in KV listing their live sessions;
// when a login would exceed the user's limit, the device used longest ago is
// signed out: its session is deleted and a short-lived `auth:revoked:<token>`
// marker lets that device explain why it was signed out. Admins are never
// limited, so someone can always get in to fix things.
//
// KV is eventually consistent: a deleted session can stay readable at other
// edge locations for up to ~60 s, so a signed-out device may keep working for
// that long. Concurrent logins by the same person can race on the index; the
// next login or /auth/me corrects it.

import { ADMIN_ROLE_ID } from './permissions';
import type { StoredUser } from './workerRoles';

export const DEFAULT_MAX_DEVICES = 2;
export const MAX_DEVICES_CAP = 10;
/** How long a signed-out device can still learn why (then it's a plain 401). */
const REVOKED_TTL_SECONDS = 14 * 86_400;
/** Last-used timestamps are only rewritten this often, to spare KV writes. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const INDEX_BUILT_KEY = 'auth:devices:built';

export interface DeviceEntry {
  token: string;
  label: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
}

/** What the app sees — never the token. */
export interface DeviceSummary {
  /** Opaque id (hash of the token) used to sign one device out. */
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number;
  /** True for the device making the request (own list only). */
  current?: boolean;
}

const indexKey = (userId: string) => `auth:devices:${userId}`;
const sessionKey = (token: string) => `auth:session:${token}`;
const revokedKey = (token: string) => `auth:revoked:${token}`;

/** The user's device limit, or null for "unlimited" (admins). */
export function deviceLimit(user: Pick<StoredUser, 'role' | 'maxDevices'>): number | null {
  if (user.role === ADMIN_ROLE_ID) return null;
  const n = user.maxDevices;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_DEVICES_CAP) : DEFAULT_MAX_DEVICES;
}

/**
 * Validate an admin-supplied limit. undefined = leave unchanged, null =
 * back to the default, a number 1..MAX_DEVICES_CAP = that limit.
 */
export function parseMaxDevices(value: unknown): { ok: true; value: number | null | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || value === '') return { ok: true, value: null };
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_DEVICES_CAP) return { ok: true, value: n };
  return { ok: false };
}

/** "Chrome on Android" etc. — just enough for an admin to tell devices apart. */
export function deviceLabel(userAgent: string | null): string {
  const ua = userAgent ?? '';
  let browser = 'Browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/SamsungBrowser/.test(ua)) browser = 'Samsung Internet';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\/|CriOS/.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  let os = '';
  if (/iPhone/.test(ua)) os = 'iPhone';
  else if (/iPad/.test(ua)) os = 'iPad';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'Mac';
  else if (/Linux/.test(ua)) os = 'Linux';
  return os ? `${browser} on ${os}` : browser;
}

// ── Index ───────────────────────────────────────────────────────────────────

let indexesBuilt = false;

/**
 * One-time migration: sessions created before device tracking existed get
 * indexed, so they count toward the limit (and can be signed out) too.
 */
async function ensureIndexes(kv: KVNamespace): Promise<void> {
  if (indexesBuilt) return;
  if (await kv.get(INDEX_BUILT_KEY)) { indexesBuilt = true; return; }
  const byUser = new Map<string, DeviceEntry[]>();
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: 'auth:session:', cursor });
    for (const key of page.keys) {
      const raw = await kv.get(key.name);
      if (!raw) continue;
      try {
        const s = JSON.parse(raw) as { userId?: string; expiresAt?: number };
        if (!s.userId || !s.expiresAt || s.expiresAt < Date.now()) continue;
        // Unknown login time: treat as old so fresh logins win ties.
        const entry: DeviceEntry = {
          token: key.name.slice('auth:session:'.length), label: 'Earlier login',
          createdAt: 0, lastUsedAt: 0, expiresAt: s.expiresAt,
        };
        byUser.set(s.userId, [...(byUser.get(s.userId) ?? []), entry]);
      } catch { /* malformed session: ignore */ }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  for (const [userId, found] of byUser) {
    const existing = await loadIndexRaw(kv, userId);
    const known = new Set(existing.map(e => e.token));
    await saveIndex(kv, userId, [...existing, ...found.filter(e => !known.has(e.token))]);
  }
  await kv.put(INDEX_BUILT_KEY, String(Date.now()));
  indexesBuilt = true;
}

async function loadIndexRaw(kv: KVNamespace, userId: string): Promise<DeviceEntry[]> {
  const raw = await kv.get(indexKey(userId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as DeviceEntry[] : [];
  } catch {
    return [];
  }
}

async function saveIndex(kv: KVNamespace, userId: string, entries: DeviceEntry[]): Promise<void> {
  if (entries.length === 0) { await kv.delete(indexKey(userId)); return; }
  await kv.put(indexKey(userId), JSON.stringify(entries));
}

/** Live devices only (expired sessions dropped). */
async function loadIndex(kv: KVNamespace, userId: string): Promise<DeviceEntry[]> {
  await ensureIndexes(kv);
  const now = Date.now();
  return (await loadIndexRaw(kv, userId)).filter(e => e.expiresAt > now);
}

/**
 * Keep at most the user's limit; sign out the devices used longest ago.
 * Saves the index and returns how many devices were signed out.
 */
async function trimAndSave(kv: KVNamespace, user: StoredUser, entries: DeviceEntry[], protect?: string): Promise<number> {
  const limit = deviceLimit(user);
  let keep = entries;
  let removed: DeviceEntry[] = [];
  if (limit !== null && entries.length > limit) {
    const candidates = entries
      .filter(e => e.token !== protect)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.createdAt - b.createdAt);
    removed = candidates.slice(0, entries.length - limit);
    const gone = new Set(removed.map(e => e.token));
    keep = entries.filter(e => !gone.has(e.token));
    for (const entry of removed) {
      await kv.delete(sessionKey(entry.token));
      await kv.put(revokedKey(entry.token), 'device-limit', { expirationTtl: REVOKED_TTL_SECONDS });
    }
  }
  await saveIndex(kv, user.id, keep);
  return removed.length;
}

// ── Public operations ───────────────────────────────────────────────────────

/** Record a new login; returns how many older devices were signed out. */
export async function registerDevice(
  kv: KVNamespace, user: StoredUser, token: string, expiresAt: number, userAgent: string | null,
): Promise<number> {
  const now = Date.now();
  // The session is already stored, so the one-time migration scan may have
  // just indexed it as an "Earlier login" — never count it twice.
  const entries = (await loadIndex(kv, user.id)).filter(e => e.token !== token);
  entries.push({ token, label: deviceLabel(userAgent), createdAt: now, lastUsedAt: now, expiresAt });
  return trimAndSave(kv, user, entries, token);
}

/** Note that a device is in use (called on app start); throttled. */
export async function touchDevice(kv: KVNamespace, userId: string, token: string, userAgent: string | null): Promise<void> {
  const entries = await loadIndex(kv, userId);
  const entry = entries.find(e => e.token === token);
  const now = Date.now();
  if (entry) {
    if (now - entry.lastUsedAt < TOUCH_INTERVAL_MS) return;
    entry.lastUsedAt = now;
    if (entry.label === 'Earlier login') entry.label = deviceLabel(userAgent);
  } else {
    // A valid session missing from the index (e.g. a lost race): adopt it.
    const raw = await kv.get(sessionKey(token));
    if (!raw) return;
    const expiresAt = (JSON.parse(raw) as { expiresAt?: number }).expiresAt ?? now;
    entries.push({ token, label: deviceLabel(userAgent), createdAt: now, lastUsedAt: now, expiresAt });
  }
  await saveIndex(kv, userId, entries);
}

export async function forgetDevice(kv: KVNamespace, userId: string, token: string): Promise<void> {
  const entries = await loadIndex(kv, userId);
  const next = entries.filter(e => e.token !== token);
  if (next.length !== entries.length) await saveIndex(kv, userId, next);
}

/** Re-apply the limit after an admin lowered it; returns devices signed out. */
export async function enforceDeviceLimit(kv: KVNamespace, user: StoredUser): Promise<number> {
  return trimAndSave(kv, user, await loadIndex(kv, user.id));
}

/** Sign out every device of a user (account deleted). */
export async function forgetAllDevices(kv: KVNamespace, userId: string): Promise<void> {
  for (const entry of await loadIndex(kv, userId)) await kv.delete(sessionKey(entry.token));
  await kv.delete(indexKey(userId));
}

/** A stable, non-reversible id for a device, so the token never leaves the server. */
async function deviceId(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`device:${token}`)));
  return Array.from(digest.slice(0, 12), b => b.toString(16).padStart(2, '0')).join('');
}

export async function listDevices(kv: KVNamespace, userId: string, currentToken?: string | null): Promise<DeviceSummary[]> {
  const entries = (await loadIndex(kv, userId)).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  return Promise.all(entries.map(async ({ token, label, createdAt, lastUsedAt }) => {
    const summary: DeviceSummary = { id: await deviceId(token), label, createdAt, lastUsedAt };
    if (currentToken) summary.current = token === currentToken;
    return summary;
  }));
}

/**
 * Sign out some of a user's devices — one by id, or every device except
 * `keepToken`. The requesting device is never signed out here (that's the
 * ordinary logout). Returns how many devices were signed out.
 */
export async function signOutDevices(
  kv: KVNamespace, userId: string, keepToken: string | null, only?: string,
): Promise<number> {
  const entries = await loadIndex(kv, userId);
  const keep: DeviceEntry[] = [];
  let removed = 0;
  for (const entry of entries) {
    const matches = entry.token !== keepToken && (only === undefined || await deviceId(entry.token) === only);
    if (!matches) { keep.push(entry); continue; }
    await kv.delete(sessionKey(entry.token));
    await kv.put(revokedKey(entry.token), 'signed-out-remotely', { expirationTtl: REVOKED_TTL_SECONDS });
    removed++;
  }
  if (removed > 0) await saveIndex(kv, userId, keep);
  return removed;
}

/** Why a token stopped working, if it was signed out by the device limit. */
export async function revokedReason(kv: KVNamespace, token: string): Promise<string | null> {
  return kv.get(revokedKey(token));
}
