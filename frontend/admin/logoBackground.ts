// Takes the background out of a logo, in the browser, before it is uploaded.
//
// Logos almost always sit on a flat or gently graded background (the Vayu one
// is gold lettering on a near-black glow). That is a colour-to-alpha job, not
// a photo cut-out: the photo model the catalog uses is built for objects and
// chews thin lettering. Here:
//
//   1. the background colour is the median of the image's border pixels;
//   2. each pixel's opacity is how far it is from that colour, relative to
//      how far it could be (the colour-to-alpha measure), ramped so faint
//      glows and compression noise drop out and the logo body is fully solid;
//   3. partly transparent edge pixels get the background taken back out of
//      their colour, so lettering has no dark (or light) fringe on any theme;
//   4. the empty margin is trimmed, keeping a little breathing room.
//
// The result is a PNG under the server's 1 MB / 64–2048 px limits.

export interface LogoAnalysis {
    /** Already transparent round the edge: nothing to remove. */
    transparent: boolean;
    /** Share of the border close to the background colour — low means busy. */
    uniformity: number;
}

export interface ProcessedLogo {
    blob: Blob;
    url: string;
    width: number;
    height: number;
}

const MAX_SIDE = 1024;
const MIN_SIDE = 64;
const MAX_BYTES = 1024 * 1024;
/** Opacity (0–1) below which a pixel counts as background. */
const ALPHA_FLOOR = 0.18;

async function load(file: Blob): Promise<ImageData> {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    return ctx.getImageData(0, 0, w, h);
}

/** Every pixel index on a band `depth` pixels wide round the edge. */
function borderIndices(w: number, h: number, depth: number): number[] {
    const out: number[] = [];
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (x < depth || y < depth || x >= w - depth || y >= h - depth) out.push(y * w + x);
        }
    }
    return out;
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function backgroundOf(img: ImageData): { bg: [number, number, number]; analysis: LogoAnalysis } {
    const { data, width: w, height: h } = img;
    const border = borderIndices(w, h, Math.max(1, Math.round(Math.min(w, h) * 0.02)));
    const transparentShare = border.filter(i => data[i * 4 + 3] < 16).length / border.length;
    const opaque = border.filter(i => data[i * 4 + 3] >= 16);
    const bg: [number, number, number] = [0, 1, 2].map(c => median(opaque.map(i => data[i * 4 + c]))) as [number, number, number];
    const close = opaque.filter(i => Math.hypot(data[i * 4] - bg[0], data[i * 4 + 1] - bg[1], data[i * 4 + 2] - bg[2]) < 48).length;
    return {
        bg,
        analysis: { transparent: transparentShare > 0.5, uniformity: opaque.length ? close / opaque.length : 1 },
    };
}

export async function analyzeLogo(file: Blob): Promise<LogoAnalysis> {
    return backgroundOf(await load(file)).analysis;
}

/** The colour-to-alpha measure: 0 = exactly the background, 1 = as far from it as a colour can be. */
function rawAlpha(r: number, g: number, b: number, bg: [number, number, number]): number {
    let a = 0;
    const c = [r, g, b];
    for (let k = 0; k < 3; k++) {
        const d = c[k] - bg[k];
        const room = d > 0 ? 255 - bg[k] : bg[k];
        if (room > 0) a = Math.max(a, Math.abs(d) / room);
    }
    return a;
}

const smoothstep = (lo: number, hi: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
    return t * t * (3 - 2 * t);
};

function removeBackground(img: ImageData): ImageData {
    const { data } = img;
    const { bg } = backgroundOf(img);
    const n = data.length / 4;
    const raw = new Float32Array(n);
    const strong: number[] = [];
    for (let i = 0; i < n; i++) {
        const a = rawAlpha(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], bg) * (data[i * 4 + 3] / 255);
        raw[i] = a;
        if (a > ALPHA_FLOOR) strong.push(a);
    }
    // "Fully solid" is relative to how far the logo's own colours sit from the
    // background: gold on black never reaches 1 on the raw measure.
    strong.sort((a, b) => a - b);
    const body = strong.length ? strong[Math.floor(strong.length * 0.9)] : 1;
    const solidAt = Math.max(ALPHA_FLOOR + 0.1, body * 0.6);

    const out = new ImageData(img.width, img.height);
    const o = out.data;
    for (let i = 0; i < n; i++) {
        const a = smoothstep(ALPHA_FLOOR, solidAt, raw[i]);
        if (a <= 0) continue;
        for (let k = 0; k < 3; k++) {
            // Un-mix the background from edge pixels; solid pixels keep their colour.
            const c = data[i * 4 + k];
            o[i * 4 + k] = a >= 1 ? c : Math.min(255, Math.max(0, Math.round((c - bg[k] * (1 - a)) / a)));
        }
        o[i * 4 + 3] = Math.round(a * 255);
    }
    return out;
}

/** Trims to the visible logo plus a margin, padded up to the minimum size. */
function trim(img: ImageData): HTMLCanvasElement {
    const { data, width: w, height: h } = img;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (data[(y * w + x) * 4 + 3] > 12) {
                if (x < x0) x0 = x;
                if (x > x1) x1 = x;
                if (y < y0) y0 = y;
                if (y > y1) y1 = y;
            }
        }
    }
    if (x1 < 0) { x0 = 0; y0 = 0; x1 = w - 1; y1 = h - 1; } // nothing visible: keep it all
    const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.06);
    const cw = Math.max(MIN_SIDE, x1 - x0 + 1 + pad * 2);
    const ch = Math.max(MIN_SIDE, y1 - y0 + 1 + pad * 2);
    const source = canvasOf(img);
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    canvas.getContext('2d')!.drawImage(source, x0, y0, x1 - x0 + 1, y1 - y0 + 1,
        Math.round((cw - (x1 - x0 + 1)) / 2), Math.round((ch - (y1 - y0 + 1)) / 2), x1 - x0 + 1, y1 - y0 + 1);
    return canvas;
}

function canvasOf(img: ImageData): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    canvas.getContext('2d')!.putImageData(img, 0, 0);
    return canvas;
}

const toPng = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not encode the image.'))), 'image/png'));

/**
 * Prepares a logo for upload: optionally without its background, trimmed,
 * as a PNG within the upload limits.
 */
export async function prepareLogo(file: Blob, withoutBackground: boolean): Promise<ProcessedLogo> {
    const img = await load(file);
    // Kept as-is (only scaled) when its background stays: trimming would add
    // a transparent margin round an opaque picture.
    let canvas = withoutBackground ? trim(removeBackground(img)) : canvasOf(img);
    let blob = await toPng(canvas);
    // Shrink until it fits the 1 MB limit (never below the minimum size).
    while (blob.size > MAX_BYTES && Math.min(canvas.width, canvas.height) * 0.8 >= MIN_SIDE) {
        const smaller = document.createElement('canvas');
        smaller.width = Math.round(canvas.width * 0.8);
        smaller.height = Math.round(canvas.height * 0.8);
        smaller.getContext('2d')!.drawImage(canvas, 0, 0, smaller.width, smaller.height);
        canvas = smaller;
        blob = await toPng(canvas);
    }
    return { blob, url: URL.createObjectURL(blob), width: canvas.width, height: canvas.height };
}
