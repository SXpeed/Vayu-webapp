import React, { useState, useRef, useEffect } from 'react';
import { ArrowLeft, Edit2, X, Image as ImageIcon } from 'lucide-react';
import { Artwork } from '../types';
import { ArtworkFormModal } from './ArtworksView';
import { TypeDeleteDialog } from '../components/TypeDeleteDialog';
import { ZoomableImage } from '../components/ZoomableImage';
import { PreviewOnlyNote } from '../components/PreviewOnlyNote';
import { IfCan } from '../components/Layout';

/** Swaps the alpha channel of an `rgba(r, g, b, a)` color string. */
const withAlpha = (rgba: string, alpha: number): string =>
    `${rgba.slice(0, rgba.lastIndexOf(',') + 1)} ${alpha})`;

// Helper function to extract dominant color from an image URL
const getDominantColor = (imageUrl: string): Promise<string> => {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "Anonymous";
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                resolve('rgba(0,0,0,0.1)');
                return;
            }
            canvas.width = 50;
            canvas.height = 50;
            ctx.drawImage(img, 0, 0, 50, 50);

            try {
                const imageData = ctx.getImageData(0, 0, 50, 50).data;
                let r = 0, g = 0, b = 0;
                let count = 0;

                for (let i = 0; i < imageData.length; i += 16) {
                    r += imageData[i];
                    g += imageData[i + 1];
                    b += imageData[i + 2];
                    count++;
                }

                r = Math.floor(r / count);
                g = Math.floor(g / count);
                b = Math.floor(b / count);

                resolve(`rgba(${r}, ${g}, ${b}, 0.4)`);
            } catch (e) {
                console.warn('Failed to get dominant color', e);
                resolve('rgba(0,0,0,0.1)');
            }
        };
        img.onerror = () => resolve('rgba(0,0,0,0.1)');
        img.src = imageUrl;
    });
};

interface ArtworkDetailViewProps {
    artwork: Artwork;
    onClose: () => void;
    onUpdateArtwork: (artwork: Artwork) => void;
    onDeleteArtwork: (id: string) => void;
}

