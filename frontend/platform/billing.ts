// What organizations pay the platform for their plan.
//
// An organization's owner or admin picks a plan in the app (Admin → Plan),
// pays in Razorpay's checkout, and the plan changes at once. The money goes
// to the PLATFORM's own Razorpay account, connected in the control centre
// (Billing) and kept in platform_settings. An organization's own account
// (payments.ts) is for its customers and is never used here.
//
// A payment is confirmed whichever way comes first, and applied exactly once:
//   1. the browser hands back Razorpay's signed result (confirmCheckout);
//   2. the platform's webhook (order.paid, payment.captured, payment.failed);
//   3. anyone looking at it: Recheck in the app or the control centre.
// Each asks Razorpay for the order and its payments before believing
// anything; the browser's signature only says which order to look at.
//
// Nothing renews by itself: a payment buys one month or one year. Paying for
// the same plan again adds the period on to the end of the current one.

import type { Env } from '../workerEnv';
import { auditStmt } from './audit';
import { OrgError, type Actor } from './orgs';
import { razorpayApiBase, signRazorpayBody } from './payments';
import { parseLimits } from './plans';
import { discounted, runningOffers, type Offer } from './offers';
import { toPaymentDetail, type PaymentDetail } from './razorpayDetails';
import { decryptSecret, encryptSecret, maskKeyId, secretsConfigured } from './secrets';

const SETTINGS_KEY = 'billing_razorpay';
const KEY_ID_RE = /^rzp_(test|live)_[A-Za-z0-9]{8,32}$/;
/** Binds each stored secret to this use, so it can't be swapped with an organization's. */
const secretContext = (field: string) => `platform|razorpay-billing|${field}`;
/** Webhook deliveries are kept with the organizations' ones, under this name. */
const WEBHOOK_OWNER = '_platform_billing';

export type Period = 'monthly' | 'annual';
const PERIODS: Period[] = ['monthly', 'annual'];

/** An unpaid checkout started this recently is offered again instead of a new order. */
const REUSE_ORDER_MS = 30 * 60_000;
/** Payment details kept per checkout (attempts included). */
const MAX_DETAILS = 20;

// ── The platform's Razorpay account ───────────────────────────────────────

interface StoredAccount {
  mode: 'test' | 'live';
  keyId: string;
  keySecretEnc: string;
  webhookSecretEnc: string | null;
  status: 'unverified' | 'verified' | 'failed';
  lastVerifiedAt: number | null;
  lastError: string | null;
  connectedAt: number;
  connectedBy: string;
  updatedAt: number;
}

async function readAccount(db: D1Database): Promise<StoredAccount | null> {
  const row = await db.prepare('SELECT value FROM platform_settings WHERE key = ?').bind(SETTINGS_KEY).first<{ value: string }>();
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as StoredAccount;
    return typeof v.keyId === 'string' && typeof v.keySecretEnc === 'string' ? v : null;
  } catch {
    return null;
  }
}

function saveAccountStmt(db: D1Database, account: StoredAccount, actorId: string): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).bind(SETTINGS_KEY, JSON.stringify(account), account.updatedAt, actorId);
}

/** What the control centre may see. Never a secret. */
export async function describeBillingAccount(env: Env, db: D1Database, webhookUrl: string) {
  const a = await readAccount(db);
  const base = { webhookUrl, secretsConfigured: secretsConfigured(env) };
  if (!a) return { connected: false as const, ...base };
  return {
    connected: true as const,
    ...base,
    mode: a.mode,
    keyIdHint: maskKeyId(a.keyId),
    hasWebhookSecret: !!a.webhookSecretEnc,
    status: a.status,
    lastVerifiedAt: a.lastVerifiedAt,
    lastError: a.lastError,
    connectedAt: a.connectedAt,
    updatedAt: a.updatedAt,
  };
}

