// One Razorpay payment, reduced to what a person needs to see: references,
// when, how, and what the customer entered at checkout. Shared by the app's
// payment links (worker.ts) and plan payments (platform/billing.ts).

/**
 * One payment as Razorpay recorded it: references, when, how, and what the
 * customer entered at checkout. Only what the team needs to see; nothing a
 * customer didn't give Razorpay themselves.
 */
export interface PaymentDetail {
  id: string;
  amount: number; // paise
  currency: string;
  status: string; // captured | authorized | failed | refunded …
  method: string;
  createdAt: number;
  email?: string;
  contact?: string;
  vpa?: string;
  bank?: string;
  wallet?: string;
  card?: { name?: string; network?: string; last4?: string; type?: string; issuer?: string; international?: boolean };
  fee?: number;
  tax?: number;
  rrn?: string;
  upiTransactionId?: string;
  bankTransactionId?: string;
  authCode?: string;
  errorDescription?: string;
  refundStatus?: string;
  amountRefunded?: number;
}

/** Keep the fields worth showing; drop empties. */
export function toPaymentDetail(p: any): PaymentDetail {
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const card = p?.card && typeof p.card === 'object' ? {
    name: text(p.card.name), network: text(p.card.network), last4: text(p.card.last4),
    type: text(p.card.type), issuer: text(p.card.issuer), international: !!p.card.international || undefined,
  } : undefined;
  const acquirer = p?.acquirer_data ?? {};
  return Object.fromEntries(Object.entries({
    id: String(p?.id ?? ''),
    amount: Number(p?.amount) || 0,
    currency: text(p?.currency) ?? 'INR',
    status: text(p?.status) ?? 'unknown',
    method: text(p?.method) ?? '',
    createdAt: Number(p?.created_at) > 0 ? Number(p.created_at) * 1000 : 0,
    email: text(p?.email),
    contact: text(p?.contact),
    vpa: text(p?.vpa) ?? text(p?.upi?.vpa),
    bank: text(p?.bank),
    wallet: text(p?.wallet),
    card: card && Object.values(card).some(v => v !== undefined) ? card : undefined,
    fee: Number.isFinite(Number(p?.fee)) && p?.fee !== null ? Number(p.fee) : undefined,
    tax: Number.isFinite(Number(p?.tax)) && p?.tax !== null ? Number(p.tax) : undefined,
    rrn: text(acquirer.rrn),
    upiTransactionId: text(acquirer.upi_transaction_id),
    bankTransactionId: text(acquirer.bank_transaction_id),
    authCode: text(acquirer.auth_code),
    errorDescription: text(p?.error_description),
    refundStatus: text(p?.refund_status),
    amountRefunded: Number(p?.amount_refunded) > 0 ? Number(p.amount_refunded) : undefined,
  }).filter(([, v]) => v !== undefined)) as unknown as PaymentDetail;
}
