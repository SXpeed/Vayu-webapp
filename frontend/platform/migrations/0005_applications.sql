-- Platform database, migration 0005: business applications, the notification
-- outbox, and platform-level account status.
--
-- Approval, provisioning and subscription are tracked separately on purpose:
-- approving an application does not by itself mean a workspace exists or
-- that anything has been paid.
--   applications.review_status        what the provider decided
--   applications.provisioning_status  whether the workspace was created
--   subscriptions.status              billing (migration 0004)

CREATE TABLE applications (
  id                        TEXT PRIMARY KEY,
  user_id                   TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  review_status             TEXT NOT NULL DEFAULT 'draft'
                            CHECK (review_status IN ('draft', 'pending_review', 'needs_information', 'approved', 'rejected', 'withdrawn')),
  provisioning_status       TEXT NOT NULL DEFAULT 'not_started'
                            CHECK (provisioning_status IN ('not_started', 'provisioning', 'provisioned', 'failed')),

  -- What the applicant tells us.
  business_name             TEXT NOT NULL DEFAULT '',
  business_type             TEXT NOT NULL DEFAULT '',
  owner_name                TEXT NOT NULL DEFAULT '',
  phone                     TEXT NOT NULL DEFAULT '',
  address_line              TEXT NOT NULL DEFAULT '',
  city                      TEXT NOT NULL DEFAULT '',
  region                    TEXT NOT NULL DEFAULT '',
  postal_code               TEXT NOT NULL DEFAULT '',
  country                   TEXT NOT NULL DEFAULT '',
  timezone                  TEXT NOT NULL DEFAULT '',
  website                   TEXT NOT NULL DEFAULT '',
  tax_id                    TEXT NOT NULL DEFAULT '',
  expected_employees        INTEGER,
  expected_stores           INTEGER,
  requested_plan_key        TEXT NOT NULL DEFAULT '',
  billing_cycle             TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly', 'annual')),
  applicant_note            TEXT NOT NULL DEFAULT '',

  -- What the provider decides.
  provider_message          TEXT,            -- latest request for information or rejection reason
  approved_plan_version_id  TEXT,
  billing_exception_reason  TEXT,
  org_id                    TEXT,
  provisioning_error        TEXT,

  submitted_at              INTEGER,
  decided_at                INTEGER,
  decided_by                TEXT,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL
);
CREATE INDEX applications_status_idx ON applications (review_status, submitted_at DESC);

-- One open application per person, even under a double click or two tabs.
CREATE UNIQUE INDEX applications_one_open_per_user ON applications (user_id)
  WHERE review_status IN ('draft', 'pending_review', 'needs_information');

-- Everything that happened to an application, in order, for both sides.
CREATE TABLE application_events (
  id              TEXT PRIMARY KEY,
  application_id  TEXT NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  at              INTEGER NOT NULL,
  actor_user_id   TEXT,
  actor_kind      TEXT NOT NULL CHECK (actor_kind IN ('applicant', 'provider_admin', 'system')),
  action          TEXT NOT NULL,
  message         TEXT,
  -- Whether the applicant sees this event on their status page.
  visible_to_applicant INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX application_events_app_idx ON application_events (application_id, at);

-- Notifications waiting to go out. Written in the same step as the change
-- that causes them, so a notice is never lost, and keyed so a retried
-- request never queues the same notice twice. Delivery happens separately
-- once an email provider is configured; until then rows wait here and the
-- control panel shows them.
CREATE TABLE notification_outbox (
  id           TEXT PRIMARY KEY,
  dedupe_key   TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL,
  recipient    TEXT NOT NULL,
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  sent_at      INTEGER
);
CREATE INDEX notification_outbox_status_idx ON notification_outbox (status, created_at);

-- Platform-level account status. A disabled account cannot start a session,
-- and its existing sessions are revoked when it is disabled.
CREATE TABLE platform_user_status (
  user_id     TEXT PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE,
  status      TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  reason      TEXT,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);
