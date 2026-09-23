// Private viewing rooms: a curated set of artworks shared with one client
// through a secret link, protected by a passcode and an expiry date.
//
//   Staff (signed in, Catalogs permission)   /api/viewing-rooms[/:id]
//   Client (no account)                      /api/viewing/:token/open      passcode -> room + image pass
//                                            /api/viewing/:token/image     one artwork photo, with the pass
//                                            /api/viewing/:token/interest  "I'm interested" -> an inquiry
//   Client page                              app.ateliersupport.com/room/:token (room.html)
//
// Security model:
//  - The token in the link is 32 random bytes; the passcode is 6 random
//    digits, stored as a salted PBKDF2 hash and shown to staff only when set.
//  - Attempts are rate limited per room and per IP; rooms expire and can be
//    switched off at any time.
//  - A correct passcode returns a short-lived "pass": an HMAC over the token
//    and an expiry, keyed by the room's own random grant_key. Photos and the
//    interest form need a valid pass, so images keep working when FILE_AUTH
//    locks /api/files, and only the room's own photos are served. A new
//    passcode replaces grant_key, which cancels every pass issued before.
//
// Pure helpers here; the route handlers live in worker.ts.

export const PASS_TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_ROOM_ARTWORKS = 60;
export const EXPIRY_DAY_CHOICES = [7, 14, 30, 90] as const;
const PBKDF2_ITERATIONS = 50_000;

// ── Random values ────────────────────────────────────────────────────────

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  // '=' only ever appears as padding, so dropping every one is safe.
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** The secret part of the link: 32 random bytes, 43 url-safe characters. */
export function newRoomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export const ROOM_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Six random digits, without modulo bias. */
export function newPasscode(): string {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  for (;;) {
    const [n] = crypto.getRandomValues(new Uint32Array(1));
    if (n < limit) return String(n % 1_000_000).padStart(6, '0');
  }
}

export function newSecretHex(bytes = 32): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

// ── Passcodes ────────────────────────────────────────────────────────────

export async function hashPasscode(passcode: string, saltHex: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveBits']);
  const salt = new Uint8Array(saltHex.match(/../g)!.map(h => Number.parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS }, key, 256);
  return hex(bits);
}

/** Constant-time comparison of two equal-length hex strings. */
export function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function passcodeMatches(passcode: string, row: { passcode_hash: string; passcode_salt: string }): Promise<boolean> {
  if (!/^\d{6}$/.test(passcode)) return false;
  return sameHex(await hashPasscode(passcode, row.passcode_salt), row.passcode_hash);
}

// ── Passes (short-lived proof that the passcode was entered) ─────────────

