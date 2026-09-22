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
  {
    // The rest of the app's business tables, mirroring the shared database's
    // columns so existing records can be copied across unchanged (see
    // platform/legacyImport.ts). Per-organization copies: nothing here is
    // shared between organizations.
    version: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS collections (
         id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', description TEXT DEFAULT '',
         artwork_ids TEXT DEFAULT '[]', cover_image_url TEXT DEFAULT '', created_at INTEGER NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS catalogs (
         id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', description TEXT DEFAULT '',
         artwork_ids TEXT DEFAULT '[]', cover_image_url TEXT DEFAULT '', pdf_url TEXT,
         source TEXT NOT NULL DEFAULT 'generated', created_at INTEGER NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS contacts (
         id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
         email TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'manual',
         created_at INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_by_name TEXT
       )`,
      `CREATE TABLE IF NOT EXISTS inquiries (
         id TEXT PRIMARY KEY, inquiry_number TEXT NOT NULL DEFAULT '', customer_name TEXT NOT NULL DEFAULT '',
         customer_phone TEXT DEFAULT '', customer_email TEXT DEFAULT '', customer_address TEXT DEFAULT '',
         artwork_ids TEXT DEFAULT '[]', notes TEXT DEFAULT '', source TEXT DEFAULT 'Other',
         status TEXT DEFAULT 'New', catalog_shared INTEGER DEFAULT 0, date INTEGER NOT NULL,
         created_by TEXT DEFAULT '', created_by_name TEXT DEFAULT '', image_urls TEXT DEFAULT '[]'
       )`,
      `CREATE TABLE IF NOT EXISTS inquiry_messages (
         id TEXT PRIMARY KEY, inquiry_id TEXT NOT NULL, sender_id TEXT NOT NULL, sender_name TEXT NOT NULL,
         text TEXT DEFAULT '', tags TEXT DEFAULT '[]', timestamp INTEGER NOT NULL, status TEXT DEFAULT 'sent',
         reply_to TEXT, attachment TEXT, created_at INTEGER NOT NULL DEFAULT 0
       )`,
      `CREATE INDEX IF NOT EXISTS idx_inquiry_messages ON inquiry_messages (inquiry_id, timestamp)`,
      `CREATE TABLE IF NOT EXISTS conversations (
         id TEXT PRIMARY KEY, participant_ids TEXT NOT NULL, participant_names TEXT NOT NULL,
         last_message TEXT DEFAULT '', last_message_time INTEGER DEFAULT 0, unread_count INTEGER DEFAULT 0,
         title TEXT, reason TEXT, note TEXT, is_group INTEGER DEFAULT 0, group_name TEXT,
         is_pinned INTEGER DEFAULT 0, is_archived INTEGER DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0
       )`,
      `CREATE TABLE IF NOT EXISTS messages (
         id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_id TEXT NOT NULL, sender_name TEXT NOT NULL,
         text TEXT DEFAULT '', tags TEXT DEFAULT '[]', timestamp INTEGER NOT NULL, status TEXT DEFAULT 'sent',
         reply_to TEXT, attachment TEXT, created_at INTEGER NOT NULL DEFAULT 0
       )`,
      `CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, timestamp)`,
      `CREATE TABLE IF NOT EXISTS invoices (
         id TEXT PRIMARY KEY, invoice_number TEXT NOT NULL DEFAULT '', customer_name TEXT NOT NULL DEFAULT '',
         status TEXT NOT NULL DEFAULT 'Draft', date INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}',
         created_by TEXT, created_by_name TEXT, updated_at INTEGER NOT NULL DEFAULT 0
       )`,
      `CREATE TABLE IF NOT EXISTS events (
         id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', event_date INTEGER NOT NULL DEFAULT 0,
         end_date INTEGER, todos TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '', color TEXT,
         created_at INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_by_name TEXT
       )`,
      `CREATE TABLE IF NOT EXISTS stores (
         id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', latitude REAL NOT NULL DEFAULT 0,
         longitude REAL NOT NULL DEFAULT 0, gps_radius INTEGER NOT NULL DEFAULT 150,
         wifi_required INTEGER NOT NULL DEFAULT 0, wifi_ssid TEXT NOT NULL DEFAULT '',
         created_at INTEGER NOT NULL DEFAULT 0
       )`,
      `CREATE TABLE IF NOT EXISTS attendance (
         id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, employee_name TEXT DEFAULT '', store_id TEXT NOT NULL,
         check_in_at INTEGER, check_in_lat REAL, check_in_lng REAL, check_in_accuracy REAL,
         check_out_at INTEGER, check_out_lat REAL, check_out_lng REAL, check_out_accuracy REAL,
         connection_type TEXT DEFAULT 'unknown', status TEXT NOT NULL DEFAULT 'checked-in',
         created_at INTEGER NOT NULL DEFAULT 0
       )`,
      `CREATE INDEX IF NOT EXISTS idx_attendance_employee ON attendance (employee_id, check_in_at DESC)`,
      `CREATE TABLE IF NOT EXISTS activity_logs (
         id TEXT PRIMARY KEY, user_id TEXT NOT NULL, user_name TEXT NOT NULL, action TEXT NOT NULL,
         entity TEXT NOT NULL, entity_id TEXT DEFAULT '', details TEXT DEFAULT '', timestamp INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_activity_logs_at ON activity_logs (timestamp DESC)`,
      `CREATE TABLE IF NOT EXISTS deleted_items (
         id TEXT PRIMARY KEY, entity TEXT NOT NULL, entity_id TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
         payload TEXT, deleted_at INTEGER NOT NULL DEFAULT 0, deleted_by TEXT, deleted_by_name TEXT
       )`,
    ],
  },
];

export const ORG_SCHEMA_VERSION = ORG_MIGRATIONS.at(-1)!.version;
