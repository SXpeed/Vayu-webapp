import React from 'react';
import { FlaskConical, ShieldAlert } from 'lucide-react';
import { Field, Input, Select, ToggleRow } from '../../components/ui';
import { formatRupees } from '../../components/PaymentAttempts';
import type { Invoice, PaymentAccountInfo } from '../../types';

// Pieces of the "New payment link" form: which account and mode it uses, the
// invoice it can collect against, and an admin's override. The server
// decides every one of these (docs/PAYMENT_SECURITY.md); this only asks.

/** Typed rupees as whole paise: at most two decimals, else null. */
export function rupeesToPaise(text: string): number | null {
    const m = /^\s*(\d{1,11})(?:\.(\d{1,2}))?\s*$/.exec(text);
    if (!m) return null;
    return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** An invoice's total in whole paise, as the app shows it. */
const invoicePaise = (inv: Invoice) => Math.round(inv.total * 100);

/** Which account and mode links are made in; for a test account, the confirmation. */
export const AccountNotice: React.FC<{ info: PaymentAccountInfo | null; confirmTest: boolean; onConfirmTest: (v: boolean) => void }> = ({ info, confirmTest, onConfirmTest }) => {
    if (!info) return null;
    if (!info.ready) {
        return (
            <div role="alert" className="flex gap-2.5 rounded-2xl neu-inset p-3 text-[12.5px] text-red-700 dark:text-red-400">
                <ShieldAlert size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
                <span>{info.error ?? 'Payment links can’t be made with this account right now.'}</span>
            </div>
        );
    }
    if (info.mode !== 'test') return null;
    return (
        <div className="rounded-2xl p-3 space-y-2 border border-amber-500/60 bg-amber-500/10 text-[12.5px] text-amber-900 dark:text-amber-200">
            <p className="flex gap-2.5 font-semibold">
                <FlaskConical size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
                TEST mode: customers won’t be charged, and nothing reaches the bank.
            </p>
            <ToggleRow title="This is a test link" checked={confirmTest} onChange={() => onConfirmTest(!confirmTest)} />
        </div>
    );
};

/** Proforma invoices a link can collect against (not yet marked paid). */
export const InvoiceField: React.FC<{ invoices: Invoice[]; value: string; onChange: (id: string) => void }> = ({ invoices, value, onChange }) => {
    const open = invoices.filter(i => i.status !== 'Paid');
    if (open.length === 0) return null;
    return (
        <Field label="For proforma invoice" htmlFor="pay-invoice" hint="The server works out what’s still to pay from the invoice.">
            <Select id="pay-invoice" value={value} onChange={e => onChange(e.target.value)}>
                <option value="">None: enter any amount</option>
                {open.map(i => (
                    <option key={i.id} value={i.id}>{`${i.invoiceNumber || 'Invoice'} · ${i.customerName} · ${formatRupees(invoicePaise(i))}`}</option>
                ))}
            </Select>
        </Field>
    );
};

/**
 * An admin's override against an invoice: settling it for less (a discount),
 * or collecting more than is outstanding. Both need a reason, kept with the link.
 */
export const OverrideFields: React.FC<{
    isAdmin: boolean; settles: boolean; onSettles: (v: boolean) => void;
    reasonShown: boolean; reason: string; onReason: (v: string) => void;
}> = ({ isAdmin, settles, onSettles, reasonShown, reason, onReason }) => {
    if (!isAdmin) return null;
    return (
        <>
            <ToggleRow title="This amount settles the invoice (discount)" checked={settles} onChange={() => onSettles(!settles)} />
            {(settles || reasonShown) && (
                <Field label="Reason for the change *" htmlFor="pay-override" hint="Kept with the link and in the activity log.">
                    <Input id="pay-override" value={reason} maxLength={300} onChange={e => onReason(e.target.value)} placeholder="e.g. Agreed 10% for a returning client" />
                </Field>
            )}
        </>
    );
};

/** "TEST" on a test-mode link, so it's never mistaken for real money. */
export const TestBadge: React.FC<{ mode?: 'test' | 'live' }> = ({ mode }) => (mode === 'test'
    ? <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/70 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-amber-800 dark:text-amber-300"><FlaskConical size={10} aria-hidden="true" />TEST</span>
    : null);
