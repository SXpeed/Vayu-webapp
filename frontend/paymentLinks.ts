// Razorpay payment links: making them (in the account the request belongs
// to, for an amount the server approves), their storage, refunds, the
// webhooks and the scheduled reconciliation.

import { ADMIN_ROLE_ID } from './permissions';
import { err, json, runSetupOnce } from './rows';
import { timingSafeEqual, type Ctx, type Env, type SessionData } from './workerEnv';
import { getSession } from './workerRoles';
import { orgStorageEnv } from './orgApp';
import { queueHubNotify } from './deltaSync';
import { razorpayApiBase, razorpayCredentials, signRazorpayBody, verifiedRazorpayKeys } from './platform/payments';
import { maskKeyId } from './platform/secrets';
import { recordProcessed, recordProcessingFailure, recordReconcile, recordRejection, recordVerified, safeError, type ReconcileOutcome } from './platform/webhookHealth';
import {
  CURRENCY, amountProblem, idempotencyKey, invoiceTotals, maxPaise, outstandingPaise, overrideNeeded, overrideReason,
  nextLinkStatus, referenceIdFor, testModeRefusal, requestFingerprint, requestedPaise, type InvoiceLike, type InvoiceTotals, type OverrideKind,
} from './paymentLinkPolicy';
import { toPaymentDetail, type PaymentDetail } from './platform/razorpayDetails';

export interface PaymentLinkRoute { method: string; match: (path: string) => boolean; handler: (ctx: Ctx) => Promise<Response> }

/** What this module uses from worker.ts. */
export interface PaymentLinkDeps {
  logActivity(db: D1Database, userId: string, userName: string, action: string, entity: string, entityId: string, details: string): Promise<void>;
  sendPushToSection(env: Env, section: 'payments', exceptUserId: string, payload: { title: string; body: string; tag: string; data: Record<string, string> }): Promise<void>;
  ensureInvoicesTable(db: D1Database): Promise<void>;
}

let deps: PaymentLinkDeps;
const logActivity: PaymentLinkDeps['logActivity'] = (...args) => deps.logActivity(...args);
const sendPushToSection: PaymentLinkDeps['sendPushToSection'] = (...args) => deps.sendPushToSection(...args);
const ensureInvoicesTable: PaymentLinkDeps['ensureInvoicesTable'] = (db) => deps.ensureInvoicesTable(db);

// ── Razorpay payment links ──────────────────────────────────────────────────
// Links are created via the Razorpay Payment Links API and tracked in the
// workspace's own database (payment_links, ensurePaymentLinksTable). Which Razorpay account creates them is
// chosen in the control centre (appRazorpayAccount): an organization's own
// account, or the shared one. When a link is paid, that account's webhook
// arrives (the shared account's at POST /payments/webhook, an organization's
// at /api/v2/webhooks/razorpay/<orgId>); we verify its signature, mark the
// record paid and push-notify the whole team (applyPaymentLinkEvent).

type PaymentMode = 'test' | 'live';

interface StoredPaymentLink {
  id: string;
  shortUrl: string;
  amount: number; // paise
  description: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  status: string; // created | paid | partially_paid | expired | cancelled
  createdAt: number;
  createdBy: string;
  createdByName: string;
  paidAt?: number;
  paymentId?: string;
  paymentMethod?: string;
  /** The Razorpay account it was created in: an organization id, or 'shared'. */
  account?: string;
  /** The organization it belongs to (null: the original app, before organizations). Set on links made since the 2026-09 hardening. */
  orgId?: string | null;
  /**
   * Test or live, from the keys it was made with. Missing on older links
   * until a status check with that account's keys proves which (a test key
   * can't read live links and the other way round); until then it counts as
   * unknown and stays out of live totals.
   */
  mode?: PaymentMode;
  currency?: string;
  /** "rzp_live_…WXYZ": which key made it, for audits. */
  keyIdHint?: string;
  /** Razorpay's reference_id: unique per request (idempotency), used to find a link whose creation answer was lost. */
  referenceId?: string;
  /** The proforma invoice it collects against, if any. */
  invoiceId?: string;
  /** What was approved when it was made (amount, invoice totals, any override and who made it). Never changed afterwards. */
  approved?: ApprovedAmount;
  /** What customers have paid on it, in paise (Razorpay's amount_paid). */
  amountPaid?: number;
  /** Consecutive failed status checks (the scheduled job backs off). */
  checkFailures?: number;
  /** Last time its refunds were asked of Razorpay. */
  refundsCheckedAt?: number;
  /** When the link stops accepting payment (Razorpay's expire_by); unset: Razorpay's default. */
  expiresAt?: number;
  /** Last time the app asked Razorpay for this link's status (see reconcilePaymentLinks). */
  checkedAt?: number;
  /** What Razorpay recorded for each payment on the link, as last fetched (see /details). */
  payments?: PaymentDetail[];
}

/** Links that can still be paid. */
const OPEN_LINK_STATUSES = new Set(['created', 'partially_paid']);
/** Razorpay wants expire_by at least 15 minutes ahead; the app offers up to six months. */
const MIN_LINK_VALIDITY_MS = 20 * 60_000;
const MAX_LINK_VALIDITY_MS = 180 * 86_400_000;

/** A requested expiry: undefined when none was asked for, null when it is out of range. */
function parseLinkExpiry(value: unknown): number | null | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const at = Number(value);
  const ahead = at - Date.now();
  if (!Number.isFinite(at) || ahead < MIN_LINK_VALIDITY_MS || ahead > MAX_LINK_VALIDITY_MS) return null;
  return Math.floor(at);
}

/**
 * The keys of the Razorpay account a link was made in — needed to cancel it,
 * change it or read its status. Links from before accounts were recorded
 * were all made in the shared account.
 */
async function linkAccountKeys(env: Env, link: Pick<StoredPaymentLink, 'account' | 'mode'>): Promise<{ keyId: string; keySecret: string; mode: PaymentMode | null } | null> {
  const account = link.account;
  let keys: { keyId: string; keySecret: string; mode: PaymentMode | null } | null = null;
  if (!account || account === 'shared') {
    keys = env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET ? { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET, mode: keyMode(env.RAZORPAY_KEY_ID) } : null;
  } else if (env.PLATFORM_DB) {
    try {
      keys = await razorpayCredentials(env, env.PLATFORM_DB, account);
    } catch (e) {
      console.error(JSON.stringify({ event: 'payment_keys_unavailable', account: account.slice(0, 64), reason: (e as Error).name }));
      keys = null;
    }
  }
  // The account's keys now are for the other mode (test keys replaced by
  // live ones, say): they can't see this link, and must not be used as if
  // they could. The link keeps its mode and account.
  if (keys && link.mode && keys.mode && keys.mode !== link.mode) return null;
  return keys;
}

/**
 * An older link's mode, proven by reading it with its account's keys: test
 * and live are separate at Razorpay, so a successful read settles it.
 */
function noteProvenMode(link: StoredPaymentLink, keys: { mode: PaymentMode | null }): void {
  if (!link.mode && keys.mode) link.mode = keys.mode;
}