/** Connects (or replaces) the keys. A blank webhook secret keeps the stored one. */
export async function connectBillingAccount(env: Env, db: D1Database, body: Record<string, unknown>, actor: Actor): Promise<void> {
  if (!secretsConfigured(env)) {
    throw new OrgError(503, 'secrets_unavailable', 'Payment credential storage is not configured (PAYMENT_SECRETS_KEY).');
  }
  const keyId = typeof body.keyId === 'string' ? body.keyId.trim() : '';
  const keySecret = typeof body.keySecret === 'string' ? body.keySecret.trim() : '';
  const webhookSecret = typeof body.webhookSecret === 'string' ? body.webhookSecret.trim() : '';
  const match = KEY_ID_RE.exec(keyId);
  if (!match) throw new OrgError(400, 'invalid', 'Key ID must look like rzp_test_… or rzp_live_… (from Razorpay → Settings → API Keys).');
  if (keySecret.length < 16 || keySecret.length > 128) throw new OrgError(400, 'invalid', 'Enter the key secret shown when the key was generated.');
  if (webhookSecret && (webhookSecret.length < 8 || webhookSecret.length > 128)) {
    throw new OrgError(400, 'invalid', 'Webhook secret must be 8–128 characters.');
  }
  const existing = await readAccount(db);
  const now = Date.now();
  const account: StoredAccount = {
    mode: match[1] as 'test' | 'live',
    keyId,
    keySecretEnc: await encryptSecret(env, secretContext('key_secret'), keySecret),
    webhookSecretEnc: webhookSecret
      ? await encryptSecret(env, secretContext('webhook_secret'), webhookSecret)
      : existing?.webhookSecretEnc ?? null,
    status: 'unverified',
    lastVerifiedAt: null,
    lastError: null,
    connectedAt: existing?.connectedAt ?? now,
    connectedBy: existing?.connectedBy ?? actor.userId,
    updatedAt: now,
  };
  await db.batch([
    saveAccountStmt(db, account, actor.userId),
    auditStmt(db, {
      actorUserId: actor.userId, actorKind: 'provider_admin', action: existing ? 'billing.razorpay.replace' : 'billing.razorpay.connect',
      targetType: 'platform_settings', targetId: SETTINGS_KEY,
      details: { mode: account.mode, keyIdHint: maskKeyId(keyId), webhookSecretChanged: !!webhookSecret }, ip: actor.ip,
    }),
  ]);
}

/** One read-only call with the stored keys; organizations can pay only once this passes. */
export async function verifyBillingAccount(env: Env, db: D1Database, actor: Actor) {
  const a = await readAccount(db);
  if (!a) throw new OrgError(404, 'not_connected', 'No Razorpay account is connected for plan payments.');
  const secret = await decryptSecret(env, secretContext('key_secret'), a.keySecretEnc);
  let status: 'verified' | 'failed' = 'failed';
  let error: string | null = null;
  try {
    const res = await fetch(`${razorpayApiBase(env)}/v1/orders?count=1`, { headers: { Authorization: basicAuth(a.keyId, secret) } });
    if (res.ok) status = 'verified';
    else if (res.status === 401) error = 'Razorpay rejected these keys (401). Check the key ID and secret.';
    else error = `Razorpay answered ${res.status}. Try again later.`;
  } catch {
    error = 'Could not reach Razorpay. Try again later.';
  }
  const now = Date.now();
  const next: StoredAccount = { ...a, status, lastVerifiedAt: status === 'verified' ? now : a.lastVerifiedAt, lastError: error, updatedAt: now };
  await db.batch([
    saveAccountStmt(db, next, actor.userId),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'billing.razorpay.verify', targetType: 'platform_settings', targetId: SETTINGS_KEY, details: { status, error }, ip: actor.ip }),
  ]);
  return { status, error };
}

export async function disconnectBillingAccount(db: D1Database, actor: Actor): Promise<void> {
  const a = await readAccount(db);
  if (!a) throw new OrgError(404, 'not_connected', 'No Razorpay account is connected for plan payments.');
  await db.batch([
    db.prepare('DELETE FROM platform_settings WHERE key = ?').bind(SETTINGS_KEY),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'billing.razorpay.disconnect', targetType: 'platform_settings', targetId: SETTINGS_KEY, details: { keyIdHint: maskKeyId(a.keyId) }, ip: actor.ip }),
  ]);
}

function basicAuth(keyId: string, secret: string): string {
  const pair = `${keyId}:${secret}`;
  return `Basic ${btoa(pair)}`;
}

/** The account's keys when organizations can pay into it (verified). */
async function payableKeys(env: Env, db: D1Database): Promise<{ keyId: string; keySecret: string; mode: 'test' | 'live' } | null> {
  const a = await readAccount(db);
  if (a?.status !== 'verified') return null;
  try {
    return { keyId: a.keyId, keySecret: await decryptSecret(env, secretContext('key_secret'), a.keySecretEnc), mode: a.mode };
  } catch {
    return null;
  }
}

