import type { PaymentAccountInfo, PaymentLink } from '../types';
import { apiCall as call } from './apiClient';

export interface CreatePaymentLinkInput {
    /** Whole paise. Leave out with an invoice to collect what's outstanding on it. */
    amountPaise?: number;
    description?: string;
    customerName: string;
    customerPhone?: string;
    customerEmail?: string;
    notifySms?: boolean;
    notifyEmail?: boolean;
    /** When the link stops accepting payment (ms since epoch). */
    expiresAt?: number;
    /** 'test' confirms a test-mode link (the account says which mode it is). */
    mode?: 'test';
    invoiceId?: string;
    /** With invoiceId: this smaller amount settles the invoice (admins, with a reason). */
    settlesInFull?: boolean;
    overrideReason?: string;
}

export const paymentService = {
    /**
     * One link per idempotency key: send the same key when retrying the same
     * request (a timeout, a double tap) and the server returns the link it
     * already made instead of making another.
     */
    async createPaymentLink(input: CreatePaymentLinkInput, idempotencyKey: string): Promise<PaymentLink> {
        return call<PaymentLink>('/payments/link', {
            method: 'POST',
            headers: { 'Idempotency-Key': idempotencyKey },
            body: JSON.stringify(input),
        });
    },

    /** Which account and mode new links are made in. */
    async getAccount(): Promise<PaymentAccountInfo> {
        return call<PaymentAccountInfo>('/payments/account');
    },

    async getPaymentLinks(): Promise<PaymentLink[]> {
        return call<PaymentLink[]>('/payments/links');
    },

    /** Cancels it at Razorpay first when it could still be paid; then removes it. */
    async deletePaymentLink(id: string): Promise<void> {
        await call(`/payments/links/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },

    /** Ask Razorpay afresh about one link: its status and every payment on it (also "Recheck"). */
    async getPaymentLinkDetails(id: string): Promise<{ link: PaymentLink; checked: boolean; reason?: string; checkedAt?: number }> {
        return call(`/payments/links/${encodeURIComponent(id)}/details`);
    },

    /** How long an unpaid link stays valid. */
    async setPaymentLinkExpiry(id: string, expiresAt: number): Promise<PaymentLink> {
        return call<PaymentLink>(`/payments/links/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ expiresAt }),
        });
    },
};
