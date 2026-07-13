import { Collection } from '../types';

import { apiCall as call } from './apiClient';

export const collectionService = {
    async getCollections(): Promise<Collection[]> {
        return call<Collection[]>('/collections');
    },

    async saveCollection(collection: Collection): Promise<Collection> {
        return call<Collection>('/collections', {
            method: 'POST',
            body: JSON.stringify(collection),
        });
    },

    async updateCollection(collection: Collection): Promise<Collection> {
        return call<Collection>(`/collections/${collection.id}`, {
            method: 'PUT',
            body: JSON.stringify(collection),
        });
    },

    async deleteCollection(id: string): Promise<void> {
        await call<{ success: boolean }>(`/collections/${id}`, {
            method: 'DELETE',
        });
    },
};