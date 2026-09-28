// The Roster: a curated showcase of the inventory, arranged in sections
// ("Jenjum Gadi collection", "New this month" …) the way a gallery website
// lays out its pieces. Staff browse it, heart pieces for themselves and
// gather a selection; curating it (sections, their pieces and order, how
// prices show) needs the Roster "edit" permission, given by role.
//
// Storage: two tables in the workspace's own database, created on first use
// (both the original D1 database and an organization's own database).
// Sections are few and small, so they are not in change_log: a change sends a
// signal-only "roster" invalidate (like payments) and an open Roster refetches.
//
// Concurrency: every section carries a version. An update names the version
// it was read at; a stale one is refused with the current section (409), so
// two curators never silently overwrite each other.

import { atLeast, ADMIN_ROLE_ID } from './permissions';
import { err, json, runSetupOnce } from './rows';
import { cleanIds, cleanText } from './viewingRooms';
import type { ChangeEvent, Ctx, SessionData } from './workerEnv';
import { getRoles, getSession, permissionsFor } from './workerRoles';

export const PRICE_DISPLAYS = ['request', 'price', 'hidden'] as const;
export type PriceDisplay = (typeof PRICE_DISPLAYS)[number];

/** The backdrop pieces sit on: "studio" is the deep navy of a gallery shoot. */
export const BACKDROPS = ['studio', 'ivory', 'charcoal', 'none'] as const;
export type Backdrop = (typeof BACKDROPS)[number];

export const MAX_SECTIONS = 60;
/** How a removed section is filed in the admin's Deleted archive. */
export const ROSTER_ARCHIVE_ENTITY = 'roster_section';
export const MAX_SECTION_ARTWORKS = 300;
const MAX_FAVORITES = 2000;

export interface RosterSection {
  id: string;
  name: string;
  description: string;
  artworkIds: string[];
  priceDisplay: PriceDisplay;
  backdrop: Backdrop;
  hideSold: boolean;
  position: number;
  version: number;
  createdAt: number;
  updatedAt: number;
  updatedByName: string;
}

export function ensureRosterTables(db: D1Database): Promise<void> {
  return runSetupOnce(db, 'rosterTables', async () => {
    await db.prepare(`CREATE TABLE IF NOT EXISTS roster_sections (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL DEFAULT '',
      description     TEXT NOT NULL DEFAULT '',
      artwork_ids     TEXT NOT NULL DEFAULT '[]',
      price_display   TEXT NOT NULL DEFAULT 'request',
      backdrop        TEXT NOT NULL DEFAULT 'studio',
      hide_sold       INTEGER NOT NULL DEFAULT 0,
      position        INTEGER NOT NULL DEFAULT 0,
      version         INTEGER NOT NULL DEFAULT 1,
      created_at      INTEGER NOT NULL,
      created_by      TEXT,
      updated_at      INTEGER NOT NULL,
      updated_by      TEXT,
      updated_by_name TEXT NOT NULL DEFAULT ''
    )`).run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS roster_favorites (
      user_id    TEXT NOT NULL,
      artwork_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, artwork_id)
    )`).run();
  });
}

function parseIds(raw: unknown): string[] {
  try {
    const ids = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(ids) ? ids.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function rowToSection(row: Record<string, unknown>): RosterSection {
  const price = String(row.price_display) as PriceDisplay;
  const backdrop = String(row.backdrop) as Backdrop;
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    description: String(row.description ?? ''),
    artworkIds: parseIds(row.artwork_ids),
    priceDisplay: PRICE_DISPLAYS.includes(price) ? price : 'request',
    backdrop: BACKDROPS.includes(backdrop) ? backdrop : 'studio',
    hideSold: Number(row.hide_sold) === 1,
    position: Number(row.position) || 0,
    version: Number(row.version) || 1,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    updatedByName: String(row.updated_by_name ?? ''),
  };
}

interface SectionInput {
  name: string;
  description: string;
  artworkIds: string[];
  priceDisplay: PriceDisplay;
  backdrop: Backdrop;
  hideSold: boolean;
}

/**
 * The curator's form, cleaned. Pieces that no longer exist are dropped rather
 * than refused: an artwork deleted while the form was open shouldn't block
 * saving everything else.
 */
export async function readSectionInput(db: D1Database, body: Record<string, unknown>): Promise<SectionInput | string> {
  const name = cleanText(body.name, 80);
  if (!name) return 'Give the section a name';
  const requested = cleanIds(body.artworkIds);
  if (requested.length > MAX_SECTION_ARTWORKS) return `A section can hold up to ${MAX_SECTION_ARTWORKS} pieces`;
  const price = body.priceDisplay as PriceDisplay;
  const backdrop = body.backdrop as Backdrop;
  return {
    name,
    description: cleanText(body.description, 500),
    artworkIds: await existingArtworkIds(db, requested),
    priceDisplay: PRICE_DISPLAYS.includes(price) ? price : 'request',
    backdrop: BACKDROPS.includes(backdrop) ? backdrop : 'studio',
    hideSold: body.hideSold === true,
  };
}

/** The ids that are real artworks, in the order given. */
async function existingArtworkIds(db: D1Database, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const res = await db.prepare(`SELECT id FROM artworks WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
    for (const row of res.results || []) found.add(String(row.id));
  }
  return ids.filter(id => found.has(id));
}

