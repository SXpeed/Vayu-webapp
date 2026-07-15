import { removeBackground } from '@imgly/background-removal';

export interface PdfImageInfo {
    dataUrl: string;
    width: number;
    height: number;
    format: string;
}

/** Progress messages ("Downloading AI model 45%", "Removing background…"). */
export type CutoutProgress = (message: string) => void;

// Let the library resolve its own CDN URL based on its internal PACKAGE_VERSION.
// Do NOT hardcode publicPath — the library already uses the correct default.

const CROP_PADDING_PX = 30;
const ALPHA_THRESHOLD = 10;

const cutoutCache = new Map<string, PdfImageInfo>();
const MAX_CACHE = 20;

function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Failed to load processed image'));
        img.src = src;
    });
}

function blobToDataURL(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('Could not read processed image'));
        reader.readAsDataURL(blob);
    });
}

/** Crop the transparent PNG down to its visible content plus a small margin,
 *  so the cutout fills the PDF image box instead of floating in dead space. */
function cropToContent(img: HTMLImageElement): HTMLCanvasElement | null {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);

    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1;
    for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
            if (data[(y * canvas.width + x) * 4 + 3] > ALPHA_THRESHOLD) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }
    if (maxX === -1) return null; // fully transparent — keep original

    minX = Math.max(0, minX - CROP_PADDING_PX);
    minY = Math.max(0, minY - CROP_PADDING_PX);
    maxX = Math.min(canvas.width - 1, maxX + CROP_PADDING_PX);
    maxY = Math.min(canvas.height - 1, maxY + CROP_PADDING_PX);

    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const cropped = document.createElement('canvas');
    cropped.width = w;
    cropped.height = h;
    const cctx = cropped.getContext('2d');
    if (!cctx) return null;
    cctx.drawImage(canvas, minX, minY, w, h, 0, 0, w, h);
    return cropped;
}

export async function removeBackgroundImageLocal(imgUrl: string, onProgress?: CutoutProgress): Promise<PdfImageInfo> {
    const cached = cutoutCache.get(imgUrl);
    if (cached) return cached;

    const absoluteUrl = new URL(imgUrl, globalThis.location.href).href;

    const transparentBlob = await removeBackground(absoluteUrl, {
        progress: (key: string, current: number, total: number) => {
            if (!onProgress) return;
            if (key.startsWith('fetch:') && total > 0) {
                const pct = Math.round((current / total) * 100);
                onProgress(`Downloading AI model ${pct}%`);
            } else {
                onProgress('Removing background…');
            }
        },
    });
    onProgress?.('Removing background…');

    const rawDataUrl = await blobToDataURL(transparentBlob);
    const img = await loadImage(rawDataUrl);

    const croppedCanvas = cropToContent(img);
    const info: PdfImageInfo = croppedCanvas
        ? {
            dataUrl: croppedCanvas.toDataURL('image/png'),
            width: croppedCanvas.width,
            height: croppedCanvas.height,
            format: 'PNG',
        }
        : { dataUrl: rawDataUrl, width: img.width, height: img.height, format: 'PNG' };

    if (cutoutCache.size >= MAX_CACHE) {
        const firstKey = cutoutCache.keys().next().value;
        if (firstKey) cutoutCache.delete(firstKey);
    }
    cutoutCache.set(imgUrl, info);
    return info;
}
