import React, { useMemo, useState } from 'react';
import { Check, Image as ImageIcon, Info } from 'lucide-react';
import type { Artwork, ArtworkStatus } from '../types';
import { getThumbUrl } from '../services/storageService';
import { SearchBar } from './SearchBar';
import { Pill } from './ui';

type Filter = 'All' | 'Selected' | ArtworkStatus;

interface ArtworkPickerProps {
    artworks: Artwork[];
    selected: ReadonlySet<string>;
    onToggle: (id: string) => void;
    /** Adds every piece the search and filter show ("Add all shown"). */
    onAddMany?: (ids: string[]) => void;
    /** Opens a piece's details; shows an info button on each tile. */
    onInfo?: (art: Artwork) => void;
    /** The small line under the title. Default: the inventory id, else the status. */
    detail?: (art: Artwork) => string;
    /** Offer the Available / Reserved / Sold filters (off where only one status is listed). */
    statusFilters?: boolean;
    /** Scroll inside a tall box instead of growing the page (forms with more below). */
    scroll?: boolean;
    searchPlaceholder?: string;
    className?: string;
}

const STATUSES: ArtworkStatus[] = ['Available', 'Reserved', 'Sold'];

const matches = (art: Artwork, q: string) =>
    !q || [art.title, art.customId, art.artist, art.medium].some(v => v?.toLowerCase().includes(q));

/**
 * Choosing artworks for a catalog, collection, inquiry, proforma, viewing
 * room or sale: a search, filters, and a grid of tiles — the photo
 * on a studio backdrop, a check in the corner, the title and one detail line
 * under it. Tapping a tile adds or removes it.
 */
export const ArtworkPicker: React.FC<ArtworkPickerProps> = ({
    artworks, selected, onToggle, onAddMany, onInfo, detail, statusFilters = true,
    scroll = false, searchPlaceholder = 'Search by title, ID or artist…', className = '',
}) => {
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<Filter>('All');
    const q = query.trim().toLowerCase();

    const shown = useMemo(() => artworks.filter(art => {
        if (filter === 'Selected' && !selected.has(art.id)) return false;
        if (filter !== 'All' && filter !== 'Selected' && art.status !== filter) return false;
        return matches(art, q);
    }), [artworks, filter, selected, q]);

    const notYetChosen = shown.filter(a => !selected.has(a.id)).map(a => a.id);

    return (
        <div className={`space-y-3 ${className}`}>
            <SearchBar value={query} onChange={setQuery} placeholder={searchPlaceholder} />
            <div className="flex items-center gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 py-1">
                <Pill active={filter === 'All'} onClick={() => setFilter('All')} className="shrink-0">All</Pill>
                <Pill active={filter === 'Selected'} onClick={() => setFilter('Selected')} className="shrink-0">Selected · {selected.size}</Pill>
                {statusFilters && STATUSES.map(s => (
                    <Pill key={s} active={filter === s} onClick={() => setFilter(s)} className="shrink-0">{s}</Pill>
                ))}
                {onAddMany && (
                    <button type="button" onClick={() => onAddMany(notYetChosen)} disabled={notYetChosen.length === 0}
                        className="ml-auto shrink-0 pl-2 text-[10.5px] font-semibold uppercase tracking-wider text-gold-700 dark:text-gold-300 disabled:opacity-40 active-scale">
                        Add all shown
                    </button>
                )}
            </div>

            {shown.length === 0 ? (
                <p className="neu-card p-6 text-center text-[13px] text-[var(--neu-text-dim)]">
                    {artworks.length === 0 ? 'No artworks yet.' : 'No artworks match.'}
                </p>
            ) : (
                <div className={scroll ? 'max-h-[min(70vh,46rem)] overflow-y-auto no-scrollbar -mx-2 px-2 py-2' : ''}>
                    <div className="grid grid-cols-3 sm:grid-cols-4 xl:grid-cols-5 gap-2.5">
                        {shown.map(art => {
                            const on = selected.has(art.id);
                            const line = detail ? detail(art) : (art.customId || art.status);
                            return (
                                <div key={art.id} className="relative">
                                    <button type="button" onClick={() => onToggle(art.id)} aria-pressed={on}
                                        aria-label={`${on ? 'Remove' : 'Add'} ${art.title}`}
                                        className={`w-full text-left rounded-2xl p-1.5 active-scale transition-shadow ${on ? 'neu-inset ring-1 ring-gold-500/60' : 'neu-raised-sm'}`}>
                                        <span className="relative block aspect-square rounded-xl overflow-hidden tile-backdrop">
                                            {art.imageUrls?.[0] ? (
                                                <img src={getThumbUrl(art.imageUrls[0])} alt="" loading="lazy" decoding="async" className="w-full h-full object-contain p-1.5" />
                                            ) : (
                                                <span className="w-full h-full flex items-center justify-center tile-backdrop-icon"><ImageIcon size={18} strokeWidth={1} /></span>
                                            )}
                                            <span className={`absolute top-1 right-1 w-5 h-5 rounded-full flex items-center justify-center ${on ? 'neu-accent' : 'bg-black/25'}`}>
                                                {on && <Check size={11} strokeWidth={3} className="text-white" />}
                                            </span>
                                        </span>
                                        <span className="mt-1 block px-0.5 text-[11px] leading-tight truncate text-[var(--neu-text)]">{art.title}</span>
                                        <span className="block px-0.5 text-[9.5px] uppercase tracking-wider truncate text-[var(--neu-text-dim)]">{line}</span>
                                    </button>
                                    {onInfo && (
                                        <button type="button" onClick={() => onInfo(art)} aria-label={`Details of ${art.title}`} title="Details"
                                            className="absolute top-2.5 left-2.5 w-5 h-5 rounded-full bg-black/35 text-white flex items-center justify-center active-scale">
                                            <Info size={11} />
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
};
