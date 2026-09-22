// Shared worker-side types and small helpers. Lives in its own module so the
// Durable Object (frontend/realtime.ts) and the delta-sync endpoint
// (frontend/deltaSync.ts) can import the same Env without a circular import
// back into worker.ts.

export interface Env {
  VAYU_KV: KVNamespace;
  VAYU_R2: R2Bucket;
  VAYU_DB: D1Database;
  // Razorpay credentials — set via `wrangler secret put <NAME>`.
  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
  RAZORPAY_WEBHOOK_SECRET?: string;
  // Calendarific (Indian public holidays & festivals) — set via `wrangler secret put`.
  CALENDARIFIC_API_KEY?: string;
  // HMAC secret shared by the Worker and the SyncHub Durable Object. Used for
  // realtime connection tickets. Set via `wrangler secret put REALTIME_SECRET`
  // (at least 32 characters). Without it realtime stays off even when
  // REALTIME_ENABLED is on — see realtimeEnabled().
  REALTIME_SECRET?: string;
  // Bindings added for the sync/realtime rollout. Optional in the type so the
  // worker still typechecks (and runs) before the wrangler config is updated.
  SYNC_HUB?: DurableObjectNamespace;
  ANALYTICS?: AnalyticsEngineDataset;
  // Non-secret feature flags. "on" enables, anything else leaves the old
  // behaviour in place, so rollback is a config change rather than a revert.
  WORKSPACE_ID?: string;
  REALTIME_ENABLED?: string;
  DELTA_SYNC_ENABLED?: string;
  FILE_AUTH?: string;
  // Extra allowed origin(s) for the WebSocket handshake, comma-separated.
  // Same-origin always works; set this only if the app is served from another
  // origin than the API.
  REALTIME_ALLOWED_ORIGIN?: string;
}

/** Per-request context, shared by the router and the route handlers. */
export interface Ctx {
  request: Request;
  env: Env;
  url: URL;
  path: string;
  method: string;
  execCtx: ExecutionContext;
}

// ── Per-request metrics (Analytics Engine) ─────────────────────────────────
// Counters a request accumulates on its way through (D1 rows, KV ops) so the
// telemetry data point can include them without extra round trips.

interface RequestMetrics {
  d1RowsRead: number;
  d1RowsWritten: number;
  kvOps: number;
}

const metricsByRequest = new WeakMap<Request, RequestMetrics>();

export function requestMetrics(request: Request): RequestMetrics {
  let metrics = metricsByRequest.get(request);
  if (!metrics) {
    metrics = { d1RowsRead: 0, d1RowsWritten: 0, kvOps: 0 };
    metricsByRequest.set(request, metrics);
  }
  return metrics;
}

export function addD1Usage(request: Request, rowsRead: number, rowsWritten: number): void {
  const metrics = requestMetrics(request);
  metrics.d1RowsRead += rowsRead;
  metrics.d1RowsWritten += rowsWritten;
}

export function addKvOp(request: Request, count = 1): void {
  requestMetrics(request).kvOps += count;
}

/**
 * A per-request view of the bindings that counts KV operations and D1 rows as
 * handlers use them, so the analytics data point can include real usage
 * numbers without instrumenting every call site. Handlers keep using
 * ctx.env.VAYU_KV / ctx.env.VAYU_DB exactly as before.
 */
