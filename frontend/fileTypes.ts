// What an uploaded file really is, and how it may be served.
//
// Uploads are served from the app's own address, and the app keeps its
// sign-in token where page scripts can read it. So a file that a browser
// would *run* — HTML, SVG with script, XML — must never be delivered as
// itself: opening its link would run the uploader's code as the app and hand
// them the viewer's session. The name and type the browser claims for an
// upload are the uploader's to choose, so they are not trusted.
//
// Rules:
//   - On upload, the file's first bytes decide what it is. Real images and
//     PDFs keep their true type; anything claiming to be one but not is
//     stored as an opaque download.
//   - On delivery, only raster images, PDFs and plain text are shown in the
//     browser. SVG is shown inside a CSP sandbox (no script, no same-origin).
//     Everything else downloads, also inside a sandbox, with nosniff so the
//     browser never second-guesses the type. This covers files stored before
//     these rules too.

/** Types a browser displays without running anything. */
const INLINE = new Set([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/heic', 'image/heif',
    'application/pdf',
]);

/** For anything shown or downloaded that is not a plain image or PDF. */
export const SANDBOX_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";

/** How many leading bytes the checks look at. */
export const SNIFF_BYTES = 1024;

const PDF_MARK = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/** The real type of a file from its first bytes, when it is an image or a PDF. */
export function sniff(head: Uint8Array): string | null {
    const at = (offset: number, ...bytes: number[]) => bytes.every((b, i) => head[offset + i] === b);
    if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
    if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
    if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
    if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
    if (at(4, 0x66, 0x74, 0x79, 0x70)) { // ISO media "ftyp" box
        const brand = String.fromCharCode(...head.slice(8, 12));
        if (brand === 'avif' || brand === 'avis') return 'image/avif';
        if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
    }
    // PDF readers accept a little junk before the marker.
    for (let i = 0; i + PDF_MARK.length <= Math.min(head.length, SNIFF_BYTES); i++) {
        if (at(i, ...PDF_MARK)) return 'application/pdf';
    }
    return null;
}

const MIME = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;

/** The type to store an upload under: its real type, never a false image or PDF claim. */
export function storedContentType(claimed: string | undefined, head: Uint8Array): string {
    const real = sniff(head);
    if (real) return real;
    const type = (claimed ?? '').toLowerCase().split(';')[0].trim();
    // Claims to be an image or PDF but isn't one.
    if (INLINE.has(type)) return 'application/octet-stream';
    return MIME.test(type) ? type : 'application/octet-stream';
}

/** True when the bytes are an image a thumbnail can be. */
export function isRasterImage(head: Uint8Array): boolean {
    const real = sniff(head);
    return real !== null && real.startsWith('image/');
}

export interface Delivery {
    contentType: string;
    disposition: 'inline' | 'attachment';
    csp?: string;
}

/** How a stored file is handed to the browser. */
export function delivery(storedType: string | undefined): Delivery {
    const type = (storedType ?? '').toLowerCase().split(';')[0].trim();
    if (INLINE.has(type)) return { contentType: type, disposition: 'inline' };
    if (type === 'text/plain') return { contentType: 'text/plain; charset=utf-8', disposition: 'inline', csp: SANDBOX_CSP };
    if (type === 'image/svg+xml') return { contentType: type, disposition: 'inline', csp: SANDBOX_CSP };
    return { contentType: 'application/octet-stream', disposition: 'attachment', csp: SANDBOX_CSP };
}

/** A lower-case extension of 1–8 letters or digits, or '' — never path or header characters. */
export function safeExtension(name: string | undefined): string {
    const ext = (name ?? '').split('.').pop()?.toLowerCase() ?? '';
    return /^[a-z0-9]{1,8}$/.test(ext) && ext !== (name ?? '').toLowerCase() ? ext : '';
}

/** The last part of a storage key, safe to put in a Content-Disposition header. */
export function downloadName(key: string): string {
    const last = key.split('/').pop() || 'file';
    return last.replace(/__thumb$/, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'file';
}
