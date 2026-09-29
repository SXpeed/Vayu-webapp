// Payment webhook health, from signals an outsider can't fake.
//
//   - Verified deliveries (signature checked with that account's own secret)
//     and whether applying them worked.
//   - What the scheduled reconciliation found: a payment or refund Razorpay
//     has that no verified webhook delivered is real evidence the webhook
//     isn't arriving.
//   - Rejected deliveries (bad signature, unknown address) are counted per
//     hour for telemetry only. They never make an account look unhealthy and
//     never alert anyone: anyone on the internet can send them.
//
// "No webhook lately" alone is not a failure: a business with no payments
// gets no events. Every write here is best-effort; a missing table (before
// migrations 0010/0011) or a telemetry error never fails a payment.

const HOUR = 3_600_000;

const isMissingSchema = (e: unknown) => /no such (table|column)/i.test(String((e as Error)?.message ?? e));

async function quietly(run: () => Promise<unknown>, what: string): Promise<void> {
  try {
    await run();
  } catch (e) {
    if (!isMissingSchema(e)) console.warn(JSON.stringify({ event: 'webhook_health_write_failed', what, reason: (e as Error).name }));
  }
}

/** A short, safe error text: a class and status, never a payload. */
export function safeError(e: unknown): string {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return text.replace(/[^\w .:()/-]/g, '').slice(0, 160);
}

const upsert = `INSERT INTO payment_webhook_health (org_id, provider) VALUES (?, ?) ON CONFLICT(org_id, provider) DO NOTHING`;

/** A delivery whose signature checked out (with the current or, during a rotation, the previous secret). */
export function recordVerified(db: D1Database, account: string, eventType: string | null, withPrevious: boolean): Promise<void> {
  return quietly(() => db.batch([
    db.prepare(upsert).bind(account, 'razorpay'),
    db.prepare(`UPDATE payment_webhook_health SET last_verified_at = ?, last_event_type = ?, verified_count = verified_count + 1,
                verified_with_previous = verified_with_previous + ? WHERE org_id = ? AND provider = 'razorpay'`)
      .bind(Date.now(), eventType?.slice(0, 64) ?? null, withPrevious ? 1 : 0, account),
  ]), 'verified');
}

/** A verified delivery was applied. */
export function recordProcessed(db: D1Database, account: string): Promise<void> {
  return quietly(() => db.prepare("UPDATE payment_webhook_health SET last_processed_ok_at = ? WHERE org_id = ? AND provider = 'razorpay'")
    .bind(Date.now(), account).run(), 'processed');
}

/** A verified delivery couldn't be applied (Razorpay will retry it). */
export function recordProcessingFailure(db: D1Database, account: string, e: unknown): Promise<void> {
  return quietly(() => db.batch([
    db.prepare(upsert).bind(account, 'razorpay'),
    db.prepare(`UPDATE payment_webhook_health SET processing_failures = processing_failures + 1, last_processing_error = ?,
                last_processing_error_at = ? WHERE org_id = ? AND provider = 'razorpay'`)
      .bind(safeError(e), Date.now(), account),
  ]), 'processing_failure');
}

/**
 * A rejected delivery, counted per hour. `scope` must come from a bounded set
 * (an account that exists, or a fixed name), never straight from the URL, so
 * an attacker can't fill the table with new rows.
 */
export function recordRejection(db: D1Database, scope: string, reason: string): Promise<void> {
  const hour = Math.floor(Date.now() / HOUR) * HOUR;
  return quietly(() => db.prepare(
    `INSERT INTO webhook_rejections (hour_start, scope, reason, count) VALUES (?, ?, ?, 1)
     ON CONFLICT(hour_start, scope, reason) DO UPDATE SET count = count + 1`,
  ).bind(hour, scope.slice(0, 80), reason.slice(0, 40)).run(), 'rejection');
}

export interface ReconcileOutcome { checked: number; missed: number; failures: number; error: string | null }

