// Paying the platform for the workspace's plan (Admin → Plan → Upgrade).
// The server makes a Razorpay order; Razorpay's own checkout takes the
// payment; the server then checks with Razorpay and changes the plan.

import { apiCall } from './apiClient';
import type { PaymentDetail } from '../types';

export type BillingPeriod = 'monthly' | 'annual';

export interface PlanOption {
    key: string;
    name: string;
    description: string;
    currency: string;
    priceMonthly: number; // paise
    priceAnnual: number;
    current: boolean;
    highlights: { limits: Record<string, number | null>; modules: Record<string, boolean>; features: Record<string, boolean> };
}

export interface PlanPayment {
    id: string;
    orderId: string;
    planKey: string;
    planName: string;
    period: BillingPeriod;
    amount: number;
    currency: string;
    mode: 'test' | 'live';
    /** created: not paid yet · attempted: tried, not successful · paid */
    status: 'created' | 'attempted' | 'paid';
    method: string | null;
    paymentId: string | null;
    createdAt: number;
    createdByName: string | null;
    paidAt: number | null;
    checkedAt: number | null;
    appliedAt: number | null;
    periodStart: number | null;
    periodEnd: number | null;
    payments: PaymentDetail[];
}

export interface BillingInfo {
    payable: boolean;
    mode: 'test' | 'live' | null;
    reason: string | null;
    orgName: string | null;
    plans: PlanOption[];
    payments: PlanPayment[];
}

export interface Checkout {
    id: string;
    orderId: string;
    keyId: string;
    amount: number;
    currency: string;
    planName: string;
    period: BillingPeriod;
    mode: 'test' | 'live';
    orgName: string;
    prefill: { name: string; email: string };
}

export interface Reconciled {
    payment: PlanPayment;
    checked: boolean;
    applied: boolean;
    reason: string | null;
}

interface RazorpayResult {
    razorpay_payment_id: string;
    razorpay_order_id: string;
    razorpay_signature: string;
}

interface RazorpayInstance {
    open(): void;
    on(event: 'payment.failed', handler: (response: { error?: { description?: string } }) => void): void;
}

declare global {
    interface Window {
        Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
    }
}

const CHECKOUT_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';
let scriptLoading: Promise<void> | null = null;

/** Razorpay's checkout, loaded only when someone is about to pay. */
function loadCheckout(): Promise<void> {
    if (window.Razorpay) return Promise.resolve();
    scriptLoading ??= new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = CHECKOUT_SCRIPT;
        script.async = true;
        script.onload = () => (window.Razorpay ? resolve() : reject(new Error('Razorpay checkout did not load.')));
        script.onerror = () => {
            scriptLoading = null;
            script.remove();
            reject(new Error("Couldn't load Razorpay's checkout. Check your connection and try again."));
        };
        document.head.appendChild(script);
    });
    return scriptLoading;
}

export type PayOutcome =
    | { kind: 'paid'; result: Reconciled }
    | { kind: 'pending'; result: Reconciled }   // paid in Razorpay, not yet confirmed
    | { kind: 'closed'; checkout: Checkout }     // the person closed the checkout
    | { kind: 'failed'; message: string; checkout: Checkout };

export const billingService = {
    get: () => apiCall<BillingInfo>('/billing'),

    recheck: (id: string) => apiCall<Reconciled>(`/billing/payments/${encodeURIComponent(id)}/recheck`, { method: 'POST' }),

    /**
     * Opens Razorpay's checkout for a plan and period, and resolves once the
     * person has paid (and the server has confirmed it with Razorpay), closed
     * it, or the payment failed.
     */
    async pay(planKey: string, period: BillingPeriod, opts: { accent?: string; appName?: string } = {}): Promise<PayOutcome> {
        const [checkout] = await Promise.all([
            apiCall<Checkout>('/billing/checkout', { method: 'POST', body: JSON.stringify({ planKey, period }) }),
            loadCheckout(),
        ]);
        const Razorpay = window.Razorpay;
        if (!Razorpay) throw new Error('Razorpay checkout did not load.');
        return new Promise<PayOutcome>(resolve => {
            let lastError: string | null = null;
            let settled = false;
            const finish = (outcome: PayOutcome) => { if (!settled) { settled = true; resolve(outcome); } };
            const rzp = new Razorpay({
                key: checkout.keyId,
                order_id: checkout.orderId,
                amount: checkout.amount,
                currency: checkout.currency,
                name: opts.appName || 'Plan payment',
                description: `${checkout.planName} · ${checkout.period === 'annual' ? '1 year' : '1 month'} · ${checkout.orgName}`,
                prefill: { name: checkout.prefill.name, email: checkout.prefill.email },
                notes: { workspace: checkout.orgName },
                theme: opts.accent ? { color: opts.accent } : undefined,
                handler: async (response: RazorpayResult) => {
                    try {
                        const result = await apiCall<Reconciled>('/billing/confirm', {
                            method: 'POST',
                            body: JSON.stringify({ id: checkout.id, ...response }),
                        });
                        finish({ kind: result.payment.status === 'paid' ? 'paid' : 'pending', result });
                    } catch {
                        // Paid, but the confirmation didn't get through: a recheck
                        // (or Razorpay's webhook) will finish it.
                        const result = await billingService.recheck(checkout.id).catch(() => null);
                        if (result) finish({ kind: result.payment.status === 'paid' ? 'paid' : 'pending', result });
                        else finish({ kind: 'failed', checkout, message: "Your payment went through, but we couldn't confirm it yet. Use Recheck on it below in a minute." });
                    }
                },
                modal: {
                    confirm_close: true,
                    ondismiss: () => finish(lastError ? { kind: 'failed', checkout, message: lastError } : { kind: 'closed', checkout }),
                },
            });
            // A failed attempt: Razorpay lets them try again in the same window.
            rzp.on('payment.failed', response => { lastError = response.error?.description || 'The payment failed.'; });
            rzp.open();
        });
    },
};
