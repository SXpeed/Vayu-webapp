import { Conversation, Message, MessageStatus } from '../types';

import { apiCall as call } from './apiClient';

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

    async deleteConversation(conversationId: string): Promise<void> {
        await call<{ success: boolean }>(`/conversations/${conversationId}`, {
            method: 'DELETE',
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