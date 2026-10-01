import React, { useEffect, useState } from 'react';
import { CloudOff } from 'lucide-react';
import { photoStore } from '../services/photoStore';
import { fileKeyOf } from '../services/workspace';

/**
 * Offline, a full-size photo not saved on the device shows as its preview
 * (public/sw.js): this says so, so a softer picture isn't a surprise.
 */
export const PreviewOnlyNote: React.FC<{ src: string; className?: string }> = ({ src, className = '' }) => {
    const [previewOnly, setPreviewOnly] = useState(false);

    useEffect(() => {
        let live = true;
        const check = () => {
            if (navigator.onLine || fileKeyOf(src) === null) { setPreviewOnly(false); return; }
            void photoStore.hasFullSize(src).then(saved => { if (live) setPreviewOnly(!saved); });
        };
        check();
        globalThis.addEventListener('online', check);
        globalThis.addEventListener('offline', check);
        return () => {
            live = false;
            globalThis.removeEventListener('online', check);
            globalThis.removeEventListener('offline', check);
        };
    }, [src]);

    if (!previewOnly) return null;
    return (
        <span className={`neu-chip-float inline-flex items-center gap-1 text-[11px] text-[var(--neu-text-dim)] ${className}`}>
            <CloudOff size={11} /> Preview · full photo when online
        </span>
    );
};