async function hmacHex(keyHex: string, message: string): Promise<string> {
  const raw = new Uint8Array(keyHex.match(/../g)!.map(h => Number.parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

export async function issuePass(grantKey: string, token: string, now = Date.now()): Promise<{ pass: string; expiresAt: number }> {
  const expiresAt = now + PASS_TTL_MS;
  const mac = await hmacHex(grantKey, `${token}.${expiresAt}`);
  return { pass: `${expiresAt}.${mac}`, expiresAt };
}

export async function passValid(pass: string | null, grantKey: string, token: string, now = Date.now()): Promise<boolean> {
  const m = /^(\d{13})\.([0-9a-f]{64})$/.exec(pass ?? '');
  if (!m) return false;
  const expiresAt = Number(m[1]);
  if (expiresAt <= now || expiresAt > now + PASS_TTL_MS) return false;
  return sameHex(await hmacHex(grantKey, `${token}.${expiresAt}`), m[2]);
}

// ── Room state and client view ───────────────────────────────────────────

export type RoomStatus = 'active' | 'expired' | 'off';

export function roomStatus(row: { is_active: number; expires_at: number }, now = Date.now()): RoomStatus {
  if (!row.is_active) return 'off';
  return row.expires_at <= now ? 'expired' : 'active';
}

/** R2 key behind an /api/files/ URL, or null for anything else. */
export function fileKeyOf(url: string): string | null {
  if (typeof url !== 'string' || !url.startsWith('/api/files/')) return null;
  const key = decodeURIComponent(url.slice('/api/files/'.length));
  return key && !key.includes('..') ? key : null;
}

/** Every photo key the room may serve: each artwork's images and their thumbnails. */
export function roomImageKeys(artworks: { imageUrls: string[] }[]): Set<string> {
  const keys = new Set<string>();
  for (const art of artworks) {
    for (const url of art.imageUrls ?? []) {
      const key = fileKeyOf(url);
      if (key) { keys.add(key); keys.add(`${key}__thumb`); }
    }
  }
  return keys;
}

export interface ClientArtwork {
  id: string;
  title: string;
  artist?: string;
  year?: string;
  medium?: string;
  dimensions?: string;
  description?: string;
  availability: 'available' | 'reserved' | 'sold';
  /** Only when the room shows prices, and not for sold pieces. */
  price?: number;
  plusGst?: boolean;
  images: { full: string; thumb: string }[];
}

function availabilityOf(status: string | undefined): ClientArtwork['availability'] {
  if (status === 'Sold') return 'sold';
  if (status === 'Reserved') return 'reserved';
  return 'available';
}

/**
 * What the client page gets for one artwork. Internal fields (stock id,
 * location, cost, who added it) never leave the server.
 */
export function clientArtwork(art: {
  id: string; title: string; artist?: string; artworkYear?: string; medium?: string; dimensions?: string;
  description?: string; status?: string; price?: number; plusGst?: boolean; imageUrls?: string[];
}, token: string, pass: string, showPrices: boolean): ClientArtwork {
  const imageUrl = (key: string) => `/api/viewing/${token}/image?k=${encodeURIComponent(key)}&p=${encodeURIComponent(pass)}`;
  const images = (art.imageUrls ?? []).map(fileKeyOf).filter((k): k is string => !!k)
    .map(key => ({ full: imageUrl(key), thumb: imageUrl(`${key}__thumb`) }));
  const availability = availabilityOf(art.status);
  const sold = availability === 'sold';
  return {
    id: art.id,
    title: art.title,
    artist: art.artist || undefined,
    year: art.artworkYear || undefined,
    medium: art.medium || undefined,
    dimensions: art.dimensions || undefined,
    description: art.description || undefined,
    availability,
    ...(showPrices && !sold && typeof art.price === 'number' && art.price > 0 ? { price: art.price, plusGst: !!art.plusGst } : {}),
    images,
  };
}

// ── Input ────────────────────────────────────────────────────────────────

export function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function cleanIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128))];
}

/** name@domain.tld, one @, no spaces. A plain check, no regex to backtrack on. */
export function looksLikeEmail(value: string): boolean {
  const at = value.indexOf('@');
  if (at < 1 || at !== value.lastIndexOf('@') || /\s/.test(value)) return false;
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

export const VIEWING_ROOMS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS viewing_rooms (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    client_name TEXT NOT NULL DEFAULT '',
    client_phone TEXT NOT NULL DEFAULT '',
    client_email TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    artwork_ids TEXT NOT NULL DEFAULT '[]',
    show_prices INTEGER NOT NULL DEFAULT 0,
    passcode_hash TEXT NOT NULL,
    passcode_salt TEXT NOT NULL,
    grant_key TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    view_count INTEGER NOT NULL DEFAULT 0,
    last_viewed_at INTEGER,
    inquiry_count INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL DEFAULT '',
    created_by_name TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`;

/** What staff see for a room (never the passcode hash, salt or grant key). */
export function staffRoom(row: Record<string, unknown>, now = Date.now()) {
  let artworkIds: string[] = [];
  try { artworkIds = JSON.parse(String(row.artwork_ids ?? '[]')); } catch { /* malformed */ }
  return {
    id: String(row.id),
    token: String(row.token),
    name: String(row.name ?? ''),
    clientName: String(row.client_name ?? ''),
    clientPhone: String(row.client_phone ?? ''),
    clientEmail: String(row.client_email ?? ''),
    message: String(row.message ?? ''),
    artworkIds,
    showPrices: Number(row.show_prices) === 1,
    expiresAt: Number(row.expires_at),
    status: roomStatus({ is_active: Number(row.is_active), expires_at: Number(row.expires_at) }, now),
    viewCount: Number(row.view_count ?? 0),
    lastViewedAt: row.last_viewed_at ? Number(row.last_viewed_at) : null,
    inquiryCount: Number(row.inquiry_count ?? 0),
    createdBy: String(row.created_by ?? ''),
    createdByName: String(row.created_by_name ?? ''),
    createdAt: Number(row.created_at),
  };
}
