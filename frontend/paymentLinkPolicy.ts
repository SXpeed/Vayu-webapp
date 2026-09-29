// What a new payment link may ask for: the amount rules, the invoice it pays
// against, and who may override them. Pure functions (no bindings), shared by
// the Worker's payment-link route and its tests. docs/PAYMENT_SECURITY.md.
//
// Money is integer paise throughout. Rupees from older clients are accepted
// only when they convert exactly (at most two decimals).

export const CURRENCY = 'INR';
/** Razorpay's minimum for INR (₹1). */
export const MIN_PAISE = 100;
/**
 * A sanity ceiling well inside safe-integer range, so nothing overflows. The
 * real per-payment limit is the Razorpay account's own (it refuses above it);
 * a lower business ceiling can be set with PAYMENT_LINK_MAX_PAISE.
 */
export const HARD_MAX_PAISE = 100_000_000_000; // ₹100 crore

export type AmountProblem = { code: string; error: string };

/** A configured ceiling in paise, or the hard one. */
export function maxPaise(configured: string | undefined): number {
  const n = Number(configured);
  return Number.isSafeInteger(n) && n >= MIN_PAISE && n <= HARD_MAX_PAISE ? n : HARD_MAX_PAISE;
}

const invalid = (error: string): { paise: null; problem: AmountProblem } => ({ paise: null, problem: { code: 'invalid_amount', error } });

/**
 * The amount asked for, in paise: `amountPaise` (an integer) or, from older
 * clients, `amount` in rupees with at most two decimals. paise is null when
 * neither was given; problem says what's wrong with one that was.
 */
export function requestedPaise(body: { amountPaise?: unknown; amount?: unknown }): { paise: number | null; problem?: AmountProblem } {
  if (body.amountPaise !== undefined && body.amountPaise !== null) {
    const n = body.amountPaise;
    if (typeof n !== 'number' || !Number.isSafeInteger(n)) return invalid('The amount must be a whole number of paise.');
    return { paise: n };
  }
  if (body.amount === undefined || body.amount === null || body.amount === '') return { paise: null };
  const rupees = typeof body.amount === 'number' ? body.amount : Number.NaN;
  if (!Number.isFinite(rupees)) return invalid('Enter a valid amount.');
  const paise = Math.round(rupees * 100);
  if (Math.abs(paise - rupees * 100) > 1e-6) return invalid('An amount can have at most two decimals (paise).');
  if (!Number.isSafeInteger(paise)) return invalid('Enter a valid amount.');
  return { paise };
}

/** Bounds every link must be within. */
export function amountProblem(paise: number, max: number): AmountProblem | null {
  if (paise < MIN_PAISE) return { code: 'amount_too_small', error: 'A payment link must be for at least ₹1.' };
  if (paise > max) return { code: 'amount_too_large', error: `A payment link can be for at most ₹${(max / 100).toLocaleString('en-IN')}.` };
  return null;
}

// ── Test and live ────────────────────────────────────────────────────

export type PaymentMode = 'test' | 'live';

/**
 * Test-mode keys can't take real money, so a customer paying such a link
 * pays nothing. Refused in production unless allowed for that account, and
 * even then only when the person creating it has said it's a test.
 */
export function testModeRefusal(account: { mode: PaymentMode; testAllowed: boolean }, requested: unknown): { status: number; code: string; error: string } | null {
  if (account.mode === 'live') {
    return requested === 'test' ? { status: 409, code: 'mode_mismatch', error: 'This account takes real payments; a test link can’t be made with it.' } : null;
  }
  if (!account.testAllowed) {
    return { status: 409, code: 'test_mode_blocked', error: 'This Razorpay account is in test mode, which can’t take real payments, and test links aren’t allowed for it. Ask us to connect live keys.' };
  }
  if (requested !== 'test') {
    return { status: 409, code: 'test_mode_confirm', error: 'This account is in TEST mode: the customer won’t be charged. Confirm it’s a test to make the link.' };
  }
  return null;
}

// ── Invoices ─────────────────────────────────────────────────────────────

export interface InvoiceLike {
  id?: unknown; invoiceNumber?: unknown; status?: unknown;
  items?: unknown; taxRate?: unknown; total?: unknown;
}

export interface InvoiceTotals {
  itemsPaise: number;
  taxRate: number;
  taxPaise: number;
  totalPaise: number;
}

