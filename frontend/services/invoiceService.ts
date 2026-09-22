import { Invoice } from '../types';

import { apiCall as call } from './apiClient';

/** Proforma invoices on the server, shared by every device. */
export const invoiceService = {
    async getInvoices(): Promise<Invoice[]> {
        return call<Invoice[]>('/invoices');
    },

    /** Create or update (ids are assigned by the app). */
    async saveInvoice(invoice: Invoice): Promise<Invoice> {
        return call<Invoice>(`/invoices/${encodeURIComponent(invoice.id)}`, {
            method: 'PUT',
            body: JSON.stringify(invoice),
        });
    },

    async deleteInvoice(id: string): Promise<void> {
        await call<{ success: boolean }>(`/invoices/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
};

/**
 * True when the server predates invoice sync: it answers the unknown route
 * with a bare "Not found". Callers then keep invoices on this device only,
 * exactly as before, without nagging on every save.
 */
export const isSyncUnavailable = (err: unknown): boolean => (err as Error)?.message === 'Not found';
