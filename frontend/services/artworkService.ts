import { Artwork } from '../types';

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