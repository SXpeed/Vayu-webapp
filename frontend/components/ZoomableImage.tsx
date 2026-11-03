import React, { useCallback, useRef } from 'react';
import QuickPinchZoom, { make3dTransformValue } from 'react-quick-pinch-zoom';
import { PreviewOnlyNote } from './PreviewOnlyNote';

interface ZoomableImageProps {
    src: string;
    alt?: string;
    className?: string;
}

export const ZoomableImage: React.FC<ZoomableImageProps> = ({ src, alt, className }) => {
    // The library measures and moves its direct child, so that's what gets the transform.
    // Both fill the slot, so the scale never depends on when the photo loads: transforming
    // the <img> instead shrank it toward its top-left corner and left a gap on the right.
    const boxRef = useRef<HTMLDivElement>(null);

    // The library sizes its box on screen against its unzoomed layout size. Where
    // the browser reports screen sizes after the UI-size zoom on <body> (0.95 by
    // default; Chrome does, older Safari doesn't), that shrank the photo to 95%
    // toward the top-left corner: the gap on the right. Measuring the zoom the same
    // way the library does corrects it in both. Offsets need no correction.
    const onUpdate = useCallback(({ x, y, scale }: { x: number; y: number; scale: number }) => {
        const pageZoom = document.body.getBoundingClientRect().width / document.body.offsetWidth || 1;
        boxRef.current?.style.setProperty('transform', make3dTransformValue({ x, y, scale: scale / pageZoom }));
    }, []);

    return (
        <>
        <QuickPinchZoom onUpdate={onUpdate} wheelScaleFactor={0.5} doubleTapZoomOutOnMaxScale={true} minZoom={1} maxZoom={4} draggableUnZoomed={false}
            containerProps={{ className: 'w-full h-full' }}>
            <div ref={boxRef} className="w-full h-full flex items-center justify-center relative">
                <img
                    src={src}
                    alt={alt || "Zoomable Image"}
                    loading="lazy"
                    decoding="async"
                    className={className}
                />
            </div>
        </QuickPinchZoom>
        <PreviewOnlyNote src={src} className="!absolute bottom-4 left-1/2 -translate-x-1/2 z-10 pointer-events-none" />
        </>
    );
};
