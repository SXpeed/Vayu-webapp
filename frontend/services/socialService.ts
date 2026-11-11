import type { FieldValues, Invite, InviteInput, Recipient, SocialTemplate, TemplateInput } from '../socialRules';
import { apiCall as call } from './apiClient';

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export type WhatsAppConnection =
    | { connected: true; number: string; webhookUrl: string; connectedAt: number }
    | { connected: false; available: boolean };

export interface Audience { total: number; optedOut: number; reachable: number; max: number }

export const socialService = {
    connection: () => call<WhatsAppConnection>('/social/whatsapp'),
    connect: (authKey: string, number: string) => call<WhatsAppConnection>('/social/whatsapp', json('PUT', { authKey, number })),
    disconnect: () => call<WhatsAppConnection>('/social/whatsapp', { method: 'DELETE' }),

    async templates(): Promise<SocialTemplate[]> {
        return (await call<{ templates: SocialTemplate[] }>('/social/templates')).templates;
    },
    /** Asks MSG91 too: brings in templates made in its own panel; `skipped` are ones this app can't send yet. */
    refreshTemplates: () => call<{ templates: SocialTemplate[]; checked: boolean; skipped: number }>('/social/templates?refresh=1'),
    createTemplate: (t: TemplateInput & { sampleImageUrl?: string }) => call<SocialTemplate>('/social/templates', json('POST', t)),
    async removeTemplate(id: string): Promise<void> { await call(`/social/templates/${id}`, { method: 'DELETE' }); },

    audience: (tagIds: string[]) => call<Audience>(`/social/audience?tags=${tagIds.map(encodeURIComponent).join(',')}`),
    async test(templateId: string, values: FieldValues, imageUrl: string, phone: string): Promise<void> {
        await call('/social/test', json('POST', { templateId, values, imageUrl, phone }));
    },
    async invites(): Promise<Invite[]> { return (await call<{ invites: Invite[] }>('/social/invites')).invites; },
    invite: (id: string) => call<{ invite: Invite; recipients: Recipient[] }>(`/social/invites/${id}`),
    send: (input: InviteInput) => call<Invite>('/social/invites', json('POST', input)),
};
