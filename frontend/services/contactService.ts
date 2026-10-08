import { Contact, ContactTag } from '../types';

import { apiCall as call } from './apiClient';

export const contactService = {
    async getContacts(): Promise<Contact[]> {
        return call<Contact[]>('/contacts');
    },

    async saveContact(contact: Contact): Promise<Contact> {
        return call<Contact>('/contacts', {
            method: 'POST',
            body: JSON.stringify(contact),
        });
    },

    async importContacts(contacts: Contact[]): Promise<number> {
        const res = await call<{ imported: number }>('/contacts/import', {
            method: 'POST',
            body: JSON.stringify({ contacts }),
        });
        return res.imported;
    },

    /** The server's copy back: its updatedAt is what the next edit must send. */
    async updateContact(contact: Contact): Promise<Contact> {
        return call<Contact>(`/contacts/${contact.id}`, {
            method: 'PUT',
            body: JSON.stringify(contact),
        });
    },

    async bulkTags(contactIds: string[], add: string[], remove: string[]): Promise<void> {
        await call('/contacts/bulk-tags', { method: 'POST', body: JSON.stringify({ contactIds, add, remove }) });
    },

    getTags(): Promise<ContactTag[]> {
        return call<ContactTag[]>('/contact-tags');
    },

    saveTag(tag: { id?: string; name: string; color: string }): Promise<ContactTag> {
        return call<ContactTag>(tag.id ? `/contact-tags/${tag.id}` : '/contact-tags', {
            method: tag.id ? 'PUT' : 'POST',
            body: JSON.stringify(tag),
        });
    },

    async deleteTag(id: string): Promise<void> {
        await call(`/contact-tags/${id}`, { method: 'DELETE' });
    },

    async deleteContact(id: string): Promise<void> {
        await call<{ success: boolean }>(`/contacts/${id}`, {
            method: 'DELETE',
        });
    },
};