export const ArtworkDetailView: React.FC<ArtworkDetailViewProps> = ({ artwork, onClose, onUpdateArtwork, onDeleteArtwork }) => {
    const [activeImageIndex, setActiveImageIndex] = useState(0);
    const [isEditing, setIsEditing] = useState(false);
    const [isFullScreen, setIsFullScreen] = useState(false);
    const [glowColor, setGlowColor] = useState<string>('rgba(0,0,0,0.05)');

    const mainCarouselRef = useRef<HTMLDivElement>(null);
    const fullScreenCarouselRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (artwork.imageUrls.length > 0) {
            getDominantColor(artwork.imageUrls[activeImageIndex]).then(color => {
                setGlowColor(color);
            });
        }
    }, [activeImageIndex, artwork.imageUrls]);

    const handleSaveEdit = (updatedData: Omit<Artwork, 'id' | 'createdAt'>) => {
        onUpdateArtwork({
            ...updatedData,
            id: artwork.id,
            createdAt: artwork.createdAt
        });
        setIsEditing(false);
    };

    const [confirmOpen, setConfirmOpen] = useState(false);

    const handleDelete = () => {
        setConfirmOpen(true);
    };



    const artistLine = [artwork.artist, artwork.artworkYear].filter(Boolean).join(', ');

    let statusClass = 'text-yellow-700 dark:text-yellow-400';
    if (artwork.status === 'Available') statusClass = 'text-green-700 dark:text-green-400';
    else if (artwork.status === 'Sold') statusClass = 'text-red-700 dark:text-red-400';

    const imageCount = artwork.imageUrls.length;

    /** Dots are tappable: scroll the carousel; its onScroll syncs the index. */
    const goToImage = (idx: number) => {
        const el = mainCarouselRef.current;
        if (el) el.scrollTo({ left: idx * el.clientWidth, behavior: 'smooth' });
    };

    // Only what is filled in: an empty field says nothing worth a row.
    const specs = [
        { label: 'Medium', value: artwork.medium },
        { label: 'Dimensions', value: artwork.dimensions },
        { label: 'Location', value: artwork.location },
    ].filter(x => x.value?.trim());

    return (
        <div className="absolute inset-0 bg-[var(--neu-bg)] z-[60] flex flex-col animate-fade-in-up">
            {/* Header — raised back / edit buttons */}
            <div className="shrink-0 z-20 px-5 lg:px-10 pb-2" style={{ paddingTop: 'calc(1rem + var(--safe-top))' }}>
                <div className="max-w-6xl mx-auto flex justify-between items-center">
                    <button onClick={onClose} aria-label="Back" className="neu-icon-btn neu-btn active-scale">
                        <ArrowLeft size={18} />
                    </button>
                    <IfCan section="inventory">
                        <button onClick={() => setIsEditing(true)} aria-label="Edit artwork" className="neu-icon-btn neu-btn active-scale">
                            <Edit2 size={16} />
                        </button>
                    </IfCan>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto no-scrollbar neu-scroll-fade px-5 lg:px-10 pt-2">
                <div className="max-w-6xl mx-auto lg:grid lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:gap-14 lg:items-start">

                    {/* Picture: on the page itself, with room around it and a soft shadow; no frames. */}
                    <div className="lg:sticky lg:top-0">
                        <div className="relative h-[52dvh] min-h-[280px] lg:h-[min(calc(100dvh-9rem),760px)] flex flex-col">
                            {imageCount > 0 ? (
                                <div
                                    ref={mainCarouselRef}
                                    className="flex-1 w-full flex overflow-x-auto snap-x snap-mandatory no-scrollbar"
                                    onScroll={(e) => {
                                        const scrollLeft = (e.target as HTMLElement).scrollLeft;
                                        const width = (e.target as HTMLElement).clientWidth;
                                        setActiveImageIndex(Math.round(scrollLeft / width));
                                    }}
                                >
                                    {artwork.imageUrls.map((url, idx) => (
                                        <div key={url} className="w-full h-full snap-center shrink-0 px-2 pt-2 pb-8 lg:p-6 lg:pb-10">
                                            <button
                                                type="button"
                                                onClick={() => setIsFullScreen(true)}
                                                aria-label="View full screen"
                                                className="w-full h-full p-0 border-none bg-transparent cursor-zoom-in flex items-center justify-center"
                                            >
                                                <img
                                                    src={url}
                                                    alt={`${artwork.title} - ${idx + 1}`}
                                                    loading="lazy"
                                                    decoding="async"
                                                    className="max-w-full max-h-full object-contain rounded-md shadow-[0_16px_28px_-16px_rgba(0,0,0,0.35)]"
                                                />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="flex-1 w-full flex items-center justify-center rounded-2xl neu-inset text-[var(--neu-text-dim)]">
                                    <ImageIcon size={48} strokeWidth={1} />
                                </div>
                            )}
                        </div>

                        {imageCount > 0 && (
                            <div className="flex justify-center mt-2 empty:hidden">
                                <PreviewOnlyNote src={artwork.imageUrls[activeImageIndex] ?? artwork.imageUrls[0]} className="!static" />
                            </div>
                        )}

                        {/* Pager: small dots, the current one longer */}
                        {imageCount > 1 && (imageCount <= 8 ? (
                            <div className="flex justify-center items-center gap-0.5 mt-2">
                                {artwork.imageUrls.map((url, idx) => (
                                    <button
                                        key={url}
                                        type="button"
                                        onClick={() => goToImage(idx)}
                                        aria-label={`Image ${idx + 1} of ${imageCount}`}
                                        aria-current={idx === activeImageIndex ? 'true' : undefined}
                                        className="p-1.5"
                                    >
                                        <span className={`block h-1.5 rounded-full transition-all duration-300 ${idx === activeImageIndex ? 'w-4 bg-[var(--neu-gold)]' : 'w-1.5 bg-[var(--neu-text-dim)] opacity-40'}`} />
                                    </button>
                                ))}
                            </div>
                        ) : (
                            <p className="mt-2 text-center text-[11px] tracking-widest tabular-nums text-[var(--neu-text-dim)]">
                                {activeImageIndex + 1} / {imageCount}
                            </p>
                        ))}
                    </div>

                    {/* Details: type and hairlines, no boxes */}
                    <div className="mt-8 lg:mt-6 lg:sticky lg:top-6">
                        <p className="flex items-center gap-3 text-[11px] font-medium uppercase tracking-[0.18em]">
                            {artwork.customId && <span className="text-[var(--neu-text-dim)] truncate">{artwork.customId}</span>}
                            <span className={`inline-flex items-center gap-1.5 shrink-0 ${statusClass}`}>
                                <span className="w-1.5 h-1.5 rounded-full bg-current" aria-hidden="true" />
                                {artwork.status}
                            </span>
                        </p>
                        <h1 className="mt-3 text-[1.75rem] lg:text-[2.1rem] font-serif leading-tight text-[var(--neu-text)] break-words">{artwork.title}</h1>
                        {artistLine && <p className="mt-1.5 text-sm text-[var(--neu-text-dim)]">{artistLine}</p>}

                        <p className="mt-6 text-2xl font-light tabular-nums text-[var(--neu-text)]">
                            ₹{artwork.price.toLocaleString('en-IN')}
                            {artwork.plusGst && <span className="ml-1.5 text-xs text-[var(--neu-text-dim)]">+ GST</span>}
                        </p>

                        {specs.length > 0 && (
                            <dl className="mt-7 border-t border-[var(--neu-line)]">
                                {specs.map(({ label, value }) => (
                                    <div key={label} className="flex items-baseline justify-between gap-6 py-3 border-b border-[var(--neu-line)]">
                                        <dt className="text-[11px] uppercase tracking-[0.14em] text-[var(--neu-text-dim)] shrink-0">{label}</dt>
                                        <dd className="text-sm text-[var(--neu-text)] text-right break-words min-w-0">{value}</dd>
                                    </div>
                                ))}
                            </dl>
                        )}

                        {artwork.description && (
                            <div className="mt-7">
                                <h2 className="text-[11px] uppercase tracking-[0.14em] text-[var(--neu-text-dim)]">{artwork.descriptionTitle || 'About this piece'}</h2>
                                <p className="mt-2.5 text-sm leading-relaxed text-[var(--neu-text)] opacity-85 whitespace-pre-wrap">
                                    {artwork.description}
                                </p>
                            </div>
                        )}
                    </div>
                </div>

                {/* Clears the phone dock (it stays visible over this view) and the home indicator */}
                <div className="h-[calc(6rem+var(--safe-bottom-ui))] lg:h-10" />
            </div>

            {/* Full Screen Image Viewer */}
            {isFullScreen && artwork.imageUrls.length > 0 && (
                <div className="absolute inset-0 z-[100] bg-[var(--neu-bg)] flex flex-col animate-fade-in overflow-hidden">
                    {/* Full Screen Glow Background */}
                    <div
                        className="absolute inset-0 transition-colors duration-700 ease-in-out z-0"
                        style={{ background: `radial-gradient(circle at center, ${withAlpha(glowColor, 0.3)} 0%, transparent 80%)` }}
                    />

                    <div className="px-3 pb-2 z-20 flex justify-between items-center" style={{ paddingTop: 'calc(1rem + var(--safe-top))' }}>
                        <div className="w-9"></div>
                        {artwork.imageUrls.length > 1 ? (
                            <span className="neu-status px-3 py-1 text-[11px] font-medium tracking-widest text-[var(--neu-text-dim)]">
                                {activeImageIndex + 1} / {artwork.imageUrls.length}
                            </span>
                        ) : <div />}
                        <button
                            onClick={() => setIsFullScreen(false)}
                            aria-label="Close"
                            className="neu-icon-btn neu-btn active-scale"
                        >
                            <X size={16} />
                        </button>
                    </div>

                    <div
                        ref={fullScreenCarouselRef}
                        className="flex-1 w-full h-full flex overflow-x-auto snap-x snap-mandatory no-scrollbar pb-[calc(72px+var(--safe-bottom-ui))] lg:pb-4 relative z-10"
                        onScroll={(e) => {
                            const scrollLeft = (e.target as HTMLElement).scrollLeft;
                            const width = (e.target as HTMLElement).clientWidth;
                            setActiveImageIndex(Math.round(scrollLeft / width));
                        }}
                    >
                        {artwork.imageUrls.map((url, idx) => (
                            <div key={url} className="w-full h-full snap-center shrink-0 p-3 flex items-center justify-center relative">
                                <ZoomableImage
                                    src={url}
                                    alt={`${artwork.title} - ${idx + 1}`}
                                    className="max-w-full max-h-full object-contain drop-shadow-2xl"
                                />
                            </div>
                        ))}
                    </div>


                </div>
            )}

            {isEditing && (
                <ArtworkFormModal
                    initialData={artwork}
                    onClose={() => setIsEditing(false)}
                    onSave={handleSaveEdit}
                    onDelete={handleDelete}
                />
            )}

            <TypeDeleteDialog
                isOpen={confirmOpen}
                title="Delete artwork"
                itemName={artwork.title}
                message="it will be archived for admin review"
                onClose={() => setConfirmOpen(false)}
                onConfirm={() => {
                    onDeleteArtwork(artwork.id);
                    setConfirmOpen(false);
                    onClose(); // Close the detail view after deletion
                }}
            />
        </div>
    );
};
