import React, { useEffect, useRef, useState } from 'react';
import { BookOpen, FileText } from 'lucide-react';
import type { Artwork, Catalog } from '../types';
import { getThumbUrl } from '../services/storageService';
import { fileKeyOf } from '../services/workspace';
import { pdfFirstPage } from '../services/pdfThumbnail';

/**
 * A cover someone uploaded — a stored file. Catalogs made without one used to
 * get a random stock photo from another site, which the app no longer loads
 * (and which never showed the catalog anyway), so those don't count.
 */
export const uploadedCover = (catalog: Pick<Catalog, 'coverImageUrl'> | null | undefined): string | undefined => {
    const url = catalog?.coverImageUrl;
    return url && fileKeyOf(url) !== null ? url : undefined;
};

/** The catalog's first artwork photo, in the catalog's own order. */
const firstArtworkPhoto = (catalog: Catalog, artworks: Artwork[]): string | undefined => {
    for (const id of catalog.artworkIds) {
        const url = artworks.find(a => a.id === id)?.imageUrls?.[0];
        if (url) return url;
    }
    return undefined;
};

/**
 * The picture on a catalog tile: its uploaded cover; otherwise the first page
 * of its PDF; otherwise its first artwork's photo; otherwise an icon. The PDF
 * page is drawn once the tile scrolls into view, and kept on the device.
 */
export const CatalogCover: React.FC<{ catalog: Catalog; artworks: Artwork[]; className?: string }> = ({ catalog, artworks, className = '' }) => {
    const cover = uploadedCover(catalog);
    const photo = firstArtworkPhoto(catalog, artworks);
    const wantsPdfPage = !cover && !!catalog.pdfUrl;

    const holder = useRef<HTMLDivElement>(null);
    const [pdfPage, setPdfPage] = useState<{ pdfUrl: string; objectUrl: string | null } | null>(null);

    useEffect(() => {
        if (!wantsPdfPage || !catalog.pdfUrl) return;
        const pdfUrl = catalog.pdfUrl;
        let alive = true;
        let objectUrl: string | null = null;
        const load = () => {
            void pdfFirstPage(pdfUrl).then(blob => {
                if (!alive) return;
                objectUrl = blob ? URL.createObjectURL(blob) : null;
                setPdfPage({ pdfUrl, objectUrl });
            });
        };
        // Only when the tile is (nearly) on screen: each PDF is a download.
        const el = holder.current;
        if (!el || typeof IntersectionObserver === 'undefined') {
            load();
        } else {
            const io = new IntersectionObserver(entries => {
                if (entries.some(e => e.isIntersecting)) {
                    io.disconnect();
                    load();
                }
            }, { rootMargin: '200px' });
            io.observe(el);
            return () => {
                alive = false;
                io.disconnect();
                if (objectUrl) URL.revokeObjectURL(objectUrl);
            };
        }
        return () => {
            alive = false;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [wantsPdfPage, catalog.pdfUrl]);

    const drawn = pdfPage && pdfPage.pdfUrl === catalog.pdfUrl ? pdfPage : null;
    let src: string | undefined;
    // The PDF page is shown from its top, where the photo is, not its middle.
    let position = 'center';
    if (cover) src = getThumbUrl(cover);
    else if (drawn?.objectUrl) { src = drawn.objectUrl; position = 'top'; }
    // No PDF, or it couldn't be drawn (too large, offline): the first photo.
    else if (photo && (!wantsPdfPage || drawn)) src = getThumbUrl(photo);

    const waiting = wantsPdfPage && !drawn;
    return (
        <div ref={holder} className={`relative w-full h-full ${className}`}>
            {src ? (
                <img
                    loading="lazy"
                    decoding="async"
                    src={src}
                    alt={catalog.name}
                    className="w-full h-full object-cover"
                    style={{ objectPosition: position }}
                />
            ) : (
                <div className={`w-full h-full flex flex-col items-center justify-center gap-1.5 text-[var(--neu-gold)] ${waiting ? 'animate-pulse' : ''}`}>
                    {catalog.pdfUrl ? <FileText size={30} strokeWidth={1.25} /> : <BookOpen size={30} strokeWidth={1.25} />}
                    {!waiting && <span className="text-[10px] font-bold uppercase tracking-widest">{catalog.pdfUrl ? 'PDF' : 'No cover yet'}</span>}
                </div>
            )}
        </div>
    );
};
