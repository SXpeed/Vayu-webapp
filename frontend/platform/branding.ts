// Provider branding: the platform's own name and logo, set from the control
// panel instead of being baked into the build.
//
// Organization branding (each business's own name and logo) is a separate,
// later feature; this is the ateliersupport brand itself.
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

export async function uploadLogo(env: Env, db: D1Database, request: Request, actor: Actor): Promise<Branding> {
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

  const current = await getBranding(db);
  const extension = info.type === 'image/png' ? 'png' : info.type === 'image/jpeg' ? 'jpg' : 'webp';
  const key = `platform/branding/logo-${crypto.randomUUID()}.${extension}`;
  await env.VAYU_R2.put(key, bytes, { httpMetadata: { contentType: info.type } });

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
  const branding = await getBranding(db);
  if (!branding.logoKey || !env.VAYU_R2) return new Response('Not found', { status: 404 });
  const object = await env.VAYU_R2.get(branding.logoKey);
  if (!object) return new Response('Not found', { status: 404 });
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'image/png',
      // Safe to cache hard: the address carries a version that changes on
      // every upload.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}

/** Test hook. */
export function resetBrandingCache(): void {
  cached = null;
}
