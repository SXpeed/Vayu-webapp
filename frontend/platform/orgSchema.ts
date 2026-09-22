// Schema for one organization's own business database.
//
// Every organization has its own SQLite database inside its own Durable
// Object, so one organization's rows physically cannot be read from another's.
// Migrations are applied in order and recorded in org_schema, so opening an
// organization is idempotent and a redeploy never re-runs a migration.
//
// Keep this list append-only: add a new entry, never edit an applied one.

export interface OrgMigration {
  version: number;
  statements: string[];
}

export const ORG_MIGRATIONS: OrgMigration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS org_schema (
         version     INTEGER PRIMARY KEY,
         applied_at  INTEGER NOT NULL
       )`,
      // Mirrors the current app's artworks table, plus:
      //  - updated_at / updated_by, and
      //  - version, which makes concurrent edits safe: a save carries the
      //    version it read, and a stale save is rejected instead of quietly
      //    overwriting a colleague's change.
      `CREATE TABLE IF NOT EXISTS artworks (
         id                 TEXT PRIMARY KEY,
         custom_id          TEXT NOT NULL DEFAULT '',
         title              TEXT NOT NULL DEFAULT '',
         artist             TEXT DEFAULT '',
         artwork_year       TEXT DEFAULT '',
         description_title  TEXT DEFAULT '',
         description        TEXT DEFAULT '',
         dimensions         TEXT DEFAULT '',
         medium             TEXT DEFAULT '',
         status             TEXT NOT NULL DEFAULT 'Available',
         location           TEXT DEFAULT '',
         price              REAL DEFAULT 0,
         plus_gst           INTEGER DEFAULT 0,
         image_urls         TEXT NOT NULL DEFAULT '[]',
         version            INTEGER NOT NULL DEFAULT 1,
         created_at         INTEGER NOT NULL,
         created_by         TEXT,
         updated_at         INTEGER NOT NULL,
         updated_by         TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_artworks_created ON artworks (created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_artworks_status ON artworks (status)`,
      // What happened inside this organization. Business audit, separate from
      // the platform-level audit trail.
      `CREATE TABLE IF NOT EXISTS org_audit (
         id           TEXT PRIMARY KEY,
         at           INTEGER NOT NULL,
         actor_id     TEXT,
         action       TEXT NOT NULL,
         entity       TEXT,
         entity_id    TEXT,
         details      TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_org_audit_at ON org_audit (at DESC)`,
    ],
  },
];

export const ORG_SCHEMA_VERSION = ORG_MIGRATIONS.at(-1)!.version;
