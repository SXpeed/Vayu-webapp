# One database per organization

Each organization's business data lives in its **own** SQLite database, inside
its own Durable Object named by the organization id. Isolation is physical: code
holding one organization's database cannot reach another's rows, so a forgotten
`WHERE org_id = ?` can't leak data across businesses. It also scales without a
ceiling — nothing is shared between organizations, so load grows per
organization instead of piling onto one table.

| Piece | Where |
|---|---|
| Schema + migrations | `frontend/platform/orgSchema.ts` |
| The database object | `frontend/platform/orgStore.ts` (`OrgStore`) |
| Request pipeline + routes | `frontend/platform/orgApi.ts` |
| Bindings | `wrangler.jsonc`, `frontend/wrangler.json` (`ORG_STORE`, migration tag `v2`) |
| Tests | `frontend/tests/orgStore.integration.test.mjs` (runs a real Worker) |

## Why Durable Objects and not a D1 database per organization

D1 databases must be listed in configuration before deploying (about 5,000 per
Worker), and creating them at runtime needs an account-wide API token inside
ordinary requests. Durable Objects are unlimited in number, are addressed by
name, need no credentials, and hold up to 10 GB each. Cloudflare's own limits
pages confirm both.

## The request pipeline

Every call to `/api/v2/org/:orgId/*` goes through the same order, failing closed
at each step (`resolveOrgContext`):

1. **Session** — a valid platform sign-in, or 401.
2. **Membership** — one query returns the person's role in that organization and
   the organization's status. Not a member and "no such organization" return the
   **same** 403, so the API never reveals which organizations exist.
3. **Organization status** — suspended or closed is refused before any database
   is opened.
4. **Role** — staff may read and edit; deleting and reading the business audit
   log need manager or above.
5. **The database** — opened by organization id. There is no fallback to a
   default organization: unresolved means refused.

The id in the URL is only a lookup key; it grants nothing without a membership
row. Membership is re-checked on every request, so disabling a member takes
effect immediately, even with a valid session already in the browser.

## Concurrent edits (tested, not assumed)

- **Saving an artwork** carries the version it was read at. If someone else saved
  first, the save is refused with `conflict` instead of silently overwriting
  their work.
- **Selling or reserving** uses a conditional update: the status changes only if
  it is still what the user saw. Two people marking the same artwork sold at the
  same moment: one succeeds, the other is told it is already sold. Realtime
  updates do **not** prevent this by themselves, which is why the check is in the
  database operation.

## Schema changes

`ORG_MIGRATIONS` in `orgSchema.ts` is an append-only list. Each organization's
database records which versions it has applied and runs any it is missing the
next time it is opened, so a deploy never re-runs a migration and organizations
that are idle migrate when they are next used. Add a new entry; never edit an
applied one.

## What lives here so far

`artworks` (with version and audit columns) and `org_audit`, the organization's
own business audit log. The rest of the business tables (collections, catalogs,
contacts, inquiries, invoices, messages, attendance) move over with the app
migration, using the same pattern.

## Current API

```
GET    /api/v2/me/orgs                               organizations I can open
GET    /api/v2/org/:id                               name, my role, storage info
GET    /api/v2/org/:id/artworks?limit&offset
POST   /api/v2/org/:id/artworks                      create
GET    /api/v2/org/:id/artworks/:artworkId
PUT    /api/v2/org/:id/artworks/:artworkId           needs the version read
POST   /api/v2/org/:id/artworks/:artworkId/status    {expected, status}
DELETE /api/v2/org/:id/artworks/:artworkId           manager and above
GET    /api/v2/org/:id/audit                         manager and above
```

## Not done yet

- **The app still uses the old shared database.** These routes exist alongside
  it. Moving the app's screens over, and migrating Vayu's data in as the first
  organization, is the next phase.
- **Realtime per organization:** the existing hub is still workspace-wide. It
  moves into each organization's object, so updates can't cross organizations
  even in principle.
- **Backups and export per organization:** Durable Object storage has
  Cloudflare's own point-in-time recovery, but independent exports to R2 still
  need building.
- **Plan limits** (item counts, storage) are not enforced yet.
