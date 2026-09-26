import { PaymentLink } from '../types';
import { apiCall as call } from './apiClient';

export interface CreatePaymentLinkInput {
    amount: number; // rupees
    description?: string;
    customerName: string;
    customerPhone?: string;
    customerEmail?: string;
    notifySms?: boolean;
    notifyEmail?: boolean;
    /** When the link stops accepting payment (ms since epoch). */
    expiresAt?: number;
}

export const paymentService = {
    async createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymentLink> {
        return call<PaymentLink>('/payments/link', {
            method: 'POST',
            body: JSON.stringify(input),
        });
    },

    async getPaymentLinks(): Promise<PaymentLink[]> {
        return call<PaymentLink[]>('/payments/links');
    },

    /** Cancels it at Razorpay first when it could still be paid; then removes it. */
    async deletePaymentLink(id: string): Promise<void> {
        await call(`/payments/links/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },

    /** How long an unpaid link stays valid. */
    async setPaymentLinkExpiry(id: string, expiresAt: number): Promise<PaymentLink> {
        return call<PaymentLink>(`/payments/links/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ expiresAt }),
        });
    },
};
