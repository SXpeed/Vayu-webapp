import React, { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, Heart, Image as ImageIcon, ShoppingBag, X } from 'lucide-react';
import { FullScreenPortal } from '../../components/FullScreenPortal';
import { Badge, Button } from '../../components/ui';
import type { Artwork, RosterBackdrop, RosterPriceDisplay } from '../../types';
import { BACKDROP_CLASS, priceLine } from './rosterShared';

interface RosterQuickViewProps {
    /** The pieces being browsed, so the arrows step through the same list. */
    pieces: Artwork[];
    index: number;
    onIndex: (index: number) => void;
    /** How the price shows for a piece (its section decides). */
    displayFor: (art: Artwork) => { priceDisplay: RosterPriceDisplay; backdrop: RosterBackdrop };
    isFavorite: (id: string) => boolean;
    isSelected: (id: string) => boolean;
    onToggleFavorite: (id: string) => void;
    onToggleSelect: (id: string) => void;
    /** Set when the person may open the full inventory record. */
    onOpenRecord?: (art: Artwork) => void;
    onClose: () => void;
}

const STATUS_TONE: Record<Artwork['status'], string> = {
    Available: 'text-green-700 dark:text-green-400',
    Sold: 'text-red-700 dark:text-red-400',
    Reserved: 'text-yellow-700 dark:text-yellow-400',
};

const Detail: React.FC<{ label: string; value?: string }> = ({ label, value }) => (value ? (
    <div className="min-w-0">
        <dt className="text-[10px] uppercase tracking-[0.14em] text-[var(--neu-text-dim)]">{label}</dt>
        <dd className="mt-0.5 text-[13px] text-[var(--neu-text)] break-words">{value}</dd>
    </div>
) : null);

/** A closer look at one piece, stepping through the list it was opened from. */
export const RosterQuickView: React.FC<RosterQuickViewProps> = ({
    pieces, index, onIndex, displayFor, isFavorite, isSelected, onToggleFavorite, onToggleSelect, onOpenRecord, onClose,
}) => {
    const art = pieces[index];
    const [photo, setPhoto] = useState(0);
    useEffect(() => { setPhoto(0); }, [art?.id]);

    const step = (by: number) => {
        if (pieces.length < 2) return;
        onIndex((index + by + pieces.length) % pieces.length);
    };

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowRight') step(1);
            else if (e.key === 'ArrowLeft') step(-1);
        };
        globalThis.addEventListener('keydown', onKey);
        return () => globalThis.removeEventListener('keydown', onKey);
    });

    if (!art) return null;
    const { priceDisplay, backdrop } = displayFor(art);
    const price = priceLine(art, priceDisplay);
    const images = art.imageUrls;
    const favorite = isFavorite(art.id);
    const selected = isSelected(art.id);

    return (
        <FullScreenPortal>
            <div className="neu-sheet animate-fade-in-up" role="dialog" aria-modal="true" aria-label={art.title}>
                <div className="flex items-center justify-between gap-3 px-3 pb-2" style={{ paddingTop: 'calc(0.75rem + var(--safe-top))' }}>
                    <button type="button" onClick={onClose} aria-label="Close" className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale">
                        <X size={20} />
                    </button>
                    <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--neu-text-dim)]">
                        {index + 1} of {pieces.length}
                    </p>
                    <div className="flex items-center gap-2">
                        <button type="button" onClick={() => step(-1)} disabled={pieces.length < 2} aria-label="Previous piece" className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale disabled:opacity-40">
                            <ChevronLeft size={18} />
                        </button>
                        <button type="button" onClick={() => step(1)} disabled={pieces.length < 2} aria-label="Next piece" className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale disabled:opacity-40">
                            <ChevronRight size={18} />
                        </button>
                    </div>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-4 pb-[calc(2rem+var(--safe-bottom-ui))] lg:px-6 lg:pb-6">
                    <div className="lg:grid lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:gap-7 lg:items-start">
                        <div>
                            <div className={`neu-picture-well w-full aspect-square rounded-[1.25rem] ${BACKDROP_CLASS[backdrop]}`}>
                                {images[photo] ? (
                                    <img src={images[photo]} alt={art.title} decoding="async"
                                        className={`w-full h-full ${backdrop === 'none' ? 'object-cover' : 'object-contain p-6 md:p-10'}`} />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center text-white/40"><ImageIcon size={40} strokeWidth={1} /></div>
                                )}
                            </div>
                            {images.length > 1 && (
                                <div className="mt-3 flex gap-2 overflow-x-auto no-scrollbar pb-1" role="tablist" aria-label="Photos">
                                    {images.map((url, i) => (
                                        <button key={url} type="button" role="tab" aria-selected={i === photo} aria-label={`Photo ${i + 1}`}
                                            onClick={() => setPhoto(i)}
                                            className={`shrink-0 w-14 h-14 rounded-xl overflow-hidden active-scale ${BACKDROP_CLASS[backdrop]} ${i === photo ? 'ring-2 ring-gold-500' : 'opacity-70'}`}>
                                            <img src={url} alt="" loading="lazy" className={`w-full h-full ${backdrop === 'none' ? 'object-cover' : 'object-contain p-1'}`} />
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div className="mt-5 lg:mt-0 space-y-5">
                            <div>
                                <div className="flex flex-wrap items-center gap-2 mb-2">
                                    {art.customId && <Badge>{art.customId}</Badge>}
                                    <Badge className={STATUS_TONE[art.status]}>
                                        {art.status}
                                    </Badge>
                                </div>
                                <h2 className="font-serif text-2xl lg:text-[1.75rem] leading-tight text-gold-700 dark:text-gold-300">{art.title}</h2>
                                {(art.artist || art.artworkYear) && (
                                    <p className="mt-1 text-sm text-[var(--neu-text-dim)]">{[art.artist, art.artworkYear].filter(Boolean).join(', ')}</p>
                                )}
                                {price && (
                                    <p className={`mt-3 text-base ${priceDisplay === 'price' && art.price ? 'font-semibold text-[var(--neu-gold)]' : 'text-[var(--neu-text)]'}`}>{price}</p>
                                )}
                            </div>

                            <div className="flex flex-wrap gap-2">
                                <Button variant={selected ? 'default' : 'primary'} onClick={() => onToggleSelect(art.id)} icon={<ShoppingBag size={15} />}>
                                    {selected ? 'In your selection' : 'Add to selection'}
                                </Button>
                                <Button onClick={() => onToggleFavorite(art.id)} aria-pressed={favorite}
                                    icon={<Heart size={15} fill={favorite ? 'currentColor' : 'none'} className={favorite ? 'text-[#d4485a]' : ''} />}>
                                    {favorite ? 'Favourite' : 'Add to favourites'}
                                </Button>
                            </div>

                            <dl className="neu-card p-4 grid grid-cols-2 gap-x-4 gap-y-3.5">
                                <Detail label="Medium" value={art.medium} />
                                <Detail label="Dimensions" value={art.dimensions} />
                                <Detail label="Artist" value={art.artist} />
                                <Detail label="Year" value={art.artworkYear} />
                            </dl>

                            {art.description && (
                                <div>
                                    {art.descriptionTitle && <p className="neu-label">{art.descriptionTitle}</p>}
                                    <p className="text-[13.5px] leading-relaxed text-[var(--neu-text)] whitespace-pre-line">{art.description}</p>
                                </div>
                            )}

                            {onOpenRecord && (
                                <button type="button" onClick={() => onOpenRecord(art)}
                                    className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-gold-700 dark:text-gold-300 active-scale">
                                    <ExternalLink size={12} /> Open the inventory record
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </FullScreenPortal>
    );
};