/** One payment, from Razorpay's Payments API, with the given account's keys. */
async function razorpayPayment(env: Env, keys: { keyId: string; keySecret: string }, paymentId: string): Promise<any> { // null when there is none
  const res = await fetch(`${razorpayApiBase(env)}/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { 'Authorization': basicAuthHeader(keys.keyId, keys.keySecret) },
  });
  return res.ok ? res.json().catch(() => null) : null;
}

/** One Razorpay Payment Links API call with the given account's keys. */
async function razorpayLinkCall(
  env: Env, keys: { keyId: string; keySecret: string }, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown,
): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(`${razorpayApiBase(env)}/v1/payment_links${path}`, {
    method,
    headers: { 'Authorization': basicAuthHeader(keys.keyId, keys.keySecret), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/** Copy Razorpay's view of a link onto the record; true when the status changed to paid. */
function applyRazorpayLinkState(record: StoredPaymentLink, entity: any): boolean {
  const wasPaid = record.status === 'paid';
  if (typeof entity?.status === 'string') record.status = entity.status;
  if (Number(entity?.expire_by) > 0) record.expiresAt = Number(entity.expire_by) * 1000;
  if (Number.isSafeInteger(entity?.amount_paid) && entity.amount_paid >= 0) record.amountPaid = entity.amount_paid;
  const payment = Array.isArray(entity?.payments) ? entity.payments.find((p: any) => p?.status === 'captured') ?? entity.payments[0] : null;
  if (record.status === 'paid' && payment) {
    record.paidAt ??= Number(payment.created_at) > 0 ? Number(payment.created_at) * 1000 : Date.now();
    record.paymentId ||= payment.payment_id || '';
    record.paymentMethod ||= payment.method || '';
  }
  return !wasPaid && record.status === 'paid';
}

/** A Razorpay key id's mode, or null when it isn't a Razorpay key id. */
function keyMode(keyId: string | undefined): PaymentMode | null {
  const m = /^rzp_(test|live)_/.exec(keyId ?? '');
  return m ? m[1] as PaymentMode : null;
}

/** The account a new payment link is made in, or why none may be. */
type LinkAccount = {
  keyId: string; keySecret: string;
  /** 'shared' (the original business, before organizations) or the organization id. */
  account: string; orgId: string | null;
  mode: PaymentMode;
  /** Test-mode links are allowed for this account in this environment. */
  testAllowed: boolean;
};
type LinkAccountRefusal = { error: string; code: string; status: number };

/** Local development and tests: test-mode keys need no extra permission there. */
const isDevelopment = (env: Env) => env.PLATFORM_ENV === 'development';

/**
 * The Razorpay account a NEW payment link is made in. Explicit, never chosen
 * by a global setting:
 *   - a request for an organization (/api/o/<org>/…): that organization's own
 *     verified account, and nothing else, whichever storage it uses;
 *   - the original app on its own (/api, no organization): only the shared
 *     account in the RAZORPAY_* secrets, and only while LEGACY_PAYMENT_LINKS
 *     is on (docs/PAYMENT_SECURITY.md has the cutoff).
 * A business's money must never land in another business's account, so
 * there is no fallback from one to the other.
 */
async function linkAccountFor(env: Env): Promise<LinkAccount | LinkAccountRefusal> {
  if (env.ORG_ID) {
    const own = env.PLATFORM_DB ? await verifiedRazorpayKeys(env, env.PLATFORM_DB, env.ORG_ID) : null;
    if (!own) {
      return { status: 503, code: 'account_not_ready', error: "This business's Razorpay account isn't connected and verified yet. Ask us to connect it; no payment link was created." };
    }
    return {
      keyId: own.keyId, keySecret: own.keySecret, account: env.ORG_ID, orgId: env.ORG_ID, mode: own.mode,
      testAllowed: isDevelopment(env) || own.allowTestLinks,
    };
  }
  if (env.LEGACY_PAYMENT_LINKS !== 'on') {
    return { status: 410, code: 'legacy_route_retired', error: 'Payment links are now made from your workspace. Sign out, sign in with your workspace account, and try again.' };
  }
  const mode = keyMode(env.RAZORPAY_KEY_ID);
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET || !mode) {
    return { status: 503, code: 'account_not_ready', error: 'Razorpay is not configured. Ask your admin to set the RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET secrets.' };
  }
  return {
    keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET, account: 'shared', orgId: null, mode,
    testAllowed: isDevelopment(env) || env.SHARED_RAZORPAY_ALLOW_TEST === 'on',
  };
}

function formatRupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function basicAuthHeader(username: string, password: string): string {
  const credentials = btoa(`${username}:${password}`);
  return `Basic ${credentials}`;
}

/** A refusal as the API's usual error shape, with a machine-readable code. */
const refuse = (r: { error: string; code: string; status: number }) => json({ error: r.error, code: r.code }, r.status);

/**
 * This workspace's payment-link requests by idempotency key: a double click,
 * a retry after a timeout, or two tabs sending the same request make one
 * link, not several.
 */
function ensurePaymentLinkRequests(db: D1Database): Promise<void> {
  return runSetupOnce(db, 'paymentLinkRequests', () => db.prepare(`
      CREATE TABLE IF NOT EXISTS payment_link_requests (
        scope TEXT NOT NULL,
        idem_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        reference_id TEXT NOT NULL,
        status TEXT NOT NULL,
        link_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, idem_key)
      )
    `).run());
}

/**
 * Payment links live in the workspace's own database. They used to be KV
 * records (`payment:link:<id>`, and `payment:pay:<paymentId>` -> link id):
 * a listing stopped near 1000 and could be a minute behind. The first use in
 * each database copies those records in; the KV copies are left as they were.
 */
function ensurePaymentLinksTable(env: Env): Promise<void> {
  const db = env.VAYU_DB;
  return runSetupOnce(db, 'paymentLinks', async () => {
    await db.batch([
      db.prepare('CREATE TABLE IF NOT EXISTS payment_links (id TEXT PRIMARY KEY, invoice_id TEXT, created_at INTEGER NOT NULL, data TEXT NOT NULL)'),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_payment_links_invoice ON payment_links(invoice_id)'),
      db.prepare('CREATE TABLE IF NOT EXISTS payment_link_payments (payment_id TEXT PRIMARY KEY, link_id TEXT NOT NULL)'),
    ]);
    // INSERT OR IGNORE: a copy never overwrites a row written since.
    const statements = (await kvLinks(env)).flatMap(link => linkStatements(db, link, 'copy'));
    for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50)); // NOSONAR: batches in turn
  });
}

/** The KV records of before the move (ensurePaymentLinksTable copies them once). */
async function kvLinks(env: Env): Promise<StoredPaymentLink[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.VAYU_KV.list({ prefix: 'payment:link:', cursor }); // NOSONAR: each page needs the previous page's cursor
    names.push(...page.keys.map(k => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const raws = await Promise.all(names.map(name => env.VAYU_KV.get(name)));
  return raws.filter((raw): raw is string => raw !== null).map(raw => JSON.parse(raw) as StoredPaymentLink);
}

/** The payments a refund can be on: the one that paid it, and any captured or refunded since. */
function paymentIdsOf(link: StoredPaymentLink): string[] {
  const ids = new Set<string>();
  if (link.paymentId) ids.add(link.paymentId);
  for (const p of link.payments ?? []) if (p.status === 'captured' || p.status === 'refunded') ids.add(p.id);
  return [...ids];
}

/** A link's row and its payment index, as statements for one batch (a transaction). */
function linkStatements(db: D1Database, link: StoredPaymentLink, how: 'save' | 'copy'): D1PreparedStatement[] {
  const insert = how === 'copy'
    ? 'INSERT OR IGNORE INTO payment_links (id, invoice_id, created_at, data) VALUES (?, ?, ?, ?)'
    : 'INSERT INTO payment_links (id, invoice_id, created_at, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET invoice_id = excluded.invoice_id, data = excluded.data';
  return [
    db.prepare(insert).bind(link.id, link.invoiceId ?? null, link.createdAt || Date.now(), JSON.stringify(link)),
    ...paymentIdsOf(link).map(id => db.prepare('INSERT OR IGNORE INTO payment_link_payments (payment_id, link_id) VALUES (?, ?)').bind(id, link.id)),
  ];
}

const linksFrom = (rows: { data: string }[]) => rows.map(r => JSON.parse(r.data) as StoredPaymentLink);

/** Every payment link stored for this workspace. */
async function storedLinks(env: Env): Promise<StoredPaymentLink[]> {
  await ensurePaymentLinksTable(env);
  return linksFrom((await env.VAYU_DB.prepare('SELECT data FROM payment_links').all<{ data: string }>()).results);
}

/** The links made against one invoice. */
async function invoiceLinks(env: Env, invoiceId: string): Promise<StoredPaymentLink[]> {
  await ensurePaymentLinksTable(env);
  return linksFrom((await env.VAYU_DB.prepare('SELECT data FROM payment_links WHERE invoice_id = ?').bind(invoiceId).all<{ data: string }>()).results);
}

async function readLink(env: Env, id: string): Promise<StoredPaymentLink | null> {
  await ensurePaymentLinksTable(env);
  const row = await env.VAYU_DB.prepare('SELECT data FROM payment_links WHERE id = ?').bind(id).first<{ data: string }>();
  return row ? JSON.parse(row.data) as StoredPaymentLink : null;
}

/** Saves a link, and the payment -> link index, together. */
async function saveLink(env: Env, link: StoredPaymentLink): Promise<void> {
  await ensurePaymentLinksTable(env);
  await env.VAYU_DB.batch(linkStatements(env.VAYU_DB, link, 'save'));
}

async function deleteLink(env: Env, id: string): Promise<void> {
  await ensurePaymentLinksTable(env);
  await env.VAYU_DB.batch([
    env.VAYU_DB.prepare('DELETE FROM payment_links WHERE id = ?').bind(id),
    env.VAYU_DB.prepare('DELETE FROM payment_link_payments WHERE link_id = ?').bind(id),
  ]);
}

/** The immutable record of what was approved when a link was made. */
interface ApprovedAmount {
  amountPaise: number;
  currency: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  invoiceTotalPaise: number | null;
  taxRate: number | null;
  taxPaise: number | null;
  outstandingBeforePaise: number | null;
  settlesInFull: boolean;
  override: { kind: OverrideKind; reason: string } | null;
  approvedBy: string;
  approvedByName: string;
  approvedAt: number;
}

interface LinkRequestBody {
  amountPaise?: unknown; amount?: unknown; currency?: unknown; description?: string;
  customerName?: string; customerPhone?: string; customerEmail?: string;
  notifySms?: boolean; notifyEmail?: boolean;
  /** When the link stops accepting payment (ms); omitted: Razorpay's default. */
  expiresAt?: number;
  /** 'test' confirms a test-mode link (refused for live accounts). */
  mode?: unknown;
  /** Pay against this proforma invoice: the amount defaults to what's outstanding. */
  invoiceId?: unknown;
  /** With invoiceId: this (smaller) amount settles the invoice. An override. */
  settlesInFull?: unknown;
  overrideReason?: unknown;
}

/**
 * The amount for a new link, worked out on the server: for an invoice, from
 * the invoice's own items and tax and what is still outstanding; otherwise
 * the amount asked for. Overrides (more than outstanding, or a discount)
 * need the workspace admin role and a reason.
 */
/** This workspace's invoice and its recomputed totals (another business's invoice isn't in this database). */
async function linkInvoice(ctx: Ctx, invoiceId: unknown): Promise<{ id: string; invoice: InvoiceLike; totals: InvoiceTotals } | Response> {
  const notFound = json({ error: 'Invoice not found', code: 'invoice_not_found' }, 404);
  if (typeof invoiceId !== 'string' || invoiceId.length > 128) return notFound;
  await ensureInvoicesTable(ctx.env.VAYU_DB);
  const row = await ctx.env.VAYU_DB.prepare('SELECT data FROM invoices WHERE id = ?').bind(invoiceId).first<{ data: string }>();
  let invoice: InvoiceLike | null = null;
  try { invoice = row ? JSON.parse(row.data) as InvoiceLike : null; } catch { invoice = null; }
  if (!invoice) return notFound;
  if (invoice.status === 'Paid') return json({ error: 'This invoice is already marked paid.', code: 'invoice_paid' }, 409);
  const totals = invoiceTotals(invoice);
  if (!totals) return json({ error: "This invoice's total doesn't match its items and tax. Open it, check it and save it again.", code: 'invoice_total_mismatch' }, 409);
  return { id: invoiceId, invoice, totals };
}

/** An override's record, or why it isn't allowed: workspace admins only, with a reason. */
function approveOverride(session: SessionData, kind: OverrideKind, reasonText: unknown): { kind: OverrideKind; reason: string } | Response {
  if (session.role !== ADMIN_ROLE_ID) {
    const what = kind === 'above_outstanding' ? 'more than is outstanding' : 'less than the invoice as full settlement';
    return json({ error: `Only a workspace admin can ask for ${what}.`, code: 'override_forbidden' }, 403);
  }
  const reason = overrideReason(reasonText);
  if (!reason) return json({ error: 'Give a reason for the change (at least 5 characters); it is kept with the link.', code: 'override_reason_required' }, 400);
  return { kind, reason };
}

const noInvoice = { invoiceId: null, invoiceNumber: null, invoiceTotalPaise: null, taxRate: null, taxPaise: null, outstandingBeforePaise: null, settlesInFull: false, override: null };

/**
 * The amount for a new link, worked out on the server: for an invoice, from
 * the invoice's own items and tax and what is still outstanding; otherwise
 * the amount asked for. Overrides (more than outstanding, or a discount)
 * need the workspace admin role and a reason.
 */
async function approveAmount(ctx: Ctx, session: SessionData, body: LinkRequestBody, mode: PaymentMode): Promise<ApprovedAmount | Response> {
  if (body.currency !== undefined && body.currency !== CURRENCY) return json({ error: 'Payment links are in rupees (INR) only.', code: 'unsupported_currency' }, 400);
  const asked = requestedPaise(body);
  if (asked.problem) return json(asked.problem, 400);
  const base = { currency: CURRENCY, approvedBy: session.userId, approvedByName: session.name, approvedAt: Date.now() };
  const settlesInFull = body.settlesInFull === true;
  if (body.invoiceId === undefined || body.invoiceId === null || body.invoiceId === '') {
    if (asked.paise === null) return json({ error: 'Enter the amount.', code: 'invalid_amount' }, 400);
    if (settlesInFull) return json({ error: 'Only a link for an invoice can settle it.', code: 'invalid_request' }, 400);
    return { ...base, ...noInvoice, amountPaise: asked.paise };
  }
  const found = await linkInvoice(ctx, body.invoiceId);
  if (found instanceof Response) return found;
  const { totals } = found;
  const outstanding = outstandingPaise(totals.totalPaise, found.id, await invoiceLinks(ctx.env, found.id), mode);
  const paise = asked.paise ?? outstanding;
  if (paise === 0) return json({ error: 'Nothing is outstanding on this invoice: its links already cover the total.', code: 'nothing_outstanding' }, 409);
  const kind = overrideNeeded(paise, outstanding, settlesInFull);
  const override = kind ? approveOverride(session, kind, body.overrideReason) : null;
  if (override instanceof Response) return override;
  return {
    ...base, amountPaise: paise, invoiceId: found.id, invoiceNumber: typeof found.invoice.invoiceNumber === 'string' ? found.invoice.invoiceNumber : null,
    invoiceTotalPaise: totals.totalPaise, taxRate: totals.taxRate, taxPaise: totals.taxPaise, outstandingBeforePaise: outstanding, settlesInFull, override,
  };
}

/** The link Razorpay made for a reference, if it made one. */
async function linkByReference(env: Env, keys: { keyId: string; keySecret: string }, referenceId: string): Promise<any> { // null when there is none
  const res = await razorpayLinkCall(env, keys, 'GET', `?reference_id=${encodeURIComponent(referenceId)}`).catch(() => null);
  if (!res?.ok) return null;
  const found = (Array.isArray(res.data?.payment_links) ? res.data.payment_links : []) as { reference_id?: string }[];
  return found.find(l => l?.reference_id === referenceId) ?? null;
}

type Claim = { kind: 'go' } | { kind: 'done'; linkId: string } | { kind: 'refused'; response: Response };

/** Takes the idempotency key for this request, or says why not / what it already made. */
async function claimLinkRequest(db: D1Database, scope: string, key: string, fingerprint: string, referenceId: string): Promise<Claim> {
  await ensurePaymentLinkRequests(db);
  const now = Date.now();
  const inserted = await db.prepare(
    `INSERT INTO payment_link_requests (scope, idem_key, fingerprint, reference_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT DO NOTHING`,
  ).bind(scope, key, fingerprint, referenceId, now, now).run();
  if ((inserted.meta?.changes ?? 0) > 0) return { kind: 'go' };
  const existing = await db.prepare('SELECT fingerprint, status, link_id, updated_at FROM payment_link_requests WHERE scope = ? AND idem_key = ?')
    .bind(scope, key).first<{ fingerprint: string; status: string; link_id: string | null; updated_at: number }>();
  if (!existing) return { kind: 'go' };
  if (existing.fingerprint !== fingerprint) {
    return { kind: 'refused', response: json({ error: 'This request key was already used for a different payment link.', code: 'idempotency_key_reused' }, 422) };
  }
  if (existing.status === 'done' && existing.link_id) return { kind: 'done', linkId: existing.link_id };
  if (existing.status === 'pending' && now - existing.updated_at < 60_000) {
    return { kind: 'refused', response: json({ error: 'This payment link is still being made. Wait a moment.', code: 'request_in_progress' }, 409) };
  }
  // An earlier attempt failed or was cut off: take it over (only one taker wins).
  const retaken = await db.prepare(
    "UPDATE payment_link_requests SET status = 'pending', updated_at = ? WHERE scope = ? AND idem_key = ? AND updated_at = ?",
  ).bind(now, scope, key, existing.updated_at).run();
  return (retaken.meta?.changes ?? 0) > 0
    ? { kind: 'go' }
    : { kind: 'refused', response: json({ error: 'This payment link is still being made. Wait a moment.', code: 'request_in_progress' }, 409) };
}

const finishLinkRequest = (db: D1Database, scope: string, key: string, linkId: string | null) =>
  db.prepare('UPDATE payment_link_requests SET status = ?, link_id = ?, updated_at = ? WHERE scope = ? AND idem_key = ?')
    .bind(linkId ? 'done' : 'failed', linkId, Date.now(), scope, key).run();

/**
 * Makes the link at Razorpay with a reference unique to this request. When
 * the answer is lost (timeout, network, a 5xx) or Razorpay says the
 * reference was already used, the link is looked up by that reference
 * instead of being made again.
 */
async function createAtRazorpay(env: Env, account: LinkAccount, payload: Record<string, unknown>, referenceId: string): Promise<{ entity: any } | { error: string; status: number }> {
  let res: Response | null = null;
  try {
    res = await fetch(`${razorpayApiBase(env)}/v1/payment_links`, {
      method: 'POST',
      headers: { 'Authorization': basicAuthHeader(account.keyId, account.keySecret), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, reference_id: referenceId }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    res = null;
  }
  const data = res ? await res.json().catch(() => ({})) as any : null;
  if (res?.ok && data?.id) return { entity: data };
  const description = String(data?.error?.description ?? '');
  const ambiguous = !res || res.status >= 500 || /reference/i.test(description);
  if (ambiguous) {
    const found = await linkByReference(env, account, referenceId);
    if (found?.id) return { entity: found };
    return { status: 502, error: "Razorpay didn't confirm the link. Try again: the same request won't make a second link." };
  }
  return { status: 502, error: description || `Razorpay error (${res?.status ?? 'no answer'})` };
}

/**
 * GET /payments/account — which account new links are made in and its mode,
 * so the Payments screen can say so before anyone makes a link. Never a key.
 */
async function handlePaymentAccount(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const account = await linkAccountFor(ctx.env);
  if ('error' in account) return json({ ready: false, code: account.code, error: account.error });
  return json({
    ready: account.mode === 'live' || account.testAllowed,
    account: account.orgId ? 'organization' : 'shared',
    mode: account.mode,
    testAllowed: account.testAllowed,
    keyIdHint: maskKeyId(account.keyId),
  });
}

/** The customer, description and validity of a new link, checked. */
function linkDetails(body: LinkRequestBody): { customer: Record<string, string>; description: string; expiresAt: number | undefined } | Response {
  if (!body.customerName?.trim()) return err('Customer name is required');
  const expiresAt = parseLinkExpiry(body.expiresAt);
  if (expiresAt === null) return err('The link must stay valid for at least 20 minutes and at most 6 months');
  const customer: Record<string, string> = { name: body.customerName.trim().slice(0, 100) };
  if (body.customerPhone?.trim()) customer.contact = body.customerPhone.trim().slice(0, 20);
  if (body.customerEmail?.trim()) customer.email = body.customerEmail.trim().slice(0, 120);
  return { customer, description: body.description?.trim().slice(0, 240) || '', expiresAt };
}

/** Null to go ahead and make the link; otherwise the answer (the link made earlier, or a refusal). */
async function replayOrClaim(ctx: Ctx, scope: string, key: string, fingerprint: string, referenceId: string): Promise<Response | null> {
  const claim = await claimLinkRequest(ctx.env.VAYU_DB, scope, key, fingerprint, referenceId);
  if (claim.kind === 'refused') return claim.response;
  if (claim.kind === 'done') {
    const made = await readLink(ctx.env, claim.linkId);
    if (made) return json({ ...made, replayed: true }, 200);
  }
  return null;
}

/** What Razorpay is asked to make: the approved amount, the customer, and how long it stays valid. */
function razorpayLinkPayload(approved: ApprovedAmount, body: LinkRequestBody, details: { customer: Record<string, string>; description: string; expiresAt: number | undefined }, createdBy: string): Record<string, unknown> {
  const { customer, description, expiresAt } = details;
  const notes: Record<string, string> = { created_by: createdBy.slice(0, 100), app: 'vayu-webapp' };
  if (approved.invoiceNumber) notes.invoice = approved.invoiceNumber.slice(0, 100);
  return {
    amount: approved.amountPaise,
    currency: CURRENCY,
    description: description || 'Payment',
    customer,
    notify: { sms: !!body.notifySms && !!customer.contact, email: !!body.notifyEmail && !!customer.email },
    reminder_enable: true,
    ...(expiresAt ? { expire_by: Math.floor(expiresAt / 1000) } : {}),
    notes,
  };
}

/** The activity entries for a new link, and a separate one for an override with its reason. */
async function logLinkCreated(ctx: Ctx, session: SessionData, record: StoredPaymentLink, approved: ApprovedAmount): Promise<void> {
  const testNote = record.mode === 'test' ? ' (TEST mode)' : '';
  const invoiceNote = approved.invoiceNumber ? ` against invoice ${approved.invoiceNumber}` : '';
  await logActivity(ctx.env.VAYU_DB, session.userId, session.name, 'created', 'payment link', record.id,
    `Created payment link of ${formatRupees(approved.amountPaise)} for "${record.customerName}"${invoiceNote}${testNote}`);
  if (approved.override) {
    await logActivity(ctx.env.VAYU_DB, session.userId, session.name, 'updated', 'payment link', record.id,
      `Amount override (${approved.override.kind === 'above_outstanding' ? 'more than outstanding' : 'settles for less'}): ${formatRupees(approved.amountPaise)} of ${formatRupees(approved.outstandingBeforePaise ?? 0)} outstanding. Reason: ${approved.override.reason}`);
  }
}

/**
 * POST /payments/link — a payment link, in the account this request is
 * attributed to (linkAccountFor), for an amount the server has approved
 * (approveAmount), at most once per Idempotency-Key.
 */
async function handlePaymentLinkCreate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const body = await ctx.request.json<LinkRequestBody>().catch(() => null);
  if (!body || typeof body !== 'object') return err('Invalid request');

  const account = await linkAccountFor(ctx.env);
  if ('error' in account) return refuse(account);
  const modeRefusal = testModeRefusal(account, body.mode);
  if (modeRefusal) return refuse(modeRefusal);

  const approved = await approveAmount(ctx, session, body, account.mode);
  if (approved instanceof Response) return approved;
  const bounds = amountProblem(approved.amountPaise, maxPaise(ctx.env.PAYMENT_LINK_MAX_PAISE));
  if (bounds) return json(bounds, 400);
  const details = linkDetails(body);
  if (details instanceof Response) return details;
  const { customer, description, expiresAt } = details;

  // One link per request key: the client sends the same key when it retries.
  const scope = `${account.account}|${session.userId}`;
  const key = idempotencyKey(ctx.request.headers.get('Idempotency-Key')) ?? crypto.randomUUID();
  const fingerprint = await requestFingerprint({
    account: account.account, mode: account.mode, amountPaise: approved.amountPaise, invoiceId: approved.invoiceId,
    settlesInFull: approved.settlesInFull, customer, description, expiresAt: expiresAt ?? null,
  });
  const referenceId = await referenceIdFor(scope, key);
  const earlier = await replayOrClaim(ctx, scope, key, fingerprint, referenceId);
  if (earlier) return earlier;

  const made = await createAtRazorpay(ctx.env, account, razorpayLinkPayload(approved, body, details, session.name), referenceId);
  if ('error' in made) {
    await finishLinkRequest(ctx.env.VAYU_DB, scope, key, null);
    return json({ error: made.error, code: 'provider_error' }, made.status);
  }

  const data = made.entity;
  const record: StoredPaymentLink = {
    id: data.id,
    shortUrl: data.short_url,
    amount: approved.amountPaise,
    description,
    customerName: customer.name,
    customerPhone: customer.contact || '',
    customerEmail: customer.email || '',
    status: data.status || 'created',
    createdAt: Date.now(),
    createdBy: session.userId,
    createdByName: session.name,
    account: account.account,
    orgId: account.orgId,
    mode: account.mode,
    currency: CURRENCY,
    keyIdHint: maskKeyId(account.keyId),
    referenceId,
    invoiceId: approved.invoiceId ?? undefined,
    approved,
    expiresAt: Number(data.expire_by) > 0 ? Number(data.expire_by) * 1000 : expiresAt,
  };
  await saveLink(ctx.env, record);
  await finishLinkRequest(ctx.env.VAYU_DB, scope, key, record.id);
  await logLinkCreated(ctx, session, record, approved);
  queueHubNotify(ctx, [{ entity: 'payments', id: record.id, op: 'put' }]);
  return json(record, 201);
}

// ── Refunds ─────────────────────────────────────────────────────────────────
// Kept in the workspace's own database, keyed by Razorpay's refund id and
// scoped to the account it came from. Status only moves forward: pending
// (refund.created is NOT a completed refund) → processed or failed, which are
// final. Totals count processed refunds only, from these rows.

type RefundStatus = 'pending' | 'processed' | 'failed';

function ensureRefundsTable(db: D1Database): Promise<void> {
  return runSetupOnce(db, 'paymentRefunds', () => db.prepare(`
      CREATE TABLE IF NOT EXISTS payment_refunds (
        refund_id TEXT PRIMARY KEY,
        account TEXT NOT NULL,
        payment_id TEXT NOT NULL,
        link_id TEXT,
        mode TEXT,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `).run());
}

interface RefundRow { refund_id: string; account: string; payment_id: string; link_id: string | null; mode: string | null; amount: number; currency: string; status: RefundStatus; created_at: number }

const REFUND_STATUS_BY_EVENT: Record<string, RefundStatus> = {
  'refund.created': 'pending',
  'refund.processed': 'processed',
  'refund.failed': 'failed',
};

/** A refund as Razorpay describes it, checked; null when it isn't one. */
function refundFrom(entity: any, status: RefundStatus): { id: string; paymentId: string; amount: number; currency: string; status: RefundStatus; createdAt: number } | null {
  const id = typeof entity?.id === 'string' ? entity.id : '';
  const paymentId = typeof entity?.payment_id === 'string' ? entity.payment_id : '';
  const amount = Number(entity?.amount);
  const currency = typeof entity?.currency === 'string' ? entity.currency.toUpperCase().slice(0, 3) : '';
  if (!/^rfnd_\w{6,40}$/.test(id) || !/^pay_\w{6,40}$/.test(paymentId) || !Number.isSafeInteger(amount) || amount <= 0 || currency.length !== 3) return null;
  return { id, paymentId, amount, currency, status, createdAt: Number(entity?.created_at) > 0 ? Number(entity.created_at) * 1000 : Date.now() };
}

/** Razorpay's refund status from its API ('pending' | 'processed' | 'failed'), else null. */
const apiRefundStatus = (s: unknown): RefundStatus | null => (s === 'pending' || s === 'processed' || s === 'failed' ? s : null);

/** Remembers which link a payment belongs to, so a refund can find it. */
/** The link a payment was made on, in this workspace. */
async function linkForPayment(env: Env, paymentId: string): Promise<StoredPaymentLink | null> {
  await ensurePaymentLinksTable(env);
  const row = await env.VAYU_DB.prepare(
    'SELECT l.data FROM payment_link_payments p JOIN payment_links l ON l.id = p.link_id WHERE p.payment_id = ?',
  ).bind(paymentId).first<{ data: string }>();
  if (row) return JSON.parse(row.data) as StoredPaymentLink;
  // A payment not indexed (one that never captured): look through the links' own records.
  return (await storedLinks(env)).find(link => link.paymentId === paymentId || link.payments?.some(p => p.id === paymentId)) ?? null;
}

/**
 * Records one refund (insert, or move its status forward). Atomic: one
 * statement, and a row from another account is never touched. Returns
 * whether anything changed.
 */
async function recordRefund(env: Env, account: string, refund: NonNullable<ReturnType<typeof refundFrom>>, link: StoredPaymentLink | null): Promise<'new' | 'advanced' | 'unchanged' | 'other_account'> {
  const db = env.VAYU_DB;
  await ensureRefundsTable(db);
  const before = await db.prepare('SELECT account, status FROM payment_refunds WHERE refund_id = ?').bind(refund.id).first<{ account: string; status: RefundStatus }>();
  if (before && before.account !== account) {
    console.warn(JSON.stringify({ event: 'refund_account_mismatch', refund: refund.id, account: account.slice(0, 64) }));
    return 'other_account';
  }
  const now = Date.now();
  await db.prepare(
    `INSERT INTO payment_refunds (refund_id, account, payment_id, link_id, mode, amount, currency, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(refund_id) DO UPDATE SET
       status = CASE WHEN payment_refunds.status IN ('processed', 'failed') THEN payment_refunds.status ELSE excluded.status END,
       link_id = COALESCE(payment_refunds.link_id, excluded.link_id),
       mode = COALESCE(payment_refunds.mode, excluded.mode),
       updated_at = excluded.updated_at
     WHERE payment_refunds.account = excluded.account`,
  ).bind(refund.id, account, refund.paymentId, link?.id ?? null, link?.mode ?? null, refund.amount, refund.currency, refund.status, refund.createdAt, now).run();
  if (!before) return 'new';
  const after = await db.prepare('SELECT status FROM payment_refunds WHERE refund_id = ?').bind(refund.id).first<{ status: RefundStatus }>();
  return after?.status === before.status ? 'unchanged' : 'advanced';
}

/** A verified refund.* event for this account. */
async function applyRefundEvent(ctx: Ctx, event: any, account: string): Promise<void> {
  const status = REFUND_STATUS_BY_EVENT[event?.event];
  const refund = status ? refundFrom(event?.payload?.refund?.entity, status) : null;
  if (!refund) return;
  const found = await linkForPayment(ctx.env, refund.paymentId);
  // A payment id belongs to one account; a link from another account is never matched.
  const link = found && (found.account ?? 'shared') === account ? found : null;
  const outcome = await recordRefund(ctx.env, account, refund, link);
  if (link && (outcome === 'new' || outcome === 'advanced')) queueHubNotify(ctx, [{ entity: 'payments', id: link.id, op: 'put' }]);
}

/** Any verified event for an account: payment links, or refunds. */
async function applyAccountEvent(ctx: Ctx, event: any, account: string): Promise<void> {
  if (typeof event?.event === 'string' && event.event.startsWith('refund.')) return applyRefundEvent(ctx, event, account);
  return applyPaymentLinkEvent(ctx, event, account);
}

/** Every refund in this workspace, by link id. */
async function refundsByLink(db: D1Database): Promise<Map<string, RefundRow[]>> {
  await ensureRefundsTable(db);
  const { results } = await db.prepare('SELECT * FROM payment_refunds WHERE link_id IS NOT NULL').all<RefundRow>();
  const map = new Map<string, RefundRow[]>();
  for (const r of results) map.set(r.link_id!, [...(map.get(r.link_id!) ?? []), r]);
  return map;
}

/** A link with its refunds summed: processed (refunded) and pending, in paise. */
function withRefunds(link: StoredPaymentLink, refunds: RefundRow[] | undefined) {
  if (!refunds?.length) return link;
  const sum = (s: RefundStatus) => refunds.filter(r => r.status === s && r.currency === (link.currency ?? CURRENCY)).reduce((a, r) => a + r.amount, 0);
  return { ...link, refundedPaise: sum('processed'), refundPendingPaise: sum('pending'), refunds: refunds.map(r => ({ id: r.refund_id, amount: r.amount, status: r.status, createdAt: r.created_at })) };
}

/** What a link actually collected: Razorpay's amount_paid when known, else the full amount once paid. */
const collectedPaise = (l: StoredPaymentLink): number => l.amountPaid ?? (l.status === 'paid' ? l.amount : 0);

async function handlePaymentLinksList(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const links = await storedLinks(ctx.env);
  links.sort((a, b) => b.createdAt - a.createdAt);
  const refunds = await refundsByLink(ctx.env.VAYU_DB);
  // Read-only: checking with Razorpay is POST /payments/links/refresh and the scheduled job.
  // Past its expiry but not yet confirmed by Razorpay: show it as expired.
  const now = Date.now();
  return json(links.map(l => withRefunds(OPEN_LINK_STATUSES.has(l.status) && l.expiresAt && l.expiresAt < now ? { ...l, status: 'expired' } : l, refunds.get(l.id))));
}

/**
 * GET /payments/summary?from=&to= (ms) — collected, refunded and net, for
 * LIVE links only, by when each was paid. Test links and links whose mode
 * isn't proven yet are counted separately, never in the money figures.
 * Collected is what customers paid; refunded is processed refunds; neither
 * is an accounting or tax figure.
 */
async function handlePaymentSummary(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const from = Number(ctx.url.searchParams.get('from')) || 0;
  const to = Number(ctx.url.searchParams.get('to')) || Number.MAX_SAFE_INTEGER;
  const summary = summarizeLinks(await storedLinks(ctx.env), await refundsByLink(ctx.env.VAYU_DB), from, to);
  return json({ currency: CURRENCY, from, to: to === Number.MAX_SAFE_INTEGER ? null : to, ...summary });
}

/** A link's processed and pending refunds in rupees (other currencies left out). */
function refundTotals(refunds: RefundRow[] | undefined): { processed: number; pending: number } {
  const out = { processed: 0, pending: 0 };
  for (const r of refunds ?? []) {
    if (r.currency !== CURRENCY) continue;
    if (r.status === 'processed') out.processed += r.amount;
    else if (r.status === 'pending') out.pending += r.amount;
  }
  return out;
}

/** Collected, refunded and net over live links paid in [from, to]; test and unproven links only counted. */
function summarizeLinks(links: StoredPaymentLink[], refunds: Map<string, RefundRow[]>, from: number, to: number) {
  let collected = 0; let refunded = 0; let pendingRefunds = 0; let paidCount = 0; let testLinks = 0; let unknownMode = 0;
  for (const l of links) {
    if (!l.paidAt || l.paidAt < from || l.paidAt > to || collectedPaise(l) === 0) continue;
    if (l.mode === 'test') { testLinks++; continue; }
    if (l.mode !== 'live' || (l.currency ?? CURRENCY) !== CURRENCY) { unknownMode++; continue; }
    paidCount++;
    collected += collectedPaise(l);
    const r = refundTotals(refunds.get(l.id));
    refunded += r.processed;
    pendingRefunds += r.pending;
  }
  return {
    live: { paidCount, collectedPaise: collected, refundedPaise: refunded, pendingRefundPaise: pendingRefunds, netPaise: collected - refunded },
    excluded: { testLinks, unknownMode },
  };
}

// ── Reconciliation ──────────────────────────────────────────────────────────
// Webhooks are the fast path. The scheduled job (every 10 minutes, every
// workspace) and POST /payments/links/refresh ask Razorpay about open links
// and recently paid ones (for refunds), within a budget of API calls, backing
// off from links that keep failing. Anything found that no webhook delivered
// counts as "missed" in the account's webhook health.

const MINUTE = 60_000;
const RECONCILE_CALLS_PER_RUN = 40;
const REFUND_CHECK_WINDOW_MS = 90 * 86_400_000;
const REFUND_CHECK_EVERY_MS = 24 * 3_600_000;

/** How long to wait between checks of an open link: soon after it's made, then less often, and backing off after failures. */
function checkInterval(link: StoredPaymentLink, now: number): number {
  const age = now - link.createdAt;
  let base = 6 * 60 * MINUTE;
  if (age < 86_400_000) base = 10 * MINUTE;
  else if (age < 7 * 86_400_000) base = 60 * MINUTE;
  return base * 2 ** Math.min(link.checkFailures ?? 0, 5);
}

type Outcomes = Map<string, ReconcileOutcome>;
const outcomeFor = (o: Outcomes, account: string): ReconcileOutcome => {
  let x = o.get(account);
  if (!x) { x = { checked: 0, missed: 0, failures: 0, error: null }; o.set(account, x); }
  return x;
};

/** One open link against Razorpay. True when its status changed. */
async function reconcileOpenLink(ctx: Ctx, link: StoredPaymentLink, out: ReconcileOutcome): Promise<boolean> {
  const keys = await linkAccountKeys(ctx.env, link);
  const res = keys ? await razorpayLinkCall(ctx.env, keys, 'GET', `/${encodeURIComponent(link.id)}`).catch(() => null) : null;
  link.checkedAt = Date.now();
  if (!keys || !res?.ok) {
    link.checkFailures = (link.checkFailures ?? 0) + 1;
    out.failures++;
    out.error = keys ? `link check answered ${res?.status ?? 'nothing'}` : 'account keys unavailable';
    await saveCheckMarks(ctx.env, link, { checkedAt: link.checkedAt, checkFailures: link.checkFailures });
    return false;
  }
  out.checked++;
  link.checkFailures = 0;
  const before = `${link.status}|${link.expiresAt}|${link.amountPaid ?? ''}`;
  noteProvenMode(link, keys);
  const nowPaid = applyRazorpayLinkState(link, res.data);
  await saveLink(ctx.env, link);
  if (nowPaid) { out.missed++; await announcePaymentReceived(ctx, link); }
  return before !== `${link.status}|${link.expiresAt}|${link.amountPaid ?? ''}`;
}

/** A paid link's refunds against Razorpay. True when a refund was new or moved on. */
async function reconcileRefunds(ctx: Ctx, link: StoredPaymentLink, out: ReconcileOutcome): Promise<boolean> {
  const keys = await linkAccountKeys(ctx.env, link);
  const res = keys && link.paymentId
    ? await fetch(`${razorpayApiBase(ctx.env)}/v1/payments/${encodeURIComponent(link.paymentId)}/refunds`, { headers: { Authorization: basicAuthHeader(keys.keyId, keys.keySecret) } }).catch(() => null)
    : null;
  link.refundsCheckedAt = Date.now();
  if (!res?.ok) {
    out.failures++;
    out.error = `refund check answered ${res?.status ?? 'nothing'}`;
    await saveCheckMarks(ctx.env, link, { refundsCheckedAt: link.refundsCheckedAt });
    return false;
  }
  out.checked++;
  const items = ((await res.json().catch(() => ({}))) as { items?: unknown[] }).items ?? [];
  let changed = false;
  for (const item of items.slice(0, 50)) {
    const status = apiRefundStatus((item as { status?: unknown })?.status);
    const refund = status ? refundFrom(item, status) : null;
    if (!refund?.paymentId || refund.paymentId !== link.paymentId) continue;
    const outcome = await recordRefund(ctx.env, link.account ?? 'shared', refund, link); // NOSONAR: one payment's refunds are recorded in order
    if (outcome === 'new' || outcome === 'advanced') { changed = true; out.missed++; }
  }
  await saveCheckMarks(ctx.env, link, { refundsCheckedAt: link.refundsCheckedAt });
  return changed;
}

/**
 * Records when a link was checked on the link as it is NOW (one statement):
 * the copy the run started from may be older than a webhook that has since
 * marked it paid.
 */
async function saveCheckMarks(env: Env, link: StoredPaymentLink, marks: Pick<StoredPaymentLink, 'checkedAt' | 'checkFailures' | 'refundsCheckedAt'>): Promise<void> {
  await ensurePaymentLinksTable(env);
  await env.VAYU_DB.prepare('UPDATE payment_links SET data = json_patch(data, ?) WHERE id = ?').bind(JSON.stringify(marks), link.id).run();
}

/** Checks this workspace's due links, spending from the shared budget. */
async function reconcileWorkspace(ctx: Ctx, budget: { left: number }, outcomes: Outcomes): Promise<void> {
  const now = Date.now();
  const links = await storedLinks(ctx.env);
  const open = links.filter(l => OPEN_LINK_STATUSES.has(l.status) && now - (l.checkedAt ?? 0) > checkInterval(l, now));
  const paid = links.filter(l => (l.status === 'paid' || l.status === 'partially_paid') && l.paymentId
    && now - (l.paidAt ?? 0) < REFUND_CHECK_WINDOW_MS && now - (l.refundsCheckedAt ?? 0) > REFUND_CHECK_EVERY_MS);
  const changed: string[] = [];
  for (const link of open) {
    if (budget.left <= 0) break;
    budget.left--;
    // One at a time: each check spends from the run's Razorpay call budget.
    if (await reconcileOpenLink(ctx, link, outcomeFor(outcomes, link.account ?? 'shared'))) changed.push(link.id); // NOSONAR
  }
  for (const link of paid) {
    if (budget.left <= 0) break;
    budget.left--;
    if (await reconcileRefunds(ctx, link, outcomeFor(outcomes, link.account ?? 'shared'))) changed.push(link.id); // NOSONAR
  }
  if (changed.length) queueHubNotify(ctx, changed.map(id => ({ entity: 'payments' as const, id, op: 'put' as const })));
}

async function saveOutcomes(env: Env, outcomes: Outcomes): Promise<void> {
  if (!env.PLATFORM_DB) return;
  const platformDb = env.PLATFORM_DB;
  await Promise.all([...outcomes].map(([account, o]) => recordReconcile(platformDb, account, o)));
}

/** POST /payments/links/refresh — check this workspace's due links now (the Payments screen's refresh). */
async function handlePaymentLinksRefresh(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const outcomes: Outcomes = new Map();
  await reconcileWorkspace(ctx, { left: 10 }, outcomes);
  ctx.execCtx.waitUntil(saveOutcomes(ctx.env, outcomes));
  let checked = 0;
  for (const o of outcomes.values()) checked += o.checked;
  return json({ checked });
}

/**
 * The scheduled job: every workspace (the original one and each organization
 * with its own storage), starting at a different one each run so all get a
 * turn, until the run's budget of Razorpay calls is spent.
 */
export async function reconcileAllWorkspaces(env: Env, execCtx: ExecutionContext): Promise<void> {
  const spaces: Env[] = [env];
  if (env.PLATFORM_DB) {
    const { results } = await env.PLATFORM_DB.prepare("SELECT id, app_storage FROM organizations WHERE status = 'active' AND app_storage = 'own' ORDER BY id")
      .all<{ id: string; app_storage: 'own' | 'original' }>();
    spaces.push(...results.map(o => orgStorageEnv(env, o)));
  }
  const start = Math.floor(Date.now() / (10 * MINUTE)) % spaces.length;
  const budget = { left: RECONCILE_CALLS_PER_RUN };
  const outcomes: Outcomes = new Map();
  for (let i = 0; i < spaces.length && budget.left > 0; i++) {
    const space = spaces[(start + i) % spaces.length];
    const url = new URL('https://scheduled.invalid/api/payments/reconcile');
    const ctx: Ctx = { request: new Request(url, { method: 'POST' }), env: space, url, path: '/payments/reconcile', method: 'POST', execCtx };
    try {
      await reconcileWorkspace(ctx, budget, outcomes); // NOSONAR: workspaces share one call budget, so they go in turn
    } catch (e) {
      console.error(JSON.stringify({ event: 'reconcile_workspace_failed', org: space.ORG_ID ?? 'original', reason: safeError(e) }));
    }
  }
  await saveOutcomes(env, outcomes);
}

/** Asks Razorpay about one link, and its payments. Saves (and announces) only when `persist`. */
async function freshLinkDetails(ctx: Ctx, link: StoredPaymentLink, persist: boolean): Promise<Response> {
  const keys = await linkAccountKeys(ctx.env, link);
  if (!keys) return json({ link, checked: false, reason: "The Razorpay account this link was made in isn't connected." });
  const res = await razorpayLinkCall(ctx.env, keys, 'GET', `/${encodeURIComponent(link.id)}`).catch(() => null);
  if (!res?.ok) return json({ link, checked: false, reason: "Couldn't reach Razorpay. Showing what was last recorded." });

  noteProvenMode(link, keys);
  const nowPaid = applyRazorpayLinkState(link, res.data);
  const paymentIds: string[] = (Array.isArray(res.data?.payments) ? res.data.payments : [])
    .map((p: any) => p?.payment_id).filter((v: unknown): v is string => typeof v === 'string' && !!v).slice(0, 10);
  const fetched = await Promise.all(paymentIds.map(pid => razorpayPayment(ctx.env, keys, pid).catch(() => null)));
  const payments = fetched.filter(Boolean).map(toPaymentDetail);
  if (payments.length) link.payments = payments;
  // The payment that settled it: its own time and method, not our record's guess.
  const settled = payments.find(p => p.status === 'captured' || p.status === 'refunded');
  if (link.status === 'paid' && settled) {
    link.paidAt = settled.createdAt || link.paidAt;
    link.paymentId = settled.id;
    link.paymentMethod = settled.method;
  }
  link.checkedAt = Date.now();
  if (persist) {
    await saveLink(ctx.env, link);
    if (nowPaid) {
      ctx.execCtx.waitUntil(announcePaymentReceived(ctx, link));
      queueHubNotify(ctx, [{ entity: 'payments', id: link.id, op: 'put' }]);
    }
  }
  const refunds = await refundsByLink(ctx.env.VAYU_DB);
  return json({ link: withRefunds(link, refunds.get(link.id)), checked: true, checkedAt: link.checkedAt });
}

const LINK_DETAILS_PATH = /^\/payments\/links\/(plink_\w{6,40})\/(details|recheck)$/;

/**
 * GET /payments/links/:id/details — Razorpay's current view of one link and
 * every payment on it (references, time, method, what the customer entered),
 * without changing anything. POST /payments/links/:id/recheck does the same
 * and saves it: a link found paid is marked paid and announced like a webhook.
 */
async function handlePaymentLinkDetails(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const id = LINK_DETAILS_PATH.exec(ctx.path)?.[1];
  if (!id) return err('Payment link not found', 404);
  const link = await readLink(ctx.env, id);
  if (!link) return err('Payment link not found', 404);
  return freshLinkDetails(ctx, link, ctx.method === 'POST');
}

/** Push and activity entry for a payment, once (the caller knows it just turned paid). */
async function announcePaymentReceived(ctx: Ctx, link: StoredPaymentLink): Promise<void> {
  const name = link.customerName || 'customer';
  const descriptionSuffix = link.description ? ` — ${link.description}` : '';
  await Promise.all([
    sendPushToSection(ctx.env, 'payments', '', {
      title: `${formatRupees(link.amount)} from ${name}`,
      body: `Payment received ✓${descriptionSuffix}`,
      tag: `payment-${link.id}`,
      data: { view: 'payments', paymentLinkId: link.id },
    }),
    logActivity(ctx.env.VAYU_DB, 'razorpay', 'Razorpay', 'received', 'payment', link.id,
      `Payment of ${formatRupees(link.amount)} received from "${name}"`),
  ]);
}

const PAYMENT_LINK_PATH = /^\/payments\/links\/(plink_\w{6,40})$/;

async function loadPaymentLink(ctx: Ctx): Promise<StoredPaymentLink | Response> {
  const id = PAYMENT_LINK_PATH.exec(ctx.path)?.[1];
  if (!id) return err('Payment link not found', 404);
  return (await readLink(ctx.env, id)) ?? err('Payment link not found', 404);
}

/**
 * DELETE /payments/links/:id — remove a link from the app. One that can still
 * be paid is cancelled at Razorpay first, so a customer can't pay a link the
 * team no longer sees; if it was paid in the meantime it is kept. A paid
 * link's payment stays in Razorpay; only the app's record goes.
 */
/**
 * Cancels a link that can still be paid, so nobody pays it after it is
 * gone. A refusal comes back as the response to send (and nothing is
 * deleted); null means the link can go.
 */
async function cancelOpenLink(ctx: Ctx, link: StoredPaymentLink): Promise<Response | null> {
  if (!OPEN_LINK_STATUSES.has(link.status)) return null;
  const keys = await linkAccountKeys(ctx.env, link);
  if (!keys) return err("The Razorpay account this link was made in isn't connected, so it can't be cancelled. Nothing was deleted.", 503);
  const cancel = await razorpayLinkCall(ctx.env, keys, 'POST', `/${encodeURIComponent(link.id)}/cancel`);
  if (cancel.ok) return null;
  // Already paid, expired or cancelled at Razorpay? Then it can't be cancelled.
  const current = await razorpayLinkCall(ctx.env, keys, 'GET', `/${encodeURIComponent(link.id)}`);
  if (!current.ok) return err(cancel.data?.error?.description || `Razorpay couldn't cancel the link (${cancel.status}). Nothing was deleted.`, 502);
  const nowPaid = applyRazorpayLinkState(link, current.data);
  if (link.status === 'paid' || link.status === 'partially_paid') {
    await saveLink(ctx.env, link);
    if (nowPaid) await announcePaymentReceived(ctx, link);
    queueHubNotify(ctx, [{ entity: 'payments', id: link.id, op: 'put' }]);
    return err('This link has just been paid, so it was kept.', 409);
  }
  if (OPEN_LINK_STATUSES.has(link.status)) {
    return err(cancel.data?.error?.description || "Razorpay couldn't cancel the link. Nothing was deleted.", 502);
  }
  return null;
}

async function handlePaymentLinkDelete(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const link = await loadPaymentLink(ctx);
  if (link instanceof Response) return link;
  // Its record is what counts the money toward its invoice and the totals.
  if (link.status === 'paid' || link.status === 'partially_paid') return err('A paid link stays in the list: it counts toward its invoice.', 409);
  const refused = await cancelOpenLink(ctx, link);
  if (refused) return refused;

  await deleteLink(ctx.env, link.id);
  await logActivity(ctx.env.VAYU_DB, session.userId, session.name, 'deleted', 'payment link', link.id,
    `Deleted the payment link of ${formatRupees(link.amount)} for "${link.customerName}"`);
  queueHubNotify(ctx, [{ entity: 'payments', id: link.id, op: 'delete' }]);
  return json({ deleted: true });
}

/** PATCH /payments/links/:id { expiresAt } — change how long an unpaid link stays valid. */
async function handlePaymentLinkUpdate(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.VAYU_KV);
  if (!session) return err('Unauthorized', 401);
  const link = await loadPaymentLink(ctx);
  if (link instanceof Response) return link;
  const body = await ctx.request.json<{ expiresAt?: unknown }>().catch(() => ({} as { expiresAt?: unknown }));
  const expiresAt = parseLinkExpiry(body.expiresAt);
  if (!expiresAt) return err('The link must stay valid for at least 20 minutes and at most 6 months');
  if (!OPEN_LINK_STATUSES.has(link.status)) return err('Only a link that is still waiting for payment can be changed', 409);
  const keys = await linkAccountKeys(ctx.env, link);
  if (!keys) return err("The Razorpay account this link was made in isn't connected.", 503);
  const res = await razorpayLinkCall(ctx.env, keys, 'PATCH', `/${encodeURIComponent(link.id)}`, { expire_by: Math.floor(expiresAt / 1000) });
  if (!res.ok) return err(res.data?.error?.description || `Razorpay couldn't change the link (${res.status})`, 502);
  applyRazorpayLinkState(link, res.data);
  link.expiresAt = Number(res.data?.expire_by) > 0 ? Number(res.data.expire_by) * 1000 : expiresAt;
  link.checkedAt = Date.now();
  await saveLink(ctx.env, link);
  await logActivity(ctx.env.VAYU_DB, session.userId, session.name, 'updated', 'payment link', link.id,
    `Changed the payment link for "${link.customerName}" to stay valid until ${new Date(link.expiresAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  queueHubNotify(ctx, [{ entity: 'payments', id: link.id, op: 'put' }]);
  return json(link);
}

/** The shared account's webhook secrets: the current one, and during a rotation the previous one until RAZORPAY_WEBHOOK_SECRET_PREVIOUS_UNTIL. */
function sharedWebhookSecrets(env: Env): { secret: string; previous: boolean }[] {
  const out: { secret: string; previous: boolean }[] = [];
  if (env.RAZORPAY_WEBHOOK_SECRET) out.push({ secret: env.RAZORPAY_WEBHOOK_SECRET, previous: false });
  const until = Date.parse(env.RAZORPAY_WEBHOOK_SECRET_PREVIOUS_UNTIL ?? '');
  if (env.RAZORPAY_WEBHOOK_SECRET_PREVIOUS && Number.isFinite(until) && until > Date.now()) {
    out.push({ secret: env.RAZORPAY_WEBHOOK_SECRET_PREVIOUS, previous: true });
  }
  return out;
}

/**
 * POST /payments/webhook — the shared account's Razorpay events. Verified
 * against the exact raw body with the shared secret (or, during a rotation,
 * the previous one); there is no way to skip the check. Rejections are
 * counted for telemetry only; health comes from verified deliveries.
 */
async function handlePaymentWebhook(ctx: Ctx): Promise<Response> {
  const secrets = sharedWebhookSecrets(ctx.env);
  if (!secrets.length) return err('Webhook not configured', 503);
  const signature = ctx.request.headers.get('x-razorpay-signature')?.toLowerCase();
  const platformDb = ctx.env.PLATFORM_DB;
  const reject = async (reason: string, status: number, message: string) => {
    if (platformDb) await recordRejection(platformDb, 'shared', reason);
    return err(message, status);
  };
  if (!signature) return reject('no_signature', 400, 'Missing signature');
  const rawBody = await ctx.request.text();
  if (rawBody.length > 256 * 1024) return reject('too_large', 413, 'Too large');
  let used: { previous: boolean } | null = null;
  for (const s of secrets) {
    if (timingSafeEqual(await signRazorpayBody(s.secret, rawBody), signature)) { used = s; break; }
  }
  if (!used) return reject('bad_signature', 401, 'Invalid signature');
  let event: any;
  try { event = JSON.parse(rawBody); } catch { return err('Invalid JSON', 400); }
  if (platformDb) await recordVerified(platformDb, 'shared', typeof event?.event === 'string' ? event.event : null, used.previous);
  try {
    await applyAccountEvent(ctx, event, 'shared');
  } catch (e) {
    // Verified but not applied: 500, so Razorpay retries it.
    if (platformDb) await recordProcessingFailure(platformDb, 'shared', e);
    throw e;
  }
  if (platformDb) await recordProcessed(platformDb, 'shared');
  return json({ received: true });
}

/**
 * A record for a link created outside the app (e.g. Razorpay's dashboard),
 * so the history stays complete. Its mode is unknown until a status check
 * with this account's keys proves it.
 */
function linkFromEvent(plink: any, status: string, account: string): StoredPaymentLink {
  return {
    id: plink.id,
    shortUrl: plink.short_url || '',
    amount: plink.amount || 0,
    description: plink.description || '',
    customerName: plink.customer?.name || '',
    customerPhone: plink.customer?.contact || '',
    customerEmail: plink.customer?.email || '',
    status,
    createdAt: plink.created_at ? plink.created_at * 1000 : Date.now(),
    createdBy: '',
    createdByName: '',
    account,
    orgId: account === 'shared' ? null : account,
    currency: typeof plink.currency === 'string' ? plink.currency : CURRENCY,
  };
}

/** The payment that paid a link: when, which, how. */
function notePayment(link: StoredPaymentLink, payment: any): void {
  // When the customer paid, not when the (possibly retried) webhook arrived.
  link.paidAt = Number(payment?.created_at) > 0 ? Number(payment.created_at) * 1000 : Date.now();
  link.paymentId = payment?.id || '';
  link.paymentMethod = payment?.method || '';
}

const STATUS_BY_EVENT: Record<string, string> = {
  'payment_link.paid': 'paid',
  'payment_link.partially_paid': 'partially_paid',
  'payment_link.expired': 'expired',
  'payment_link.cancelled': 'cancelled',
};
/**
 * Applies one verified Razorpay event to the app's payment link records:
 * status, and for a payment the paid time, payment id and method, plus one
 * push and activity entry. Idempotent (retries change nothing and notify
 * once), so it can run for every delivery of an event.
 *
 * `receivingAccount` is the account whose webhook secret verified the event
 * ('shared' or an organization id). A record made in any other account is
 * left alone: one account's events never change another's links, and test
 * and live never mix (each is its own account at Razorpay).
 */
async function applyPaymentLinkEvent(ctx: Ctx, event: any, receivingAccount: string): Promise<void> {
  const plink = event?.payload?.payment_link?.entity;
  if (!plink?.id) return;
  const incoming = STATUS_BY_EVENT[event.event];
  if (!incoming) return;

  const record = await readLink(ctx.env, String(plink.id));
  if (record && (record.account ?? 'shared') !== receivingAccount) {
    console.warn(JSON.stringify({ event: 'payment_event_account_mismatch', link: String(plink.id).slice(0, 40), receivingAccount: receivingAccount.slice(0, 64) }));
    return;
  }

  // Razorpay retries webhooks — don't re-notify a link we already marked paid.
  const alreadyPaid = record?.status === 'paid';

  const updated: StoredPaymentLink = record ?? linkFromEvent(plink, incoming, receivingAccount);
  const newStatus = nextLinkStatus(record?.status, incoming);
  if (record?.status === newStatus && event.event !== 'payment_link.paid') return;
  updated.status = newStatus;
  if (event.event === 'payment_link.paid' && !alreadyPaid) notePayment(updated, event?.payload?.payment?.entity);
  if (Number.isSafeInteger(plink.amount_paid) && plink.amount_paid >= (updated.amountPaid ?? 0)) updated.amountPaid = plink.amount_paid;
  await saveLink(ctx.env, updated);

  // Payment links live in KV, which cannot share a D1 transaction with the
  // change log — so the webhook sends a signal-only hub event instead, and
  // clients refetch /payments/links. A lost signal only delays the next
  // scheduled refresh; the KV record is already committed.
  queueHubNotify(ctx, [{ entity: 'payments', id: plink.id, op: 'put' }]);
  if (event.event === 'payment_link.paid' && !alreadyPaid) {
    ctx.execCtx.waitUntil(announcePaymentReceived(ctx, updated));
  }
}

/**
 * Razorpay events verified with an organization's own webhook secret. They
 * only ever touch links made in that organization's account:
 *   - in its workspace (its own storage, or the original storage when it is
 *     the organization connected to it);
 *   - or, for links made before 2026-09 while the control centre pointed the
 *     original app at this account, in the original storage — found by the
 *     link's own record saying it was made in this account, never by the
 *     old global setting.
 * Unknown links (made on Razorpay's dashboard) are recorded in its workspace.
 */
/**
 * Whether an event's link (or, for a refund, the link its payment was made
 * on) lives in the original storage and was made in this organization's
 * account, rather than in the organization's own workspace.
 */
async function madeInOriginalStorage(env: Env, home: Env, orgId: string, event: any): Promise<boolean> {
  const linkId: unknown = event?.payload?.payment_link?.entity?.id;
  const paymentId: unknown = event?.payload?.refund?.entity?.payment_id;
  if (typeof linkId === 'string') {
    if (await readLink(home, linkId)) return false;
    return (await readLink(env, linkId))?.account === orgId;
  }
  if (typeof paymentId === 'string') {
    if (await linkForPayment(home, paymentId)) return false;
    return (await linkForPayment(env, paymentId))?.account === orgId;
  }
  return false;
}

export async function routeOrgPaymentEvent(request: Request, env: Env, execCtx: ExecutionContext, orgId: string, event: unknown): Promise<void> {
  if (!env.PLATFORM_DB) return;
  const url = new URL(request.url);
  const at = (target: Env): Ctx => ({ request, env: target, url, path: url.pathname, method: request.method, execCtx });
  const org = await env.PLATFORM_DB.prepare('SELECT id, app_storage FROM organizations WHERE id = ?')
    .bind(orgId).first<{ id: string; app_storage: 'own' | 'original' }>();
  if (!org) return;
  const home = orgStorageEnv(env, org);
  if (org.app_storage === 'own' && await madeInOriginalStorage(env, home, orgId, event)) {
    await applyAccountEvent(at(env), event, orgId);
    return;
  }
  await applyAccountEvent(at(home), event, orgId);
}


// ── Routes ──────────────────────────────────────────────────────────────────

const isExact = (p: string) => (path: string) => path === p;

/**
 * The payment-link routes. Also hands this module what it needs from
 * worker.ts; the route table calls this as worker.ts loads, so the scheduled
 * job and the organizations' webhooks (which use the same module) find it set.
 */
export function paymentLinkRoutes(given: PaymentLinkDeps): PaymentLinkRoute[] {
  deps = given;
  return [
    { method: 'POST', match: isExact('/payments/link'), handler: handlePaymentLinkCreate },
    { method: 'GET', match: isExact('/payments/account'), handler: handlePaymentAccount },
    { method: 'GET', match: isExact('/payments/summary'), handler: handlePaymentSummary },
    { method: 'POST', match: isExact('/payments/links/refresh'), handler: handlePaymentLinksRefresh },
    { method: 'POST', match: (p) => /^\/payments\/links\/plink_\w{6,40}\/recheck$/.test(p), handler: handlePaymentLinkDetails },
    { method: 'GET', match: isExact('/payments/links'), handler: handlePaymentLinksList },
    { method: 'GET', match: (p) => /^\/payments\/links\/plink_\w{6,40}\/details$/.test(p), handler: handlePaymentLinkDetails },
    { method: 'DELETE', match: (p) => PAYMENT_LINK_PATH.test(p), handler: handlePaymentLinkDelete },
    { method: 'PATCH', match: (p) => PAYMENT_LINK_PATH.test(p), handler: handlePaymentLinkUpdate },
    { method: 'POST', match: isExact('/payments/webhook'), handler: handlePaymentWebhook },
  ];
}