/** One reconciliation pass over an account's records. */
export function recordReconcile(db: D1Database, account: string, o: ReconcileOutcome): Promise<void> {
  if (o.checked === 0 && o.failures === 0) return Promise.resolve();
  const now = Date.now();
  return quietly(() => db.batch([
    db.prepare(upsert).bind(account, 'razorpay'),
    db.prepare(`UPDATE payment_webhook_health SET reconciled_at = ?, reconcile_checked = reconcile_checked + ?,
                missed_by_webhook = missed_by_webhook + ?, last_missed_at = CASE WHEN ? > 0 THEN ? ELSE last_missed_at END,
                reconcile_failures = reconcile_failures + ?, last_reconcile_error = COALESCE(?, last_reconcile_error)
                WHERE org_id = ? AND provider = 'razorpay'`)
      .bind(now, o.checked, o.missed, o.missed, now, o.failures, o.error, account),
  ]), 'reconcile');
}

export type HealthState = 'healthy' | 'attention' | 'no_events' | 'unknown';

export interface WebhookHealth {
  state: HealthState;
  detail: string;
  lastVerifiedAt: number | null;
  verifiedCount: number;
  verifiedWithPrevious: number;
  processingFailures: number;
  lastProcessingError: string | null;
  missedByWebhook: number;
  lastMissedAt: number | null;
  reconciledAt: number | null;
  /** Rejected deliveries to this account's address in the last 24 hours (telemetry only). */
  rejected24h: number;
}

interface HealthRow {
  last_verified_at: number | null; verified_count: number; verified_with_previous: number;
  processing_failures: number; last_processing_error: string | null; last_processing_error_at: number | null;
  last_processed_ok_at?: number | null; missed_by_webhook?: number; last_missed_at?: number | null; reconciled_at?: number | null;
}

/** The health verdict from the recorded signals. Pure, for tests. */
export function healthVerdict(r: HealthRow | null): { state: HealthState; detail: string } {
  if (!r) return { state: 'no_events', detail: 'No verified webhook yet. That is normal until a payment is made.' };
  const lastOk = r.last_processed_ok_at ?? r.last_verified_at ?? 0;
  if (r.last_processing_error_at && r.last_processing_error_at > lastOk) {
    return { state: 'attention', detail: 'The last verified delivery could not be applied; Razorpay retries it for 24 hours.' };
  }
  if (r.last_missed_at && r.last_missed_at > (r.last_verified_at ?? 0)) {
    return { state: 'attention', detail: 'The scheduled check found payments the webhook did not deliver. Check the webhook address, events and secret in Razorpay.' };
  }
  if (!r.last_verified_at) return { state: 'no_events', detail: 'No verified webhook yet. That is normal until a payment is made.' };
  return { state: 'healthy', detail: 'Verified webhooks are arriving and being applied.' };
}

/** An account's webhook health for the control centre. Never includes payloads. */
export async function webhookHealth(db: D1Database, account: string): Promise<WebhookHealth> {
  let row: HealthRow | null = null;
  let rejected24h = 0;
  try {
    row = await db.prepare("SELECT * FROM payment_webhook_health WHERE org_id = ? AND provider = 'razorpay'").bind(account).first<HealthRow>();
    const since = Date.now() - 24 * HOUR;
    rejected24h = (await db.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM webhook_rejections WHERE scope = ? AND hour_start >= ?')
      .bind(`org:${account}`, since).first<{ n: number }>())?.n ?? 0;
  } catch (e) {
    if (!isMissingSchema(e)) throw e;
    return {
      state: 'unknown', detail: 'Apply the platform database migrations 0010 and 0011 to record webhook health.',
      lastVerifiedAt: null, verifiedCount: 0, verifiedWithPrevious: 0, processingFailures: 0, lastProcessingError: null,
      missedByWebhook: 0, lastMissedAt: null, reconciledAt: null, rejected24h: 0,
    };
  }
  return {
    ...healthVerdict(row),
    lastVerifiedAt: row?.last_verified_at ?? null,
    verifiedCount: row?.verified_count ?? 0,
    verifiedWithPrevious: row?.verified_with_previous ?? 0,
    processingFailures: row?.processing_failures ?? 0,
    lastProcessingError: row?.last_processing_error ?? null,
    missedByWebhook: row?.missed_by_webhook ?? 0,
    lastMissedAt: row?.last_missed_at ?? null,
    reconciledAt: row?.reconciled_at ?? null,
    rejected24h,
  };
}
