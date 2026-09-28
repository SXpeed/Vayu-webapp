import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play, X } from 'lucide-react';
import { FullScreenPortal } from '../../components/FullScreenPortal';
import type { Artwork, RosterPriceDisplay } from '../../types';
import { priceLine } from './rosterShared';

const AUTOPLAY_MS = 6000;

interface RosterPresentProps {
    title: string;
    pieces: Artwork[];
    priceDisplay: RosterPriceDisplay;
    onClose: () => void;
}

/**
 * Presenting a section to a client across the table: one piece at a time on
 * the studio backdrop, full screen where the browser allows it, with the
 * arrow keys, swipes or an automatic slideshow. Nothing to edit here, and
 * nothing a client shouldn't see (no inventory ids, no internal notes).
 */
export const RosterPresent: React.FC<RosterPresentProps> = ({ title, pieces, priceDisplay, onClose }) => {
    const [index, setIndex] = useState(0);
    const [playing, setPlaying] = useState(false);
    const stageRef = useRef<HTMLDivElement>(null);
    const touchX = useRef<number | null>(null);

    const step = useCallback((by: number) => {
        setIndex(i => (i + by + pieces.length) % Math.max(pieces.length, 1));
    }, [pieces.length]);

    // Full screen is a nicety: some browsers (iPhone Safari) refuse it.
    useEffect(() => {
        const el = stageRef.current;
        el?.requestFullscreen?.().catch(() => undefined);
        return () => {
            if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
        };
    }, []);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); step(1); }
            else if (e.key === 'ArrowLeft') step(-1);
        };
        globalThis.addEventListener('keydown', onKey);
        return () => globalThis.removeEventListener('keydown', onKey);
    }, [onClose, step]);

    useEffect(() => {
        if (!playing || pieces.length < 2) return;
        const timer = setInterval(() => step(1), AUTOPLAY_MS);
        return () => clearInterval(timer);
    }, [playing, pieces.length, step]);

    const art = pieces[index];
    if (!art) return null;
    const price = priceLine(art, priceDisplay);
    const details = [art.medium, art.dimensions].filter(Boolean).join(' · ');

    return (
        <FullScreenPortal>
            <div
                ref={stageRef}
                className="roster-stage fixed inset-0 z-[60] flex flex-col select-none"
                role="dialog"
                aria-modal="true"
                aria-label={`Presenting ${title}`}
                onTouchStart={e => { touchX.current = e.touches[0]?.clientX ?? null; }}
                onTouchEnd={e => {
                    const start = touchX.current;
                    const end = e.changedTouches[0]?.clientX;
                    touchX.current = null;
                    if (start === null || end === undefined || Math.abs(end - start) < 40) return;
                    step(end < start ? 1 : -1);
                }}
            >
                <div className="flex items-center justify-between gap-3 px-4 md:px-8" style={{ paddingTop: 'calc(1rem + var(--safe-top))' }}>
                    <p className="text-[11px] uppercase tracking-[0.24em] text-white/60 truncate">{title}</p>
                    <div className="flex items-center gap-2 shrink-0">
                        <button type="button" onClick={() => setPlaying(p => !p)} aria-label={playing ? 'Pause slideshow' : 'Play slideshow'}
                            className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/15 flex items-center justify-center active-scale">
                            {playing ? <Pause size={16} /> : <Play size={16} />}
                        </button>
                        <button type="button" onClick={onClose} aria-label="Stop presenting"
                            className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/15 flex items-center justify-center active-scale">
                            <X size={18} />
                        </button>
                    </div>
                </div>

                <div className="relative flex-1 min-h-0 flex items-center justify-center px-4 md:px-20">
                    {art.imageUrls[0] && (
                        <img key={art.id} src={art.imageUrls[0]} alt={art.title} decoding="async"
                            className="max-w-full max-h-full object-contain drop-shadow-[0_30px_40px_rgba(0,0,0,0.45)] animate-fade-in" />
                    )}
                    {pieces.length > 1 && (
                        <>
                            <button type="button" onClick={() => step(-1)} aria-label="Previous piece"
                                className="hidden md:flex absolute left-6 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/10 hover:bg-white/15 items-center justify-center active-scale">
                                <ChevronLeft size={22} />
                            </button>
                            <button type="button" onClick={() => step(1)} aria-label="Next piece"
                                className="hidden md:flex absolute right-6 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/10 hover:bg-white/15 items-center justify-center active-scale">
                                <ChevronRight size={22} />
                            </button>
                        </>
                    )}
                </div>

                <div className="px-6 md:px-10 pt-4 text-center" style={{ paddingBottom: 'calc(1.5rem + var(--safe-bottom-ui))' }}>
                    <h2 className="font-serif text-2xl md:text-3xl tracking-wide text-[#e6c27a]">{art.title}</h2>
                    {(art.artist || details) && (
                        <p className="mt-1.5 text-[13px] text-white/70">{[art.artist, details].filter(Boolean).join(' — ')}</p>
                    )}
                    {price && <p className="mt-1 text-[13px] text-white/85">{price}</p>}
                    {pieces.length > 1 && (
                        <div className="mt-4 flex justify-center gap-1.5" aria-hidden="true">
                            {pieces.slice(0, 40).map((p, i) => (
                                <span key={p.id} className={`h-1 rounded-full transition-all ${i === index ? 'w-6 bg-[#e6c27a]' : 'w-1.5 bg-white/30'}`} />
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </FullScreenPortal>
    );
};
