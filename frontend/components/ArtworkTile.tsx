import React from 'react';
import { Image as ImageIcon } from 'lucide-react';
import type { Artwork } from '../types';
import { getThumbUrl } from '../services/storageService';
import { useInventorySettings } from '../services/inventorySettingsService';
import { statusOf } from '../inventoryRules';
import { STATUS_TEXT } from '../views/inventoryTools';

/** Grid for ArtworkTile: three across on a phone, like the artwork picker. */
export const ARTWORK_TILE_GRID = 'grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-2.5 md:gap-3';

/**
 * One piece in a collection or catalog: the whole photo on the studio
 * backdrop (never cropped), then the title, inventory id and price. The same
 * look as the artwork picker, for looking rather than choosing.
 */
export const ArtworkTile: React.FC<{ art: Artwork; onOpen: () => void; index?: number }> = ({ art, onOpen, index = 0 }) => {
    // The status people set (a custom one such as On loan), shown unless it is plain Available.
    const status = statusOf(art, useInventorySettings());
    return (
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
            {status.id !== 'Available' && (
                <span className={`neu-chip-float top-1 left-1 !text-[8.5px] !px-1.5 ${STATUS_TEXT[status.color]}`}>{status.name}</span>
            )}
        </span>
        <span className="mt-1 block px-0.5 font-serif text-[12px] leading-tight truncate text-[var(--neu-text)]">{art.title}</span>
        <span className="block px-0.5 text-[9.5px] uppercase tracking-wider truncate text-[var(--neu-text-dim)]">{art.customId || art.medium || status.name}</span>
        <span className="block px-0.5 mt-0.5 text-[10.5px] font-semibold truncate text-[var(--neu-gold)]">
            ₹{art.price.toLocaleString('en-IN')}{art.plusGst ? ' + GST' : ''}
        </span>
    </button>
    );
};
