# Organization isolation — audit and status

Audit of 2026-10-09 against the "strict multi-organisation data isolation"
brief. It records how isolation is enforced today, what this audit fixed, how
each part is tested, and what is still a known limit.

## How isolation is enforced

| Layer | Mechanism | Where |
|---|---|---|
| Request → organization | `/api/o/<orgId>/…`; the organization must exist and be active; the platform sign-in **and** membership are checked on every request; non-member, unknown and suspended organizations get the same 404 | `orgApp.ts` (`openOrgRequest`) |
| Database | Each organization has its **own SQLite database** (a Durable Object named by its id). No query can reach another organization's rows, so record ids from another organization simply do not exist (no IDOR / BOLA / cross-tenant foreign keys possible). The organization that owns the original app's data uses the original D1. | `orgStorage.ts`, `orgAppDb.ts` |
| Settings (KV) | Every key prefixed `org:<id>:` | `orgStorage.ts` (`prefixedKv`) |
| Files (R2) | Every key prefixed `orgs/<id>/`; served only after the membership check plus the private file cookie (`FILE_AUTH=on`); `Cache-Control: private` | `orgStorage.ts`, `worker.ts` (`handleFileGet`), `fileAuth.ts` |
| Roles | Role belongs to the membership in that organization; enforced on the server per action | `orgApp.ts`, `access.ts`, `permissions.ts` |
| Realtime & sync | One hub and one change log per organization | `realtime.ts`, `deltaSync.ts` |
| Scheduled jobs | Each organization processed with its own storage, one at a time | `worker.ts` (`reconcileAllWorkspaces`) |
| Webhooks | Razorpay events verified with that organization's own secret | `platform/payments.ts` |
| API responses | `Cache-Control: no-store` on every app and platform API answer (files keep `private`) | `worker.ts` (`withServerTiming`), `platform/http.ts` |
| Server memory | 30-second memo of sign-in and membership, keyed `orgId|userId`, positive answers only, cleared on this isolate by any account/team change | `orgApp.ts` |
| Device storage | Saved copies keyed `<list>@<orgId>`; all removed at any sign-out | `services/db.ts` |
| Switching | Switch reloads the app (no in-flight request or state survives); entering an organization loads only its own saved copy | `components/AccountCards.tsx`, `App.tsx` (`handleLogin`) |

## Fixed in this audit

1. **Switching showed the previous organization's data.** The sign-in screen
   opened on the device copy that belongs to no organization, and entering an
   organization only merged changes into it. `handleLogin` now loads that
   organization's own copy first. Verified on the local test copy with another
   organization's data planted in the shared copy.
2. **Sign-out left other organizations' data on the device.** Only the open
   organization's copy was removed, and a sign-out by the server (removed from
   the organization, device limit, session ended) removed none.
   `db.clearSavedCopies()` now removes every organization's copy on every
   sign-out path (unsent offline sales stay: they exist nowhere else).
3. **A sale's carried-over tags crossed organizations.** The last sale's tags
   were stored once per device, so organization B's next sale was pre-filled
   with organization A's event tag. Now stored per organization.
4. **Tabs in different organizations shared one realtime socket.** A person's
   id is the same in every organization with its own storage, and tabs elected
   one leader per id: a tab in B followed A's socket (A's presence and typing,
   none of B's live updates). Tab groups are now per organization.
5. **Notifications from another organization showed.** The phone hid only
   notifications for a different person; ids repeat across organizations.
   Notifications now name their organization and the service worker hides one
   from another organization than the one open. Devices and notifications that
   name none (older versions, the original sign-in) behave as before.
6. **API answers had no cache policy.** Now `no-store` by default.

## Tests

| Brief scenario | Test |
|---|---|
| 1, 6, 15, 17 — two organizations, other ids, same URLs | `orgApp` "one organization never sees another", "the address alone opens nothing"; `orgStore` "business data stays inside its own organization"; `platformOrgs` "ids from another organization are not found" |
| 5, 18 — manipulated organization id / privilege | `orgApp` "the address alone opens nothing"; `orgStore` "roles are enforced on the server"; `platformOrgs` "organization owners are not provider admins" |
| 8 — realtime per organization | `orgApp` "delta sync and realtime run per organization" |
| 9, 10 — removed member, role change | `orgApp` "removing someone takes effect on their next request", "an app role change moves the platform role with it"; `orgStore` "a disabled member loses access…" |
| 11 — files through manipulated URLs | `orgApp` "files are stored per organization…"; `fileAuth` suite |
| 7, 16 — caches | `orgApp` "an organization's data is never kept by a browser or shared cache"; `tenantStorage` "signing out removes every organization's saved copy" |
| 14 — data after logout | `tenantStorage`; `fileAuth` "signing out ends the file cookie" |
| Notifications across organizations | `swPush` "the same person working in another organization does not see it" |
| Carried-over form data | `tenantStorage` "a sale's carried-over tags stay in their own workspace" |

`npm test` (356 tests) must pass before release; CI runs it before every deploy.

## Known limits (not fixed)

- **Removal lag up to 30 s on other isolates.** The access memo (accepted
  2026-10-01 for speed) means a removed member keeps access on another
  server instance for at most 30 seconds. Same instance: immediate.
- **Two tabs, one stored workspace choice.** Tabs keep their own organization
  in memory, but `as_workspace` is shared, so reloading a tab opens the
  organization last chosen in any tab. Not a leak (the person is a member of
  both); can surprise.
- **Realtime tab grouping has no automated test** (needs two browser tabs);
  verified by reading the code only.
- **Not covered by this audit:** the control centre's own operator access (a
  provider admin can see every organization by design), and PostgreSQL-style
  RLS (the app uses one database per organization instead, which is stronger
  isolation for this design).

## Rollback

No database or storage migration was made. Revert the commit. Devices then go
back to the old sign-out behaviour; notifications keep working (the `org`
field is optional on both sides).
