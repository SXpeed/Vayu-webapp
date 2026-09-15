import React, { useCallback, useRef } from 'react';

interface PhotoCaptureOptions {
    /** Allow picking several photos at once from the gallery. */
    multiple?: boolean;
}

/**
 * Hidden inputs for grabbing photos. `openCamera` opens the rear camera
 * directly on phones (desktop browsers fall back to an image picker) and
 * `openGallery` picks existing photos. Render `inputs` once in the component.
 */
export function usePhotoCapture(onFiles: (files: File[]) => void, { multiple = false }: PhotoCaptureOptions = {}) {
    const cameraRef = useRef<HTMLInputElement>(null);
    const galleryRef = useRef<HTMLInputElement>(null);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files ?? []);
        // Reset so choosing the same photo again still fires onChange.
        e.target.value = '';
        if (files.length > 0) onFiles(files);
    };

    const openCamera = useCallback(() => cameraRef.current?.click(), []);
    const openGallery = useCallback(() => galleryRef.current?.click(), []);

    const inputs = (
        <>
            <input type="file" accept="image/*" capture="environment" ref={cameraRef} className="hidden" onChange={handleChange} tabIndex={-1} aria-hidden="true" />
            <input type="file" accept="image/*" multiple={multiple} ref={galleryRef} className="hidden" onChange={handleChange} tabIndex={-1} aria-hidden="true" />
        </>
    );

    return { openCamera, openGallery, inputs };
}
