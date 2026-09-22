# HANDOFF — Delta sync + WebSocket implementation

**Read this first.** Status of the "reduce Cloudflare invocations via delta
sync + hibernating WebSockets" work. Design: `docs/ARCHITECTURE.md`.
Rollout/rollback/measurement: `docs/DEPLOYMENT.md`. Earlier polling-reduction
work: `CHANGES.md`.

## Status (2026-09-22): implementation complete, NOT deployed

Everything is uncommitted working-tree changes on `main` (base `5f50372`).
Nothing has been deployed or committed.

Verification, all run locally:

| Check | Result |
|---|---|
| `npx tsc -p tsconfig.json --noEmit` (worker) | clean |
| `npx tsc -p tsconfig.web.json --noEmit` (web) | clean |
| `npm run build` (from `frontend/`) | clean |
| `npx wrangler deploy --dry-run` (repo root) | bundles; all bindings resolve |
| `npm test` (from `frontend/`) | 37/37: scheduler, merge, sync client, access/tickets, **local D1 integration** |
| `npm run test:smoke` | 13/13 against `wrangler dev` running the real Worker + SyncHub |
| Headless Chromium against local `wrangler dev` (ad-hoc script, not in repo) | 2 tabs, 1 socket; a server write reached the visible tab with 1 `/api/sync` and 0 list reloads; leader hand-over after closing the leader tab; no 5xx |

Not verifiable locally: hibernation eviction and wake-up, real Analytics
Engine writes, edge WebSocket idle timeouts, behaviour at scale, and actual
invocation savings (measure after rollout, per DEPLOYMENT.md).

## Done in this session (on top of the earlier backend work)

**Config / schema:** DO binding + `v1` migration, AE dataset and flag vars
(all `off`) in both `wrangler.jsonc` and `frontend/wrangler.json`;
`change_log` DDL and indexes in `schema.sql`; 30-day retention
(`pruneChangeLog`, opportunistic from `/api/sync`, keeps the newest row).

**Bugs found and fixed in the backend written earlier:**

1. **`trackedEnv` broke every `db.batch()`**: it passed wrapper objects to
   D1, which then failed with a 500. Since every mutation now uses a batch, all
   writes would have failed after deploy, *regardless of flags*. Found by the
   smoke test and fixed in `workerEnv.ts`.
2. The realtime secret fell back to a **predictable string in source**, so
   anyone could forge tickets. It now fails closed (`realtimeEnabled()`
   requires a ≥ 32-char `REALTIME_SECRET`).
3. `applyMessageStatus` queried `participant_ids` on `messages`, a column
   that doesn't exist (it would have thrown after the UPDATE), wasn't atomic,
   and its third branch was a no-op. Replaced by the shared
   `statusUpgradeStmts`: atomic, forward-only, delivered|read only,
   participant-checked. The hub `ack` now also requires messages to belong to
   the named conversation.
4. The file cookie's `Path=/api/files` meant `/auth/me` could never see it (so
   re-issue was dead code) and logout never deleted its KV token. The path is
   now `/api`, with `fileCookieValid()`.
5. D1's 100-bound-parameter limit: the `IN (…)` lists in `/api/sync` could
   reach 500 ids. They're now chunked. Records were keyed by id only across
   entities; they're now keyed by `entity|id`.
6. With an empty `change_log`, `cursor=0` meant "boundary", so a client
   stayed in the snapshot loop forever. A missing cursor now means boundary;
   `0` is a real cursor. Cursors ahead of the log (DB reset,
   `WORKSPACE_ID` change) return `resyncRequired`.
7. The hub lease was only checked on inbound frames (edge-answered pings
   never reach the hub), so expired sockets kept getting events. Fan-out and
   presence now enforce it. `reauth` can no longer switch the socket's user.
   The hub no longer re-runs DDL on every ack. Removed the unused imports and
   the duplicate route segment.

**Frontend (new):** `services/syncMerge.ts`, `services/deltaSyncClient.ts`,
`services/realtimeService.ts`, wired through `hooks/useEntityData.ts`
(`syncAll`, delta-aware scheduler, 10-min safety interval while connected,
presence from the hub), `App.tsx` (startup/login use `syncAll`),
`views/PaymentsView.tsx` (refetch on the `payments` signal), `hooks/useAuth.ts`
(KV heartbeat skipped while connected), `sw.js` (push triggers
`SYNC_REQUIRED`). `refreshScheduler` accepts a function interval.

**Deliberate deviation from the earlier plan:** the sync cursor is kept **in
memory per tab**, not in localStorage per identity. A cursor shared between
tabs lets one tab advance past changes another tab's state never received.
Every tab takes a full copy at startup anyway, so persisting the cursor
would save nothing.

## Still open (optional / next)

- Typing indicator UI in `MessagingView.tsx`. The plumbing exists
  (`realtimeService.sendTyping`, `typing` events), but there's no UI yet.
- `AttendanceView` ignores `attendance`/`store` invalidations (it loads its own
  data). Wire it up if live attendance matters.
- Startup still does a full list load per tab (first sync pass). Starting from
  the offline copy plus a persisted per-tab cursor would cut that too, but it
  needs `db.ts` to become per-identity first.
- Commit, then roll out per `docs/DEPLOYMENT.md` (flags one at a time;
  baseline measurement first).
