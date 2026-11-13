import type {
    Channel, FieldValues, Invite, InviteInput, PersonTrack, Recipient, ReplyMessage, ReplyThread, ResendSettings,
    SocialTemplate, TemplateInput, TrackHistory,
} from '../socialRules';
import { apiCall as call } from './apiClient';

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export interface EmailSender { domain: string; from: string; fromName: string; replyTo: string }

/** The workspace's MSG91 account: `number` is '' when it has no WhatsApp number; `email` is unset until the sender is set. */
export type Msg91Connection =
    | { connected: true; number: string; webhookUrl: string; connectedAt: number; email: EmailSender | null }
    | { connected: false; available: boolean };

export interface Audience { total: number; optedOut: number; reachable: number; max: number }
export interface TagReach { tagId: string; name: string; contacts: number; whatsapp: number; email: number }
export interface Reach {
    totals: { contacts: number; whatsapp: number; email: number; optedOut: number };
    tags: TagReach[];
    /** A WhatsApp number (digits) or an email address that asked not to be messaged. */
    optouts: { address: string; at: number }[];
}

export const socialService = {
    connection: () => call<Msg91Connection>('/social/whatsapp'),
    connect: (authKey: string, number: string) => call<Msg91Connection>('/social/whatsapp', json('PUT', { authKey, number })),
    disconnect: () => call<Msg91Connection>('/social/whatsapp', { method: 'DELETE' }),
    setEmailSender: (sender: EmailSender) => call<Msg91Connection>('/social/email', json('PUT', sender)),

    async templates(channel: Channel): Promise<SocialTemplate[]> {
        return (await call<{ templates: SocialTemplate[] }>(`/social/templates?channel=${channel}`)).templates;
    },
    /** Asks MSG91 too: each review's result, and (WhatsApp) templates made in its own panel; `skipped` are ones this app can't send. */
    refreshTemplates: (channel: Channel) => call<{ templates: SocialTemplate[]; checked: boolean; skipped: number }>(`/social/templates?channel=${channel}&refresh=1`),
    createTemplate: (t: TemplateInput & { sampleImageUrl?: string }) => call<SocialTemplate>('/social/templates', json('POST', t)),
    async removeTemplate(id: string): Promise<void> { await call(`/social/templates/${id}`, { method: 'DELETE' }); },

    audience: (channel: Channel, tagIds: string[]) => call<Audience>(`/social/audience?channel=${channel}&tags=${tagIds.map(encodeURIComponent).join(',')}`),
    /** `to`: a WhatsApp number or an email address, by the template's channel. */
    async test(channel: Channel, templateId: string, values: FieldValues, imageUrl: string, to: string): Promise<void> {
        await call('/social/test', json('POST', { channel, templateId, values, imageUrl, phone: to }));
    },
    async invites(channel: Channel): Promise<Invite[]> { return (await call<{ invites: Invite[] }>(`/social/invites?channel=${channel}`)).invites; },
    invite: (id: string) => call<{ invite: Invite; recipients: Recipient[] }>(`/social/invites/${id}`),
    send: (channel: Channel, input: InviteInput) => call<Invite>('/social/invites', json('POST', { channel, ...input })),
    /** Calls off an invite that is still scheduled. */
    async cancel(id: string): Promise<void> { await call(`/social/invites/${id}`, { method: 'DELETE' }); },
    /** A new invite, the same message, to the people this one failed to reach. */
    retryFailed: (id: string) => call<Invite>(`/social/invites/${id}/retry`, { method: 'POST' }),
    reach: () => call<Reach>('/social/reach'),

    /** Every contact sent an invite (their latest per channel), those never sent one, and the automatic resend settings. */
    people: () => call<{ people: PersonTrack[]; never: { contactId: string; name: string }[]; settings: ResendSettings }>('/social/people'),
    async personHistory(key: string): Promise<TrackHistory[]> { return (await call<{ history: TrackHistory[] }>(`/social/people/${encodeURIComponent(key)}`)).history; },
    /** The same message again to these people (by their row on the invite); only those it didn't reach. */
    resend: (recipientIds: string[]) => call<{ invites: number; people: number; problems: string[] }>('/social/resend', json('POST', { recipientIds })),
    setResendSettings: (s: ResendSettings) => call<ResendSettings>('/social/resend-settings', json('PUT', s)),

    /** WhatsApp conversations; email replies go to `replyTo`. */
    replies: () => call<{ threads: ReplyThread[]; replyTo: string }>('/social/replies'),
    thread: (phone: string) => call<{ phone: string; name: string; messages: ReplyMessage[]; lastInAt: number; windowMs: number; optedOut: boolean }>(`/social/replies/${phone}`),
    async reply(phone: string, message: { text: string } | { templateId: string; values: FieldValues; imageUrl: string }): Promise<void> {
        await call(`/social/replies/${phone}`, json('POST', message));
    },
};
