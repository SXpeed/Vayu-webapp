import { removeBackground } from '@imgly/background-removal';

/**
 * Background removal for catalog PDFs.
 *
 * Runs inside the catalog-PDF Web Worker, never on the page: the model runs
 * on the CPU as single-threaded WASM, and on the main thread each image froze
 * the UI for seconds. So nothing here may touch the DOM — decoding goes
 * through createImageBitmap and cropping through OffscreenCanvas.
 */

/** Progress messages ("Downloading AI model 45%", "Removing background…"). */
export type CutoutProgress = (message: string) => void;

// Let the library resolve its own CDN URL based on its internal PACKAGE_VERSION.
// Do NOT hardcode publicPath — the library already uses the correct default.

const CROP_PADDING_PX = 30;
const ALPHA_THRESHOLD = 10;

/**
 * The library memoises its setup keyed on JSON.stringify(config) — which drops
 * functions — so it keeps calling the progress callback from the *first*
 * image for every later one (image 3 reported itself as "Image 1"). All
 * progress therefore goes through one stable function that forwards to the
 * image currently being processed. Images are processed one at a time.
 */
let currentProgress: CutoutProgress | undefined;
const forwardProgress = (key: string, current: number, total: number) => {
    if (!currentProgress) return;
    if (key.startsWith('fetch:') && total > 0) {
        const pct = Math.round((current / total) * 100);
        currentProgress(`Downloading AI model ${pct}%`);
    } else {
        currentProgress('Removing background…');
    }
};

/** Cropped cutouts, kept for the worker's lifetime so regenerating is quick. */
const cutoutCache = new Map<string, Blob>();
const MAX_CACHE = 20;

interface Bounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/** Bounding box of pixels more opaque than ALPHA_THRESHOLD; null when none are. */
function findOpaqueBounds(data: Uint8ClampedArray, width: number, height: number): Bounds | null {
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
        const rowStart = y * width;
        for (let x = 0; x < width; x++) {
            if (data[(rowStart + x) * 4 + 3] <= ALPHA_THRESHOLD) continue;
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
        }
    }
    return maxX === -1 ? null : { minX, minY, maxX, maxY };
}

/** Crop the transparent image down to its visible content plus a small margin,
 *  so the cutout fills the PDF image box instead of floating in dead space. */
async function cropToContent(image: ImageBitmap): Promise<Blob | null> {
    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0);

    const bounds = findOpaqueBounds(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
    if (!bounds) return null; // fully transparent — keep original

    const minX = Math.max(0, bounds.minX - CROP_PADDING_PX);
    const minY = Math.max(0, bounds.minY - CROP_PADDING_PX);
    const maxX = Math.min(canvas.width - 1, bounds.maxX + CROP_PADDING_PX);
    const maxY = Math.min(canvas.height - 1, bounds.maxY + CROP_PADDING_PX);

    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const cropped = new OffscreenCanvas(w, h);
    const cctx = cropped.getContext('2d');
    if (!cctx) return null;
    cctx.drawImage(canvas, minX, minY, w, h, 0, 0, w, h);
    return cropped.convertToBlob({ type: 'image/png' });
}

/** Remove the background from an image; returns the cropped transparent PNG. */
export async function removeBackgroundToBlob(imgUrl: string, onProgress?: CutoutProgress): Promise<Blob> {
    const cached = cutoutCache.get(imgUrl);
    if (cached) return cached;

    // In a worker, location is the worker script's URL — same origin, so a
    // root-relative /api/files/… path still resolves to the right place.
    const absoluteUrl = new URL(imgUrl, globalThis.location.href).href;

    currentProgress = onProgress;
    const transparentBlob = await removeBackground(absoluteUrl, { progress: forwardProgress });
    onProgress?.('Removing background…');

    const image = await createImageBitmap(transparentBlob);
    const cropped = await cropToContent(image);
    image.close();
    const result = cropped ?? transparentBlob;

    if (cutoutCache.size >= MAX_CACHE) {
        const firstKey = cutoutCache.keys().next().value;
        if (firstKey) cutoutCache.delete(firstKey);
    }
    cutoutCache.set(imgUrl, result);
    return result;
}
