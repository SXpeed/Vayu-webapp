-- Platform database, migration 0007: organizations in the app.
--
-- The app (app.ateliersupport.com) now signs people in with their platform
-- account and opens the organization they choose (frontend/orgApp.ts).

-- Where an organization's app data lives:
--   'own'      its own database (a Durable Object named by the organization id),
--              and its own slice of file storage and settings. Every new
--              organization.
--   'original' the original app's database, files and settings (Vayu's data,
--              which predates organizations). At most one organization.
ALTER TABLE organizations ADD COLUMN app_storage TEXT NOT NULL DEFAULT 'own' CHECK (app_storage IN ('own', 'original'));
CREATE UNIQUE INDEX organizations_one_original ON organizations (app_storage) WHERE app_storage = 'original';

-- The id this member has inside the organization's app data, when it differs
-- from their platform account id: someone who already had a platform account
-- when the original app's people were brought in keeps their old app id, so
-- their messages, check-ins and history stay theirs. NULL = the account id.
ALTER TABLE memberships ADD COLUMN app_user_id TEXT;
CREATE UNIQUE INDEX memberships_app_user ON memberships (org_id, app_user_id) WHERE app_user_id IS NOT NULL;

-- Invitations to join an organization. The link carries a random token; only
-- its hash is stored. Single use, tied to one email address, and it expires.
CREATE TABLE invitations (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  -- Platform role (who may manage the team) and the app role (what they can
  -- see and do in the app: 'admin', 'user' or a custom role id).
  role         TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'staff')),
  app_role     TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
  invited_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  accepted_at  INTEGER,
  accepted_by  TEXT
);
CREATE INDEX invitations_org_idx ON invitations (org_id, status);
-- One open invitation per person per organization; sending again replaces it.
CREATE UNIQUE INDEX invitations_one_pending ON invitations (org_id, email) WHERE status = 'pending';
