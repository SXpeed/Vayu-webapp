import type { RosterBackdrop, RosterPriceDisplay, RosterSection } from '../types';
import { apiCall as call } from './apiClient';

export interface RosterData {
    sections: RosterSection[];
    /** The signed-in person's own hearted pieces, newest first. */
    favorites: string[];
    /** The server's answer to "may I curate?" (the Roster edit permission). */
    canEdit: boolean;
}

export interface RosterSectionInput {
    name: string;
    description: string;
    artworkIds: string[];
    priceDisplay: RosterPriceDisplay;
    backdrop: RosterBackdrop;
    hideSold: boolean;
}

/** A save refused because someone else saved first; carries their version. */
export class StaleSectionError extends Error {
    constructor(message: string, readonly latest: RosterSection | null) {
        super(message);
    }
}

export const rosterService = {
    get(): Promise<RosterData> {
        return call<RosterData>('/roster');
    },

    create(input: RosterSectionInput): Promise<RosterSection> {
        return call<RosterSection>('/roster/sections', { method: 'POST', body: JSON.stringify(input) });
    },

    async update(section: RosterSection, input: RosterSectionInput): Promise<RosterSection> {
        try {
            return await call<RosterSection>(`/roster/sections/${section.id}`, {
                method: 'PUT',
                body: JSON.stringify({ ...input, version: section.version }),
            });
        } catch (e) {
            const error = e as Error & { status?: number; code?: string };
            if (error.status === 409 && error.code === 'stale') {
                // The latest copy is in the body; fetch it rather than parse twice.
                const latest = (await rosterService.get().catch(() => null))?.sections.find(s => s.id === section.id) ?? null;
                throw new StaleSectionError(error.message, latest);
            }
            throw e;
        }
    },

    async remove(id: string): Promise<void> {
        await call<{ success: boolean }>(`/roster/sections/${id}`, { method: 'DELETE' });
    },

    reorder(ids: string[]): Promise<RosterSection[]> {
        return call<RosterSection[]>('/roster/order', { method: 'PUT', body: JSON.stringify({ ids }) });
    },

    async setFavorite(artworkId: string, on: boolean): Promise<void> {
        await call<{ success: boolean }>(`/roster/favorites/${encodeURIComponent(artworkId)}`, { method: on ? 'PUT' : 'DELETE' });
    },
};
