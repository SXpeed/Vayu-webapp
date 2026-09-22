# What we are changing

**Status:** The local polling-reduction work has been **rolled back** so the
upcoming delta-sync / WebSocket implementation (the "Claude implementation")
can be tested from a clean `main` (commit `5f50372`). Nothing was lost — the
rolled-back work is preserved in git stash `stash@{0}` (see bottom). This file
is the only change kept in the working tree.

## 1. Why

The deployment burns Worker invocations with per-tab polling: three 15-second
pollers in `useEntityData`, 15-second payment-link polling in `PaymentsView`,
and a 30-second presence heartbeat in `useAuth`. With several tabs open per
user this multiplies into thousands of invocations per user per day for data
that rarely changes.

## 2. The rolled-back changes (per file)

### NEW `frontend/services/refreshScheduler.ts`
A single-flight refresh loop used by every caller:
- One refresh runs at a time; focus / online / visibility /
  BroadcastChannel events request a refresh but **cannot** bypass the
  cooldown or the failure backoff (this was the "request storm" risk).
- Exponential backoff on failures: `intervalMs × 2^failures`, capped at
  15 minutes; reset on success.
- Hidden or offline tabs do no work; the next eligible event resumes them.
- `now` / `setTimer` / `clearTimer` are injectable, which is what the tests use.

### `frontend/hooks/useEntityData.ts`
- **Removed** the three 15-second pollers (conversations+messages,
  inquiry messages, all entities).
- **Added** a per-view scheduler effect: each `ViewState` declares the
  datasets it depends on (e.g. `catalogs` also refreshes `artworks` because
  catalog screens embed artwork data; `invoice` refreshes `invoices` +
  `artworks`). Messaging and inquiry refresh every 60 s; other views 120 s.
- A real change signal — the `vayu_cloud_sync` BroadcastChannel
  `SYNC_REQUIRED` event fired by the service worker after a push — triggers a
  refresh immediately, still single-flight.
- `loadData` is now single-flight (no overlapping loads), accepts an optional
  subset of datasets, dropped the old 12 s `withTimeout` race (apiClient
  already aborts; racing another timeout launched duplicate requests), and
  ignores responses that arrive after the signed-in identity changed.
  Bootstrap keeps the saved-copy fallback; scheduler-driven refreshes throw
  so the scheduler backs off instead of silently spinning.

### `frontend/hooks/useAuth.ts`
- Presence heartbeat: 30 s interval + `beforeunload` offline marking →
  **5-minute** heartbeat, only while the tab is visible and online.
- Unload no longer forces the user offline. The server-side KV TTL expires
  instead, so closing one tab does not mark a user offline while another tab
  of the same user stays open.

### `frontend/views/PaymentsView.tsx`
- 15-second payment-links polling → 60-second visible-tab refresh.
  Razorpay webhooks remain the source of truth; silent refresh failures
  rethrow so the scheduler backs off.

### `frontend/worker.ts`
- `PRESENCE_TTL_SECONDS` 45 → 420 (7 min) to match the 5-minute heartbeat
  with grace. Old clients (30 s heartbeat + explicit offline on unload)
  remain compatible; only a hard crash of an old client now lingers
  "online" up to 7 minutes.

### `loadTeamMembers` (in `useEntityData.ts`)
- Dropped the duplicate `getPresence` request — `/auth/team` already
  includes presence. Two KV-scanning requests per team view → one.

## 3. Tests (verified)

`frontend/tests/refreshScheduler.test.mjs` — 5 `node:test` unit tests:
event coalescing, hidden/offline pause+resume, backoff cannot be bypassed by
focus events, cleanup during an in-flight request, initial delay prevents a
duplicate bootstrap refresh.

```
node --test frontend/tests/refreshScheduler.test.mjs   # from repo root
```

Verified passing (5/5) on 2026-09-22 before the rollback. Note: the bare
directory form `node --test frontend/tests/` does **not** work on this
machine's Node (v25.9.0) — pass the test file explicitly.

## 4. Expected request behavior (theoretical counts, NOT measurements)

Per visible tab, per 10 minutes, approximate:
| Source | Before | After |
|---|---|---|
| Entity/message polling | ~40 requests (4 datasets × 4 polls of every dataset) | 5–10 requests of only that view's datasets |
| Payment links | ~40 | ~1 |
| Presence heartbeat | ~20 | ~2 |
| Hidden / offline tab | pollers paused, but refetch on every visibility flip | single-flight refresh on resume only |

No production baseline or savings percentage has been measured; the actual
invocation reduction must be measured after deployment (e.g. Cloudflare
Analytics / Analytics Engine before-vs-after).

## 5. Next step — the implementation to be tested

The larger reduction work (not yet started in code) is:
authenticated delta sync (`/api/sync`) with a D1 change log, a hibernating
Durable Object WebSocket hub with connection-based presence, connection
tickets for browser WebSockets, Analytics Engine instrumentation, and
authenticated private-file delivery. That implementation supersedes the
scheduler-only approach for connected clients (the scheduler remains the
disconnected/offline fallback).

## 6. Recovering the rolled-back work

```
git stash list          # stash@{0} = "polling reduction + refresh scheduler ..."
git stash apply stash@{0}   # re-apply, keep the stash
git stash pop  stash@{0}    # re-apply and drop the stash
```

Stash `stash@{0}` contains all 5 modified files plus the untracked
`frontend/services/refreshScheduler.ts` and `frontend/tests/`.

## 7. Delta sync + realtime (implemented, not deployed)

The follow-up described in §5 is now implemented behind three flags
(`DELTA_SYNC_ENABLED`, `REALTIME_ENABLED`, `FILE_AUTH`), all `off` by default.
While a realtime socket is connected, the scheduler above runs a 10-minute
safety sync; when the socket is down it remains the fallback. See
`HANDOFF.md` for status and verification, `docs/ARCHITECTURE.md` for the
design, and `docs/DEPLOYMENT.md` for rollout, rollback and how to measure the
real invocation change. No savings have been measured yet.
