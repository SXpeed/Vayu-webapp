// Provider branding: the platform's own name and logo, set from the control
// panel instead of being baked into the build.
//
// Each organization can also have its own logo (end of this file), which its
// app shows in place of this one.
//
// The logo is validated properly: an allowed type, a real image of that type
// (checked by its own bytes, not the name or the declared type), a sane size
// and sane dimensions. Only raster formats — an SVG can carry script, so it is
// refused rather than sanitized.

import type { Env } from '../workerEnv';
import { auditStmt } from './audit';
import { OrgError, type Actor } from './orgs';

const KEY = 'branding';
const CACHE_MS = 15_000;
const MAX_BYTES = 1024 * 1024;
const MIN_PX = 64;
const MAX_PX = 2048;

export interface Branding {
  appName: string;
  tagline: string;
  /** R2 object key, or null while the built-in icon is used. */
  logoKey: string | null;
  /** Bumped on every upload so caches fetch the new file. */
  logoVersion: number;
  accentColor: string | null;
}

export const DEFAULT_BRANDING: Branding = {
  appName: 'ateliersupport',
  tagline: '',
  logoKey: null,
  logoVersion: 0,
  accentColor: null,
};

let cached: { value: Branding; at: number } | null = null;

export async function getBranding(db: D1Database): Promise<Branding> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const row = await db.prepare('SELECT value FROM platform_settings WHERE key = ?').bind(KEY).first<{ value: string }>();
  let value = DEFAULT_BRANDING;
  if (row) {
    try {
      const parsed = JSON.parse(row.value) as Partial<Branding>;
      value = {
        appName: typeof parsed.appName === 'string' && parsed.appName.trim() ? parsed.appName.trim() : DEFAULT_BRANDING.appName,
        tagline: typeof parsed.tagline === 'string' ? parsed.tagline : '',
        logoKey: typeof parsed.logoKey === 'string' ? parsed.logoKey : null,
        logoVersion: typeof parsed.logoVersion === 'number' ? parsed.logoVersion : 0,
        accentColor: typeof parsed.accentColor === 'string' ? parsed.accentColor : null,
      };
    } catch { value = DEFAULT_BRANDING; }
  }
  cached = { value, at: Date.now() };
  return value;
}

/** What any visitor may see: a name, a tagline and a logo address. */
export async function publicBranding(db: D1Database) {
  const b = await getBranding(db);
  return {
    appName: b.appName,
    tagline: b.tagline,
    accentColor: b.accentColor,
    logoUrl: b.logoKey ? `/api/v2/public/branding/logo?v=${b.logoVersion}` : null,
  };
}

