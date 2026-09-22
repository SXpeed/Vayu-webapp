-- Platform database, migration 0003: record of data imports into an
-- organization (for example moving the original shared app database in as the
-- first organization). One row per attempt, so a retried import is visible.
CREATE TABLE org_imports (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  source       TEXT NOT NULL,
  mode         TEXT NOT NULL CHECK (mode IN ('dry_run', 'run')),
  status       TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  counts       TEXT,
  error        TEXT,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  started_by   TEXT
);
CREATE INDEX org_imports_org_idx ON org_imports (org_id, started_at DESC);
