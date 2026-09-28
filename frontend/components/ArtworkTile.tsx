import React from 'react';
import { Image as ImageIcon } from 'lucide-react';
import type { Artwork } from '../types';
import { getThumbUrl } from '../services/storageService';

/** Grid for ArtworkTile: three across on a phone, like the artwork picker. */
export const ARTWORK_TILE_GRID = 'grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-2.5 md:gap-3';

const STATUS_TONE: Record<Artwork['status'], string> = {
    Available: '',
    Reserved: 'text-yellow-700 dark:text-yellow-400',
    Sold: 'text-red-700 dark:text-red-400',
};

/**
 * One piece in a collection or catalog: the whole photo on the studio
 * backdrop (never cropped), then the title, inventory id and price. The same
 * look as the artwork picker, for looking rather than choosing.
 */
export const ArtworkTile: React.FC<{ art: Artwork; onOpen: () => void; index?: number }> = ({ art, onOpen, index = 0 }) => (
    <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${art.title}`}
        className="w-full text-left rounded-2xl p-1.5 neu-raised-sm active-scale animate-fade-in-up"
        style={{ animationDelay: `${Math.min(index, 12) * 35}ms` }}
    >
        <span className="relative block aspect-square rounded-xl overflow-hidden tile-backdrop">
            {art.imageUrls?.[0] ? (
                <img src={getThumbUrl(art.imageUrls[0])} alt="" loading="lazy" decoding="async" className="w-full h-full object-contain p-1.5" />
            ) : (
                <span className="w-full h-full flex items-center justify-center tile-backdrop-icon"><ImageIcon size={20} strokeWidth={1} /></span>
            )}
            {art.status !== 'Available' && (
                <span className={`neu-chip-float top-1 left-1 !text-[8.5px] !px-1.5 ${STATUS_TONE[art.status]}`}>{art.status}</span>
            )}
        </span>
        <span className="mt-1 block px-0.5 font-serif text-[12px] leading-tight truncate text-[var(--neu-text)]">{art.title}</span>
        <span className="block px-0.5 text-[9.5px] uppercase tracking-wider truncate text-[var(--neu-text-dim)]">{art.customId || art.medium || art.status}</span>
        <span className="block px-0.5 mt-0.5 text-[10.5px] font-semibold truncate text-[var(--neu-gold)]">
            ₹{art.price.toLocaleString('en-IN')}{art.plusGst ? ' + GST' : ''}
        </span>
    </button>
);
