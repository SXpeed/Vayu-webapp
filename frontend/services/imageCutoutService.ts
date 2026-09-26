import { preload, removeBackground } from '@imgly/background-removal';

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
 *
 * Order: the PDF generator calls preloadCutoutModel() first, so the model is
 * downloaded and started before any photo is processed.
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
/** Download progress (0–1) while the model is being fetched by preloadCutoutModel. */
let currentDownload: ((fraction: number) => void) | undefined;

/**
 * The model file is fetched first, then the runtime's own files; the model is
 * by far the largest, so it counts for most of the bar. Everything seen so
 * far is kept, so the fraction only goes up.
 */
const downloads = new Map<string, { current: number; total: number }>();
const MODEL_SHARE = 0.85;
const downloadFraction = (): number => {
    let model = 0;
    let rest = { current: 0, total: 0 };
    for (const [key, d] of downloads) {
        if (d.total <= 0) continue;
        if (key.includes('/models/')) model = d.current / d.total;
        else rest = { current: rest.current + d.current, total: rest.total + d.total };
    }
    return MODEL_SHARE * model + (1 - MODEL_SHARE) * (rest.total ? rest.current / rest.total : 0);
};

const forwardProgress = (key: string, current: number, total: number) => {
    if (key.startsWith('fetch:')) {
        downloads.set(key, { current, total });
        const fraction = downloadFraction();
        currentDownload?.(fraction);
        currentProgress?.(`Downloading AI model ${Math.round(fraction * 100)}%`);
    } else {
        currentProgress?.('Removing background…');
    }
};

/**
 * Try the GPU until a GPU run fails once; then stay on the CPU for this
 * session. Computers only: on phones and tablets the GPU shares the phone's
 * memory, and the GPU model needed well over a gigabyte, which got the app
 * killed after a few pages (reported 2026-09-26); Android's GPUs also gave
 * worse cutouts. Phones use the CPU on every core (cross-origin isolation).
 */
let gpuUsable = !/Android|iPhone|iPad|Mobile/i.test(globalThis.navigator?.userAgent ?? '')
    // iPadOS reports itself as a Mac; a touch screen gives it away.
    && !((globalThis.navigator?.maxTouchPoints ?? 0) > 1 && /Macintosh/.test(globalThis.navigator?.userAgent ?? ''));

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

/**
 * Download and start the model before any photo is processed. Resolves when
 * it is ready (at once if it already is); `onFraction` gets 0–1 while the
 * files download. Throws if the model can't be loaded on either device.
 */
export const preloadCutoutModel = (onFraction?: (fraction: number) => void): Promise<void> => exclusive(async () => {
    currentDownload = onFraction;
    try {
        if (gpuUsable) {
            try {
                await preload({ progress: forwardProgress, device: 'gpu' });
                return;
            } catch (e) {
                gpuUsable = false;
                console.warn('Starting background removal on the GPU failed; using the CPU from now on.', e);
            }
        }
        await preload({ progress: forwardProgress, device: 'cpu' });
    } finally {
        onFraction?.(1);
        currentDownload = undefined;
    }
});

/** Cutouts, kept for the worker's lifetime so regenerating is quick. Few: each is a large PNG held in memory. */
const cutoutCache = new Map<string, Blob>();
const MAX_CACHE = 6;

/**
 * The longest side a cutout is made at. A cutout fills at most the 206mm
 * image box, so 2000px is still over 240 dpi. Working on the full photo
 * (12 megapixels and up from a phone camera) held several copies of 48MB+
 * each and was what crashed phones on catalogs of more than a few pages.
 */
export const CUTOUT_MAX_EDGE_PX = 2000;

/**
 * The photo at no more than `maxEdge` on its longest side, EXIF rotation
 * applied, as a JPEG the model can read. Smaller photos are returned as
 * they are. Same picture, only smaller: the product keeps its framing.
 */
async function withinSize(photo: Blob, maxEdge: number): Promise<Blob> {
    const bitmap = await createImageBitmap(photo, { imageOrientation: 'from-image' });
    try {
        const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
        if (scale === 1) return photo;
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Failed to get canvas context');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, 0, w, h);
        return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
    } finally {
        bitmap.close();
    }
}

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
 * photo's own framing and proportions (nothing trimmed), at most
 * CUTOUT_MAX_EDGE_PX on its longest side.
 */
export async function removeBackgroundToBlob(imgUrl: string, onProgress?: CutoutProgress): Promise<Blob> {
    const cached = cutoutCache.get(imgUrl);
    if (cached) return cached;

    // In a worker, location is the worker script's URL — same origin, so a
    // root-relative /api/files/… path still resolves to the right place.
    const absoluteUrl = new URL(imgUrl, globalThis.location.href).href;
    const res = await fetch(absoluteUrl);
    if (!res.ok) throw new Error(`Image request failed (${res.status})`);
    // The model and everything after it work on a page-sized copy.
    const original = await withinSize(await res.blob(), CUTOUT_MAX_EDGE_PX);

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