/**
 * The keys a checkout was made with, to ask Razorpay about it. Only while
 * that same key is still the connected one (verified or not): after a key
 * change the old orders can't be read with the new key.
 */
async function keysForPayment(env: Env, db: D1Database, keyId: string): Promise<{ keyId: string; keySecret: string } | null> {
  const a = await readAccount(db);
  if (a?.keyId !== keyId) return null;
  try {
    return { keyId: a.keyId, keySecret: await decryptSecret(env, secretContext('key_secret'), a.keySecretEnc) };
  } catch {
    return null;
  }
}

async function razorpay(env: Env, keys: { keyId: string; keySecret: string }, method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await fetch(`${razorpayApiBase(env)}/v1${path}`, {
    method,
    headers: { Authorization: basicAuth(keys.keyId, keys.keySecret), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({})) as Record<string, any>;
  return { ok: res.ok, status: res.status, data };
}

// ── Plans an organization can pay for ─────────────────────────────────────

export interface PlanOption {
  key: string;
  name: string;
  description: string;
  currency: string;
  priceMonthly: number;
  priceAnnual: number;
  /** The organization's plan now (its own version, so renewing keeps its price). */
  current: boolean;
  highlights: { limits: Record<string, number | null>; modules: Record<string, boolean>; features: Record<string, boolean> };
  /** A limited-time offer this organization gets on this plan now, with the prices after it. */
  offer: { percentOff: number; label: string; endsAt: number; priceMonthly: number; priceAnnual: number } | null;
}

interface VersionRow {
  plan_id: string;
  version_id: string;
  key: string;
  name: string;
  description: string;
  currency: string;
  price_monthly: number;
  price_annual: number;
  billing_type: string;
  limits: string;
}

/** Paid plans on offer (published and public), and the organization's own if it is paid. */
async function planOptions(db: D1Database, orgId: string): Promise<(PlanOption & { versionId: string })[]> {
  const [{ results: offered }, own] = await Promise.all([
    db.prepare(
      `SELECT p.id AS plan_id, v.id AS version_id, p.key, p.name, p.description, v.currency, v.price_monthly, v.price_annual, v.billing_type, v.limits
       FROM plans p JOIN plan_versions v ON v.plan_id = p.id AND v.status = 'published'
       WHERE p.status = 'published' AND p.is_public = 1 AND v.billing_type = 'paid'
         AND v.version = (SELECT MAX(v2.version) FROM plan_versions v2 WHERE v2.plan_id = p.id AND v2.status = 'published')
       ORDER BY p.sort_order, p.name`,
    ).all<VersionRow>(),
    db.prepare(
      `SELECT p.id AS plan_id, v.id AS version_id, p.key, p.name, p.description, v.currency, v.price_monthly, v.price_annual, v.billing_type, v.limits
       FROM subscriptions s JOIN plan_versions v ON v.id = s.plan_version_id JOIN plans p ON p.id = v.plan_id
       WHERE s.org_id = ?`,
    ).bind(orgId).first<VersionRow>(),
  ]);
  const offers = await runningOffers(db);
  const toOption = (r: VersionRow, current: boolean) => {
    const limits = parseLimits(JSON.parse(r.limits || '{}'));
    return {
      versionId: r.version_id, key: r.key, name: r.name, description: r.description, currency: r.currency,
      priceMonthly: r.price_monthly, priceAnnual: r.price_annual, current,
      highlights: { limits: limits.limits, modules: limits.modules, features: limits.features },
      offer: offerFor(offers.get(r.plan_id), current, r),
    };
  };
  const list = offered.map(r => (own?.key === r.key ? toOption(own, true) : toOption(r, false)));
  if (own?.billing_type === 'paid' && !list.some(o => o.key === own.key)) list.unshift(toOption(own, true));
  return list;
}

/** The offer this organization gets on a plan: renewals of its own plan only when the offer says so. */
function offerFor(offer: Offer | undefined, current: boolean, r: VersionRow): PlanOption['offer'] {
  if (!offer || (current && !offer.includeRenewals)) return null;
  const price = (amount: number) => (amount >= 100 ? discounted(amount, offer.percentOff) : amount);
  return {
    percentOff: offer.percentOff, label: offer.label, endsAt: offer.endsAt,
    priceMonthly: price(r.price_monthly), priceAnnual: price(r.price_annual),
  };
}

/** GET /billing for the app: what can be paid for, and whether paying works yet. */
export async function billingOptions(env: Env, db: D1Database, orgId: string) {
  const [account, options] = await Promise.all([readAccount(db), planOptions(db, orgId)]);
  const payable = account?.status === 'verified' && secretsConfigured(env);
  return {
    payable,
    mode: payable ? account.mode : null,
    reason: payable ? null : "Online payment isn't set up yet. Contact us to change your plan.",
    plans: options.map(({ versionId: _internal, ...o }) => o),
  };
}

// ── Checkout ──────────────────────────────────────────────────────────────

export interface BillingPaymentRow {
  id: string;
  org_id: string;
  plan_version_id: string;
  plan_key: string;
  plan_name: string;
  period: Period;
  amount: number;
  currency: string;
  mode: 'test' | 'live';
  key_id: string;
  razorpay_order_id: string;
  razorpay_payment_id: string | null;
  status: 'created' | 'attempted' | 'paid';
  method: string | null;
  details: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: number;
  paid_at: number | null;
  checked_at: number | null;
  applied_at: number | null;
  period_start: number | null;
  period_end: number | null;
  list_amount: number | null;
  discount_percent: number | null;
  offer_label: string | null;
}

/** What Razorpay's checkout needs to open for one payment. */
function checkoutFor(row: BillingPaymentRow, orgName: string, payer: { name: string; email: string }) {
  return {
    id: row.id,
    orderId: row.razorpay_order_id,
    keyId: row.key_id,
    amount: row.amount,
    currency: row.currency,
    planName: row.plan_name,
    period: row.period,
    mode: row.mode,
    orgName,
    prefill: { name: payer.name, email: payer.email },
  };
}

/**
 * The price for a period: the list price, lowered by a running offer. The
 * list price and the offer are kept with the payment.
 */
function checkoutPrice(option: { name: string; priceAnnual: number; priceMonthly: number; offer?: { priceAnnual: number; priceMonthly: number } | null }, period: Period): { listAmount: number; amount: number } {
  const annual = period === 'annual';
  const listAmount = annual ? option.priceAnnual : option.priceMonthly;
  if (listAmount < 100) throw new OrgError(400, 'invalid', `${option.name} has no ${annual ? 'annual' : 'monthly'} price.`);
  if (!option.offer) return { listAmount, amount: listAmount };
  return { listAmount, amount: annual ? option.offer.priceAnnual : option.offer.priceMonthly };
}

export async function startCheckout(
  env: Env, db: D1Database, orgId: string, body: Record<string, unknown>,
  payer: { userId: string; name: string; email: string; ip: string | null },
) {
  const planKey = typeof body.planKey === 'string' ? body.planKey : '';
  const period = PERIODS.includes(body.period as Period) ? body.period as Period : null;
  if (!period) throw new OrgError(400, 'invalid', 'Choose monthly or annual.');
  const option = (await planOptions(db, orgId)).find(o => o.key === planKey);
  if (!option) throw new OrgError(404, 'plan_unavailable', 'That plan is not available to buy. Refresh and choose again.');
  const { listAmount, amount } = checkoutPrice(option, period);
  const keys = await payableKeys(env, db);
  if (!keys) throw new OrgError(503, 'billing_unavailable', "Online payment isn't set up yet. Contact us to change your plan.");
  const org = await db.prepare('SELECT name FROM organizations WHERE id = ?').bind(orgId).first<{ name: string }>();
  if (!org) throw new OrgError(404, 'org_not_found', 'Organization not found.');
  const offer = option.offer;
  const offerLabel = offer?.label ? ` (${offer.label.slice(0, 60)})` : '';

  // Opening the checkout again (closed by mistake, a retry) reuses the order.
  const recent = await db.prepare(
    `SELECT * FROM billing_payments
     WHERE org_id = ? AND plan_version_id = ? AND period = ? AND amount = ? AND key_id = ? AND created_by = ?
       AND status IN ('created', 'attempted') AND created_at > ?
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(orgId, option.versionId, period, amount, keys.keyId, payer.userId, Date.now() - REUSE_ORDER_MS).first<BillingPaymentRow>();
  if (recent) return checkoutFor(recent, org.name, payer);

  const id = crypto.randomUUID();
  const order = await razorpay(env, keys, 'POST', '/orders', {
    amount,
    currency: option.currency,
    receipt: id,
    notes: {
      purpose: 'plan', org_id: orgId, organization: org.name.slice(0, 200), plan: option.key, period, payment_ref: id,
      ...(offer ? { offer: `${offer.percentOff}% off${offerLabel}`, list_amount: listAmount } : {}),
    },
  }).catch(() => null);
  if (!order?.ok || typeof order.data.id !== 'string') {
    throw new OrgError(502, 'razorpay_error', order?.data?.error?.description || "Couldn't start the payment with Razorpay. Try again in a moment.");
  }
  const now = Date.now();
  await db.batch([
    db.prepare(
      `INSERT INTO billing_payments (id, org_id, plan_version_id, plan_key, plan_name, period, amount, currency, mode, key_id,
         razorpay_order_id, status, created_by, created_by_name, created_at, list_amount, discount_percent, offer_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?)`,
    ).bind(id, orgId, option.versionId, option.key, option.name, period, amount, option.currency, keys.mode, keys.keyId,
      order.data.id, payer.userId, payer.name.slice(0, 200), now,
      offer ? listAmount : null, offer?.percentOff ?? null, offer ? offer.label || null : null),
    auditStmt(db, {
      actorUserId: payer.userId, actorKind: 'user', action: 'billing.checkout.start', targetType: 'billing_payment', targetId: id, orgId,
      details: { plan: option.key, period, amount, listAmount, offer, currency: option.currency, orderId: order.data.id }, ip: payer.ip,
    }),
  ]);
  const row = await db.prepare('SELECT * FROM billing_payments WHERE id = ?').bind(id).first<BillingPaymentRow>();
  return checkoutFor(row!, org.name, payer);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a.codePointAt(i) ?? 0) ^ (b.codePointAt(i) ?? 0);
  return diff === 0;
}

async function loadOrgPayment(db: D1Database, orgId: string, id: string): Promise<BillingPaymentRow> {
  const row = await db.prepare('SELECT * FROM billing_payments WHERE id = ? AND org_id = ?').bind(id, orgId).first<BillingPaymentRow>();
  if (!row) throw new OrgError(404, 'payment_not_found', 'Payment not found.');
  return row;
}

/**
 * The browser's result from Razorpay's checkout. Its signature proves the
 * order and payment ids came from Razorpay; the payment is then read back
 * from Razorpay before the plan changes.
 */
export async function confirmCheckout(env: Env, db: D1Database, orgId: string, body: Record<string, unknown>) {
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const id = text(body.id);
  const orderId = text(body.razorpay_order_id);
  const paymentId = text(body.razorpay_payment_id);
  const signature = text(body.razorpay_signature).toLowerCase();
  if (!id || !orderId || !paymentId || !signature) throw new OrgError(400, 'invalid', 'The payment result is incomplete.');
  const row = await loadOrgPayment(db, orgId, id);
  if (row.razorpay_order_id !== orderId) throw new OrgError(400, 'invalid', 'This payment result belongs to another order.');
  const keys = await keysForPayment(env, db, row.key_id);
  if (!keys) throw new OrgError(503, 'billing_unavailable', 'The Razorpay account this payment was made in is no longer connected. Contact us.');
  const expected = await signRazorpayBody(keys.keySecret, `${orderId}|${paymentId}`);
  if (!timingSafeEqual(expected, signature)) throw new OrgError(400, 'signature_invalid', "The payment result couldn't be verified. If money was taken, use Recheck or contact us.");
  return reconcileBillingPayment(env, db, row);
}

// ── Asking Razorpay, and applying a paid payment ──────────────────────────

/** Adds a month or a year, keeping the day where the month has one (31 Jan → 28/29 Feb). */
export function addPeriod(from: number, period: Period): number {
  const d = new Date(from);
  const months = period === 'annual' ? 12 : 1;
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return target.getTime();
}

/**
 * Moves the organization onto the paid plan, once. The payment row takes a
 * token first; the subscription change and its audit entry happen in the
 * same transaction only if that token is theirs, so a browser, a webhook and
 * a recheck arriving together change the plan exactly once.
 */
async function applyPaidPayment(db: D1Database, id: string): Promise<boolean> {
  const row = await db.prepare('SELECT * FROM billing_payments WHERE id = ?').bind(id).first<BillingPaymentRow>();
  if (row?.status !== 'paid' || row.applied_at) return false;
  const sub = await db.prepare('SELECT plan_version_id, status, current_period_end FROM subscriptions WHERE org_id = ?')
    .bind(row.org_id).first<{ plan_version_id: string | null; status: string; current_period_end: number | null }>();
  const paidAt = row.paid_at ?? Date.now();
  // The same plan, still running: the new period follows on from the current one.
  const currentEnd = sub?.current_period_end ?? 0;
  const continues = sub?.plan_version_id === row.plan_version_id && sub.status === 'active' && currentEnd > paidAt;
  const start = continues ? currentEnd : paidAt;
  const end = addPeriod(start, row.period);
  const token = crypto.randomUUID();
  const now = Date.now();
  const mine = '(SELECT applied_token FROM billing_payments WHERE id = ?) = ?';
  await db.batch([
    db.prepare('UPDATE billing_payments SET applied_token = ?, applied_at = ?, period_start = ?, period_end = ? WHERE id = ? AND applied_token IS NULL')
      .bind(token, now, start, end, id),
    db.prepare(
      `INSERT INTO subscriptions (org_id, plan_version_id, status, current_period_end, payment_waived, started_at, updated_at, updated_by)
       SELECT ?, ?, 'active', ?, 0, ?, ?, ? WHERE ${mine}
       ON CONFLICT(org_id) DO UPDATE SET
         plan_version_id = excluded.plan_version_id, status = 'active', current_period_end = excluded.current_period_end,
         payment_waived = 0, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).bind(row.org_id, row.plan_version_id, end, now, now, row.created_by, id, token),
    db.prepare(
      `INSERT INTO platform_audit (id, at, actor_user_id, actor_kind, action, target_type, target_id, org_id, details, ip)
       SELECT ?, ?, NULL, 'system', 'billing.payment.applied', 'organization', ?, ?, ?, NULL WHERE ${mine}`,
    ).bind(crypto.randomUUID(), now, row.org_id, row.org_id, JSON.stringify({
      paymentId: id, orderId: row.razorpay_order_id, razorpayPaymentId: row.razorpay_payment_id,
      plan: row.plan_key, planVersionId: row.plan_version_id, period: row.period, amount: row.amount,
      before: sub ?? null, periodStart: start, periodEnd: end,
    }), id, token),
  ]);
  const after = await db.prepare('SELECT applied_token FROM billing_payments WHERE id = ?').bind(id).first<{ applied_token: string }>();
  return after?.applied_token === token;
}