/**
 * An invoice's total worked out on the server from its items and tax rate,
 * the way the app computes it (items summed, then tax on the sum, each
 * rounded to the paisa). Null when the invoice doesn't hold up: no items,
 * a bad price or rate, or a stored total that disagrees by more than a paisa.
 */
export function invoiceTotals(invoice: InvoiceLike): InvoiceTotals | null {
  if (!Array.isArray(invoice.items) || invoice.items.length === 0) return null;
  let itemsPaise = 0;
  for (const item of invoice.items as { price?: unknown }[]) {
    const price = Number(item?.price);
    if (!Number.isFinite(price) || price < 0) return null;
    itemsPaise += Math.round(price * 100);
  }
  const taxRate = Number(invoice.taxRate ?? 0);
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) return null;
  const taxPaise = Math.round((itemsPaise * taxRate) / 100);
  const totalPaise = itemsPaise + taxPaise;
  const stored = Math.round(Number(invoice.total) * 100);
  if (!Number.isFinite(stored) || Math.abs(stored - totalPaise) > 1) return null;
  if (!Number.isSafeInteger(totalPaise)) return null;
  return { itemsPaise, taxRate, taxPaise, totalPaise };
}

/** A link counted against an invoice: paid, part-paid, or still open to pay. */
export interface InvoiceLinkLike { invoiceId?: string; amount: number; amountPaid?: number; status: string; mode?: string }

const COUNTING = new Set(['created', 'partially_paid', 'paid']);

/**
 * What is still to collect on an invoice: its total less every link against
 * it that is paid or can still be paid (an open link would collect its full
 * amount if paid). Only links of the same mode count: test links never
 * reduce what is owed for real, and live ones don't count against a test.
 * A link of unknown mode (older records) counts as live.
 */
export function outstandingPaise(totalPaise: number, invoiceId: string, links: InvoiceLinkLike[], mode: 'test' | 'live' = 'live'): number {
  const committed = links
    .filter(l => l.invoiceId === invoiceId && (l.mode ?? 'live') === mode && COUNTING.has(l.status))
    .reduce((sum, l) => sum + l.amount, 0);
  return Math.max(totalPaise - committed, 0);
}

export type OverrideKind = 'above_outstanding' | 'settles_for_less';

/**
 * Whether a request against an invoice needs override authority, and why.
 * Collecting part of what is outstanding (an instalment) is routine; asking
 * for more than is outstanding, or marking a smaller amount as settling the
 * invoice (a discount), is an override.
 */
export function overrideNeeded(paise: number, outstanding: number, settlesInFull: boolean): OverrideKind | null {
  if (paise > outstanding) return 'above_outstanding';
  if (settlesInFull && paise < outstanding) return 'settles_for_less';
  return null;
}

/** An override's reason: required, trimmed, bounded. */
export function overrideReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const reason = value.trim().replace(/\s+/g, ' ');
  return reason.length >= 5 && reason.length <= 300 ? reason : null;
}

// ── Link status ──────────────────────────────────────────────────────

/** How far along a link is. Events can arrive out of order; a link only moves forward. */
const STATUS_RANK: Record<string, number> = { created: 0, partially_paid: 1, expired: 2, cancelled: 2, paid: 3 };

/** The status after an event: the incoming one unless the link is already further along. */
export function nextLinkStatus(current: string | undefined, incoming: string): string {
  if (!current) return incoming;
  return (STATUS_RANK[incoming] ?? 0) > (STATUS_RANK[current] ?? 0) ? incoming : current;
}

// ── Idempotency ──────────────────────────────────────────────────────────

/** A client's idempotency key: 8–100 url-safe characters, or null. */
export function idempotencyKey(header: string | null): string | null {
  const key = header?.trim() ?? '';
  return /^[A-Za-z0-9_-]{8,100}$/.test(key) ? key : null;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Razorpay's reference_id for a request: unique per payment link, at most 40
 * characters, and the same every time the same request is retried, so a
 * retry after a timeout can't make a second link (Razorpay refuses a
 * reference it has seen, and the first link can be looked up by it).
 */
export async function referenceIdFor(scope: string, key: string): Promise<string> {
  const digest = await sha256Hex(scope + '|' + key);
  return 'vy_' + digest.slice(0, 36);
}

/** A fingerprint of what was asked, so one key can't be reused for a different request. */
export function requestFingerprint(parts: Record<string, unknown>): Promise<string> {
  const ordered = Object.keys(parts).sort((a, b) => a.localeCompare(b)).map(k => [k, parts[k] ?? null]);
  return sha256Hex(JSON.stringify(ordered));
}