function save(db: D1Database, value: Branding, actorId: string): D1PreparedStatement {
  cached = { value, at: Date.now() };
  return db.prepare(
    `INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).bind(KEY, JSON.stringify(value), Date.now(), actorId);
}

export async function updateBranding(db: D1Database, body: Record<string, unknown>, actor: Actor): Promise<Branding> {
  const current = await getBranding(db);
  const appName = body.appName === undefined ? current.appName : String(body.appName).trim();
  if (appName.length < 2 || appName.length > 40) throw new OrgError(400, 'invalid', 'The name must be 2–40 characters.');
  const tagline = body.tagline === undefined ? current.tagline : String(body.tagline).trim().slice(0, 80);
  const accentColor = body.accentColor === undefined ? current.accentColor
    : (body.accentColor === null || body.accentColor === '' ? null : String(body.accentColor).trim());
  if (accentColor !== null && !/^#[0-9a-fA-F]{6}$/.test(accentColor)) {
    throw new OrgError(400, 'invalid', 'The accent colour must be a hex value like #b8860b.');
  }
  const next: Branding = { ...current, appName, tagline, accentColor };
  await db.batch([
    save(db, next, actor.userId),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'branding.update', targetType: 'platform_settings', targetId: KEY, details: { before: current, after: next }, ip: actor.ip }),
  ]);
  return next;
}

// ── Logo ──────────────────────────────────────────────────────────────────

interface ImageInfo { type: string; width: number; height: number }

/**
 * Reads the format and size from the file's own bytes. A file that does not
 * start like a PNG, JPEG or WebP is refused, whatever it claims to be.
 */
export function inspectImage(bytes: Uint8Array): ImageInfo | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // PNG: signature, then an IHDR chunk with width and height.
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { type: 'image/png', width: view.getUint32(16), height: view.getUint32(20) };
  }
  // JPEG: walk the segments to the frame header that carries the size.
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      const length = view.getUint16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'image/jpeg', height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
      }
      i += 2 + length;
    }
    return null;
  }
  // WebP: RIFF container, VP8/VP8L/VP8X payload.
  if (bytes.length > 30 && String.fromCodePoint(...bytes.slice(0, 4)) === 'RIFF' && String.fromCodePoint(...bytes.slice(8, 12)) === 'WEBP') {
    const fourcc = String.fromCodePoint(...bytes.slice(12, 16));
    if (fourcc === 'VP8X') return { type: 'image/webp', width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)), height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) };
    if (fourcc === 'VP8 ') return { type: 'image/webp', width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (fourcc === 'VP8L') {
      const b = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
      return { type: 'image/webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

/** Reads and checks an uploaded logo: the raw image is the request body. */
async function readLogo(env: Env, request: Request): Promise<{ bytes: Uint8Array; info: ImageInfo; extension: string }> {
  if (!env.VAYU_R2) throw new OrgError(503, 'storage_unavailable', 'File storage is not configured in this environment.');
  const declared = request.headers.get('Content-Type') ?? '';
  if (!/^image\/(png|jpeg|webp)$/.test(declared.split(';')[0].trim())) {
    throw new OrgError(400, 'invalid', 'Send the image as a PNG, JPEG or WebP. SVG is not accepted.');
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length === 0) throw new OrgError(400, 'invalid', 'The file is empty.');
  if (bytes.length > MAX_BYTES) throw new OrgError(413, 'too_large', 'The logo must be 1 MB or smaller.');

  const info = inspectImage(bytes);
  if (!info) throw new OrgError(400, 'invalid', 'That file is not a readable PNG, JPEG or WebP image.');
  if (info.type !== declared.split(';')[0].trim()) {
    throw new OrgError(400, 'invalid', `The file is a ${info.type}, not a ${declared}.`);
  }
  if (info.width < MIN_PX || info.height < MIN_PX) throw new OrgError(400, 'invalid', `The logo must be at least ${MIN_PX}×${MIN_PX} pixels.`);
  if (info.width > MAX_PX || info.height > MAX_PX) throw new OrgError(400, 'invalid', `The logo must be at most ${MAX_PX}×${MAX_PX} pixels.`);
  const extension = info.type === 'image/png' ? 'png' : info.type === 'image/jpeg' ? 'jpg' : 'webp';
  return { bytes, info, extension };
}

/** Streams a stored logo. Safe to cache hard: its address carries a version. */
async function logoResponse(env: Env, key: string | null): Promise<Response> {
  if (!key || !env.VAYU_R2) return new Response('Not found', { status: 404 });
  const object = await env.VAYU_R2.get(key);
  if (!object) return new Response('Not found', { status: 404 });
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}

export async function uploadLogo(env: Env, db: D1Database, request: Request, actor: Actor): Promise<Branding> {
  const { bytes, info, extension } = await readLogo(env, request);
  const current = await getBranding(db);
  const key = `platform/branding/logo-${crypto.randomUUID()}.${extension}`;
  await env.VAYU_R2!.put(key, bytes, { httpMetadata: { contentType: info.type } });

  const next: Branding = { ...current, logoKey: key, logoVersion: current.logoVersion + 1 };
  await db.batch([
    save(db, next, actor.userId),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'branding.logo.upload', targetType: 'platform_settings', targetId: KEY, details: { key, type: info.type, width: info.width, height: info.height, bytes: bytes.length }, ip: actor.ip }),
  ]);
  // The old file is left in storage on purpose: a page still showing it keeps
  // working. Cleaning up old logos belongs with the storage housekeeping job.
  return next;
}

/** Serves the current logo. Public, because it is on the sign-in screen. */
export async function serveLogo(env: Env, db: D1Database): Promise<Response> {
  return logoResponse(env, (await getBranding(db)).logoKey);
}

// ── Organization logos ────────────────────────────────────────────────────
//
// Each organization's own logo: what its app shows on the loading screen, in
// place of the platform's. Kept in platform_settings under one key per
// organization, so it needs no schema change. Set from the control centre.

export interface OrgBranding {
  logoKey: string | null;
  logoVersion: number;
}

const orgKey = (orgId: string) => `org_branding:${orgId}`;

export async function getOrgBranding(db: D1Database, orgId: string): Promise<OrgBranding> {
  const row = await db.prepare('SELECT value FROM platform_settings WHERE key = ?').bind(orgKey(orgId)).first<{ value: string }>();
  if (!row) return { logoKey: null, logoVersion: 0 };
  try {
    const parsed = JSON.parse(row.value) as Partial<OrgBranding>;
    return {
      logoKey: typeof parsed.logoKey === 'string' ? parsed.logoKey : null,
      logoVersion: typeof parsed.logoVersion === 'number' ? parsed.logoVersion : 0,
    };
  } catch {
    return { logoKey: null, logoVersion: 0 };
  }
}

/** The logo's address, or null while the organization has none. */
export function orgLogoUrl(orgId: string, b: OrgBranding): string | null {
  return b.logoKey ? `/api/v2/public/orgs/${orgId}/logo?v=${b.logoVersion}` : null;
}

/** Logo addresses for many organizations at once (the workspace list). */
export async function orgLogoUrls(db: D1Database, orgIds: string[]): Promise<Map<string, string | null>> {
  const urls = new Map<string, string | null>();
  if (orgIds.length === 0) return urls;
  const { results } = await db.prepare(
    `SELECT key, value FROM platform_settings WHERE key IN (${orgIds.map(() => '?').join(',')})`,
  ).bind(...orgIds.map(orgKey)).all<{ key: string; value: string }>();
  const byKey = new Map(results.map(r => [r.key, r.value]));
  for (const id of orgIds) {
    let b: OrgBranding = { logoKey: null, logoVersion: 0 };
    const raw = byKey.get(orgKey(id));
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<OrgBranding>;
        if (typeof parsed.logoKey === 'string') b = { logoKey: parsed.logoKey, logoVersion: Number(parsed.logoVersion) || 0 };
      } catch { /* treated as no logo */ }
    }
    urls.set(id, orgLogoUrl(id, b));
  }
  return urls;
}

function saveOrg(db: D1Database, orgId: string, value: OrgBranding, actorId: string): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).bind(orgKey(orgId), JSON.stringify(value), Date.now(), actorId);
}

async function requireOrg(db: D1Database, orgId: string): Promise<void> {
  const org = await db.prepare('SELECT 1 FROM organizations WHERE id = ?').bind(orgId).first();
  if (!org) throw new OrgError(404, 'org_not_found', 'Organization not found.');
}

export async function uploadOrgLogo(env: Env, db: D1Database, orgId: string, request: Request, actor: Actor): Promise<OrgBranding> {
  await requireOrg(db, orgId);
  const { bytes, info, extension } = await readLogo(env, request);
  const current = await getOrgBranding(db, orgId);
  const key = `platform/orgs/${orgId}/logo-${crypto.randomUUID()}.${extension}`;
  await env.VAYU_R2!.put(key, bytes, { httpMetadata: { contentType: info.type } });
  const next: OrgBranding = { logoKey: key, logoVersion: current.logoVersion + 1 };
  await db.batch([
    saveOrg(db, orgId, next, actor.userId),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'org.logo.upload', targetType: 'organization', targetId: orgId, orgId, details: { key, type: info.type, width: info.width, height: info.height, bytes: bytes.length }, ip: actor.ip }),
  ]);
  return next;
}

/** Back to the platform's logo. The file stays, like replaced platform logos. */
export async function removeOrgLogo(db: D1Database, orgId: string, actor: Actor): Promise<OrgBranding> {
  await requireOrg(db, orgId);
  const current = await getOrgBranding(db, orgId);
  // The version keeps counting, so a later upload never reuses an address.
  const next: OrgBranding = { logoKey: null, logoVersion: current.logoVersion };
  await db.batch([
    saveOrg(db, orgId, next, actor.userId),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'org.logo.remove', targetType: 'organization', targetId: orgId, orgId, details: { key: current.logoKey }, ip: actor.ip }),
  ]);
  return next;
}

/** Public, like the platform logo: the loading screen shows it before any sign-in check. */
export async function serveOrgLogo(env: Env, db: D1Database, orgId: string): Promise<Response> {
  return logoResponse(env, (await getOrgBranding(db, orgId)).logoKey);
}

/** Test hook. */
export function resetBrandingCache(): void {
  cached = null;
}
