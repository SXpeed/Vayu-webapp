-- Platform database, migration 0008: what organizations pay the platform for
-- their plan (platform/billing.ts).
--
-- One row per checkout: a Razorpay order for one plan version and one period
-- (a month or a year), in the platform's own Razorpay account (connected in
-- the control centre, kept in platform_settings). Never an organization's
-- account: that one is for its customers' payments.
--
-- A row is applied to the subscription exactly once: applied_token is set by
-- the first confirmation (browser, webhook or recheck), and the subscription
-- change in the same transaction only happens when that token is its own.

CREATE TABLE billing_payments (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  plan_version_id     TEXT NOT NULL REFERENCES plan_versions (id),
  plan_key            TEXT NOT NULL,
  plan_name           TEXT NOT NULL,
  period              TEXT NOT NULL CHECK (period IN ('monthly', 'annual')),
  amount              INTEGER NOT NULL,          -- minor units (paise)
  currency            TEXT NOT NULL DEFAULT 'INR',
  mode                TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  key_id              TEXT NOT NULL,             -- the Razorpay key the order was made with
  razorpay_order_id   TEXT NOT NULL UNIQUE,
  razorpay_payment_id TEXT,                      -- the payment that settled it
  status              TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'attempted', 'paid')),
  method              TEXT,
  details             TEXT,                      -- JSON: every payment on the order, as last fetched
  created_by          TEXT,
  created_by_name     TEXT,
  created_at          INTEGER NOT NULL,
  paid_at             INTEGER,
  checked_at          INTEGER,
  applied_token       TEXT,
  applied_at          INTEGER,
  period_start        INTEGER,
  period_end          INTEGER
);
CREATE INDEX billing_payments_org_idx ON billing_payments (org_id, created_at DESC);
CREATE INDEX billing_payments_status_idx ON billing_payments (status, created_at DESC);
