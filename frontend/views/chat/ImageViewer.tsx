// A chat photo, full screen: pinch or double-tap to zoom (a mouse wheel on a
// computer), the full-size file rather than the thumbnail in the bubble.
// Closes with the X or Escape.

import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Download, X } from 'lucide-react';
import { ZoomableImage } from '../../components/ZoomableImage';

export interface ViewedImage {
    url: string;
    name: string;
    /** "Asha · 10:42 AM" */
    caption: string;
}

export const ImageViewer: React.FC<{ image: ViewedImage; onClose: () => void }> = ({ image, onClose }) => {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    const control = 'w-10 h-10 rounded-full flex items-center justify-center bg-white/10 hover:bg-white/20 text-white active-scale';
    return createPortal(
        <div className="fixed inset-0 z-[96] bg-black flex flex-col animate-fade-in" role="dialog" aria-modal="true" aria-label="Photo">
            <div className="flex items-center gap-3 px-3 pb-2 pt-[calc(0.75rem+var(--safe-top,0px))] text-white">
                <p className="min-w-0 flex-1 text-[13px] truncate opacity-80">{image.caption}</p>
                <a href={image.url} download={image.name} target="_blank" rel="noreferrer" aria-label="Download photo" className={control}>
                    <Download size={18} />
                </a>
                <button type="button" onClick={onClose} aria-label="Close photo" className={control} autoFocus>
                    <X size={20} />
                </button>
            </div>
            {/* Centred like the artwork viewer: the zoom layer needs a centring parent. */}
            <div className="flex-1 min-h-0 overflow-hidden flex items-center justify-center p-2 pb-[calc(0.5rem+var(--safe-bottom,0px))]">
                <ZoomableImage src={image.url} alt={image.name} className="max-w-full max-h-full object-contain" />
            </div>
        </div>,
        document.body,
    );
};
