// Each organization's OWN Razorpay account, for payments it collects from its
// customers. This is deliberately separate from how organizations pay the
// platform (subscription billing): money from an organization's customers
// goes to that organization's account, never the provider's.
//
// Credentials are encrypted at rest (secrets.ts) and never returned by an
// API. Webhooks arrive at /api/v2/webhooks/razorpay/<orgId>, are verified
// with that organization's own webhook secret, and are stored once per event
// id, so retries and replays are no-ops.

import type { Env } from '../workerEnv';
import { auditStmt } from './audit';
import { OrgError, type Actor } from './orgs';
import { decryptSecret, encryptSecret, maskKeyId, secretsConfigured } from './secrets';

const PROVIDER = 'razorpay';
const KEY_ID_RE = /^rzp_(test|live)_[A-Za-z0-9]{8,32}$/;

const ctx = (orgId: string, field: string) => `${orgId}|${PROVIDER}|${field}`;

interface IntegrationRow {
  org_id: string;
  mode: 'test' | 'live';
  key_id: string;
  key_secret_enc: string;
  webhook_secret_enc: string | null;
  status: string;
  last_verified_at: number | null;
  last_error: string | null;
  connected_at: number;
  updated_at: number;
}

async function row(db: D1Database, orgId: string): Promise<IntegrationRow | null> {
  return db.prepare('SELECT * FROM org_payment_integrations WHERE org_id = ? AND provider = ?')
    .bind(orgId, PROVIDER).first<IntegrationRow>();
}

/** What the control panel may see. Never includes a secret. */
export async function describeRazorpay(db: D1Database, orgId: string, webhookUrl: string) {
  const r = await row(db, orgId);
  const usedByApp = (await getAppPaymentsOrg(db)) === orgId;
  if (!r) return { connected: false, webhookUrl, usedByApp };
  return {
    connected: true,
    usedByApp,
    mode: r.mode,
    keyIdHint: maskKeyId(r.key_id),
    hasWebhookSecret: !!r.webhook_secret_enc,
    status: r.status,
    lastVerifiedAt: r.last_verified_at,
    lastError: r.last_error,
    connectedAt: r.connected_at,
    updatedAt: r.updated_at,
    webhookUrl,
  };
}

async function orgExists(db: D1Database, orgId: string): Promise<void> {
  const org = await db.prepare('SELECT status FROM organizations WHERE id = ?').bind(orgId).first<{ status: string }>();
  if (!org) throw new OrgError(404, 'org_not_found', 'Organization not found.');
  if (org.status === 'closed') throw new OrgError(409, 'org_closed', 'This organization is closed.');
}

/**
 * Connects (or replaces) an organization's Razorpay keys. A blank webhook
 * secret keeps the stored one when replacing keys.
 */
export async function connectRazorpay(env: Env, db: D1Database, orgId: string, body: Record<string, unknown>, actor: Actor) {
  if (!secretsConfigured(env)) {
    throw new OrgError(503, 'secrets_unavailable', 'Payment credential storage is not configured (PAYMENT_SECRETS_KEY).');
  }
  await orgExists(db, orgId);
  const keyId = typeof body.keyId === 'string' ? body.keyId.trim() : '';
  const keySecret = typeof body.keySecret === 'string' ? body.keySecret.trim() : '';
  const webhookSecret = typeof body.webhookSecret === 'string' ? body.webhookSecret.trim() : '';
  const match = KEY_ID_RE.exec(keyId);
  if (!match) throw new OrgError(400, 'invalid', 'Key ID must look like rzp_test_… or rzp_live_… (from Razorpay → Settings → API Keys).');
  if (keySecret.length < 16 || keySecret.length > 128) throw new OrgError(400, 'invalid', 'Enter the key secret shown when the key was generated.');
  if (webhookSecret && (webhookSecret.length < 8 || webhookSecret.length > 128)) {
    throw new OrgError(400, 'invalid', 'Webhook secret must be 8–128 characters.');
  }
  const mode = match[1] as 'test' | 'live';
  const existing = await row(db, orgId);
  const keySecretEnc = await encryptSecret(env, ctx(orgId, 'key_secret'), keySecret);
  const webhookEnc = webhookSecret
    ? await encryptSecret(env, ctx(orgId, 'webhook_secret'), webhookSecret)
    : existing?.webhook_secret_enc ?? null;
  const now = Date.now();
  await db.batch([
    db.prepare(
      `INSERT INTO org_payment_integrations
         (org_id, provider, mode, key_id, key_secret_enc, webhook_secret_enc, status, last_verified_at, last_error, connected_by, connected_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'unverified', NULL, NULL, ?, ?, ?)
       ON CONFLICT(org_id, provider) DO UPDATE SET
         mode = excluded.mode, key_id = excluded.key_id, key_secret_enc = excluded.key_secret_enc,
         webhook_secret_enc = excluded.webhook_secret_enc, status = 'unverified',
         last_verified_at = NULL, last_error = NULL, updated_at = excluded.updated_at`,
    ).bind(orgId, PROVIDER, mode, keyId, keySecretEnc, webhookEnc, actor.userId, now, now),
    auditStmt(db, {
      actorUserId: actor.userId, actorKind: 'provider_admin', action: existing ? 'payments.razorpay.replace' : 'payments.razorpay.connect',
      targetType: 'organization', targetId: orgId, orgId,
      details: { mode, keyIdHint: maskKeyId(keyId), webhookSecretChanged: !!webhookSecret },
      ip: actor.ip,
    }),
  ]);
}

