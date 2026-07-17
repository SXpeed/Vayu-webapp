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
};
