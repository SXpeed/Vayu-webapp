import React, { useState, useRef, useEffect } from 'react';
import toast from 'react-hot-toast';
import { ArrowLeft, Edit2, X, Image as ImageIcon, Share2 } from 'lucide-react';
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
            void getDominantColor(artwork.imageUrls[activeImageIndex]).then(color => {
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
    // The wall label's lines: what the piece is, then where it is kept.
    const labelLines = [artwork.medium, artwork.dimensions].filter(v => v?.trim());

    const priceText = `₹${artwork.price.toLocaleString('en-IN')}${artwork.plusGst ? ' + GST' : ''}`;

    // The photo on screen, fetched ahead: iPhones refuse to share once an
    // await has passed after the tap, so the file must be ready at the tap.
    const shareFile = useRef<File | null>(null);
    const shownUrl = artwork.imageUrls[activeImageIndex] ?? artwork.imageUrls[0];
    useEffect(() => {
        shareFile.current = null;
        if (!shownUrl || !navigator.canShare) return;
        let current = true;
        fetch(shownUrl)
            .then(r => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
            .then(blob => {
                const file = new File([blob], `${artwork.title || 'artwork'}.${blob.type.split('/')[1] || 'jpg'}`, { type: blob.type || 'image/jpeg' });
                if (current && navigator.canShare({ files: [file] })) shareFile.current = file;
            })
            .catch(() => { /* shares the text without the photo */ });
        return () => { current = false; };
    }, [shownUrl, artwork.title]);

    const handleShare = async () => {
        const text = [artwork.title, artistLine, priceText, ...specs.map(s => `${s.label}: ${s.value}`)].filter(Boolean).join('\n');
        try {
            if (navigator.share) {
                await navigator.share(shareFile.current ? { files: [shareFile.current], title: artwork.title, text } : { title: artwork.title, text });
            } else {
                await navigator.clipboard.writeText(text);
                toast.success('Details copied');
            }
        } catch (e) {
            if ((e as Error).name !== 'AbortError') toast.error('Could not share');
        }
    };

    return (
        <div className="absolute inset-0 bg-[var(--neu-bg)] z-[60] flex flex-col animate-fade-in-up">
            {/* Back / edit float over the picture */}
            <div className="absolute inset-x-0 top-0 z-20 px-4 lg:px-10 pointer-events-none" style={{ paddingTop: 'calc(1rem + var(--safe-top))' }}>
                <div className="max-w-6xl mx-auto flex justify-between items-center">
                    <button onClick={onClose} aria-label="Back" className="neu-icon-btn neu-btn active-scale pointer-events-auto">
                        <ArrowLeft size={18} />
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto no-scrollbar">
                <div className="max-w-6xl mx-auto lg:grid lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:gap-12 lg:items-start lg:px-10 lg:pt-20">

                    {/* Hero: the picture edge to edge over a wash of its own colour */}
                    <div className="relative lg:sticky lg:top-6 lg:rounded-[2rem] lg:overflow-hidden">
                        <div
                            aria-hidden="true"
                            className="absolute inset-0 transition-[background] duration-700"
                            style={{ background: `radial-gradient(120% 90% at 50% 40%, ${withAlpha(glowColor, 0.55)} 0%, ${withAlpha(glowColor, 0.18)} 55%, transparent 100%)` }}
                        />
                        <div className="relative h-[60dvh] min-h-[320px] lg:h-[min(calc(100dvh-8rem),760px)] flex flex-col" style={{ paddingTop: 'calc(4.25rem + var(--safe-top))' }}>
                            {imageCount > 0 ? (
                                <div
                                    ref={mainCarouselRef}
                                    className="flex-1 min-h-0 w-full flex overflow-x-auto snap-x snap-mandatory no-scrollbar"
                                    onScroll={(e) => {
                                        const scrollLeft = (e.target as HTMLElement).scrollLeft;
                                        const width = (e.target as HTMLElement).clientWidth;
                                        setActiveImageIndex(Math.round(scrollLeft / width));
                                    }}
                                >
                                    {artwork.imageUrls.map((url, idx) => (
                                        <div key={url} className="w-full h-full snap-center shrink-0 px-6 pb-12 lg:px-10 lg:pb-14">
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
                                                    className="max-w-full max-h-full object-contain rounded-md shadow-[0_24px_40px_-18px_rgba(0,0,0,0.45)]"
                                                />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="flex-1 mx-6 mb-12 flex items-center justify-center rounded-2xl neu-inset text-[var(--neu-text-dim)]">
                                    <ImageIcon size={48} strokeWidth={1} />
                                </div>
                            )}

                            {/* Pager: small dots, the current one longer */}
                            {imageCount > 1 && (
                                <div className="absolute inset-x-0 bottom-6 lg:bottom-5 flex justify-center items-center gap-0.5">
                                    {imageCount <= 8 ? artwork.imageUrls.map((url, idx) => (
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
                                    )) : (
                                        <span className="neu-status px-3 py-1 text-[11px] tracking-widest tabular-nums text-[var(--neu-text-dim)]">
                                            {activeImageIndex + 1} / {imageCount}
                                        </span>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Details: a sheet that rises over the picture on phones */}
                    <div className="relative -mt-7 lg:mt-0 lg:sticky lg:top-6 rounded-t-[2rem] lg:rounded-none bg-[var(--neu-bg)] px-5 pt-3 lg:px-0 lg:pt-0 shadow-[0_-12px_30px_-18px_rgba(0,0,0,0.25)] lg:shadow-none">
                        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-[var(--neu-line)] lg:hidden" aria-hidden="true" />

                        {imageCount > 0 && (
                            <div className="mb-3 empty:hidden">
                                <PreviewOnlyNote src={shownUrl} className="!static" />
                            </div>
                        )}

                        {/* A gallery wall label: artist, title and year, what it is made
                            of and its size, the price, then the studio's own notes. */}
                        <div className="lg:pt-6">
                            {artwork.artist && (
                                <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-[var(--neu-text-dim)]">{artwork.artist}</p>
                            )}
                            <h1 className="mt-2 font-serif text-[1.85rem] lg:text-[2.4rem] leading-tight text-[var(--neu-text)] break-words">
                                <span className="italic">{artwork.title}</span>
                                {artwork.artworkYear && <span className="text-[var(--neu-text-dim)]">, {artwork.artworkYear}</span>}
                            </h1>
                            {labelLines.length > 0 && (
                                <div className="mt-4 space-y-1 text-[15px] leading-snug text-[var(--neu-text)]">
                                    {labelLines.map(line => <p key={line} className="break-words">{line}</p>)}
                                </div>
                            )}
                            <p className="mt-5 text-xl font-light tabular-nums text-[var(--neu-text)]">
                                ₹{artwork.price.toLocaleString('en-IN')}
                                {artwork.plusGst && <span className="ml-1.5 text-xs text-[var(--neu-text-dim)]">+ GST</span>}
                            </p>
                            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-[var(--neu-text-dim)]">
                                <span className={`inline-flex items-center gap-1.5 font-medium ${statusClass}`}>
                                    <span className="w-1.5 h-1.5 rounded-full bg-current" aria-hidden="true" />
                                    {artwork.status}
                                </span>
                                {artwork.customId && <><span aria-hidden="true">·</span><span className="uppercase tracking-[0.14em]">{artwork.customId}</span></>}
                                {artwork.location && <><span aria-hidden="true">·</span><span>{artwork.location}</span></>}
                            </p>
                        </div>

                        <div className="mt-6 flex gap-2.5">
                            <button type="button" onClick={handleShare} className="neu-button flex-1 lg:flex-none inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium text-[var(--neu-text)] active-scale">
                                <Share2 size={16} className="text-[var(--neu-gold)]" />
                                Share
                            </button>
                            <IfCan section="inventory">
                                <button type="button" onClick={() => setIsEditing(true)} className="neu-button flex-1 lg:flex-none inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium text-[var(--neu-text)] active-scale">
                                    <Edit2 size={15} className="text-[var(--neu-gold)]" />
                                    Edit
                                </button>
                            </IfCan>
                        </div>

                        {artwork.description && (
                            <div className="mt-7 pt-6 border-t border-[var(--neu-line)]">
                                <h2 className="text-[11px] uppercase tracking-[0.14em] text-[var(--neu-text-dim)]">{artwork.descriptionTitle || 'About this piece'}</h2>
                                <p className="mt-2.5 text-sm leading-relaxed text-[var(--neu-text)] opacity-85 whitespace-pre-wrap">
                                    {artwork.description}
                                </p>
                            </div>
                        )}

                        {/* Clears the phone dock (it stays visible over this view) and the home indicator */}
                        <div className="h-[calc(6rem+var(--safe-bottom-ui))] lg:h-10" />
                    </div>
                </div>
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