export interface Reconciled {
  payment: BillingPaymentRow;
  checked: boolean;
  /** This call is the one that moved the organization onto the plan. */
  applied: boolean;
  reason?: string;
}

/**
 * Reads the order and every payment on it from Razorpay, records what it
 * finds, and applies the plan when the order is paid. A payment that was
 * only authorised (an account set to capture by hand) is captured first.
 */
export async function reconcileBillingPayment(env: Env, db: D1Database, row: BillingPaymentRow): Promise<Reconciled> {
  const keys = await keysForPayment(env, db, row.key_id);
  if (!keys) {
    // Paid but never applied (e.g. the keys changed right after): still apply.
    const applied = await applyPaidPayment(db, row.id);
    const payment = await db.prepare('SELECT * FROM billing_payments WHERE id = ?').bind(row.id).first<BillingPaymentRow>();
    return { payment: payment ?? row, checked: false, applied, reason: 'The Razorpay account this payment was made in is no longer connected. Showing what was last recorded.' };
  }
  const orderPath = `/orders/${encodeURIComponent(row.razorpay_order_id)}`;
  const [order, list] = await Promise.all([
    razorpay(env, keys, 'GET', orderPath).catch(() => null),
    razorpay(env, keys, 'GET', `${orderPath}/payments`).catch(() => null),
  ]);
  if (!order?.ok || !list?.ok) {
    return { payment: row, checked: false, applied: await applyPaidPayment(db, row.id), reason: "Couldn't reach Razorpay. Showing what was last recorded." };
  }
  const items: any[] = Array.isArray(list.data.items) ? list.data.items : [];
  const settledStatuses = new Set(['captured', 'refunded']);
  if (!items.some(p => settledStatuses.has(p?.status))) {
    const authorized = items.find(p => p?.status === 'authorized' && Number(p.amount) === row.amount);
    if (authorized) {
      const captured = await razorpay(env, keys, 'POST', `/payments/${encodeURIComponent(authorized.id)}/capture`, { amount: row.amount, currency: row.currency }).catch(() => null);
      if (captured?.ok) items[items.indexOf(authorized)] = captured.data;
    }
  }
  const details: PaymentDetail[] = items.map(toPaymentDetail)
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_DETAILS);
  const settled = details.find(p => settledStatuses.has(p.status) && p.amount === row.amount);
  const paid = order.data.status === 'paid' || !!settled;
  const tried = details.length > 0 || order.data.status === 'attempted';
  let status: BillingPaymentRow['status'] = 'created';
  if (paid) status = 'paid';
  else if (tried) status = 'attempted';
  const now = Date.now();
  await db.prepare(
    `UPDATE billing_payments SET
       status = CASE WHEN status = 'paid' THEN 'paid' ELSE ? END,
       razorpay_payment_id = COALESCE(?, razorpay_payment_id), method = COALESCE(?, method),
       paid_at = CASE WHEN ? = 'paid' THEN COALESCE(paid_at, ?) ELSE paid_at END,
       details = ?, checked_at = ?
     WHERE id = ?`,
  ).bind(status, settled?.id ?? null, settled?.method || null, status, settled?.createdAt || now, JSON.stringify(details), now, row.id).run();
  const applied = paid ? await applyPaidPayment(db, row.id) : false;
  const payment = await db.prepare('SELECT * FROM billing_payments WHERE id = ?').bind(row.id).first<BillingPaymentRow>();
  return { payment: payment ?? row, checked: true, applied };
}

