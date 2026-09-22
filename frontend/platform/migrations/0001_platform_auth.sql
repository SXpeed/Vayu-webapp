-- Platform database (PLATFORM_DB), migration 0001: identity and provider admin.
--
-- This is the central platform database, separate from any organization's
-- business data. Apply with:
--   npx wrangler d1 migrations apply PLATFORM_DB --local -c wrangler.json
--
-- The first six tables are Better Auth's schema (better-auth 1.7.5 with the
-- twoFactor plugin and database rate limiting), generated with its
-- getMigrations() and kept verbatim so the library finds the columns it expects.

create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null, "twoFactorEnabled" integer);

create table "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);

create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);

create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);

create table "twoFactor" ("id" text not null primary key, "secret" text not null, "backupCodes" text not null, "userId" text not null references "user" ("id") on delete cascade, "verified" integer, "failedVerificationCount" integer, "lockedUntil" date);

create table "rateLimit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);

create index "session_userId_idx" on "session" ("userId");
create index "account_userId_idx" on "account" ("userId");
create index "verification_identifier_idx" on "verification" ("identifier");
create index "twoFactor_secret_idx" on "twoFactor" ("secret");
create index "twoFactor_userId_idx" on "twoFactor" ("userId");

-- One Google (or other provider) identity can belong to only one user.
create unique index "account_provider_identity_idx" on "account" ("providerId", "accountId");

-- Platform-wide settings, one JSON value per key (e.g. 'login_methods').
CREATE TABLE platform_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);

-- Provider (ateliersupport staff) administrators. Being a provider admin is a
-- row here, never a flag an organization admin can set: no organization API
-- writes this table.
CREATE TABLE provider_admins (
  user_id     TEXT PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('owner', 'admin', 'support')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at  INTEGER NOT NULL,
  created_by  TEXT
);

-- Platform audit trail. Append-only: no API updates or deletes rows, and the
-- triggers below make the database refuse it too (retention cleanup may only
-- remove rows older than 365 days).
CREATE TABLE platform_audit (
  id              TEXT PRIMARY KEY,
  at              INTEGER NOT NULL,
  actor_user_id   TEXT,
  actor_kind      TEXT NOT NULL CHECK (actor_kind IN ('provider_admin', 'user', 'system')),
  action          TEXT NOT NULL,
  target_type     TEXT,
  target_id       TEXT,
  org_id          TEXT,
  details         TEXT,
  ip              TEXT
);
CREATE INDEX platform_audit_at_idx ON platform_audit (at DESC);
CREATE INDEX platform_audit_target_idx ON platform_audit (target_type, target_id);

CREATE TRIGGER platform_audit_no_update BEFORE UPDATE ON platform_audit
BEGIN
  SELECT RAISE(ABORT, 'platform_audit is append-only');
END;

CREATE TRIGGER platform_audit_retention_only BEFORE DELETE ON platform_audit
WHEN OLD.at > (CAST(strftime('%s', 'now') AS INTEGER) - 365 * 86400) * 1000
BEGIN
  SELECT RAISE(ABORT, 'platform_audit rows younger than 365 days cannot be deleted');
END;
