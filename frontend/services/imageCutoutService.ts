import { removeBackground } from '@imgly/background-removal';

/**
 * Background removal for catalog PDFs.
 *
 * Runs inside the catalog-PDF Web Worker, never on the page: on the main
 * thread each image froze the UI for seconds. So nothing here may touch the
 * DOM — decoding goes through createImageBitmap and drawing through
 * OffscreenCanvas.
 *
 * Speed: the model runs on the GPU (WebGPU) where the device has one; the
 * library falls back to the CPU by itself when it doesn't. On the CPU it
 * uses every core when the app is cross-origin isolated (see the app's
 * _headers in scripts/build-sites.mjs) and a single core otherwise.
 */

/** Progress messages ("Downloading AI model 45%", "Removing background…"). */
export type CutoutProgress = (message: string) => void;

// Let the library resolve its own CDN URL based on its internal PACKAGE_VERSION.
// Do NOT hardcode publicPath — the library already uses the correct default.

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

/** Try the GPU until a GPU run fails once; then stay on the CPU for this session. */
let gpuUsable = true;

/**
 * One model run at a time. Each run already uses the whole GPU (or every CPU
 * core), and the progress forwarding above assumes a single image in flight;
 * the PDF generator still prepares other pages' photos alongside.
 */
let modelQueue: Promise<unknown> = Promise.resolve();
const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const next = modelQueue.then(task, task);
    modelQueue = next.catch(() => undefined);
    return next;
};

const runModel = async (image: Blob, onProgress?: CutoutProgress): Promise<Blob> => exclusive(async () => {
    currentProgress = onProgress;
    if (gpuUsable) {
        try {
            return await removeBackground(image, { progress: forwardProgress, device: 'gpu' });
        } catch (e) {
            gpuUsable = false;
            console.warn('Background removal on the GPU failed; using the CPU from now on.', e);
        }
    }
    return removeBackground(image, { progress: forwardProgress, device: 'cpu' });
});

/** Cutouts, kept for the worker's lifetime so regenerating is quick. */
const cutoutCache = new Map<string, Blob>();
const MAX_CACHE = 20;

/** How far apart two aspect ratios may be and still count as the same frame. */
const ASPECT_TOLERANCE = 0.01;

/**
 * Put the cutout on the photo's own canvas: same width, height and framing.
 *
 * The product must keep exactly the size and position it has in the original
 * photo — the page fits whatever image it gets into the same box, so any
 * change to the canvas shows up as the product moving or zooming. (Cropping
 * the cutout to the product, as this used to, made it look zoomed in.)
 *
 * The library returns the whole frame, normally at the source size. A
 * uniformly resized frame is scaled back onto the original canvas; anything
 * else (a different shape: cropped or rotated) is refused rather than
 * stretched, and the caller falls back to the original photo.
 */
async function onOriginalCanvas(cutout: Blob, original: Blob): Promise<Blob> {
    // `from-image` honours EXIF rotation, exactly as the page image is decoded.
    const [cut, photo] = await Promise.all([
        createImageBitmap(cutout, { imageOrientation: 'from-image' }),
        createImageBitmap(original, { imageOrientation: 'from-image' }),
    ]);
    try {
        if (cut.width === photo.width && cut.height === photo.height) return cutout;
        const sameShape = Math.abs(cut.width / cut.height - photo.width / photo.height) <= ASPECT_TOLERANCE * (photo.width / photo.height);
        if (!sameShape) {
            throw new Error(`Cutout is ${cut.width}×${cut.height}, the photo ${photo.width}×${photo.height}: not the same frame.`);
        }
        const canvas = new OffscreenCanvas(photo.width, photo.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Failed to get canvas context');
        ctx.drawImage(cut, 0, 0, photo.width, photo.height);
        return await canvas.convertToBlob({ type: 'image/png' });
    } finally {
        cut.close();
        photo.close();
    }
}

/**
 * Remove the background from an image; returns a transparent PNG with the
 * photo's own dimensions and framing (nothing trimmed, nothing rescaled).
 */
export async function removeBackgroundToBlob(imgUrl: string, onProgress?: CutoutProgress): Promise<Blob> {
    const cached = cutoutCache.get(imgUrl);
    if (cached) return cached;

    // In a worker, location is the worker script's URL — same origin, so a
    // root-relative /api/files/… path still resolves to the right place.
    const absoluteUrl = new URL(imgUrl, globalThis.location.href).href;
    const res = await fetch(absoluteUrl);
    if (!res.ok) throw new Error(`Image request failed (${res.status})`);
    const original = await res.blob();

    const transparentBlob = await runModel(original, onProgress);
    onProgress?.('Removing background…');

    const result = await onOriginalCanvas(transparentBlob, original);

    if (cutoutCache.size >= MAX_CACHE) {
        const firstKey = cutoutCache.keys().next().value;
        if (firstKey) cutoutCache.delete(firstKey);
    }
    cutoutCache.set(imgUrl, result);
    return result;
}
