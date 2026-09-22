-- Platform database, migration 0002: organizations, memberships, and each
-- organization's own payment-provider connection.

-- The organization registry. Lifecycle status only; approval, subscription
-- and provisioning get their own tables in later migrations.
CREATE TABLE organizations (
  id             TEXT PRIMARY KEY,
  slug           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  business_type  TEXT NOT NULL CHECK (business_type IN ('artist', 'studio', 'gallery', 'store', 'multi_store', 'other')),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  country        TEXT,
  timezone       TEXT,
  is_demo        INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  created_by     TEXT,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX organizations_status_idx ON organizations (status);

-- A person's membership of one organization. Identity (the "user" table) is
-- separate: one person can belong to several organizations.
CREATE TABLE memberships (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'manager', 'staff')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  -- JSON array of store ids this member may work in; NULL = all stores.
  store_access  TEXT,
  created_at    INTEGER NOT NULL,
  created_by    TEXT,
  updated_at    INTEGER NOT NULL,
  UNIQUE (org_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

-- Backstop for the API's last-owner rule: the database itself refuses a change
-- that would leave an organization without an active owner.
CREATE TRIGGER memberships_keep_an_owner BEFORE UPDATE OF role, status ON memberships
WHEN OLD.role = 'owner' AND OLD.status = 'active'
  AND (NEW.role <> 'owner' OR NEW.status <> 'active')
  AND (SELECT COUNT(*) FROM memberships
       WHERE org_id = OLD.org_id AND role = 'owner' AND status = 'active' AND id <> OLD.id) = 0
BEGIN
  SELECT RAISE(ABORT, 'an organization must keep at least one active owner');
END;

CREATE TRIGGER memberships_keep_an_owner_on_delete BEFORE DELETE ON memberships
WHEN OLD.role = 'owner' AND OLD.status = 'active'
  AND (SELECT status FROM organizations WHERE id = OLD.org_id) <> 'closed'
  AND (SELECT COUNT(*) FROM memberships
       WHERE org_id = OLD.org_id AND role = 'owner' AND status = 'active' AND id <> OLD.id) = 0
BEGIN
  SELECT RAISE(ABORT, 'an organization must keep at least one active owner');
END;

-- An organization's own payment-provider account, used to collect payments
-- from ITS customers. Separate from the platform's own subscription billing.
-- Secrets are AES-GCM encrypted with PAYMENT_SECRETS_KEY and bound to this
-- org + provider + field, so a ciphertext can't be moved to another org.
CREATE TABLE org_payment_integrations (
  org_id              TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  provider            TEXT NOT NULL CHECK (provider IN ('razorpay')),
  mode                TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  key_id              TEXT NOT NULL,
  key_secret_enc      TEXT NOT NULL,
  webhook_secret_enc  TEXT,
  status              TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified', 'verified', 'failed', 'disabled')),
  last_verified_at    INTEGER,
  last_error          TEXT,
  connected_by        TEXT,
  connected_at        INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (org_id, provider)
);

-- Every payment webhook received, once. The unique key makes a retried or
-- replayed delivery a no-op.
CREATE TABLE payment_webhook_events (
  org_id       TEXT NOT NULL,
  provider     TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  event_type   TEXT,
  received_at  INTEGER NOT NULL,
  payload      TEXT NOT NULL,
  processed_at INTEGER,
  PRIMARY KEY (org_id, provider, event_id)
);