export async function recheckOrgPayment(env: Env, db: D1Database, orgId: string, id: string) {
  return reconcileBillingPayment(env, db, await loadOrgPayment(db, orgId, id));
}

export async function recheckAnyPayment(env: Env, db: D1Database, id: string) {
  const row = await db.prepare('SELECT * FROM billing_payments WHERE id = ?').bind(id).first<BillingPaymentRow>();
  if (!row) throw new OrgError(404, 'payment_not_found', 'Payment not found.');
  return reconcileBillingPayment(env, db, row);
}

// ── Showing payments ──────────────────────────────────────────────────────

/**
 * One payment for a screen. The organization sees what it paid and how; the
 * provider also sees Razorpay's fee and tax on it.
 */
export function paymentView(row: BillingPaymentRow, audience: 'org' | 'provider') {
  let payments: PaymentDetail[] = [];
  try { payments = row.details ? JSON.parse(row.details) as PaymentDetail[] : []; } catch { payments = []; }
  if (audience === 'org') payments = payments.map(({ fee: _fee, tax: _tax, ...p }) => p);
  return {
    id: row.id,
    orderId: row.razorpay_order_id,
    planKey: row.plan_key,
    planName: row.plan_name,
    period: row.period,
    amount: row.amount,
    currency: row.currency,
    mode: row.mode,
    status: row.status,
    method: row.method,
    paymentId: row.razorpay_payment_id,
    createdAt: row.created_at,
    createdByName: row.created_by_name,
    paidAt: row.paid_at,
    checkedAt: row.checked_at,
    appliedAt: row.applied_at,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    listAmount: row.list_amount,
    discountPercent: row.discount_percent,
    offerLabel: row.offer_label,
    payments,
  };
}

