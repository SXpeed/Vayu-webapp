// One organization's business database.
//
// Each organization gets its own Durable Object (named by its organization id)
// with its own SQLite database. Isolation is physical: code holding one
// organization's object cannot reach another's rows, so a missed WHERE clause
// can't leak across organizations. It also scales without limit — there is no
// shared table that grows with the number of organizations.
//
// Callers reach this only through resolveOrgStore() in orgApi.ts, which first
// checks the session, the membership and the organization's status.

import { DurableObject } from 'cloudflare:workers';
import { ORG_MIGRATIONS, ORG_SCHEMA_VERSION } from './orgSchema';
import type { Env } from '../workerEnv';

export interface Actor {
  userId: string;
  role: string;
}

export interface ArtworkInput {
  id?: string;
  customId?: string;
  title?: string;
  artist?: string;
  artworkYear?: string;
  descriptionTitle?: string;
  description?: string;
  dimensions?: string;
  medium?: string;
  status?: string;
  location?: string;
  price?: number;
  plusGst?: boolean;
  imageUrls?: string[];
  /** The version the editor last read. Omitted only when creating. */
  version?: number;
}

export const ARTWORK_STATUSES = ['Available', 'Sold', 'Reserved'] as const;

/**
 * Thrown for expected, reportable conditions. Errors crossing the Durable
 * Object boundary keep only their message, so the code travels in it
 * ("conflict: ..."); orgApi.ts maps that back to an HTTP status.
 */
export class OrgStoreError extends Error {
  constructor(public code: string, message: string) { super(`${code}: ${message}`); }
}

interface ArtworkRow extends Record<string, SqlStorageValue> {
  id: string; custom_id: string; title: string; artist: string; artwork_year: string;
  description_title: string; description: string; dimensions: string; medium: string;
  status: string; location: string; price: number; plus_gst: number; image_urls: string;
  version: number; created_at: number; created_by: string | null; updated_at: number; updated_by: string | null;
}

