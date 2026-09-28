import React from 'react';
import { Heart, Image as ImageIcon, ShoppingBag, Check } from 'lucide-react';
import type { Artwork, RosterBackdrop, RosterPriceDisplay } from '../../types';
import { getThumbUrl } from '../../services/storageService';
import { BACKDROP_CLASS, priceLine, type Density } from './rosterShared';

interface RosterCardProps {
    art: Artwork;
    backdrop: RosterBackdrop;
    priceDisplay: RosterPriceDisplay;
    density: Density;
    favorite: boolean;
    selected: boolean;
    index: number;
    onOpen: () => void;
    onToggleFavorite: () => void;
    onToggleSelect: () => void;
}

/**
 * One piece on the Roster: the photo on its section's backdrop, a heart over
 * it, and under it the name, the price line and the bag that adds it to this
 * person's selection. The card opens the quick view; the heart and the bag
 * are their own buttons, so a tap on them never opens it.
 */
export const RosterCard: React.FC<RosterCardProps> = ({
    art, backdrop, priceDisplay, density, favorite, selected, index, onOpen, onToggleFavorite, onToggleSelect,
}) => {
    const compact = density === 'compact';
    const photo = art.imageUrls[0];
    const price = priceLine(art, priceDisplay);
    // On a backdrop the whole piece shows; with no backdrop the photo fills the tile.
    const fit = backdrop === 'none' ? 'object-cover' : `object-contain ${compact ? 'p-2' : 'p-3 md:p-5'}`;

    return (
        <article
            className="neu-tile neu-tile-interactive w-full animate-fade-in-up"
            style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}
        >
            <div className={`neu-picture-well neu-picture-well-sm w-full aspect-square rounded-[1rem] ${BACKDROP_CLASS[backdrop]}`}>
                <button type="button" onClick={onOpen} aria-label={`Open ${art.title}`} className="absolute inset-0 w-full h-full cursor-zoom-in">
                    {photo ? (
                        <img loading="lazy" decoding="async" src={getThumbUrl(photo)} alt={art.title}
                            className={`w-full h-full ${fit} transition-transform duration-500 hover:scale-[1.03]`} />
                    ) : (
                        <span className="w-full h-full flex items-center justify-center text-white/40">
                            <ImageIcon size={compact ? 22 : 30} strokeWidth={1} />
                        </span>
                    )}
                </button>
                {art.status !== 'Available' && (
                    <span className={`neu-chip-float top-2 left-2 ${art.status === 'Sold' ? 'text-red-700 dark:text-red-400' : 'text-yellow-700 dark:text-yellow-400'}`}>
                        <span className="w-1.5 h-1.5 rounded-full bg-current" />
                        {art.status}
                    </span>
                )}
                <button
                    type="button"
                    onClick={onToggleFavorite}
                    aria-pressed={favorite}
                    aria-label={favorite ? `Remove ${art.title} from favourites` : `Add ${art.title} to favourites`}
                    title={favorite ? 'In your favourites' : 'Add to favourites'}
                    className={`roster-photo-btn active-scale ${compact ? 'top-1.5 right-1.5 !w-7 !h-7' : 'top-2 right-2'}`}
                >
                    <Heart size={compact ? 13 : 15} fill={favorite ? 'currentColor' : 'none'} strokeWidth={1.75} />
                </button>
            </div>

            <div className={`flex items-end justify-between gap-2 min-w-0 ${compact ? 'px-1 pt-2 pb-0.5' : 'px-1.5 pt-3 pb-1'}`}>
                <div className="min-w-0">
                    <h3 className={`font-serif leading-snug text-[var(--neu-text)] truncate ${compact ? 'text-[12.5px]' : 'text-[15px]'}`}>{art.title}</h3>
                    {price && (
                        <p className={`mt-0.5 truncate ${compact ? 'text-[10.5px]' : 'text-[12.5px]'} ${priceDisplay === 'price' && art.price ? 'font-semibold text-[var(--neu-gold)]' : 'text-[var(--neu-text-dim)]'}`}>
                            {price}
                        </p>
                    )}
                    {!price && !compact && (art.dimensions || art.medium) && (
                        <p className="mt-0.5 text-[11px] uppercase tracking-wider text-[var(--neu-text-dim)] truncate">{art.dimensions || art.medium}</p>
                    )}
                </div>
                <button
                    type="button"
                    onClick={onToggleSelect}
                    aria-pressed={selected}
                    aria-label={selected ? `Remove ${art.title} from your selection` : `Add ${art.title} to your selection`}
                    title={selected ? 'In your selection' : 'Add to selection'}
                    className={`relative shrink-0 active-scale ${compact ? 'neu-icon-btn-sm !w-7 !h-7' : 'neu-icon-btn-sm'} ${selected ? '!text-[var(--neu-gold)]' : ''}`}
                >
                    <ShoppingBag size={compact ? 12 : 14} strokeWidth={1.75} />
                    {selected && (
                        <span className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full neu-accent flex items-center justify-center">
                            <Check size={9} strokeWidth={3} className="text-white" />
                        </span>
                    )}
                </button>
            </div>
        </article>
    );
};
