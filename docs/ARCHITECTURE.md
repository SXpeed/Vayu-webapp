# Sync & realtime architecture

How the app keeps every open screen current without per-tab polling. Code
lives in `frontend/` (the Worker entry is `frontend/worker.ts`).

## The change flow

```
REST mutation ──► one D1 batch: business write + change_log row(s)   (atomic)
                 │
                 └─► after commit (waitUntil): POST hub /notify   (best effort)
                                   │
SyncHub DO ──► per-user filtered {type:'invalidate', events:[{entity,id,op}]}
                                   │
browser leader tab ──► BroadcastChannel ──► every tab of that user
                                   │
each visible tab ──► GET /api/sync?cursor=N ──► merge into React state + offline copy
```

- **D1 is the only source of truth.** `change_log` rows are written in the
  *same* `db.batch()` as the mutation (`changeLogStmt` in `deltaSync.ts`), so a
  change is either fully recorded or not at all. `seq` is AUTOINCREMENT and
  SQLite serializes writers, so seq order = commit order.
- **The hub only carries signals, never data.** A lost notify is harmless: the
  client still pulls everything after its cursor on the next pass (reconnect,
  push, focus or the 10-minute safety sync).
- **Receipts** (`delivered`/`read`) use `statusUpgradeStmts`: a forward-only
  `UPDATE … RETURNING` plus an `INSERT … SELECT … WHERE changes() > 0`, so the
  change row exists only if the status really moved. Re-acks write nothing and
  signal nothing, which is what prevents feedback loops.

## /api/sync

| Request | Answer |
|---|---|
| no `cursor` | `{mode:'boundary', cursor:maxSeq}`, then the client takes a full copy |
| `cursor=N` (0 is valid) | `{mode:'incremental', cursor, hasMore, changes:[{seq,entity,id,op,record?}]}` |
| cursor pruned, or ahead of the log | `{resyncRequired:true, cursor}`, then a fresh full copy |
| `snapshot=<entity>&after_id=&cursor=` | keyset-paginated snapshot (available; the web client uses the list endpoints instead) |
| `DELTA_SYNC_ENABLED` ≠ on | 404, and the client falls back to per-screen polling |

- Filtering: the role's readable entities (`entityAccess.ts`, which mirrors
  the REST rules), plus `scope` (conversation participants for chat rows, the
  employee for attendance). The cursor advances past filtered rows.
- `put` rows carry the record *as it is now*; a put whose row has since been
  deleted degrades to a tombstone.
- Retention: 30 days, pruned from `/api/sync` at most every 6 h per isolate.
  The newest row is always kept so `MAX(seq)` never moves backwards.

**Client** (`services/deltaSyncClient.ts`): the cursor is **in memory, per
tab**, because it describes what that tab's React state has applied. First
pass: boundary S, then a full copy through the list endpoints, then replay
after S (idempotent, so writes that land during the copy aren't missed). The
cursor advances only after a page is applied. Passes are single-flight, and a
request that arrives mid-pass triggers exactly one more pass.

## SyncHub (Durable Object, `realtime.ts`)

- One instance per workspace (`idFromName(workspaceId)`), using the WebSocket
  **Hibernation API**. Socket identity lives in `serializeAttachment` and is
  rebuilt after eviction. Keepalive `ping`s are answered at the edge by
  `setWebSocketAutoResponse` and never wake the object.
- **Connect:** the browser POSTs `/api/realtime/ticket` (bearer session), which
  returns a 60-second, single-use, HMAC-signed ticket. It then opens
  `/api/realtime/ws?ticket=…`. The Worker checks `Upgrade` and the **Origin
  allow-list** (same origin + `REALTIME_ALLOWED_ORIGIN`) before forwarding.
  The hub verifies the signature and workspace, and burns the `jti`.
- **Lease:** 10 minutes. The client re-auths with a fresh ticket about a
  minute before expiry (same user only). Fan-out skips and closes sockets
  whose lease has lapsed (4401), so an abandoned socket can't keep receiving
  events.
- **Limits:** 6 sockets per user, 4 KB frames, 30 frames / 10 s, 50 ids per
  ack. Close codes: 4401 lease, 4403 revoked or refused, 4408 rate, 4409 size.
- **Logout** revokes *all* of that user's sockets (every device). Devices whose
  session is still valid simply reconnect with a new ticket.
- **Secret:** `REALTIME_SECRET` (≥ 32 chars). Without it realtime stays off
  even with the flag on. There is no predictable fallback key.

**Client** (`services/realtimeService.ts`): one socket per user per browser.
Tabs elect a leader with Web Locks (`navigator.locks`); the leader relays
`invalidate` / `presence` / `typing` / status to the other tabs over a
BroadcastChannel. If the leader tab closes, a waiting tab takes over. The
client reconnects with exponential backoff and jitter, fetching a new ticket
for every attempt. Hidden tabs defer their sync pass until they become
visible.

## Presence

Presence means **connected**, not "actively using". A user is online while at
least one of their sockets is inside its lease. Each `hb` frame refreshes
`lastSeenAt`, so the UI could treat a stale `lastSeen` as idle. Sleeping
devices simply drop their socket and go offline when it closes.
`/auth/team` asks the hub and falls back to the old KV heartbeat map only if
the hub call fails. The KV heartbeat is skipped while a socket is connected.

## What is not in the change log, and why

Users, roles, sessions, payment links, settings and presence live in **KV**,
and KV can't share a transaction with D1. They keep their REST refresh paths.
Payment links get a signal-only `payments` invalidate (from the Razorpay
webhook) that makes an open Payments screen refetch.

## Private files (`FILE_AUTH`)

With `FILE_AUTH=on`, `/api/files/*` requires the bearer session or the
HttpOnly `vayu_files` capability cookie (random, KV-backed, 7 days,
`Path=/api` so `/auth/me` can re-issue it and logout can delete it).
Responses are `private, max-age=86400`: browser cache only, never shared
caches. Logout clears the cookie and sends `Clear-Site-Data: "cache"`.

## Limits of this design

- **Single private workspace.** `workspaceId()` comes from server config
  (`WORKSPACE_ID`), never from the browser. Hub routing and `change_log` are
  already keyed by it, but nothing here makes the app multi-tenant.
- **One hub instance** handles every socket. That is ample for a small team.
  At hundreds of concurrent users with heavy chat, shard the hub (e.g. per
  conversation or per user group) before a single object's CPU becomes the
  bottleneck.
- Analytics Engine records one data point per request: route, method,
  workspace, http/ws, status, wall-clock ms, D1 rows read/written and KV ops.
  No tokens, cookies, bodies or query strings are recorded.
