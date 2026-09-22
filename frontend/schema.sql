-- D1 Schema for Vayu Messaging
-- Conversations and Messages tables for real-time messaging sync

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  participant_ids TEXT NOT NULL,    -- JSON array of user IDs
  participant_names TEXT NOT NULL,  -- JSON array of user names
  last_message TEXT DEFAULT '',
  last_message_time INTEGER DEFAULT 0,
  unread_count INTEGER DEFAULT 0,
  title TEXT,
  reason TEXT,
  note TEXT,
  is_group INTEGER DEFAULT 0,
  group_name TEXT,
  is_pinned INTEGER DEFAULT 0,
  is_archived INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  text TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',          -- JSON array of tags
  timestamp INTEGER NOT NULL,
  status TEXT DEFAULT 'sent',      -- sent | delivered | read
  reply_to TEXT,                   -- JSON object or null
  attachment TEXT,                 -- JSON object or null
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_conversations_participants ON conversations(participant_ids);

-- ── Artworks table ───────────────────────────────────────────────────────
-- Stores product/artwork metadata. Images are stored in R2 and referenced
-- by URL in the image_urls JSON array.

CREATE TABLE IF NOT EXISTS artworks (
  id TEXT PRIMARY KEY,
  custom_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  artist TEXT DEFAULT '',
  artwork_year TEXT DEFAULT '',
  description_title TEXT DEFAULT '',
  description TEXT DEFAULT '',
  dimensions TEXT DEFAULT '',
  medium TEXT DEFAULT '',
  status TEXT DEFAULT 'Available',   -- Available | Sold | Reserved
  location TEXT DEFAULT '',
  price REAL DEFAULT 0,
  plus_gst INTEGER DEFAULT 0,         -- 1 when price is shown as "+ GST"
  image_urls TEXT DEFAULT '[]',       -- JSON array of R2 URLs
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artworks_created ON artworks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artworks_status ON artworks(status);

-- ── Collections table ──────────────────────────────────────────────────────
-- Groups of artworks (curated sets).

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  artwork_ids TEXT DEFAULT '[]',        -- JSON array of artwork IDs
  cover_image_url TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_collections_created ON collections(created_at DESC);

-- ── Catalogs table ──────────────────────────────────────────────────────────
-- Shareable catalogs of artworks with a cover image.

CREATE TABLE IF NOT EXISTS catalogs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  artwork_ids TEXT DEFAULT '[]',        -- JSON array of artwork IDs
  cover_image_url TEXT DEFAULT '',
  pdf_url TEXT,                         -- stored PDF (generated or uploaded)
  source TEXT NOT NULL DEFAULT 'generated',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_catalogs_created ON catalogs(created_at DESC);

-- ── Inquiries table ─────────────────────────────────────────────────────────
-- Customer inquiries with linked artworks and status tracking.

CREATE TABLE IF NOT EXISTS inquiries (
  id TEXT PRIMARY KEY,
  inquiry_number TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL DEFAULT '',
  customer_phone TEXT DEFAULT '',
  customer_email TEXT DEFAULT '',
  customer_address TEXT DEFAULT '',
  artwork_ids TEXT DEFAULT '[]',        -- JSON array of artwork IDs
  notes TEXT DEFAULT '',
  source TEXT DEFAULT 'Other',
  status TEXT DEFAULT 'New',
  catalog_shared INTEGER DEFAULT 0,
  date INTEGER NOT NULL,
  created_by TEXT DEFAULT '',           -- user ID of whoever added the inquiry
  created_by_name TEXT DEFAULT '',
  image_urls TEXT DEFAULT '[]'          -- JSON array of R2 photo URLs
);

CREATE INDEX IF NOT EXISTS idx_inquiries_date ON inquiries(date DESC);
CREATE INDEX IF NOT EXISTS idx_inquiries_status ON inquiries(status);

-- ── Inquiry Messages table ──────────────────────────────────────────────────
-- Chat messages within an inquiry (team discussion about a customer inquiry).

CREATE TABLE IF NOT EXISTS inquiry_messages (
  id TEXT PRIMARY KEY,
  inquiry_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  text TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',               -- JSON array of tags
  timestamp INTEGER NOT NULL,
  status TEXT DEFAULT 'sent',
  reply_to TEXT,                        -- JSON object or null
  attachment TEXT,                      -- JSON object or null
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_inquiry_messages_inquiry ON inquiry_messages(inquiry_id, timestamp);

-- ── Activity Logs table ──────────────────────────────────────────────────────
-- Tracks user actions (create/update/delete) across all entities for admin audit.

CREATE TABLE IF NOT EXISTS activity_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  action TEXT NOT NULL,          -- created | updated | deleted | login | logout
  entity TEXT NOT NULL,          -- user | artwork | catalog | collection | inquiry | conversation | message
  entity_id TEXT DEFAULT '',
  details TEXT DEFAULT '',
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_timestamp ON activity_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_user ON activity_logs(user_id);

-- ── Calendar Events table ───────────────────────────────────────────────────
-- Team-shared upcoming events shown on the home screen.

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
);

CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date ASC);