/**
 * Where Razorpay's API lives. Tests point it at a local stand-in, but only in
 * development: in production keys can never be sent anywhere but Razorpay.
 */
export function razorpayApiBase(env: Env): string {
  return env.PLATFORM_ENV === 'development' && env.RAZORPAY_API_BASE ? env.RAZORPAY_API_BASE.replace(/\/$/, '') : 'https://api.razorpay.com';
}

/**
 * Checks the stored keys against Razorpay with one read-only call. Only this
 * organization's own keys are used.
 */
export async function verifyRazorpay(env: Env, db: D1Database, orgId: string, actor: Actor, fetcher: typeof fetch = fetch) {
  const r = await row(db, orgId);
  if (!r) throw new OrgError(404, 'not_connected', 'No Razorpay account is connected.');
  const secret = await decryptSecret(env, ctx(orgId, 'key_secret'), r.key_secret_enc);
  let status: 'verified' | 'failed' = 'failed';
  let error: string | null = null;
  try {
    const credentials = btoa(`${r.key_id}:${secret}`);
    const res = await fetcher(`${razorpayApiBase(env)}/v1/payments?count=1`, {
      headers: { Authorization: `Basic ${credentials}` },
    });
    if (res.ok) status = 'verified';
    else if (res.status === 401) error = 'Razorpay rejected these keys (401). Check the key ID and secret.';
    else error = `Razorpay answered ${res.status}. Try again later.`;
  } catch {
    error = 'Could not reach Razorpay. Try again later.';
  }
  const now = Date.now();
  await db.batch([
    db.prepare('UPDATE org_payment_integrations SET status = ?, last_verified_at = ?, last_error = ?, updated_at = ? WHERE org_id = ? AND provider = ?')
      .bind(status, status === 'verified' ? now : r.last_verified_at, error, now, orgId, PROVIDER),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'payments.razorpay.verify', targetType: 'organization', targetId: orgId, orgId, details: { status, error }, ip: actor.ip }),
  ]);
  return { status, error };
}

export async function disconnectRazorpay(db: D1Database, orgId: string, actor: Actor) {
  const r = await row(db, orgId);
  if (!r) throw new OrgError(404, 'not_connected', 'No Razorpay account is connected.');
  await db.batch([
    db.prepare('DELETE FROM org_payment_integrations WHERE org_id = ? AND provider = ?').bind(orgId, PROVIDER),
    // The app stops using an account that is no longer connected.
    db.prepare("DELETE FROM platform_settings WHERE key = ? AND json_extract(value, '$.orgId') = ?").bind(APP_PAYMENTS_KEY, orgId),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'payments.razorpay.disconnect', targetType: 'organization', targetId: orgId, orgId, details: { keyIdHint: maskKeyId(r.key_id) }, ip: actor.ip }),
  ]);
}

// ── The app's payment account ──────────────────────────────────────────────
// The original app (one business, not organization-aware yet) creates payment
// links. This setting says which organization's own Razorpay account it uses.
// Unset: the shared account in the Worker's RAZORPAY_* secrets, as before.

const APP_PAYMENTS_KEY = 'app_payments';

export async function getAppPaymentsOrg(db: D1Database): Promise<string | null> {
  const r = await db.prepare('SELECT value FROM platform_settings WHERE key = ?').bind(APP_PAYMENTS_KEY).first<{ value: string }>();
  try {
    const v = r ? JSON.parse(r.value) as { orgId?: unknown } : {};
    return typeof v.orgId === 'string' && v.orgId ? v.orgId : null;
  } catch {
    return null;
  }
}

