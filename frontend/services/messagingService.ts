import { Conversation, Message, MessageStatus } from '../types';

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

export const messagingService = {
    // ── Conversations ──────────────────────────────────────────────────

    async getConversations(): Promise<Conversation[]> {
        return call<Conversation[]>('/conversations');
    },

    async createConversation(conv: Conversation): Promise<Conversation> {
        return call<Conversation>('/conversations', {
            method: 'POST',
            body: JSON.stringify(conv),
        });
    },

    async updateConversation(conv: Conversation): Promise<Conversation> {
        return call<Conversation>(`/conversations/${conv.id}`, {
            method: 'PUT',
            body: JSON.stringify(conv),
        });
    },

    // ── Messages ───────────────────────────────────────────────────────

    async getMessages(conversationId?: string): Promise<Message[]> {
        const query = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : '';
        return call<Message[]>(`/messages${query}`);
    },

    async sendMessage(msg: Message): Promise<Message> {
        return call<Message>('/messages', {
            method: 'POST',
            body: JSON.stringify(msg),
        });
    },

    async updateMessageStatus(messageId: string, status: MessageStatus): Promise<void> {
        await call<{ success: boolean }>(`/messages/${messageId}/status`, {
            method: 'PUT',
            body: JSON.stringify({ status }),
        });
    },

    async batchUpdateStatus(messageIds: string[], status: MessageStatus): Promise<void> {
        await call<{ success: boolean }>('/messages/status-batch', {
            method: 'PUT',
            body: JSON.stringify({ messageIds, status }),
        });
    },
};