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
