# Moving Vayu in as the first organization

The existing app keeps one business's data in a shared database (`VAYU_DB`) and
its users in KV. This copies both into **one organization**: business rows into
that organization's own database, users into platform accounts plus memberships.

Code: `frontend/platform/legacyImport.ts`. Tests:
`frontend/tests/legacyImport.integration.test.mjs`.

## What it guarantees

- **Nothing is moved automatically.** It runs only when a provider admin asks,
  never on deploy or startup.
- **Dry run is the default.** A run with no `dryRun: false` writes nothing
  anywhere and returns the full report.
- **The original database is never modified.** Rows are read, not moved, so the
  current app keeps working throughout and rollback is "stop using the new
  one".
- **Ids and timestamps are preserved**, so references between records (artwork
  ids inside catalogs, sender ids on messages, invoice contents) still line up.
- **Passwords carry over.** The old PBKDF2 hashes verify against the new login,
  so nobody resets a password.
- **Safe to retry.** A row already present counts as "already there" and is left
  alone. Re-running after a failure resumes; it never duplicates.
- **Failures are visible.** Only "this row already exists" is tolerated; any
  other database error stops the import and is reported. (This caught a real
  bug: the organization table requires `updated_at`, which the old table lacks,
  and an earlier "insert or ignore" version silently dropped every row.)
- **Every attempt is recorded** in `org_imports` and the platform audit log.

## Roles

| Legacy role | Becomes |
|---|---|
| the email passed as `ownerEmail` | owner (admin if the organization already has an owner) |
| `admin` | admin |
| anything else (including custom roles) | staff |

Custom roles from the old app are not carried over yet; those people arrive as
staff and can be adjusted in the control panel.

## How to run it

1. In the control panel, create the organization (for example "Vayu Design")
   with an owner account.
2. Dry run, and read the report:
   ```
   POST /api/v2/admin/orgs/<org id>/import-legacy
   { "ownerEmail": "the.owner@example.com" }
   ```
   The report lists users found/created, memberships, per-table source counts,
   and any warnings (missing tables, users without a password, emails that
   already have a platform account).
3. Check the numbers against the app.
4. Real import (needs a sign-in newer than 30 minutes):
   ```
   POST /api/v2/admin/orgs/<org id>/import-legacy
   { "ownerEmail": "the.owner@example.com", "dryRun": false }
   ```
5. Verify: `GET /api/v2/admin/orgs/<org id>/import-legacy` shows the attempt and
   its counts; signing in as an imported member and opening the organization
   shows their data.

Before doing this against production data, take a backup: D1 Time Travel covers
the shared database, and the import itself only reads from it.

## What still has to happen after the import

- **The app screens still read the old shared database.** Pointing them at the
  organization's database is the next step; until then the import is a copy, and
  new work continues in the old database. Do the real import once, immediately
  before switching the app over, so nothing written in between is missed.
- **Files (R2) are not copied.** Image URLs keep pointing at
  `/api/files/uploads/...`, which still resolves. Per-organization file
  namespaces and ownership records come with the file-security work.
- **Custom roles and per-person permissions** from the old app are not carried
  over yet.
- **Realtime and push** are still workspace-wide.
