import { Contact } from '../types';

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

    async updateContact(contact: Contact): Promise<void> {
        await call<{ success: boolean }>(`/contacts/${contact.id}`, {
            method: 'PUT',
            body: JSON.stringify(contact),
        });
    },

    async deleteContact(id: string): Promise<void> {
        await call<{ success: boolean }>(`/contacts/${id}`, {
            method: 'DELETE',
        });
    },
};