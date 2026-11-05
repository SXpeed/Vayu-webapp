import React, { useEffect, useState } from 'react';
import { Download, Loader2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { FullScreenPortal } from './FullScreenPortal';
import { useBackClose } from '../hooks/useBackClose';
import { loadPdfjs } from '../services/pdfThumbnail';

const ZOOMS = [1, 1.5, 2, 3];

interface PdfViewerProps {
    url: string;
    name: string;
    onClose: () => void;
    onDownload: () => void;
}

/**
 * A PDF shown inside the app, page by page. Phone browsers have no PDF viewer
 * of their own, so opening one used to mean a download, then finding it in Files.
 */
export const PdfViewer: React.FC<PdfViewerProps> = ({ url, name, onClose, onDownload }) => {
    useBackClose(true, onClose);
    const [pages, setPages] = useState<string[]>([]);
    const [total, setTotal] = useState(0);
    const [aspect, setAspect] = useState(Math.SQRT2);
    const [error, setError] = useState('');
    const [zoom, setZoom] = useState(0);

    useEffect(() => {
        let cancelled = false;
        const made: string[] = [];
        let destroy: (() => Promise<void>) | undefined;
        (async () => {
            const res = await fetch(url);
            if (!res.ok) throw new Error('Could not load the PDF');
            const data = new Uint8Array(await res.arrayBuffer());
            const pdfjs = await loadPdfjs();
            const task = pdfjs.getDocument({ data });
            destroy = () => task.destroy();
            const doc = await task.promise;
            if (cancelled) return;
            setTotal(doc.numPages);
            // Sharp to about 2× zoom on a phone, small enough that a page stays a few hundred KB.
            const width = Math.min(1600, Math.max(1000, globalThis.innerWidth * globalThis.devicePixelRatio));
            // shortcut: draws every page in order, so a far page waits for the ones before it; draw on scroll if 100+ page PDFs get common.
            for (let i = 1; i <= doc.numPages && !cancelled; i++) {
                const page = await doc.getPage(i);
                const base = page.getViewport({ scale: 1 });
                if (i === 1) setAspect(base.height / base.width);
                const viewport = page.getViewport({ scale: width / base.width });
                const canvas = document.createElement('canvas');
                canvas.width = Math.round(viewport.width);
                canvas.height = Math.round(viewport.height);
                const ctx = canvas.getContext('2d');
                if (!ctx) throw new Error('Could not draw the PDF');
                ctx.fillStyle = '#ffffff'; // PDF pages are white unless they paint otherwise
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                await page.render({ canvas, canvasContext: ctx, viewport }).promise;
                page.cleanup();
                // A JPEG instead of the canvas: the browser can drop pages scrolled out of view from memory.
                const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
                if (!blob) throw new Error('Could not draw the PDF');
                if (cancelled) return;
                const src = URL.createObjectURL(blob);
                made.push(src);
                setPages(p => [...p, src]);
            }
        })().catch((e: Error) => { if (!cancelled) setError(e.message || 'Could not open the PDF'); });
        return () => {
            cancelled = true;
            void destroy?.();
            for (const src of made) URL.revokeObjectURL(src);
        };
    }, [url]);

    const z = ZOOMS[zoom];
    const iconBtn = 'w-10 h-10 shrink-0 rounded-full bg-white/10 text-white flex items-center justify-center active-scale disabled:opacity-40';

    return (
        <FullScreenPortal>
            <div role="dialog" aria-modal="true" aria-label={name} className="absolute inset-0 z-[80] bg-neutral-900 flex flex-col animate-fade-in">
                <div className="flex items-center gap-2 px-3 pt-[calc(0.75rem+var(--safe-top))] pb-3 text-white">
                    <button type="button" onClick={onClose} className={iconBtn} aria-label="Close PDF"><X size={20} /></button>
                    <div className="flex-1 min-w-0">
                        <p className="truncate text-sm font-medium">{name}</p>
                        {total > 0 && <p className="text-[11px] text-white/60">{total} {total === 1 ? 'page' : 'pages'}</p>}
                    </div>
                    <button type="button" onClick={() => setZoom(zoom - 1)} disabled={zoom === 0} className={iconBtn} aria-label="Zoom out"><ZoomOut size={18} /></button>
                    <button type="button" onClick={() => setZoom(zoom + 1)} disabled={zoom === ZOOMS.length - 1} className={iconBtn} aria-label="Zoom in"><ZoomIn size={18} /></button>
                    <button type="button" onClick={onDownload} className={iconBtn} aria-label="Download PDF"><Download size={18} /></button>
                </div>
                <div className="flex-1 overflow-auto overscroll-contain">
                    {error ? (
                        <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center text-white/80 text-sm">
                            <p>{error}</p>
                            <button type="button" onClick={onDownload} className="rounded-full bg-white/10 px-4 py-2 text-white active-scale">Download instead</button>
                        </div>
                    ) : total === 0 ? (
                        <div className="h-full flex items-center justify-center text-white/70" role="status" aria-label="Opening PDF">
                            <Loader2 size={28} className="animate-spin" />
                        </div>
                    ) : (
                        <div className="mx-auto flex flex-col gap-3 p-3 pb-[calc(1rem+var(--safe-bottom))]" style={{ width: `min(${z * 100}%, ${z * 900}px)` }}>
                            {pages.map((src, i) => <img key={src} src={src} alt={`Page ${i + 1}`} className="w-full bg-white shadow-lg" />)}
                            {Array.from({ length: total - pages.length }, (_, i) => (
                                <div key={i} className="w-full bg-white/5 flex items-center justify-center text-white/50" style={{ aspectRatio: `1 / ${aspect}` }}>
                                    {i === 0 && <Loader2 size={22} className="animate-spin" />}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </FullScreenPortal>
    );
};
