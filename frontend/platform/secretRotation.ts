// Re-encrypting stored payment credentials under the active key (secrets.ts).
//
// Resumable and idempotent: each run takes one batch, re-encrypts every value
// not already under the active key, and moves a cursor forward. A value is
// replaced only after the new ciphertext has been decrypted back and matches,
// and only if the row still holds the value that was read (a conditional
// update), so a concurrent change or a failure never loses a readable secret:
// the old value simply stays. Progress lives in platform_settings
// ('secrets_rotation'); the scheduled job continues a started rotation, and
// the control centre can run batches by hand.
//
// Retiring a key: status() must show zero values under it (and no failures)
// before it is removed from PAYMENT_SECRETS_KEYS / PAYMENT_SECRETS_KEY.

import type { Env } from '../workerEnv';
import { auditStmt } from './audit';
import type { Actor } from './orgs';
import { decryptSecret, encryptSecret, envelopeKid, keyRing, reportDecryptFailure } from './secrets';

const STATE_KEY = 'secrets_rotation';
const BILLING_KEY = 'billing_razorpay';
const BATCH = 25;
const MAX_FAILURES_KEPT = 50;

const ORG_FIELDS = ['key_secret_enc', 'webhook_secret_enc', 'webhook_secret_prev_enc'] as const;
type OrgField = typeof ORG_FIELDS[number];
const ORG_PURPOSE: Record<OrgField, string> = { key_secret_enc: 'key_secret', webhook_secret_enc: 'webhook_secret', webhook_secret_prev_enc: 'webhook_secret' };
const BILLING_FIELDS = ['keySecretEnc', 'webhookSecretEnc', 'webhookSecretPrevEnc'] as const;
type BillingField = typeof BILLING_FIELDS[number];
const BILLING_PURPOSE: Record<BillingField, string> = { keySecretEnc: 'key_secret', webhookSecretEnc: 'webhook_secret', webhookSecretPrevEnc: 'webhook_secret' };

/** The same contexts the writers use (payments.ts, billing.ts). */
const orgContext = (orgId: string, provider: string, field: OrgField) => `${orgId}|${provider}|${ORG_PURPOSE[field]}`;
const billingContext = (field: BillingField) => `platform|razorpay-billing|${BILLING_PURPOSE[field]}`;

