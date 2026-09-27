// One Razorpay payment, the way the team reads it: its outcome, amount, when,
// how it was paid, and every reference a bank or Razorpay may ask for. Used by
// payment links (Payments), plan payments (Admin → Plan) and the control
// centre's Billing.

import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { PaymentDetail } from '../types';

export const formatRupees = (paise: number) =>
    `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export const dateTime = (ts: number) => new Date(ts).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
});

const METHOD_LABELS: Record<string, string> = { upi: 'UPI', card: 'Card', netbanking: 'Net banking', wallet: 'Wallet', emi: 'EMI', bank_transfer: 'Bank transfer', paylater: 'Pay later' };

export const PAYMENT_STATUS: Record<string, { label: string; tone: string }> = {
    captured: { label: 'Successful', tone: 'text-green-700 dark:text-green-400' },
    authorized: { label: 'Authorised (not yet captured)', tone: 'text-blue-700 dark:text-blue-400' },
    failed: { label: 'Failed', tone: 'text-red-600 dark:text-red-400' },
    refunded: { label: 'Refunded', tone: 'text-gray-600 dark:text-gray-400' },
};

/** A label and a value, with an optional copy button for references. */
export const DetailRow: React.FC<{ label: string; value?: React.ReactNode; copy?: string }> = ({ label, value, copy }) => {
    const [copied, setCopied] = useState(false);
    if (value === undefined || value === null || value === '') return null;
    return (
        <div className="py-1">
            <dt className="text-[10px] uppercase tracking-wider text-gray-600 dark:text-gray-400">{label}</dt>
            <dd className="mt-0.5 text-[12.5px] text-gray-900 dark:text-gray-100 min-w-0 flex items-start gap-1.5">
                <span className="min-w-0 [overflow-wrap:anywhere]">{value}</span>
                {copy && (
                    <button
                        type="button"
                        onClick={async () => {
                            try { await navigator.clipboard.writeText(copy); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* no clipboard */ }
                        }}
                        className="shrink-0 mt-0.5 text-gray-500 hover:text-gold-700 dark:hover:text-gold-300"
                        aria-label={`Copy ${label}`}
                        title="Copy"
                    >
                        {copied ? <Check size={12} className="text-green-600" /> : <Copy size={12} />}
                    </button>
                )}
            </dd>
        </div>
    );
};

/** How it was paid, in words: "UPI · name@okbank", "Visa •••• 4242 (credit, HDFC)". */
export const paidWith = (p: PaymentDetail): string => {
    const method = METHOD_LABELS[p.method] ?? p.method;
    if (p.vpa) return `${method} · ${p.vpa}`;
    if (p.card) {
        const card = [p.card.network, p.card.last4 ? `•••• ${p.card.last4}` : ''].filter(Boolean).join(' ');
        const extra = [p.card.type, p.card.issuer, p.card.international ? 'international' : ''].filter(Boolean).join(', ');
        return extra ? `${card || method} (${extra})` : card || method;
    }
    if (p.bank) return `${method} · ${p.bank}`;
    if (p.wallet) return `${method} · ${p.wallet}`;
    return method;
};

/** Razorpay's fee on a payment, with the tax in it. */
const feeText = (p: PaymentDetail): string | undefined => {
    if (p.fee === undefined) return undefined;
    const tax = p.tax ? ` (incl. ${formatRupees(p.tax)} tax)` : '';
    return formatRupees(p.fee) + tax;
};

/** How much was refunded, and the refund's state. */
const refundText = (p: PaymentDetail): string | undefined => {
    if (!p.amountRefunded) return undefined;
    const state = p.refundStatus ? ` · ${p.refundStatus}` : '';
    return formatRupees(p.amountRefunded) + state;
};

/** Successful ones first, then the newest. */
export const sortPayments = (payments: PaymentDetail[] = []) =>
    [...payments].sort((a, b) => (a.status === 'captured' ? -1 : 0) - (b.status === 'captured' ? -1 : 0) || b.createdAt - a.createdAt);

/**
 * One payment's card. `who` names the person who paid ("Customer" on a
 * payment link, "Payer" on a plan payment).
 */
export const PaymentAttemptCard: React.FC<{ payment: PaymentDetail; who?: string }> = ({ payment: p, who = 'Customer' }) => {
    const status = PAYMENT_STATUS[p.status] ?? { label: p.status, tone: 'text-gray-700 dark:text-gray-300' };
    return (
        <div className="rounded-xl neu-inset p-3">
            <div className="flex items-baseline justify-between gap-2 mb-1">
                <span className={`text-[11px] font-semibold uppercase tracking-wider ${status.tone}`}>{status.label}</span>
                <span className="font-serif text-base text-gray-900 dark:text-white">{formatRupees(p.amount)}</span>
            </div>
            <dl>
                <DetailRow label={p.status === 'failed' ? 'Tried at' : 'Paid at'} value={p.createdAt ? dateTime(p.createdAt) : undefined} />
                <DetailRow label="Transaction ID" value={p.id} copy={p.id} />
                <DetailRow label="Paid with" value={paidWith(p)} />
                <DetailRow label="Name on card" value={p.card?.name} />
                <DetailRow label={`${who} email`} value={p.email} />
                <DetailRow label={`${who} phone`} value={p.contact} />
                <DetailRow label="Bank reference (RRN)" value={p.rrn} copy={p.rrn} />
                <DetailRow label="UPI transaction ID" value={p.upiTransactionId} copy={p.upiTransactionId} />
                <DetailRow label="Bank transaction ID" value={p.bankTransactionId} copy={p.bankTransactionId} />
                <DetailRow label="Authorisation code" value={p.authCode} />
                <DetailRow label="Razorpay fee" value={feeText(p)} />
                <DetailRow label="Refunded" value={refundText(p)} />
                <DetailRow label="Reason" value={p.errorDescription} />
            </dl>
        </div>
    );
};
