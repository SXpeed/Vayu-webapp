import localforage from 'localforage';

/**
 * A picture of a PDF's first page, for catalog tiles that have no cover
 * image of their own. Drawn once per device with PDF.js (loaded only when
 * needed) and kept on the device, so later visits show it at once.
 */

/** Width of the drawn page, in pixels: plenty for a tile, small to keep. */
const THUMB_WIDTH_PX = 480;
/**
 * PDFs larger than this aren't downloaded just for a thumbnail — some older
 * generated catalogs run to 100MB+. The caller falls back to another picture.
 */
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const CACHE_PREFIX = 'catalog-thumb:';

/** One PDF at a time: each is downloaded and parsed in full. */
let queue: Promise<unknown> = Promise.resolve();
const oneAtATime = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
};

/** Same PDF asked for by several tiles: draw it once. */
const inFlight = new Map<string, Promise<Blob | null>>();

let pdfjsReady: Promise<typeof import('pdfjs-dist')> | null = null;
const loadPdfjs = () => {
    pdfjsReady ??= (async () => {
        const pdfjs = await import('pdfjs-dist');
        const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        return pdfjs;
    })();
    return pdfjsReady;
};

async function render(pdfUrl: string): Promise<Blob | null> {
    // Size first: the response headers arrive before the body.
    const controller = new AbortController();
    const res = await fetch(pdfUrl, { signal: controller.signal });
    if (!res.ok) return null;
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > MAX_PDF_BYTES) {
        controller.abort();
        return null;
    }
    const data = new Uint8Array(await res.arrayBuffer());

    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({ data }).promise;
    try {
        const page = await doc.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: THUMB_WIDTH_PX / base.width });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.fillStyle = '#ffffff'; // PDF pages are white unless they paint otherwise
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas, canvasContext: ctx, viewport }).promise;
        return await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    } finally {
        await doc.destroy();
    }
}

/**
 * The first page of the PDF as a JPEG, or null when it can't be had (too
 * large, not a PDF, offline). Cached per device by the PDF's address.
 */
export async function pdfFirstPage(pdfUrl: string): Promise<Blob | null> {
    const key = CACHE_PREFIX + pdfUrl;
    try {
        const cached = await localforage.getItem<Blob>(key);
        if (cached) return cached;
    } catch { /* storage unavailable: draw it anyway */ }

    let pending = inFlight.get(pdfUrl);
    if (!pending) {
        pending = oneAtATime(() => render(pdfUrl))
            .catch(err => {
                console.warn('Could not draw the PDF’s first page', err);
                return null;
            })
            .then(async blob => {
                if (blob) await localforage.setItem(key, blob).catch(() => undefined);
                return blob;
            })
            .finally(() => inFlight.delete(pdfUrl));
        inFlight.set(pdfUrl, pending);
    }
    return pending;
}
