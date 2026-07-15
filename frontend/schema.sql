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
  description TEXT DEFAULT '',
  dimensions TEXT DEFAULT '',
  medium TEXT DEFAULT '',
  status TEXT DEFAULT 'Available',   -- Available | Sold | Reserved
  location TEXT DEFAULT '',
  price REAL DEFAULT 0,
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
  artwork_ids TEXT DEFAULT '[]',        -- JSON array of artwork IDs
  notes TEXT DEFAULT '',
  source TEXT DEFAULT 'Other',
  status TEXT DEFAULT 'New',
  catalog_shared INTEGER DEFAULT 0,
  date INTEGER NOT NULL
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