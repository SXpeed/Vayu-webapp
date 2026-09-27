-- Platform database, migration 0009: limited-time offers on plans, and what
-- a plan payment was discounted by (platform/offers.ts, platform/billing.ts).
--
-- An offer belongs to the plan, not a version: versions are frozen contracts,
-- and an offer is a promotion on top of whatever the plan's live price is.
-- One offer per plan at a time; it runs from starts_at until ends_at.

CREATE TABLE plan_offers (
  plan_id           TEXT PRIMARY KEY REFERENCES plans (id) ON DELETE CASCADE,
  percent_off       INTEGER NOT NULL CHECK (percent_off BETWEEN 1 AND 90),
  label             TEXT NOT NULL DEFAULT '',
  starts_at         INTEGER NOT NULL,
  ends_at           INTEGER NOT NULL,
  -- 0: only organizations choosing this plan (new to it); 1: renewals too.
  include_renewals  INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  created_by        TEXT,
  CHECK (ends_at > starts_at)
);

-- The price before the offer, and the offer applied, on each plan payment.
ALTER TABLE billing_payments ADD COLUMN list_amount INTEGER;
ALTER TABLE billing_payments ADD COLUMN discount_percent INTEGER;
ALTER TABLE billing_payments ADD COLUMN offer_label TEXT;
