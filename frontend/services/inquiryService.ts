import { Inquiry, InquiryMessage } from '../types';

const TOKEN_KEY = 'vayu_token';

function getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
}

function authHeaders(): Record<string, string> {
    const token = getToken();
    const base: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) base['Authorization'] = `Bearer ${token}`;
    return base;
}

async function call<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`/api${path}`, {
        ...options,
        headers: { ...authHeaders(), ...(options?.headers ?? {}) },
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Request failed');
    return data as T;
}

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