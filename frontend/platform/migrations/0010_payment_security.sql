-- Payment security hardening (docs/PAYMENT_SECURITY.md).
--
-- Additive only: every new column is nullable or has a default, so the Worker
-- version before this migration keeps working against the migrated database
-- (rollback is a code rollback; nothing here has to be undone).

-- Webhook secret rotation: the previous secret stays valid until
-- webhook_secret_prev_until, for Razorpay's retries of events sent before the
-- change (they keep the old signature). Encrypted like the current one.
ALTER TABLE org_payment_integrations ADD COLUMN webhook_secret_prev_enc TEXT;
ALTER TABLE org_payment_integrations ADD COLUMN webhook_secret_prev_until INTEGER;

-- Test-mode keys can create customer payment links only when a provider
-- admin has allowed it for this account (audited). Live keys ignore it.
ALTER TABLE org_payment_integrations ADD COLUMN allow_test_links INTEGER NOT NULL DEFAULT 0;

-- Webhook health, from VERIFIED deliveries only: an unauthenticated caller
-- can't move any of these numbers.
CREATE TABLE payment_webhook_health (
  org_id                   TEXT NOT NULL,
  provider                 TEXT NOT NULL,
  last_verified_at         INTEGER,
  last_event_type          TEXT,
  verified_count           INTEGER NOT NULL DEFAULT 0,
  -- Signed with the previous secret during a rotation overlap.
  verified_with_previous   INTEGER NOT NULL DEFAULT 0,
  processing_failures      INTEGER NOT NULL DEFAULT 0,
  last_processing_error    TEXT,
  last_processing_error_at INTEGER,
  PRIMARY KEY (org_id, provider)
);

-- Rejected deliveries, counted per hour and per webhook address. Telemetry
-- only: never used to mark an account unhealthy or to alert anyone, since
-- anyone on the internet can send an invalid signature.
CREATE TABLE webhook_rejections (
  hour_start  INTEGER NOT NULL,
  scope       TEXT NOT NULL,
  reason      TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour_start, scope, reason)
);