export async function listOrgPayments(db: D1Database, orgId: string) {
  const { results } = await db.prepare('SELECT * FROM billing_payments WHERE org_id = ? ORDER BY created_at DESC LIMIT 50')
    .bind(orgId).all<BillingPaymentRow>();
  return results.map(r => paymentView(r, 'org'));
}

/** The control centre's list: every organization's plan payments, newest first. */
export async function listAllPayments(db: D1Database, params: URLSearchParams) {
  const status = params.get('status');
  const orgId = params.get('org');
  const where: string[] = [];
  const binds: unknown[] = [];
  if (status && ['created', 'attempted', 'paid'].includes(status)) { where.push('b.status = ?'); binds.push(status); }
  if (orgId && /^[A-Za-z0-9-]{1,64}$/.test(orgId)) { where.push('b.org_id = ?'); binds.push(orgId); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `SELECT b.*, o.name AS org_name FROM billing_payments b LEFT JOIN organizations o ON o.id = b.org_id
               ${whereSql} ORDER BY b.created_at DESC LIMIT 200`;
  const since = Date.now() - 30 * 86_400_000;
  const [{ results }, summary] = await Promise.all([
    db.prepare(sql).bind(...binds).all<BillingPaymentRow & { org_name: string | null }>(),
    db.prepare(
      `SELECT COUNT(*) AS paid_count, COALESCE(SUM(amount), 0) AS paid_amount,
              (SELECT COUNT(*) FROM billing_payments WHERE status = 'paid' AND paid_at >= ?) AS paid_30d_count,
              (SELECT COALESCE(SUM(amount), 0) FROM billing_payments WHERE status = 'paid' AND paid_at >= ?) AS paid_30d_amount,
              (SELECT COUNT(*) FROM billing_payments WHERE status = 'attempted' AND created_at >= ?) AS failed_30d_count,
              (SELECT COUNT(*) FROM billing_payments WHERE status = 'paid' AND mode = 'test') AS test_count
       FROM billing_payments WHERE status = 'paid'`,
    ).bind(since, since, since).first<Record<string, number>>(),
  ]);
  return {
    payments: results.map(r => ({ ...paymentView(r, 'provider'), orgId: r.org_id, orgName: r.org_name })),
    summary: {
      paidCount: summary?.paid_count ?? 0,
      paidAmount: summary?.paid_amount ?? 0,
      paid30dCount: summary?.paid_30d_count ?? 0,
      paid30dAmount: summary?.paid_30d_amount ?? 0,
      unfinished30dCount: summary?.failed_30d_count ?? 0,
      /** Paid in test mode (no real money), counted in the totals above. */
      testCount: summary?.test_count ?? 0,
    },
  };
}

export async function orgNameOf(db: D1Database, orgId: string): Promise<string | null> {
  const r = await db.prepare('SELECT name FROM organizations WHERE id = ?').bind(orgId).first<{ name: string }>();
  return r?.name ?? null;
}

// ── Webhook ───────────────────────────────────────────────────────────────

const MAX_WEBHOOK_BYTES = 256 * 1024;

/**
 * POST /api/v2/webhooks/billing/razorpay. Verified with the platform
 * account's webhook secret and stored once per event id. The event only says
 * which order to look at: its state is read back from Razorpay and applied
 * like a recheck. Anything that fails before the signature check is 401.
 */
export async function receiveBillingWebhook(env: Env, db: D1Database, request: Request): Promise<{ status: number; body: unknown }> {
  const unauthorized = { status: 401, body: { error: 'Invalid signature' } };
  const signature = request.headers.get('x-razorpay-signature') ?? '';
  const eventId = request.headers.get('x-razorpay-event-id') ?? '';
  const raw = await request.text();
  if (raw.length > MAX_WEBHOOK_BYTES) return { status: 413, body: { error: 'Too large' } };
  if (!signature || !eventId || eventId.length > 128) return unauthorized;
  const a = await readAccount(db);
  if (!a?.webhookSecretEnc) return unauthorized;
  let secret: string;
  try { secret = await decryptSecret(env, secretContext('webhook_secret'), a.webhookSecretEnc); } catch { return unauthorized; }
  if (!timingSafeEqual(await signRazorpayBody(secret, raw), signature.toLowerCase())) return unauthorized;

  let event: any;
  try { event = JSON.parse(raw); } catch { return { status: 400, body: { error: 'Invalid JSON' } }; }
  const result = await db.prepare(
    `INSERT INTO payment_webhook_events (org_id, provider, event_id, event_type, received_at, payload)
     VALUES (?, 'razorpay', ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  ).bind(WEBHOOK_OWNER, eventId, String(event?.event ?? '') || null, Date.now(), raw).run();
  const duplicate = (result.meta?.changes ?? 0) === 0;

  const orderId = event?.payload?.order?.entity?.id ?? event?.payload?.payment?.entity?.order_id;
  if (typeof orderId === 'string' && orderId) {
    const row = await db.prepare('SELECT * FROM billing_payments WHERE razorpay_order_id = ?').bind(orderId).first<BillingPaymentRow>();
    // Applying is idempotent, so a retried delivery can finish what a failed one didn't.
    if (row) await reconcileBillingPayment(env, db, row);
  }
  await db.prepare('UPDATE payment_webhook_events SET processed_at = ? WHERE org_id = ? AND provider = ? AND event_id = ?')
    .bind(Date.now(), WEBHOOK_OWNER, 'razorpay', eventId).run();
  return { status: 200, body: { ok: true, duplicate } };
}
