import { parseApiResponse, tokenHeader } from './apiClient';
import { apiBase, currentWorkspace, fileKeyOf } from './workspace';

export interface UploadResult {
    key: string;
    url: string;
    thumbUrl?: string;
}

// Originals are uploaded untouched at the highest quality provided. A small
// preview copy is generated alongside for fast grid/list loading; the product
// detail page and PDF generation always use the original.
const THUMB_MAX_DIMENSION_PX = 480;
const THUMB_JPEG_QUALITY = 0.78;

/** Grid/list-sized variant of an uploaded file URL. The worker serves the
 *  original when no thumbnail exists (older uploads), so this is always safe. */
export function getThumbUrl(url: string): string {
    return fileKeyOf(url) !== null && !url.endsWith('__thumb') ? `${url}__thumb` : url;
}

function loadImage(file: File): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => {
            URL.revokeObjectURL(url);
            resolve(image);
        };
        image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('Image could not be loaded.'));
        };
        image.src = url;
    });
}

/** Small JPEG preview for grids; null when the file isn't a raster image or
 *  thumbnailing fails (upload proceeds with the original only). */
async function makeThumbnail(file: File): Promise<File | null> {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return null;

    try {
        const image = await loadImage(file);
        const scale = Math.min(1, THUMB_MAX_DIMENSION_PX / Math.max(image.width, image.height));
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        // White backing so transparent PNGs don't turn black as JPEG.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(image, 0, 0, width, height);

        const blob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, 'image/jpeg', THUMB_JPEG_QUALITY)
        );
        if (!blob) return null;

        const baseName = file.name.replace(/\.[^.]+$/, '');
        return new File([blob], `${baseName}_thumb.jpg`, { type: 'image/jpeg' });
    } catch (e) {
        console.warn('Thumbnail generation failed, uploading original only:', e);
        return null;
    }
}

const storageService = {
    async upload(file: File): Promise<UploadResult> {
        const formData = new FormData();
        formData.append('file', file);

        const thumb = await makeThumbnail(file);
        if (thumb) formData.append('thumb', thumb);

        // No Content-Type header here — the browser sets the multipart boundary.
        const res = await fetch(`${apiBase()}/upload`, {
            method: 'POST',
            headers: tokenHeader(),
            body: formData,
        });
        return parseApiResponse<UploadResult>(res);
    },

    async delete(key: string): Promise<void> {
        const res = await fetch(`${apiBase()}/files/${encodeURIComponent(key)}`, {
            method: 'DELETE',
            headers: tokenHeader(),
        });
        await parseApiResponse<{ success?: boolean }>(res);
    },

    /**
     * One-time migration: generate small copies for files uploaded before
     * thumbnails existed. Runs quietly in the background after login; once the
     * server reports nothing missing, a local flag skips future checks.
     */
    async backfillThumbnails(): Promise<number> {
        const workspace = currentWorkspace();
        const DONE_FLAG = workspace ? `vayu_thumbs_backfilled_v1@${workspace.id}` : 'vayu_thumbs_backfilled_v1';
        if (localStorage.getItem(DONE_FLAG)) return 0;

        const authHeaders = tokenHeader();
        const listRes = await fetch(`${apiBase()}/files-missing-thumbs`, { headers: authHeaders });
        const { missing } = await parseApiResponse<{ missing: string[] }>(listRes);

        let generated = 0;
        for (const key of missing) {
            try {
                const fileRes = await fetch(`${apiBase()}/files/${key}`);
                if (!fileRes.ok) continue;
                const blob = await fileRes.blob();
                const name = key.split('/').pop() || 'file';
                const thumb = await makeThumbnail(new File([blob], name, { type: blob.type }));
                if (!thumb) continue; // not a raster image (PDFs, etc.)

                const formData = new FormData();
                formData.append('key', key);
                formData.append('thumb', thumb);
                const uploadRes = await fetch(`${apiBase()}/files-thumbs`, {
                    method: 'POST',
                    headers: authHeaders,
                    body: formData,
                });
                if (uploadRes.ok) generated++;
            } catch (e) {
                console.warn(`Thumbnail backfill failed for ${key}:`, e);
            }
        }

        localStorage.setItem(DONE_FLAG, 'true');
        return generated;
    },
};

export default storageService;
