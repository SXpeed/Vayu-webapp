import { Artwork } from '../types';

import { apiCall as call } from './apiClient';

export const artworkService = {
    async getArtworks(): Promise<Artwork[]> {
        return call<Artwork[]>('/artworks');
    },

    async saveArtwork(artwork: Artwork): Promise<Artwork> {
        return call<Artwork>('/artworks', {
            method: 'POST',
            body: JSON.stringify(artwork),
        });
    },

    async updateArtwork(artwork: Artwork): Promise<Artwork> {
        return call<Artwork>(`/artworks/${artwork.id}`, {
            method: 'PUT',
            body: JSON.stringify(artwork),
        });
    },

    async deleteArtwork(id: string): Promise<void> {
        await call<{ success: boolean }>(`/artworks/${id}`, {
            method: 'DELETE',
        });
    },
};