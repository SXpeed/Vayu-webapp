import { Inquiry, InquiryMessage } from '../types';

import { apiCall as call } from './apiClient';

export const inquiryService = {
    async getInquiries(): Promise<Inquiry[]> {
        return call<Inquiry[]>('/inquiries');
    },

    async saveInquiry(inquiry: Inquiry): Promise<Inquiry> {
        return call<Inquiry>('/inquiries', {
            method: 'POST',
            body: JSON.stringify(inquiry),
        });
    },

    async updateInquiry(inquiry: Inquiry): Promise<Inquiry> {
        return call<Inquiry>(`/inquiries/${inquiry.id}`, {
            method: 'PUT',
            body: JSON.stringify(inquiry),
        });
    },

    async deleteInquiry(id: string): Promise<void> {
        await call<{ success: boolean }>(`/inquiries/${id}`, {
            method: 'DELETE',
        });
    },

    // ── Inquiry Messages ──────────────────────────────────────────────

    async getInquiryMessages(inquiryId?: string): Promise<InquiryMessage[]> {
        const query = inquiryId ? `?inquiryId=${encodeURIComponent(inquiryId)}` : '';
        return call<InquiryMessage[]>(`/inquiry-messages${query}`);
    },

    async saveInquiryMessage(message: InquiryMessage): Promise<InquiryMessage> {
        return call<InquiryMessage>('/inquiry-messages', {
            method: 'POST',
            body: JSON.stringify(message),
        });
    },

    async updateInquiryMessageStatus(id: string, status: string): Promise<void> {
        await call<{ success: boolean }>(`/inquiry-messages/${id}/status`, {
            method: 'PUT',
            body: JSON.stringify({ status }),
        });
    },

    async batchUpdateInquiryMessageStatus(messageIds: string[], status: string): Promise<void> {
        await call<{ success: boolean }>('/inquiry-messages/status-batch', {
            method: 'PUT',
            body: JSON.stringify({ messageIds, status }),
        });
    },
};