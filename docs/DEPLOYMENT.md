# Deploying delta sync & realtime

Everything ships **dark**: all three flags default to `off`, so deploying the
code changes nothing for users until a flag is flipped. Old clients (already
open tabs, the installed PWA before it updates) keep polling and stay correct
at every step, so the order below is safe.

## 1. Set the secret (once)

```
npx wrangler secret put REALTIME_SECRET      # ≥ 32 random chars, e.g. `openssl rand -hex 32`
```

Without it, realtime stays off (fail-closed). Rotating it
invalidates outstanding tickets. Connected sockets keep working until their
next re-auth, then reconnect with fresh tickets.

## 2. Switches (removed 2026-10-29)

Delta sync, realtime and private files were rolled out behind
`DELTA_SYNC_ENABLED`, `REALTIME_ENABLED` and `FILE_AUTH`, all on in production
since 2026-09-24 (history below). The switches and their "off" paths are gone:
rolling back now means reverting the code. Realtime still stays off without
`REALTIME_SECRET` or the `SYNC_HUB` binding (System health, "Live updates").

## Scheduled jobs and alerts

The cron (every 10 minutes) runs email delivery, key rotation and payment
reconciliation as separate jobs (`platform/jobs.ts`). Each outcome is kept;
System health shows "Scheduled jobs" (last run, and any job failing), and a
failing job emails the **provider notification address** (control centre →
Notifications) at most once an hour per job. Set that address, or failures only
show in System health. For errors outside the cron, add a Cloudflare
Notification in the dashboard (Workers → error rate) — owner.

## Rollback

- Clients fall back automatically: a 404 on realtime tickets (no secret or
  hub) means "no socket, retry in 30 min".
- Never delete `change_log` or user data. The log is bounded (30 days) and
  harmless when unused.
- **Historical exposure:** before private files every file URL was public
  and cacheable. If a shared cache (a Cloudflare Cache Rule, a proxy) ever
  stored `/api/files/*`, purge that prefix. Do **not** add a public Cache Rule
  for `/api/files/*`.

## Measuring the effect (don't assume savings)

Take a baseline **before** step 3.1, with the same queries over a comparable
week. Workers Analytics in the dashboard gives the invocation totals. For
per-route detail, query the Analytics Engine dataset (SQL API). Columns:
`blob1` route, `blob2` method, `blob3` workspace, `blob4` `http`|`ws`;
`double1` status, `double2` wall-clock ms, `double3` D1 rows read, `double4`
D1 rows written, `double5` KV ops. AE samples, so always weight by
`_sample_interval`:

```sql
SELECT blob1 AS route, SUM(_sample_interval) AS requests,
       SUM(_sample_interval * double3) AS d1_rows_read,
       SUM(_sample_interval * double5) AS kv_ops
FROM ANALYTICS
WHERE timestamp > NOW() - INTERVAL '7' DAY
GROUP BY route ORDER BY requests DESC
```

(Use the dataset name the binding created; `ANALYTICS` is the binding's
default dataset name.) `double2` is **wall-clock** time, not CPU. CPU time
is a separate metric in Workers Analytics. Durable Object requests and
duration are billed separately from Worker invocations; check both.

## Local verification (no Cloudflare account needed)

```
cd frontend
npx tsc -p tsconfig.worker.json --noEmit && npx tsc -p tsconfig.web.json --noEmit
npm run build
npm test                    # unit tests + local D1 integration test
npm run test:smoke          # wrangler dev (local) + real hub: tickets, origin, invalidate, sync, revoke
```

Not covered locally: hibernation eviction and wake-up (workerd doesn't evict
on demand), real Analytics Engine writes, edge WebSocket timeouts, and
behaviour at scale.

## Rollout log

**Baseline (before any flag), Worker requests per day** (Cloudflare GraphQL
`workersInvocationsAdaptive`, script `vayu-webapp`, 0 errors on all days):

| Date | Requests | Date | Requests |
|---|---|---|---|
| 2026-09-15 | 14,839 | 2026-09-19 | 6,229 |
| 2026-09-16 | 19,555 | 2026-09-20 | 44,506 |
| 2026-09-17 | 6,027 | 2026-09-21 | 75,636 |
| 2026-09-18 | 15,704 | 2026-09-22 | 21,342 (partial day) |

**2026-09-22:** `REALTIME_SECRET` set; `DELTA_SYNC_ENABLED=on` (version
2be83dcf); `REALTIME_ENABLED=on` (version b87eb25f). `FILE_AUTH` still off.
Compare against the table above from 2026-09-23 on (open tabs keep the old
polling until they reload, so the first day is mixed).
