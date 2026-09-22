-- Platform database, migration 0004: plans, versions, subscriptions,
-- entitlement overrides and usage counters.
--
-- Deliberately five separate things:
--   plans                  the product ("Studio")
--   plan_versions          what it contained when someone signed up
--   subscriptions          which version an organization is on, and its state
--   entitlement_overrides  a documented exception for one organization
--   usage_counters         what an organization actually uses
--
-- Editing a plan therefore cannot silently change an existing contract: a
-- change means a NEW version, and organizations move to it explicitly.

CREATE TABLE plans (
  id          TEXT PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,          -- stable machine name, e.g. "studio"
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired', 'archived')),
  is_public   INTEGER NOT NULL DEFAULT 0,    -- shown on the marketing site
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  created_by  TEXT,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE plan_versions (
  id             TEXT PRIMARY KEY,
  plan_id        TEXT NOT NULL REFERENCES plans (id) ON DELETE CASCADE,
  version        INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  billing_type   TEXT NOT NULL CHECK (billing_type IN ('free', 'trial', 'paid', 'custom')),
  currency       TEXT NOT NULL DEFAULT 'INR',
  price_monthly  INTEGER NOT NULL DEFAULT 0, -- minor units (paise)
  price_annual   INTEGER NOT NULL DEFAULT 0,
  trial_days     INTEGER NOT NULL DEFAULT 0,
  limits         TEXT NOT NULL DEFAULT '{}', -- JSON, see platform/plans.ts
  notes          TEXT,
  created_at     INTEGER NOT NULL,
  created_by     TEXT,
  published_at   INTEGER,
  UNIQUE (plan_id, version)
);

-- A published version is a contract: it must not change afterwards.
CREATE TRIGGER plan_versions_frozen BEFORE UPDATE ON plan_versions
WHEN OLD.status = 'published'
  AND (NEW.limits <> OLD.limits OR NEW.price_monthly <> OLD.price_monthly
       OR NEW.price_annual <> OLD.price_annual OR NEW.currency <> OLD.currency
       OR NEW.billing_type <> OLD.billing_type OR NEW.trial_days <> OLD.trial_days)
BEGIN
  SELECT RAISE(ABORT, 'a published plan version cannot be changed; publish a new version instead');
END;

CREATE TABLE subscriptions (
  org_id              TEXT PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
  plan_version_id     TEXT REFERENCES plan_versions (id),
  status              TEXT NOT NULL DEFAULT 'none'
                      CHECK (status IN ('none', 'trialing', 'payment_required', 'active', 'past_due', 'canceled')),
  trial_ends_at       INTEGER,
  current_period_end  INTEGER,
  payment_waived      INTEGER NOT NULL DEFAULT 0,
  waiver_reason       TEXT,
  external_ref        TEXT,                  -- provider subscription id, later
  started_at          INTEGER,
  updated_at          INTEGER NOT NULL,
  updated_by          TEXT
);

-- A documented exception for one organization, e.g. "50 seats until March".
CREATE TABLE entitlement_overrides (
  org_id      TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,                 -- JSON scalar
  reason      TEXT NOT NULL,
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL,
  created_by  TEXT,
  PRIMARY KEY (org_id, key)
);

-- What an organization actually uses. Seats are counted from memberships;
-- item and storage counts are reported by the organization's own database.
CREATE TABLE usage_counters (
  org_id      TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (org_id, key)
);