function toArtwork(r: ArtworkRow) {
  return {
    id: r.id,
    customId: r.custom_id,
    title: r.title,
    artist: r.artist,
    artworkYear: r.artwork_year,
    descriptionTitle: r.description_title,
    description: r.description,
    dimensions: r.dimensions,
    medium: r.medium,
    status: r.status,
    location: r.location,
    price: r.price,
    plusGst: r.plus_gst === 1,
    imageUrls: JSON.parse(r.image_urls || '[]') as string[],
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

const text = (v: unknown, max = 500): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export class OrgStore extends DurableObject<Env> {
  private ready = false;

  private sql() {
    return this.ctx.storage.sql;
  }

  /**
   * Applies any migrations this database has not seen. Safe to call on every
   * request: after the first call it is an in-memory flag, and the work
   * itself is idempotent.
   */
  private migrate(): void {
    if (this.ready) return;
    const sql = this.sql();
    sql.exec(`CREATE TABLE IF NOT EXISTS org_schema (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
    const applied = new Set<number>();
    for (const row of sql.exec<{ version: number }>('SELECT version FROM org_schema')) applied.add(row.version);
    for (const migration of ORG_MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      for (const statement of migration.statements) sql.exec(statement);
      sql.exec('INSERT OR IGNORE INTO org_schema (version, applied_at) VALUES (?, ?)', migration.version, Date.now());
    }
    this.ready = true;
  }

  private audit(actor: Actor, action: string, entity: string, entityId: string, details?: unknown): void {
    this.sql().exec(
      'INSERT INTO org_audit (id, at, actor_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
      crypto.randomUUID(), Date.now(), actor.userId, action, entity, entityId,
      details === undefined ? null : JSON.stringify(details),
    );
  }

  /** Creates the database if needed and reports what it holds. */
  info(): { schemaVersion: number; artworks: number; sizeBytes: number } {
    this.migrate();
    const [row] = [...this.sql().exec<{ n: number }>('SELECT COUNT(*) AS n FROM artworks')];
    return {
      schemaVersion: ORG_SCHEMA_VERSION,
      artworks: row?.n ?? 0,
      sizeBytes: this.ctx.storage.sql.databaseSize,
    };
  }

  listArtworks(limit = 200, offset = 0): ReturnType<typeof toArtwork>[] {
    this.migrate();
    const rows = [...this.sql().exec<ArtworkRow>(
      'SELECT * FROM artworks ORDER BY created_at DESC LIMIT ? OFFSET ?',
      Math.min(Math.max(limit, 1), 500), Math.max(offset, 0),
    )];
    return rows.map(toArtwork);
  }

  getArtwork(id: string) {
    this.migrate();
    const [row] = [...this.sql().exec<ArtworkRow>('SELECT * FROM artworks WHERE id = ?', id)];
    if (!row) throw new OrgStoreError('not_found', 'Artwork not found.');
    return toArtwork(row);
  }

  /**
   * Creates or updates an artwork. An update must carry the version it read:
   * if someone else saved first, this fails with `conflict` instead of
   * overwriting their change.
   */
  putArtwork(input: ArtworkInput, actor: Actor) {
    this.migrate();
    const status = input.status === undefined ? 'Available' : text(input.status, 20);
    if (!(ARTWORK_STATUSES as readonly string[]).includes(status)) {
      throw new OrgStoreError('invalid', `Status must be one of: ${ARTWORK_STATUSES.join(', ')}.`);
    }
    const title = text(input.title, 200);
    if (!title) throw new OrgStoreError('invalid', 'Title is required.');
    const price = typeof input.price === 'number' && Number.isFinite(input.price) ? Math.max(input.price, 0) : 0;
    const images = Array.isArray(input.imageUrls) ? input.imageUrls.filter(u => typeof u === 'string').slice(0, 50) : [];
    const now = Date.now();
    const sql = this.sql();

    if (!input.id) {
      const id = crypto.randomUUID();
      sql.exec(
        `INSERT INTO artworks (id, custom_id, title, artist, artwork_year, description_title, description,
           dimensions, medium, status, location, price, plus_gst, image_urls, version, created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        id, text(input.customId, 60), title, text(input.artist, 120), text(input.artworkYear, 20),
        text(input.descriptionTitle, 200), text(input.description, 4000), text(input.dimensions, 120),
        text(input.medium, 120), status, text(input.location, 120), price, input.plusGst ? 1 : 0,
        JSON.stringify(images), now, actor.userId, now, actor.userId,
      );
      this.audit(actor, 'artwork.create', 'artwork', id, { title });
      return this.getArtwork(id);
    }

    const [current] = [...sql.exec<{ version: number }>('SELECT version FROM artworks WHERE id = ?', input.id)];
    if (!current) throw new OrgStoreError('not_found', 'Artwork not found.');
    if (typeof input.version !== 'number' || input.version !== current.version) {
      throw new OrgStoreError('conflict', 'Someone else changed this artwork while you were editing. Reload and try again.');
    }
    sql.exec(
      `UPDATE artworks SET custom_id = ?, title = ?, artist = ?, artwork_year = ?, description_title = ?,
         description = ?, dimensions = ?, medium = ?, status = ?, location = ?, price = ?, plus_gst = ?,
         image_urls = ?, version = version + 1, updated_at = ?, updated_by = ?
       WHERE id = ? AND version = ?`,
      text(input.customId, 60), title, text(input.artist, 120), text(input.artworkYear, 20),
      text(input.descriptionTitle, 200), text(input.description, 4000), text(input.dimensions, 120),
      text(input.medium, 120), status, text(input.location, 120), price, input.plusGst ? 1 : 0,
      JSON.stringify(images), now, actor.userId, input.id, input.version,
    );
    this.audit(actor, 'artwork.update', 'artwork', input.id, { title, version: input.version + 1 });
    return this.getArtwork(input.id);
  }

  /**
   * Moves an artwork between statuses only if it is still in the status the
   * user saw. Two people selling the same piece at once: one succeeds, the
   * other is told it is already sold.
   */
  setArtworkStatus(id: string, expected: string, next: string, actor: Actor) {
    this.migrate();
    if (!(ARTWORK_STATUSES as readonly string[]).includes(next)) {
      throw new OrgStoreError('invalid', `Status must be one of: ${ARTWORK_STATUSES.join(', ')}.`);
    }
    const sql = this.sql();
    sql.exec(
      'UPDATE artworks SET status = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ? AND status = ?',
      next, Date.now(), actor.userId, id, expected,
    );
    if (sql.exec<{ n: number }>('SELECT changes() AS n').one().n === 0) {
      const [row] = [...sql.exec<{ status: string }>('SELECT status FROM artworks WHERE id = ?', id)];
      if (!row) throw new OrgStoreError('not_found', 'Artwork not found.');
      throw new OrgStoreError('conflict', `This artwork is already marked ${row.status}.`);
    }
    this.audit(actor, 'artwork.status', 'artwork', id, { from: expected, to: next });
    return this.getArtwork(id);
  }

  deleteArtwork(id: string, actor: Actor): { deleted: boolean } {
    this.migrate();
    const sql = this.sql();
    sql.exec('DELETE FROM artworks WHERE id = ?', id);
    const deleted = sql.exec<{ n: number }>('SELECT changes() AS n').one().n > 0;
    if (deleted) this.audit(actor, 'artwork.delete', 'artwork', id);
    return { deleted };
  }

  recentAudit(limit = 50) {
    this.migrate();
    return [...this.sql().exec(
      'SELECT id, at, actor_id, action, entity, entity_id, details FROM org_audit ORDER BY at DESC LIMIT ?',
      Math.min(Math.max(limit, 1), 200),
    )];
  }
}