-- ── Contacts table ──────────────────────────────────────────────────────────
-- Manually added + CSV-imported contacts. Inquiry-derived contacts are
-- computed client-side and never stored here.

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
);

CREATE INDEX IF NOT EXISTS idx_contacts_created ON contacts(created_at DESC);

-- ── Deleted Items archive ───────────────────────────────────────────────────
-- Every destructive delete first archives a snapshot here so admins can audit
-- what was removed, by whom and when.

CREATE TABLE IF NOT EXISTS deleted_items (
  id TEXT PRIMARY KEY,
  entity TEXT NOT NULL,          -- artwork | collection | catalog | inquiry | event | contact | conversation | user
  entity_id TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  payload TEXT,                  -- JSON snapshot of the deleted record
  deleted_at INTEGER NOT NULL DEFAULT 0,
  deleted_by TEXT,
  deleted_by_name TEXT
);

CREATE INDEX IF NOT EXISTS idx_deleted_items_at ON deleted_items(deleted_at DESC);

-- ── Attendance: stores & check-ins ──────────────────────────────────────────
-- Stores define the geofence (lat/lng + radius in meters) and whether the
-- employee must be on the approved store Wi-Fi. Attendance rows keep ONLY
-- server-generated timestamps; GPS + connection info are recorded for audit.

CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  latitude REAL NOT NULL DEFAULT 0,
  longitude REAL NOT NULL DEFAULT 0,
  gps_radius INTEGER NOT NULL DEFAULT 150,   -- geofence radius in meters
  wifi_required INTEGER NOT NULL DEFAULT 0,  -- Require Store Wi-Fi ON/OFF
  wifi_ssid TEXT NOT NULL DEFAULT '',        -- approved Wi-Fi network name
  created_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS attendance (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  employee_name TEXT DEFAULT '',
  store_id TEXT NOT NULL,
  check_in_at INTEGER,                  -- server timestamp
  check_in_lat REAL,
  check_in_lng REAL,
  check_in_accuracy REAL,               -- GPS accuracy in meters
  check_out_at INTEGER,                 -- server timestamp
  check_out_lat REAL,
  check_out_lng REAL,
  check_out_accuracy REAL,
  connection_type TEXT DEFAULT 'unknown', -- wifi | mobile | unknown
  status TEXT NOT NULL DEFAULT 'checked-in', -- checked-in | checked-out
  created_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_attendance_employee ON attendance(employee_id);
CREATE INDEX IF NOT EXISTS idx_attendance_in ON attendance(check_in_at DESC);
-- Delta-sync change log. Every D1 mutation appends its row(s) here in the same
-- batch as the write; /api/sync serves pages of it. The Worker also creates
-- this idempotently at runtime (deltaSync.ts ensureChangeLogTable). Rows older
-- than 30 days are pruned; the newest row is always kept.
CREATE TABLE IF NOT EXISTS change_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL,                -- put | delete
  changed_at INTEGER NOT NULL,
  actor_id TEXT NOT NULL DEFAULT '',
  scope TEXT                       -- JSON array of entitled user IDs, or NULL = team-wide
);

CREATE INDEX IF NOT EXISTS idx_change_log_ws_seq ON change_log(workspace_id, seq);
CREATE INDEX IF NOT EXISTS idx_change_log_ws_changed ON change_log(workspace_id, changed_at);
