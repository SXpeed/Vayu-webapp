// Small pieces the Roster screens share: how a piece's price reads in a
// section, the backdrop classes, sorting, and the per-person selection kept
// on this device.
import { useCallback, useEffect, useState } from 'react';
import type { Artwork, RosterBackdrop, RosterPriceDisplay, RosterSection } from '../../types';

export const BACKDROP_CLASS: Record<RosterBackdrop, string> = {
    studio: 'roster-backdrop-studio',
    ivory: 'roster-backdrop-ivory',
    charcoal: 'roster-backdrop-charcoal',
    none: '',
};

export const BACKDROP_LABEL: Record<RosterBackdrop, string> = {
    studio: 'Studio navy',
    ivory: 'Ivory',
    charcoal: 'Charcoal',
    none: 'Photo fills the tile',
};

export const PRICE_LABEL: Record<RosterPriceDisplay, string> = {
    request: 'Price on request',
    price: 'Show the price',
    hidden: 'No price line',
};

/** The price line under a piece, as its section chooses to show it. */
export function priceLine(art: Artwork, display: RosterPriceDisplay): string | null {
    if (display === 'hidden') return null;
    if (display === 'request' || !art.price) return 'Price on request';
    return `₹${art.price.toLocaleString('en-IN')}${art.plusGst ? ' + GST' : ''}`;
}

export type RosterSort = 'curated' | 'newest' | 'price-asc' | 'price-desc' | 'title';

/** Short: the sort sits in the phone's filter row. */
export const SORT_LABEL: Record<RosterSort, string> = {
    curated: 'Curated',
    newest: 'Newest',
    'price-asc': 'Price ↑',
    'price-desc': 'Price ↓',
    title: 'A–Z',
};

export function sortPieces(pieces: Artwork[], sort: RosterSort): Artwork[] {
    if (sort === 'curated') return pieces;
    const out = [...pieces];
    if (sort === 'newest') out.sort((a, b) => b.createdAt - a.createdAt);
    else if (sort === 'price-asc') out.sort((a, b) => a.price - b.price);
    else if (sort === 'price-desc') out.sort((a, b) => b.price - a.price);
    else out.sort((a, b) => a.title.localeCompare(b.title));
    return out;
}

/** The section's pieces that still exist, in the curator's order (sold ones left out if it says so). */
export function sectionPieces(section: RosterSection, byId: Map<string, Artwork>): Artwork[] {
    const pieces: Artwork[] = [];
    for (const id of section.artworkIds) {
        const art = byId.get(id);
        if (art && !(section.hideSold && art.status === 'Sold')) pieces.push(art);
    }
    return pieces;
}

export function matchesQuery(art: Artwork, q: string): boolean {
    if (!q) return true;
    return [art.title, art.artist, art.customId, art.medium, art.dimensions, art.artworkYear]
        .some(v => v?.toLowerCase().includes(q));
}

export type Density = 'comfortable' | 'compact';

export const GRID_CLASS: Record<Density, string> = {
    comfortable: 'grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3 md:gap-4 lg:gap-5',
    compact: 'grid grid-cols-3 md:grid-cols-4 xl:grid-cols-6 gap-2 md:gap-3',
};

/** A per-browser preference; a private window without storage just forgets it. */
export function usePreference<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (v: T) => void] {
    const [value, setValue] = useState<T>(() => {
        try {
            const saved = localStorage.getItem(key) as T | null;
            return saved && allowed.includes(saved) ? saved : fallback;
        } catch { return fallback; }
    });
    const set = useCallback((v: T) => {
        setValue(v);
        try { localStorage.setItem(key, v); } catch { /* private mode */ }
    }, [key]);
    return [value, set];
}

/**
 * The pieces this person has gathered (the bag icon), kept on this device
 * per person: a working shortlist on the way to an inquiry or a collection,
 * not shared with the team.
 */
export function useSelection(userId: string): {
    ids: string[];
    has: (id: string) => boolean;
    toggle: (id: string) => void;
    remove: (id: string) => void;
    clear: () => void;
} {
    const key = `vayu.roster.selection.${userId}`;
    const [ids, setIds] = useState<string[]>(() => {
        try {
            const saved = JSON.parse(localStorage.getItem(key) ?? '[]');
            return Array.isArray(saved) ? saved.filter((v): v is string => typeof v === 'string') : [];
        } catch { return []; }
    });
    useEffect(() => {
        try { localStorage.setItem(key, JSON.stringify(ids)); } catch { /* private mode */ }
    }, [key, ids]);
    return {
        ids,
        has: (id) => ids.includes(id),
        toggle: (id) => setIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])),
        remove: (id) => setIds(prev => prev.filter(x => x !== id)),
        clear: () => setIds([]),
    };
}
