import { Catalog } from '../types';

import { apiCall as call } from './apiClient';

export const catalogService = {
    async getCatalogs(): Promise<Catalog[]> {
        return call<Catalog[]>('/catalogs');
    },

    async saveCatalog(catalog: Catalog): Promise<Catalog> {
        return call<Catalog>('/catalogs', {
            method: 'POST',
            body: JSON.stringify(catalog),
        });
    },

    async updateCatalog(catalog: Catalog): Promise<Catalog> {
        return call<Catalog>(`/catalogs/${catalog.id}`, {
            method: 'PUT',
            body: JSON.stringify(catalog),
        });
    },

    async deleteCatalog(id: string): Promise<void> {
        await call<{ success: boolean }>(`/catalogs/${id}`, {
            method: 'DELETE',
        });
    },
};