async function listSections(db: D1Database): Promise<RosterSection[]> {
  const { results } = await db.prepare('SELECT * FROM roster_sections ORDER BY position ASC, created_at ASC').all();
  return (results || []).map(r => rowToSection(r as Record<string, unknown>));
}

async function sectionById(db: D1Database, id: string): Promise<RosterSection | null> {
  const row = await db.prepare('SELECT * FROM roster_sections WHERE id = ?').bind(id).first();
  return row ? rowToSection(row as Record<string, unknown>) : null;
}

// ── Routes ──────────────────────────────────────────────────────────────────

type Handler = (ctx: Ctx) => Promise<Response>;
export interface RosterRoute { method: string; match: (path: string) => boolean; handler: Handler }

/** What these routes borrow from worker.ts. */
export interface RosterDeps {
  logChange: (ctx: Ctx, session: SessionData, action: string, entity: string, id: string, details: string) => void;
  archive: (ctx: Ctx, session: SessionData, entity: string, id: string, summary: string, payload: unknown) => void;
  notify: (ctx: Ctx, events: ChangeEvent[]) => void;
}

const SECTION_PATH = /^\/roster\/sections\/([A-Za-z0-9_-]{1,64})$/;
const FAVORITE_PATH = /^\/roster\/favorites\/([^/]{1,128})$/;

/** The body as an object, or null when it isn't JSON. */
async function body(ctx: Ctx): Promise<Record<string, unknown> | null> {
  const parsed = await ctx.request.json().catch(() => null);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}

/** The signed-in caller, after the router's role check (accessRule) has passed. */
async function caller(ctx: Ctx): Promise<SessionData | Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  await ensureRosterTables(ctx.env.VAYU_DB);
  return session;
}

/** Whether the caller may curate: shown to the app so it offers the editor. */
async function canCurate(ctx: Ctx, session: SessionData): Promise<boolean> {
  if (session.role === ADMIN_ROLE_ID) return true;
  return atLeast(permissionsFor(await getRoles(ctx.env.VAYU_KV), session.role).roster, 'edit');
}