export interface RotationFailure { target: string; field: string; reason: string }
export interface RotationState {
  targetKid: string;
  running: boolean;
  /** Last organization id done (org rows are taken in id order). '' = none yet. */
  cursor: string;
  billingDone: boolean;
  reencrypted: number;
  skippedChanged: number;
  failures: RotationFailure[];
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

async function readState(db: D1Database): Promise<RotationState | null> {
  const r = await db.prepare('SELECT value FROM platform_settings WHERE key = ?').bind(STATE_KEY).first<{ value: string }>();
  try { return r ? JSON.parse(r.value) as RotationState : null; } catch { return null; }
}

const saveStateStmt = (db: D1Database, s: RotationState, by: string | null) => db.prepare(
  `INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
).bind(STATE_KEY, JSON.stringify(s), s.updatedAt, by);

const reasonOf = (e: unknown): string => (e instanceof Error && 'reason' in e ? String((e as { reason: unknown }).reason) : 'error');

/**
 * One value under the target key: the new envelope, or null when it already
 * is. Throws when it can't be read or the round trip doesn't match.
 */
async function reencrypt(env: Env, context: string, envelope: string, targetKid: string): Promise<string | null> {
  if (envelope.startsWith(`v2.${targetKid}.`)) return null;
  const plaintext = await decryptSecret(env, context, envelope);
  const next = await encryptSecret(env, context, plaintext);
  if (!next.startsWith(`v2.${targetKid}.`)) throw Object.assign(new Error('active key changed during rotation'), { reason: 'active_changed' });
  if (await decryptSecret(env, context, next) !== plaintext) throw Object.assign(new Error('round trip mismatch'), { reason: 'verify_failed' });
  return next;
}

interface OrgRow { org_id: string; provider: string; key_secret_enc: string; webhook_secret_enc: string | null; webhook_secret_prev_enc: string | null }

const isMissingColumn = (e: unknown) => /no such column/i.test(String((e as Error)?.message ?? e));

/**
 * Integration rows with every encrypted field. Before migration 0010 is
 * applied there is no previous-webhook-secret column: it reads as empty.
 */
async function orgRows(db: D1Database, tail: string, binds: unknown[]): Promise<OrgRow[]> {
  const base = 'SELECT org_id, provider, key_secret_enc, webhook_secret_enc';
  try {
    return (await db.prepare(`${base}, webhook_secret_prev_enc FROM org_payment_integrations ${tail}`).bind(...binds).all<OrgRow>()).results;
  } catch (e) {
    if (!isMissingColumn(e)) throw e;
    return (await db.prepare(`${base}, NULL AS webhook_secret_prev_enc FROM org_payment_integrations ${tail}`).bind(...binds).all<OrgRow>()).results;
  }
}

/** Re-encrypts one integration row's fields, each with its own conditional update. */
async function rotateOrgRow(env: Env, db: D1Database, row: OrgRow, state: RotationState): Promise<void> {
  for (const field of ORG_FIELDS) {
    const current = row[field];
    if (!current) continue;
    const context = orgContext(row.org_id, row.provider, field);
    let next: string | null;
    try {
      next = await reencrypt(env, context, current, state.targetKid);
    } catch (e) {
      reportDecryptFailure(context, e, 'rotation');
      state.failures.push({ target: row.org_id, field, reason: reasonOf(e) });
      continue;
    }
    if (!next) continue;
    const res = await db.prepare(`UPDATE org_payment_integrations SET ${field} = ? WHERE org_id = ? AND provider = ? AND ${field} = ?`)
      .bind(next, row.org_id, row.provider, current).run();
    if ((res.meta?.changes ?? 0) > 0) state.reencrypted++;
    else state.skippedChanged++;
  }
}

/** The platform's plan-payments account (one JSON row). */
async function rotateBilling(env: Env, db: D1Database, state: RotationState): Promise<void> {
  const r = await db.prepare('SELECT value FROM platform_settings WHERE key = ?').bind(BILLING_KEY).first<{ value: string }>();
  if (!r) return;
  let account: Record<string, unknown>;
  try { account = JSON.parse(r.value) as Record<string, unknown>; } catch { return; }
  let changed = 0;
  for (const field of BILLING_FIELDS) {
    const current = account[field];
    if (typeof current !== 'string' || !current) continue;
    try {
      const next = await reencrypt(env, billingContext(field), current, state.targetKid);
      if (next) { account[field] = next; changed++; }
    } catch (e) {
      reportDecryptFailure(billingContext(field), e, 'rotation');
      state.failures.push({ target: 'platform-billing', field, reason: reasonOf(e) });
    }
  }
  if (!changed) return;
  const res = await db.prepare('UPDATE platform_settings SET value = ? WHERE key = ? AND value = ?')
    .bind(JSON.stringify(account), BILLING_KEY, r.value).run();
  if ((res.meta?.changes ?? 0) > 0) state.reencrypted += changed;
  else state.skippedChanged += changed;
}

/** Starts (or restarts) a rotation to the active key. The old values stay until each is re-encrypted. */
export async function startRotation(env: Env, db: D1Database, actor: Actor): Promise<RotationState> {
  const { active } = keyRing(env);
  const now = Date.now();
  const state: RotationState = {
    targetKid: active, running: true, cursor: '', billingDone: false, reencrypted: 0, skippedChanged: 0,
    failures: [], startedAt: now, updatedAt: now, finishedAt: null,
  };
  await db.batch([
    saveStateStmt(db, state, actor.userId),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'secrets.rotation.start', targetType: 'platform_settings', targetId: STATE_KEY, details: { targetKid: active }, ip: actor.ip }),
  ]);
  return state;
}

/**
 * Runs one batch of a started rotation. Safe to call again after any failure
 * or timeout: done rows are skipped, and the cursor only moves after a batch.
 */
export async function runRotationBatch(env: Env, db: D1Database, actor: Actor | null, batch = BATCH): Promise<RotationState | null> {
  const state = await readState(db);
  if (!state?.running) return state;
  if (keyRing(env).active !== state.targetKid) {
    // The active key changed under a running rotation: stop rather than
    // write values under a key the operator didn't ask for. Start again.
    state.running = false;
    state.failures.push({ target: '*', field: '*', reason: 'active_key_changed' });
  } else {
    if (!state.billingDone) {
      await rotateBilling(env, db, state);
      state.billingDone = true;
    }
    const results = await orgRows(db, 'WHERE org_id > ? ORDER BY org_id, provider LIMIT ?', [state.cursor, batch]);
    for (const row of results) {
      await rotateOrgRow(env, db, row, state);
      state.cursor = row.org_id;
    }
    if (results.length < batch) { state.running = false; state.finishedAt = Date.now(); }
  }
  state.failures = state.failures.slice(-MAX_FAILURES_KEPT);
  state.updatedAt = Date.now();
  const stmts = [saveStateStmt(db, state, actor?.userId ?? null)];
  if (!state.running) {
    stmts.push(auditStmt(db, {
      actorUserId: actor?.userId ?? null, actorKind: actor ? 'provider_admin' : 'system', action: 'secrets.rotation.finish',
      targetType: 'platform_settings', targetId: STATE_KEY,
      details: { targetKid: state.targetKid, reencrypted: state.reencrypted, skippedChanged: state.skippedChanged, failures: state.failures.length },
      ip: actor?.ip ?? null,
    }));
  }
  await db.batch(stmts);
  return state;
}

export interface KeyUsage {
  active: string;
  configured: string[];
  /** Stored values per key id ('unknown' = not a recognised format). */
  byKid: Record<string, number>;
  /** Values that do not decrypt with the configured keys (checked when verify is on). */
  unreadable: { target: string; field: string; reason: string }[];
  /** Key ids that still hold values but aren't configured: those values are lost until the key is restored. */
  missingKeys: string[];
  rotation: RotationState | null;
}

function count(map: Record<string, number>, envelope: string | null | undefined): void {
  if (!envelope) return;
  const kid = envelopeKid(envelope) ?? 'unknown';
  map[kid] = (map[kid] ?? 0) + 1;
}

/** Tries to decrypt one value, recording why not. */
async function checkReadable(env: Env, out: KeyUsage['unreadable'], target: string, field: string, context: string, envelope: string | null | undefined): Promise<void> {
  if (!envelope) return;
  try { await decryptSecret(env, context, envelope); } catch (e) { out.push({ target, field, reason: reasonOf(e) }); }
}

/** The plan-payments account's values, counted (and checked) into usage. */
async function billingUsage(env: Env, db: D1Database, usage: KeyUsage, verify: boolean): Promise<void> {
  const billing = await db.prepare('SELECT value FROM platform_settings WHERE key = ?').bind(BILLING_KEY).first<{ value: string }>();
  if (!billing) return;
  let account: Record<string, unknown> = {};
  try { account = JSON.parse(billing.value) as Record<string, unknown>; } catch { /* not an account */ }
  for (const field of BILLING_FIELDS) {
    const value = typeof account[field] === 'string' ? account[field] as string : null;
    count(usage.byKid, value);
    if (verify) await checkReadable(env, usage.unreadable, 'platform-billing', field, billingContext(field), value);
  }
}

/** Which keys the stored values use, and (verify) whether each still decrypts. Never returns a secret. */
export async function keyUsage(env: Env, db: D1Database, verify: boolean): Promise<KeyUsage> {
  const { keys, active } = keyRing(env);
  const usage: KeyUsage = { active, configured: [...keys.keys()], byKid: {}, unreadable: [], missingKeys: [], rotation: await readState(db) };
  const results = await orgRows(db, '', []);
  for (const row of results) {
    for (const field of ORG_FIELDS) {
      count(usage.byKid, row[field]);
      if (verify) await checkReadable(env, usage.unreadable, row.org_id, field, orgContext(row.org_id, row.provider, field), row[field]);
    }
  }
  await billingUsage(env, db, usage, verify);
  usage.missingKeys = Object.keys(usage.byKid).filter(k => k !== 'unknown' && !keys.has(k));
  return usage;
}
