import React, { useCallback, useRef } from 'react';
import QuickPinchZoom, { make3dTransformValue } from 'react-quick-pinch-zoom';

interface ZoomableImageProps {
    src: string;
    alt?: string;
    className?: string;
}

export const ZoomableImage: React.FC<ZoomableImageProps> = ({ src, alt, className }) => {
    const imgRef = useRef<HTMLImageElement>(null);
    
    const onUpdate = useCallback(({ x, y, scale }: any) => {
        const { current: img } = imgRef;
        if (img) {
            const value = make3dTransformValue({ x, y, scale });
            img.style.setProperty("transform", value);
        }
    }, []);

    return (
        <QuickPinchZoom onUpdate={onUpdate} wheelScaleFactor={0.5} doubleTapZoomOutOnMaxScale={true} minScale={1} maxScale={4} draggableUnZoomed={false}>
            <div className="w-full h-full flex items-center justify-center relative">
                <img
                    ref={imgRef}
                    src={src}
                    alt={alt || "Zoomable Image"}
                    loading="lazy"
                    decoding="async"
                    className={className}
                    style={{ transformOrigin: '0 0' }} // QuickPinchZoom uses make3dTransformValue which often requires 0 0 origin, or let the library handle it
                />
            </div>
        </QuickPinchZoom>
    );
};