export function trackedEnv(request: Request, env: Env): Env {
  const metrics = requestMetrics(request);
  const track = <T>(result: T | Promise<T>): T | Promise<T> => {
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      return (result as Promise<T>).then(value => { track(value); return value; });
    }
    const meta = (result as { meta?: { rows_read?: number; rows_written?: number } })?.meta;
    if (meta) {
      metrics.d1RowsRead += meta.rows_read ?? 0;
      metrics.d1RowsWritten += meta.rows_written ?? 0;
    }
    return result;
  };
  // batch() must receive the binding's own statement objects — D1 can't
  // serialize a wrapper — so every wrapper remembers the statement it wraps.
  const originals = new WeakMap<object, D1PreparedStatement>();
  const wrapStatement = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = {
      bind: (...args: unknown[]) => wrapStatement(stmt.bind(...(args as never[]))),
      run: () => track(stmt.run()),
      first: (colName?: string) => track(stmt.first(colName as never)),
      all: () => track(stmt.all()),
      raw: () => track(stmt.raw()),
    } as unknown as D1PreparedStatement;
    originals.set(wrapped, stmt);
    return wrapped;
  };
  const kv = {
    get: (...args: Parameters<KVNamespace['get']>) => { metrics.kvOps += 1; return env.VAYU_KV.get(...args); },
    put: (...args: Parameters<KVNamespace['put']>) => { metrics.kvOps += 1; return env.VAYU_KV.put(...args); },
    delete: (...args: Parameters<KVNamespace['delete']>) => { metrics.kvOps += 1; return env.VAYU_KV.delete(...args); },
    list: (...args: Parameters<KVNamespace['list']>) => { metrics.kvOps += 1; return env.VAYU_KV.list(...args); },
    getWithMetadata: (...args: Parameters<KVNamespace['getWithMetadata']>) => { metrics.kvOps += 1; return env.VAYU_KV.getWithMetadata(...args); },
  } as KVNamespace;
  const db = {
    prepare: (query: string) => wrapStatement(env.VAYU_DB.prepare(query)),
    batch: <T = unknown>(statements: D1PreparedStatement[]) => {
      const unwrapped = statements.map(stmt => originals.get(stmt) ?? stmt);
      return env.VAYU_DB.batch(unwrapped).then(result => {
        for (const r of result) track(r);
        return result as D1Result<T>[];
      });
    },
  } as D1Database;
  return { ...env, VAYU_KV: kv, VAYU_DB: db };
}

export interface SessionData {
  userId: string;
  email: string;
  name: string;
  /** Refreshed from the user record on every request (see getSession). */
  role: string;
  expiresAt: number;
}

/** One committed change, as announced to the hub and to clients. */
export interface ChangeEvent {
  entity: string;
  id: string;
  op: 'put' | 'delete';
  /** Conversation id for chat-scoped rows, so the hub can filter recipients. */
  conversationId?: string;
}

/**
 * The workspace this deployment belongs to. There is no organization model in
 * the product yet: this is a SINGLE private workspace, resolved server-side
 * only. The value exists so the change log and the hub routing are already
 * keyed by workspace when multi-workspace support is ever built. A browser-
 * supplied workspace id is never accepted as authorization.
 */
export function workspaceId(env: Env): string {
  const id = (env.WORKSPACE_ID || 'default').trim();
  return id || 'default';
}

export function flagEnabled(value: string | undefined): boolean {
  return value === 'on' || value === 'true' || value === '1';
}

const MIN_REALTIME_SECRET_LENGTH = 32;
let unconfiguredSecret: string | null = null;

/** True when REALTIME_SECRET is set and long enough to sign tickets with. */
export function realtimeSecretConfigured(env: Env): boolean {
  return (env.REALTIME_SECRET?.length ?? 0) >= MIN_REALTIME_SECRET_LENGTH;
}

/** Realtime is live only with the flag on, the hub bound AND a real secret. */
export function realtimeEnabled(env: Env): boolean {
  return flagEnabled(env.REALTIME_ENABLED) && !!env.SYNC_HUB && realtimeSecretConfigured(env);
}

/**
 * The raw shared secret. The Worker and the hub compare this string on
 * internal calls; the HMAC key below is derived from it. Rotating
 * REALTIME_SECRET invalidates outstanding tickets, which is what a rotation
 * wants.
 *
 * Fails closed: with no proper secret this is a random value private to the
 * isolate (created lazily — Workers forbid randomness at global scope), so
 * nothing signed with it verifies anywhere else. There is deliberately no
 * predictable fallback: one in source would let anyone mint tickets.
 */
export function rawRealtimeSecret(env: Env): string {
  if (realtimeSecretConfigured(env)) return env.REALTIME_SECRET!;
  unconfiguredSecret ??= `${crypto.randomUUID()}${crypto.randomUUID()}`;
  return unconfiguredSecret;
}

/** 32-byte signing key derived from the raw secret. */
export async function resolveRealtimeSecret(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(rawRealtimeSecret(env)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
}