export function rosterRoutes(deps: RosterDeps): RosterRoute[] {
  const signal = (ctx: Ctx, id: string, op: 'put' | 'delete') => deps.notify(ctx, [{ entity: 'roster', id, op }]);

  /** GET /roster — every section, and the caller's own hearted pieces. */
  const list: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const db = ctx.env.VAYU_DB;
    const [sections, favs] = await Promise.all([
      listSections(db),
      db.prepare('SELECT artwork_id FROM roster_favorites WHERE user_id = ? ORDER BY created_at DESC').bind(session.userId).all(),
    ]);
    return json({
      sections,
      favorites: (favs.results || []).map(r => String(r.artwork_id)),
      canEdit: await canCurate(ctx, session),
    });
  };

  /** POST /roster/sections — a new section, placed last. */
  const create: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const db = ctx.env.VAYU_DB;
    const raw = await body(ctx);
    if (!raw) return err('Invalid request body');
    const input = await readSectionInput(db, raw);
    if (typeof input === 'string') return err(input);
    const stats = await db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS last FROM roster_sections').first<{ n: number; last: number }>();
    if ((stats?.n ?? 0) >= MAX_SECTIONS) return err(`The showcase can hold up to ${MAX_SECTIONS} sections`);
    const now = Date.now();
    const id = `rs_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
    await db.prepare(
      `INSERT INTO roster_sections (id, name, description, artwork_ids, price_display, backdrop, hide_sold, position, version,
         created_at, created_by, updated_at, updated_by, updated_by_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).bind(id, input.name, input.description, JSON.stringify(input.artworkIds), input.priceDisplay, input.backdrop,
      input.hideSold ? 1 : 0, (stats?.last ?? -1) + 1, now, session.userId, now, session.userId, session.name).run();
    deps.logChange(ctx, session, 'created', 'roster section', id, `Created showcase section "${input.name}"`);
    signal(ctx, id, 'put');
    return json(await sectionById(db, id), 201);
  };

  /** PUT /roster/sections/:id — needs the version it was read at. */
  const update: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const db = ctx.env.VAYU_DB;
    const id = SECTION_PATH.exec(ctx.path)?.[1];
    if (!id) return err('Not found', 404);
    const raw = await body(ctx);
    if (!raw) return err('Invalid request body');
    const current = await sectionById(db, id);
    if (!current) return err('That section no longer exists', 404);
    const version = Number(raw.version);
    if (!Number.isInteger(version)) return err('The section version is missing');
    const input = await readSectionInput(db, raw);
    if (typeof input === 'string') return err(input);
    const res = await db.prepare(
      `UPDATE roster_sections SET name = ?, description = ?, artwork_ids = ?, price_display = ?, backdrop = ?, hide_sold = ?,
         version = version + 1, updated_at = ?, updated_by = ?, updated_by_name = ?
       WHERE id = ? AND version = ?`,
    ).bind(input.name, input.description, JSON.stringify(input.artworkIds), input.priceDisplay, input.backdrop,
      input.hideSold ? 1 : 0, Date.now(), session.userId, session.name, id, version).run();
    if (!res.meta.changes) {
      const latest = await sectionById(db, id);
      return json({ error: `${latest?.updatedByName || 'Someone'} changed this section while you were editing. Your changes were not saved.`, code: 'stale', section: latest }, 409);
    }
    deps.logChange(ctx, session, 'updated', 'roster section', id, `Updated showcase section "${input.name}"`);
    signal(ctx, id, 'put');
    return json(await sectionById(db, id));
  };

  /** DELETE /roster/sections/:id — archived for admins like every delete. */
  const remove: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const db = ctx.env.VAYU_DB;
    const id = SECTION_PATH.exec(ctx.path)?.[1];
    if (!id) return err('Not found', 404);
    const row = await db.prepare('SELECT * FROM roster_sections WHERE id = ?').bind(id).first<Record<string, unknown>>();
    if (!row) return err('That section no longer exists', 404);
    const current = rowToSection(row);
    await db.prepare('DELETE FROM roster_sections WHERE id = ?').bind(id).run();
    // The raw row, so an admin can restore it from Deleted (worker.ts).
    deps.archive(ctx, session, ROSTER_ARCHIVE_ENTITY, id, `Showcase section "${current.name}"`, row);
    deps.logChange(ctx, session, 'deleted', 'roster section', id, `Deleted showcase section "${current.name}"`);
    signal(ctx, id, 'delete');
    return json({ success: true });
  };

  /** PUT /roster/order { ids } — the sections' order, top to bottom. */
  const reorder: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const db = ctx.env.VAYU_DB;
    const raw = await body(ctx);
    const ids = cleanIds(raw?.ids);
    const existing = await listSections(db);
    const known = new Set(existing.map(s => s.id));
    if (ids.length !== existing.length || ids.some(id => !known.has(id))) {
      return err('The showcase changed while you were arranging it. Reload and try again.', 409);
    }
    await db.batch(ids.map((id, position) =>
      db.prepare('UPDATE roster_sections SET position = ? WHERE id = ?').bind(position, id)));
    deps.logChange(ctx, session, 'updated', 'roster', 'order', 'Rearranged the showcase sections');
    signal(ctx, 'order', 'put');
    return json(await listSections(db));
  };

  /** PUT / DELETE /roster/favorites/:artworkId — the caller's own hearts. */
  const favorite = (on: boolean): Handler => async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const db = ctx.env.VAYU_DB;
    const match = FAVORITE_PATH.exec(ctx.path)?.[1];
    let artworkId = '';
    try { artworkId = match ? decodeURIComponent(match) : ''; } catch { /* malformed: refused below */ }
    if (!artworkId) return err('Not found', 404);
    if (on) {
      if ((await existingArtworkIds(db, [artworkId])).length === 0) return err('That piece no longer exists', 404);
      const count = await db.prepare('SELECT COUNT(*) AS n FROM roster_favorites WHERE user_id = ?').bind(session.userId).first<{ n: number }>();
      if ((count?.n ?? 0) >= MAX_FAVORITES) return err(`You can heart up to ${MAX_FAVORITES} pieces`);
      await db.prepare('INSERT OR IGNORE INTO roster_favorites (user_id, artwork_id, created_at) VALUES (?, ?, ?)')
        .bind(session.userId, artworkId, Date.now()).run();
    } else {
      await db.prepare('DELETE FROM roster_favorites WHERE user_id = ? AND artwork_id = ?').bind(session.userId, artworkId).run();
    }
    return json({ success: true, favorite: on });
  };

  return [
    { method: 'GET', match: p => p === '/roster', handler: list },
    { method: 'POST', match: p => p === '/roster/sections', handler: create },
    { method: 'PUT', match: p => SECTION_PATH.test(p), handler: update },
    { method: 'DELETE', match: p => SECTION_PATH.test(p), handler: remove },
    { method: 'PUT', match: p => p === '/roster/order', handler: reorder },
    { method: 'PUT', match: p => FAVORITE_PATH.test(p), handler: favorite(true) },
    { method: 'DELETE', match: p => FAVORITE_PATH.test(p), handler: favorite(false) },
  ];
}
