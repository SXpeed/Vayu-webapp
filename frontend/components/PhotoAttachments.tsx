import React, { useRef, useState } from 'react';
import { Camera, Image as ImageIcon, Loader2, X } from 'lucide-react';
import toast from 'react-hot-toast';
import storageService, { getThumbUrl } from '../services/storageService';
import { usePhotoCapture } from '../hooks/usePhotoCapture';
import { FullScreenPortal } from './FullScreenPortal';

interface PhotoAttachmentsProps {
    readonly urls: string[];
    /** Receives the URLs of photos that finished uploading. */
    readonly onAdd: (urls: string[]) => void;
    /** When set, each photo shows a remove button. */
    readonly onRemove?: (url: string) => void;
    readonly onUploadingChange?: (uploading: boolean) => void;
}

/**
 * Photo strip with "Take Photo" (opens the camera) and "Gallery" buttons.
 * Photos upload as soon as they're captured; tap one to view it full screen.
 */
export const PhotoAttachments: React.FC<PhotoAttachmentsProps> = ({ urls, onAdd, onRemove, onUploadingChange }) => {
    const [uploadingCount, setUploadingCount] = useState(0);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    // Batches can overlap (snap a photo while the last one uploads), so the
    // in-flight count lives in a ref rather than a state updater.
    const pendingRef = useRef(0);

    const uploadFiles = async (files: File[]) => {
        pendingRef.current += files.length;
        setUploadingCount(pendingRef.current);
        onUploadingChange?.(true);

        const results = await Promise.allSettled(files.map(file => storageService.upload(file)));
        const uploaded = results.flatMap(r => (r.status === 'fulfilled' ? [r.value.url] : []));
        const failed = results.length - uploaded.length;
        if (uploaded.length > 0) onAdd(uploaded);
        if (failed === 1) toast.error('A photo failed to upload. Please try again.');
        else if (failed > 1) toast.error(`${failed} photos failed to upload. Please try again.`);

        pendingRef.current -= files.length;
        setUploadingCount(pendingRef.current);
        if (pendingRef.current === 0) onUploadingChange?.(false);
    };

    const { openCamera, openGallery, inputs } = usePhotoCapture((files) => { void uploadFiles(files); }, { multiple: true });

    return (
        <div>
            {(urls.length > 0 || uploadingCount > 0) && (
                <div className="flex gap-2 flex-wrap mb-3">
                    {urls.map((url, index) => (
                        <div key={url} className="relative w-16 h-16">
                            <button
                                type="button"
                                onClick={() => setPreviewUrl(url)}
                                className="w-full h-full rounded-[6px] overflow-hidden border border-gray-200 dark:border-gray-700 active-scale"
                                aria-label={`View photo ${index + 1}`}
                            >
                                <img loading="lazy" decoding="async" src={getThumbUrl(url)} alt="" className="w-full h-full object-cover" />
                            </button>
                            {onRemove && (
                                <button
                                    type="button"
                                    onClick={() => onRemove(url)}
                                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-black/70 text-white flex items-center justify-center active-scale"
                                    aria-label={`Remove photo ${index + 1}`}
                                >
                                    <X size={11} />
                                </button>
                            )}
                        </div>
                    ))}
                    {Array.from({ length: uploadingCount }, (_, i) => (
                        <div key={`uploading-${i}`} className="w-16 h-16 rounded-[6px] bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-gray-400">
                            <Loader2 size={18} className="animate-spin" />
                        </div>
                    ))}
                </div>
            )}

            <div className="grid grid-cols-2 gap-2">
                <button
                    type="button"
                    onClick={openCamera}
                    className="flex items-center justify-center gap-2 py-2.5 rounded-[6px] bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 text-[10px] font-bold uppercase tracking-widest active-scale"
                >
                    <Camera size={15} /> Take Photo
                </button>
                <button
                    type="button"
                    onClick={openGallery}
                    className="flex items-center justify-center gap-2 py-2.5 rounded-[6px] bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200 text-[10px] font-bold uppercase tracking-widest active-scale border border-gray-200 dark:border-gray-700"
                >
                    <ImageIcon size={15} /> Gallery
                </button>
            </div>
            {inputs}

            {previewUrl && (
                <FullScreenPortal>
                    <div className="absolute inset-0 z-[80] bg-black/95 flex items-center justify-center animate-fade-in">
                        <button
                            type="button"
                            onClick={() => setPreviewUrl(null)}
                            className="absolute inset-0 w-full h-full cursor-default"
                            aria-label="Close photo"
                        />
                        <img src={previewUrl} alt="" className="relative max-w-full max-h-full object-contain pointer-events-none" />
                        <button
                            type="button"
                            onClick={() => setPreviewUrl(null)}
                            className="absolute top-[calc(1rem+env(safe-area-inset-top,0px))] right-4 w-10 h-10 rounded-full bg-white/10 text-white flex items-center justify-center active-scale"
                            aria-label="Close photo"
                        >
                            <X size={20} />
                        </button>
                    </div>
                </FullScreenPortal>
            )}
        </div>
    );
};
