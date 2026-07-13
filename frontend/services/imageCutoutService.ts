import { removeBackground } from "@imgly/background-removal";

/**
 * Produces "cutout" product images for PDF themes that place the product on
 * their own page background (themes 4 & 5): removes the photo background with
 * @imgly/background-removal (runs fully in-browser), then crops the resulting
 * transparent PNG down to the visible content plus a small margin.
 */

export interface CutoutImage {
    dataUrl: string;
    width: number;
    height: number;
    format: 'PNG';
}

const IMGLY_CONFIG = {
    publicPath: "https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/",
    debug: false,
    output: {
        format: "image/png",
        quality: 1,
    },
} as const;

const CROP_PADDING_PX = 30;
const ALPHA_THRESHOLD = 10;

// Background removal takes seconds per image, so cache results: regenerating
// a PDF after tweaking studio options reuses them. Upload URLs are immutable
// (unique key per upload), so entries never go stale. Bounded FIFO to keep
// memory in check on mobile.
const MAX_CACHE_ENTRIES = 24;
const cutoutCache = new Map<string, CutoutImage>();

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const image = new Image();

        image.onload = () => {
            URL.revokeObjectURL(url);
            resolve(image);
        };

        image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("Image could not be loaded."));
        };

        image.src = url;
    });
}

function canvasToBlob(canvas: HTMLCanvasElement, type = "image/png", quality = 1): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            (blob) => {
                if (blob) {
                    resolve(blob);
                } else {
                    reject(new Error("Canvas export failed."));
                }
            },
            type,
            quality
        );
    });
}

function blobToDataURL(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("Could not convert blob to data URL."));

        reader.readAsDataURL(blob);
    });
}

/** Find the bounding box of non-transparent pixels and crop to it (plus padding). */
async function cropTransparentPNG(blob: Blob, padding = CROP_PADDING_PX): Promise<Blob> {
    const image = await loadImageFromBlob(blob);

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return blob;

    canvas.width = image.width;
    canvas.height = image.height;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
            const index = (y * canvas.width + x) * 4;
            const alpha = data[index + 3];

            if (alpha > ALPHA_THRESHOLD) {
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
            }
        }
    }

    // Fully transparent image — nothing to crop to.
    if (maxX === -1 || maxY === -1) {
        return blob;
    }

    minX = Math.max(0, minX - padding);
    minY = Math.max(0, minY - padding);
    maxX = Math.min(canvas.width - 1, maxX + padding);
    maxY = Math.min(canvas.height - 1, maxY + padding);

    const croppedWidth = maxX - minX + 1;
    const croppedHeight = maxY - minY + 1;

    const croppedCanvas = document.createElement("canvas");
    const croppedCtx = croppedCanvas.getContext("2d");
    if (!croppedCtx) return blob;

    croppedCanvas.width = croppedWidth;
    croppedCanvas.height = croppedHeight;

    croppedCtx.clearRect(0, 0, croppedWidth, croppedHeight);

    croppedCtx.drawImage(
        canvas,
        minX,
        minY,
        croppedWidth,
        croppedHeight,
        0,
        0,
        croppedWidth,
        croppedHeight
    );

    return canvasToBlob(croppedCanvas, "image/png");
}

export async function removeBackgroundAndCrop(imgUrl: string): Promise<CutoutImage> {
    const cached = cutoutCache.get(imgUrl);
    if (cached) return cached;

    const transparentBlob = await removeBackground(imgUrl, IMGLY_CONFIG);
    const croppedBlob = await cropTransparentPNG(transparentBlob);
    const [dataUrl, finalImage] = await Promise.all([
        blobToDataURL(croppedBlob),
        loadImageFromBlob(croppedBlob),
    ]);

    const result: CutoutImage = {
        dataUrl,
        width: finalImage.width,
        height: finalImage.height,
        format: 'PNG',
    };

    if (cutoutCache.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = cutoutCache.keys().next().value;
        if (oldestKey !== undefined) cutoutCache.delete(oldestKey);
    }
    cutoutCache.set(imgUrl, result);

    return result;
}