/** Point the app's payment links at this organization's account (null: back to the shared one). */
export async function setAppPaymentsOrg(db: D1Database, orgId: string | null, actor: Actor): Promise<void> {
  const previous = await getAppPaymentsOrg(db);
  if (orgId) {
    await orgExists(db, orgId);
    const r = await row(db, orgId);
    if (r?.status !== 'verified') {
      throw new OrgError(409, 'razorpay_not_verified', "Connect this organization's Razorpay and verify its keys first.");
    }
  }
  await db.batch([
    orgId
      ? db.prepare(
          `INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        ).bind(APP_PAYMENTS_KEY, JSON.stringify({ orgId }), Date.now(), actor.userId)
      : db.prepare('DELETE FROM platform_settings WHERE key = ?').bind(APP_PAYMENTS_KEY),
    auditStmt(db, {
      actorUserId: actor.userId, actorKind: 'provider_admin', action: 'payments.app_account.set',
      targetType: 'organization', targetId: orgId ?? previous ?? 'shared', orgId: orgId ?? previous ?? undefined,
      details: { from: previous ?? 'shared', to: orgId ?? 'shared' }, ip: actor.ip,
    }),
  ]);
}

/**
 * Keys to take payments with: only a connected account whose keys Razorpay
 * has accepted (status verified). Never falls back to another account, so a
 * business's money cannot land in someone else's.
 */
export async function verifiedRazorpayKeys(env: Env, db: D1Database, orgId: string): Promise<{ keyId: string; keySecret: string; mode: 'test' | 'live' } | null> {
  const r = await row(db, orgId);
  if (r?.status !== 'verified') return null;
  try {
    return { keyId: r.key_id, keySecret: await decryptSecret(env, ctx(orgId, 'key_secret'), r.key_secret_enc), mode: r.mode };
  } catch {
    return null;
  }
}

/** Decrypted credentials for server-side use only (creating payment links). */
export async function razorpayCredentials(env: Env, db: D1Database, orgId: string) {
  const r = await row(db, orgId);
  if (!r || r.status === 'disabled') return null;
  return { keyId: r.key_id, keySecret: await decryptSecret(env, ctx(orgId, 'key_secret'), r.key_secret_enc), mode: r.mode };
}

// ── Webhooks ──────────────────────────────────────────────────────────────

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signRazorpayBody(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
}

const MAX_WEBHOOK_BYTES = 256 * 1024;

/**
 * Verifies and records one webhook delivery for one organization. Answers
 * 200 for a duplicate (so Razorpay stops retrying) and never says whether an
 * organization exists: every failure before the signature check is 401.
 */
export async function receiveRazorpayWebhook(env: Env, db: D1Database, orgId: string, request: Request): Promise<{ status: number; body: unknown; event?: unknown }> {
  const unauthorized = { status: 401, body: { error: 'Invalid signature' } };
  const signature = request.headers.get('x-razorpay-signature') ?? '';
  const eventId = request.headers.get('x-razorpay-event-id') ?? '';
  const raw = await request.text();
  if (raw.length > MAX_WEBHOOK_BYTES) return { status: 413, body: { error: 'Too large' } };
  if (!signature || !eventId || eventId.length > 128) return unauthorized;

  const r = await row(db, orgId);
  if (!r?.webhook_secret_enc || r.status === 'disabled') return unauthorized;
  let secret: string;
  try { secret = await decryptSecret(env, ctx(orgId, 'webhook_secret'), r.webhook_secret_enc); } catch { return unauthorized; }
  if (!timingSafeEqual(await signRazorpayBody(secret, raw), signature.toLowerCase())) return unauthorized;

  let event: unknown;
  try { event = JSON.parse(raw); } catch { return { status: 400, body: { error: 'Invalid JSON' } }; }
  const eventType = String((event as { event?: unknown })?.event ?? '') || null;

  const result = await db.prepare(
    `INSERT INTO payment_webhook_events (org_id, provider, event_id, event_type, received_at, payload)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  ).bind(orgId, PROVIDER, eventId, eventType, Date.now(), raw).run();
  const duplicate = (result.meta?.changes ?? 0) === 0;
  // Handed back even for a duplicate: applying it is idempotent, and a retry
  // must be able to finish work a failed first attempt left undone.
  return { status: 200, body: { ok: true, duplicate }, event };
}
