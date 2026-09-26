import { jsPDF } from 'jspdf';
import type { Artwork, CatalogTheme, PdfOptions } from '../../types';
import {
    planCatalogPages, getThemePalette, ThemePalette, logoBox, letterMark, type PlannedPage,
    THEME_STYLES, effectiveGradient, effectiveCutout, effectiveShadow,
} from './catalogLayout';

/* ------------------------------------------------------------------ */
/*  Catalog PDF generator.                                             */
/*                                                                     */
/*  Runs inside a Web Worker (catalogPdf.worker.ts), so none of it can  */
/*  freeze the page: this used to run on the main thread, and a big     */
/*  catalog locked the whole UI for the length of the build. Nothing    */
/*  here may touch the DOM — images are decoded with createImageBitmap  */
/*  and drawn on OffscreenCanvas. The page-layout calls further down    */
/*  are unchanged from when this code lived in CatalogsView.            */
/* ------------------------------------------------------------------ */

type Ctx2D = OffscreenCanvasRenderingContext2D;

/** Clip the canvas context to a rounded-corner path. */
const applyRoundedCorners = (ctx: Ctx2D, width: number, height: number) => {
    const rad = Math.max(width, height) * 0.02;
    ctx.beginPath();
    ctx.moveTo(rad, 0);
    ctx.lineTo(width - rad, 0);
    ctx.quadraticCurveTo(width, 0, width, rad);
    ctx.lineTo(width, height - rad);
    ctx.quadraticCurveTo(width, height, width - rad, height);
    ctx.lineTo(rad, height);
    ctx.quadraticCurveTo(0, height, 0, height - rad);
    ctx.lineTo(0, rad);
    ctx.quadraticCurveTo(0, 0, rad, 0);
    ctx.closePath();
    ctx.clip();
};

/**
 * Photos go into the PDF at no more than this on their longest side (about
 * 300 dpi across the 206mm image box). They are scaled once, right after
 * decoding: drawing a 12-megapixel photo at full size first held several
 * full-size copies at a time and crashed phones on longer catalogs.
 */
const PHOTO_MAX_EDGE_PX = 2500;

/** Same test the generator always used to decide PNG vs JPEG output. */
const urlLooksPng = (url: string): boolean =>
    url.toLowerCase().includes('.png') || url.toLowerCase().startsWith('data:image/png');

/** An image ready for jsPDF: encoded bytes plus the alias to register it under. */
export interface PdfImageInfo {
    data: Uint8Array;
    width: number;
    height: number;
    format: 'PNG' | 'JPEG';
    /**
     * Explicit alias. Without one, jsPDF invents an alias by hashing every
     * byte of the image — a measurable cost per page on multi-MB photos.
     * Aliases are keyed on the source and its processing, so an identical
     * image used twice is still embedded once.
     */
    alias: string;
    /** A background-removed cutout (never framed). */
    isCutout?: boolean;
}

/**
 * Fetch an image, retrying transient failures. A dropped connection or a 5xx
 * used to leave that artwork's page silently blank — seen in testing, where
 * one of four photos failed once and loaded fine on the next attempt.
 */
const fetchImage = async (url: string, attempts = 3): Promise<Blob> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const res = await fetch(url);
            if (res.ok) return await res.blob();
            lastError = new Error(`Image request failed (${res.status})`);
            // 4xx won't fix itself on a retry.
            if (res.status < 500) break;
        } catch (e) {
            lastError = e; // network error — worth retrying
        }
        if (attempt < attempts) await new Promise(r => setTimeout(r, 400 * attempt));
    }
    throw lastError;
};

const decode = async (source: string | Blob): Promise<ImageBitmap> => {
    const blob = typeof source === 'string' ? await fetchImage(source) : source;
    // `from-image` honours EXIF rotation, as <img> did.
    return createImageBitmap(blob, { imageOrientation: 'from-image' });
};

const encode = async (canvas: OffscreenCanvas, type: 'image/png' | 'image/jpeg'): Promise<Uint8Array> =>
    new Uint8Array(await (await canvas.convertToBlob({ type, quality: 0.95 })).arrayBuffer());

/** Where a photo of this shape sits in the image box: fitted, centred. Millimetres. */
const fitImageBox = (imgW: number, imgH: number, imgBoxH: number) => {
    const imgX = 2, imgY = 2, imgBoxW = PAGE_W - 4;
    const imgRatio = imgW / imgH;
    const w = imgRatio > imgBoxW / imgBoxH ? imgBoxW : imgBoxH * imgRatio;
    const h = imgRatio > imgBoxW / imgBoxH ? imgBoxW / imgRatio : imgBoxH;
    return { x: imgX + (imgBoxW - w) / 2, y: imgY + (imgBoxH - h) / 2, w, h };
};

/**
 * What a cutout is laid onto: the plain page colour, or — on a gradient page
 * — the exact strip of the page's backdrop that lies behind the photo, so the
 * result is the same picture as a transparent PNG over the page, at a
 * fraction of the size.
 */
type Matte =
    | { kind: 'colour'; rgb: [number, number, number] }
    | { kind: 'backdrop'; bitmap: ImageBitmap; imgBoxH: number };

const paintMatte = (ctx: Ctx2D, matte: Matte | null, width: number, height: number) => {
    if (matte?.kind === 'backdrop') {
        // The backdrop image covers (-0.5, -0.5)–(210.5, 297.5)mm; see drawPageBackground.
        const box = fitImageBox(width, height, matte.imgBoxH);
        const pxPerMmX = matte.bitmap.width / (PAGE_W + 1);
        const pxPerMmY = matte.bitmap.height / (PAGE_H + 1);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(
            matte.bitmap,
            (box.x + 0.5) * pxPerMmX, (box.y + 0.5) * pxPerMmY, box.w * pxPerMmX, box.h * pxPerMmY,
            0, 0, width, height,
        );
        return;
    }
    ctx.fillStyle = matte ? `rgb(${matte.rgb[0]}, ${matte.rgb[1]}, ${matte.rgb[2]})` : '#ffffff';
    ctx.fillRect(0, 0, width, height);
};

/**
 * Decode an image, optionally round its corners / add a drop shadow, scale it
 * down for the page, and re-encode it — PNG for logos and transparent images,
 * JPEG otherwise.
 */
const prepareImage = async (
    source: string | Blob,
    isPng: boolean,
    alias: string,
    radiusPx = 0,
    isLogo = false,
    addShadow = false,
    /** What a transparent image is laid onto, so it can be a small JPEG. */
    matte: Matte | null = null,
): Promise<PdfImageInfo> => {
    const bitmap = await decode(source);
    // Logos keep their own size; photos are scaled down once, here.
    const scale = isLogo ? 1 : Math.min(1, PHOTO_MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
    // Truncate like assigning to <canvas>.width did.
    const width = Math.max(1, Math.trunc(bitmap.width * scale));
    const height = Math.max(1, Math.trunc(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        bitmap.close();
        throw new Error('Failed to get canvas context');
    }

    const usePng = isLogo || (isPng && !matte);
    if (!usePng) {
        // JPEG has no transparency: what shows through is what the page has
        // behind the photo (a cutout), or white (rounded-off corners).
        paintMatte(ctx, matte, width, height);
    }
    if (radiusPx > 0) {
        applyRoundedCorners(ctx, width, height);
    }
    if (addShadow) {
        // Sized for the photo's own pixels, as before it was scaled.
        ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
        ctx.shadowBlur = 15 * scale;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 8 * scale;
    }

    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    return {
        data: await encode(canvas, usePng ? 'image/png' : 'image/jpeg'),
        width,
        height,
        format: usePng ? 'PNG' : 'JPEG',
        alias,
    };
};

// ---------------------------------------------------------------------------
// PDF generation helpers (module-level to keep cognitive complexity low)
// ---------------------------------------------------------------------------

const PAGE_W = 210;
const PAGE_H = 297;

/** Paint an 840×1188 page-background canvas and return it as JPEG bytes. */
const paintBackground = async (paint: (ctx: Ctx2D) => void): Promise<Uint8Array | null> => {
    const canvas = new OffscreenCanvas(840, 1188);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    paint(ctx);
    return encode(canvas, 'image/jpeg');
};

const generateDynamicBackground = async (bg: [number, number, number], style: NonNullable<PdfOptions['gradientStyle']>): Promise<Uint8Array | null> => {
    if (style === 'Solid') return null;

    return paintBackground(ctx => {
        const baseColor = `rgb(${bg[0]}, ${bg[1]}, ${bg[2]})`;
        const lighterColor = `rgb(${Math.min(255, bg[0] + 30)}, ${Math.min(255, bg[1] + 30)}, ${Math.min(255, bg[2] + 30)})`;
        const darkerColor = `rgb(${Math.max(0, bg[0] - 20)}, ${Math.max(0, bg[1] - 20)}, ${Math.max(0, bg[2] - 20)})`;
        const deeperColor = `rgb(${Math.max(0, bg[0] - 45)}, ${Math.max(0, bg[1] - 45)}, ${Math.max(0, bg[2] - 45)})`;

        if (style === 'Linear') {
            const grad = ctx.createLinearGradient(0, 0, 0, 1188);
            grad.addColorStop(0, lighterColor);
            grad.addColorStop(1, darkerColor);
            ctx.fillStyle = grad;
        } else if (style === 'Radial') {
            const grad = ctx.createRadialGradient(420, 594, 0, 420, 594, 700);
            grad.addColorStop(0, lighterColor);
            grad.addColorStop(1, darkerColor);
            ctx.fillStyle = grad;
        } else if (style === 'Diagonal') {
            // Corner-to-corner sweep: light top-left to dark bottom-right.
            const grad = ctx.createLinearGradient(0, 0, 840, 1188);
            grad.addColorStop(0, lighterColor);
            grad.addColorStop(0.5, baseColor);
            grad.addColorStop(1, darkerColor);
            ctx.fillStyle = grad;
        } else if (style === 'Vignette') {
            // Base color in the middle, edges falling into deep shadow.
            const grad = ctx.createRadialGradient(420, 594, 200, 420, 594, 1150);
            grad.addColorStop(0, baseColor);
            grad.addColorStop(0.65, darkerColor);
            grad.addColorStop(1, deeperColor);
            ctx.fillStyle = grad;
        } else if (style === 'Spotlight') {
            // Light falling from the top of the page, fading into shadow below.
            const brighterColor = `rgb(${Math.min(255, bg[0] + 50)}, ${Math.min(255, bg[1] + 50)}, ${Math.min(255, bg[2] + 50)})`;
            const grad = ctx.createRadialGradient(420, 120, 0, 420, 120, 1300);
            grad.addColorStop(0, brighterColor);
            grad.addColorStop(0.45, baseColor);
            grad.addColorStop(1, deeperColor);
            ctx.fillStyle = grad;
        }

        ctx.fillRect(0, 0, 840, 1188);
    });
};

/** A background image shared by every page of the catalog. */
interface PageBackground {
    data: Uint8Array;
    alias: string;
}

/**
 * Which background image the pages get, rendered once per catalog. It used
 * to be re-rendered and re-encoded for every single page, although every page
 * uses the same one.
 */
const resolvePageBackground = async (themeId: CatalogTheme, palette: ThemePalette, options: PdfOptions): Promise<PageBackground | null> => {
    // The chosen gradient, or the theme's own backdrop (catalogLayout decides,
    // for the preview too).
    const style = effectiveGradient(themeId, options);
    if (!style) return null;
    const data = await generateDynamicBackground(palette.bg, style);
    return data ? { data, alias: `bg_${style}_${palette.bg.join('')}_${Math.round(PAGE_H)}` } : null;
};

const drawPageBackground = (doc: jsPDF, background: PageBackground | null, palette: ThemePalette, pageH: number) => {
    // Solid fill first, then bleed the background image 0.5mm past every page
    // edge — placing it at exactly the page size leaves a white hairline at the
    // page edge in most PDF viewers due to rasterization rounding.
    doc.setFillColor(...palette.bg);
    doc.rect(0, 0, PAGE_W, pageH, 'F');

    if (background) {
        doc.addImage(background.data, 'JPEG', -0.5, -0.5, PAGE_W + 1, pageH + 1, background.alias, 'FAST');
    }
};

/** Cutout is on by default for theme 5 (Gradient Cutout); the studio checkbox
 *  overrides in either direction for any theme. */
const shouldRemoveBackground = (options: PdfOptions, themeId: CatalogTheme): boolean =>
    effectiveCutout(themeId, options);

/**
 * Where the build is, stage by stage, for the studio's progress panel:
 * preparing → (AI model, only when removing backgrounds) → pages → assembling.
 * 'saving' is added by the page after the worker is done.
 */
export type CatalogPdfProgress =
    | { stage: 'preparing' }
    | { stage: 'model'; fraction: number }
    | { stage: 'pages'; done: number; total: number; title?: string }
    | { stage: 'assembling' }
    | { stage: 'saving' };

/** Progress + non-fatal problems, relayed to the page by the worker. */
export interface CatalogPdfCallbacks {
    onProgress: (progress: CatalogPdfProgress) => void;
    /** Something went wrong but the PDF can still be produced. */
    onWarning: (message: string) => void;
}

const loadImageInfo = async (
    imgUrl: string | undefined,
    themeId: CatalogTheme,
    options: PdfOptions,
    onWarning: (message: string) => void,
    artworkTitle: string,
    /** What lies behind the photo on this page, for laying a cutout onto it. */
    page: { colour: [number, number, number]; backdrop: ImageBitmap | null; imgBoxH: number },
): Promise<PdfImageInfo | null> => {
    if (!imgUrl) return null;
    try {
        let source: string | Blob = imgUrl;
        let isPng = urlLooksPng(imgUrl);
        let isCutout = false;

        if (shouldRemoveBackground(options, themeId)) {
            try {
                const { removeBackgroundToBlob } = await import('../../services/imageCutoutService');
                source = await removeBackgroundToBlob(imgUrl);
                isPng = true; // cutouts are transparent PNGs
                isCutout = true;
            } catch (e) {
                console.error("Background removal failed, falling back to original image", e);
                onWarning('Background removal failed — using the original photo.');
            }
        }

        // Pass to canvas logic to add rounded corners or shadow if needed
        const cornerRadius = isCutout || !THEME_STYLES[themeId].roundedImages ? 0 : 20;
        const shadow = effectiveShadow(themeId, options);
        // A cutout on a plain page is laid onto the page colour and stored as a
        // JPEG — it looks the same, and a transparent PNG per page made PDFs
        // several times larger (and ran phones out of memory).
        let matte: Matte | null = null;
        if (isCutout) {
            matte = page.backdrop
                ? { kind: 'backdrop', bitmap: page.backdrop, imgBoxH: page.imgBoxH }
                : { kind: 'colour', rgb: page.colour };
        }
        const matteKey = matte?.kind === 'backdrop' ? `bd${page.imgBoxH}` : page.colour.join('.');
        const alias = `img|${isCutout ? 'cutout' : 'photo'}|r${cornerRadius}|s${shadow ? 1 : 0}|m${matte ? matteKey : '-'}|${imgUrl}`;
        const info = await prepareImage(source, isPng, alias, cornerRadius, false, shadow, matte);
        return { ...info, isCutout };
    } catch (e) {
        console.error("Failed to load image for PDF", e);
        onWarning(`Couldn't load a photo of “${artworkTitle || 'Untitled'}” — that page has no image.`);
        return null;
    }
};

// Fit the image inside the page's image box at its natural aspect ratio,
// centered — pages are uniform A4.
const drawProductImage = (doc: jsPDF, imgInfo: PdfImageInfo | null, imgBoxH: number, frame: [number, number, number] | null) => {
    if (!imgInfo) return;
    const { x: drawX, y: drawY, w: drawW, h: drawH } = fitImageBox(imgInfo.width, imgInfo.height, imgBoxH);

    const compression = imgInfo.format === 'PNG' ? undefined : 'FAST';

    doc.addImage(imgInfo.data, imgInfo.format, drawX, drawY, drawW, drawH, imgInfo.alias, compression);

    // Gallery: a hairline frame hugging the photo (a cutout has no edge to frame).
    if (frame && !imgInfo.isCutout) {
        doc.setDrawColor(...frame);
        doc.setLineWidth(0.3);
        doc.rect(drawX, drawY, drawW, drawH);
    }
};

const drawFallbackLetter = (doc: jsPDF, options: PdfOptions, i: number, gold: [number, number, number]) => {
    // Position and size come from catalogLayout, shared with the preview.
    const mark = letterMark(options);
    doc.setFont("times", "normal");
    doc.setFontSize(mark.pt);
    doc.setTextColor(...gold);
    doc.text(`${String.fromCodePoint(65 + i)}.`, mark.x, mark.y, mark.align === 'left' ? undefined : { align: mark.align });
};

/**
 * The logo, processed once per catalog. It used to be downloaded, redrawn and
 * re-encoded as a PNG on every page, although it is the same on all of them.
 * Null means "use the letter mark" — no logo, or it couldn't be processed.
 */
const resolveLogo = async (logoUrl: string | undefined): Promise<PdfImageInfo | null> => {
    if (!logoUrl) return null;
    try {
        return await prepareImage(logoUrl, urlLooksPng(logoUrl), 'logoAlias', 0, true);
    } catch (e) {
        console.warn('Logo processing failed', e);
        return null;
    }
};

const drawLogo = (doc: jsPDF, logoInfo: PdfImageInfo | null, options: PdfOptions, i: number, gold: [number, number, number]) => {
    if (!logoInfo) {
        drawFallbackLetter(doc, options, i, gold);
        return;
    }
    // Placement, offsets and size (aspect ratio kept, inside the page border)
    // come from catalogLayout, which the studio preview uses too.
    const box = logoBox(options, logoInfo.width, logoInfo.height);
    doc.addImage(logoInfo.data, logoInfo.format, box.x, box.y, box.w, box.h, logoInfo.alias, 'FAST');
};

const drawPageBorder = (doc: jsPDF, pageH: number) => {
    doc.setDrawColor(210, 202, 192);
    doc.setLineWidth(0.25);
    doc.rect(2, 2, PAGE_W - 4, pageH - 4);
};

const drawPage0Text = (doc: jsPDF, art: Artwork, options: PdfOptions, catalogName: string, palette: ThemePalette, pageH: number) => {
    const { ink, gold, lineColor } = palette;
    // Anchor the text block to the bottom of the (image-sized) page.
    const yOff = pageH - PAGE_H;
    doc.setDrawColor(...lineColor);
    doc.setLineWidth(0.25);
    doc.line(13, 252 + yOff, PAGE_W - 13, 252 + yOff);

    let currentY = 258 + yOff;
    if (options.showCatalogName) {
        doc.setFont("times", "italic");
        doc.setFontSize(12);
        doc.setTextColor(...gold);
        doc.text(catalogName, 13, currentY);
        currentY += 6;
    }

    // Add extra space before title
    currentY += 2;

    if (options.showTitle) {
        doc.setFont("times", "normal");
        doc.setFontSize(20);
        doc.setTextColor(...ink);
        doc.text(art.title.toUpperCase(), 13, currentY, { charSpace: 2.2 });
        currentY += 9;
    }

    if (options.showTitleNote && art.medium) {
        doc.setFont("times", "normal");
        doc.setFontSize(14);
        doc.setTextColor(...gold);
        doc.text("MEDIUM", 13, currentY);

        doc.setFont("times", "normal");
        doc.setFontSize(16);
        doc.setTextColor(...ink);
        doc.text(art.medium, 46, currentY);

        currentY += 9;
    }



    if (options.showDimensions && art.dimensions) {
        doc.setFont("times", "normal");
        doc.setFontSize(14);
        doc.setTextColor(...gold);
        doc.text("DIMENSIONS", 13, currentY);

        doc.setFont("times", "normal");
        doc.setFontSize(16);
        doc.setTextColor(...ink);
        doc.text(`${art.dimensions} inch`, 46, currentY);

        doc.setFont("times", "normal");
        doc.setFontSize(14);
        doc.setTextColor(...gold);
        doc.text("|", 106, currentY);

        doc.text("ITEM CODE", 114, currentY);

        doc.setFont("times", "normal");
        doc.setFontSize(16);
        doc.setTextColor(...ink);
        doc.text(art.customId || '', 144, currentY);

        currentY += 9;
    }

    if (options.showPrice) {
        doc.setFont("times", "normal");
        doc.setFontSize(14);
        doc.setTextColor(...gold);
        doc.text("PRICE", 13, currentY);

        doc.setFont("times", "normal");
        doc.setFontSize(16);
        doc.setTextColor(...ink);
        const formattedPrice = `${Number(art.price || 0).toLocaleString('en-IN')}${art.plusGst ? ' +GST' : ''}`;
        doc.text(formattedPrice, 46, currentY);
    }
};

const drawPage1Text = (doc: jsPDF, art: Artwork, options: PdfOptions, palette: ThemePalette, pageH: number) => {
    if (!(options.showDescription && art.description)) return;
    const { ink, gold, lineColor } = palette;
    // Anchor the text block to the bottom of the (image-sized) page.
    const yOff = pageH - PAGE_H;
    doc.setDrawColor(...lineColor);
    doc.setLineWidth(0.25);
    doc.line(13, 252 + yOff, PAGE_W - 13, 252 + yOff);

    doc.setFont("times", "normal");
    doc.setFontSize(16);
    doc.setTextColor(...gold);
    doc.text("DESCRIPTION", 13, 258 + yOff, { charSpace: 2 });

    doc.setFont("times", "normal");
    doc.setFontSize(14);
    doc.setTextColor(...ink);
    const splitDesc = doc.splitTextToSize(art.description, PAGE_W - 26);
    doc.text(splitDesc, 13, 268 + yOff);
};

/** What every page shares, prepared once per catalog. */
interface CatalogDrawContext {
    doc: jsPDF;
    options: PdfOptions;
    palette: ThemePalette;
    background: PageBackground | null;
    logo: PdfImageInfo | null;
    catalogName: string;
    /** The theme frames its photos (Gallery). */
    framed: boolean;
    /** Pages already in the document. */
    pageCount: { value: number };
}

/** The image box's height: above the text zone, or the whole page when there is no text. */
const imageBoxHeight = (page: PlannedPage, options: PdfOptions): number => {
    const hasBottomText = page.pageIndex === 0 || (page.pageIndex === 1 && options.showDescription && page.art.description);
    return hasBottomText ? 250 : PAGE_H - 4;
};

/** Draw one planned page with its (already prepared) photo. */
const drawPlannedPage = (ctx: CatalogDrawContext, page: PlannedPage, imgInfo: PdfImageInfo | null): void => {
    const { doc, options, palette, background, logo, catalogName, framed, pageCount } = ctx;
    const { art, artIndex, pageIndex } = page;

    // Uniform A4 pages; the image fits inside the image box above the text zone.
    // jsPDF starts with one empty page, so only later pages need adding. This
    // counts pages in the whole document: it used to go by artwork index,
    // which left page 1 blank when the first artwork produced no pages.
    if (pageCount.value > 0) doc.addPage();
    pageCount.value += 1;

    drawPageBackground(doc, background, palette, PAGE_H);

    const imgBoxH = imageBoxHeight(page, options);
    drawProductImage(doc, imgInfo, imgBoxH, framed ? palette.lineColor : null);

    drawLogo(doc, logo, options, artIndex, palette.gold);

    drawPageBorder(doc, PAGE_H);

    if (pageIndex === 0) {
        drawPage0Text(doc, art, options, catalogName, palette, PAGE_H);
    } else if (pageIndex === 1) {
        drawPage1Text(doc, art, options, palette, PAGE_H);
    }
};

/**
 * How many pages' photos are prepared ahead of the page being drawn. Fetching,
 * decoding and re-encoding run on the browser's own threads, so several at
 * once use several cores; background removal still takes one image at a time
 * (imageCutoutService), since each run already uses the GPU or every core.
 */
const prefetchDepth = (): number => {
    const nav = globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined;
    // Phones (and anything reporting little memory): the page being drawn plus
    // one ahead. Several full photos at once is what ran them out of memory.
    const phone = /Android|iPhone|iPad|Mobile/i.test(nav?.userAgent ?? '') || (nav?.deviceMemory ?? 8) <= 4;
    if (phone) return 2;
    return Math.max(2, Math.min(3, (nav?.hardwareConcurrency ?? 4) - 1));
};

/**
 * The chosen end-page design, once, after every other page: fitted inside the
 * page at its own aspect ratio (never cropped or stretched), centred on the
 * page background. No logo or border — it is a finished design.
 */
/** Prepare the end-page design (started early, alongside the artwork pages). */
const loadLastPage = async (url: string, onWarning: (message: string) => void): Promise<PdfImageInfo | null> => {
    try {
        return await prepareImage(url, urlLooksPng(url), `lastpage|${url}`, 0, false, false);
    } catch (e) {
        console.error('Failed to load the last page design', e);
        onWarning("Couldn't load the last page design — the catalog ends without it.");
        return null;
    }
};

const drawLastPage = (
    doc: jsPDF,
    info: PdfImageInfo | null,
    background: PageBackground | null,
    palette: ThemePalette,
    pageCount: { value: number },
): void => {
    if (!info) return;
    if (pageCount.value > 0) doc.addPage();
    pageCount.value += 1;
    drawPageBackground(doc, background, palette, PAGE_H);
    const scale = Math.min(PAGE_W / info.width, PAGE_H / info.height);
    const w = info.width * scale;
    const h = info.height * scale;
    doc.addImage(info.data, info.format, (PAGE_W - w) / 2, (PAGE_H - h) / 2, w, h, info.alias, info.format === 'PNG' ? undefined : 'FAST');
};

/** Everything the generator needs, all of it structured-clone safe. */
export interface CatalogPdfJob {
    artworks: Artwork[];
    options: PdfOptions;
    themeId: CatalogTheme;
    catalogName: string;
    catalogCoverUrl: string;
}

/** Build the whole catalog and return the finished PDF's bytes. */
export const buildCatalogPdf = async (job: CatalogPdfJob, callbacks: CatalogPdfCallbacks): Promise<ArrayBuffer> => {
    const { artworks, themeId, catalogName, catalogCoverUrl } = job;
    let { options } = job;
    const doc = new jsPDF();
    const palette = getThemePalette(themeId, options);

    callbacks.onProgress({ stage: 'preparing' });
    const customLogo = options.logoSelection === 'Select 1' ? options.customLogo1 : options.customLogo2;
    const shared = Promise.all([
        resolvePageBackground(themeId, palette, options),
        resolveLogo(customLogo || catalogCoverUrl),
    ]);

    // Background removal: the AI model is downloaded and started first, as its
    // own step, and only then are photos processed. If it can't be loaded the
    // catalog is made with the original photos (one warning, not one per page).
    if (shouldRemoveBackground(options, themeId)) {
        callbacks.onProgress({ stage: 'model', fraction: 0 });
        try {
            const { preloadCutoutModel } = await import('../../services/imageCutoutService');
            await preloadCutoutModel(fraction => callbacks.onProgress({ stage: 'model', fraction }));
        } catch (e) {
            console.error('Background removal model failed to load', e);
            callbacks.onWarning("The background-removal model couldn't be loaded — using the original photos.");
            options = { ...options, removeBackground: false };
        }
    }
    const [background, logo] = await shared;
    // The backdrop, decoded once, for laying cutouts onto (see Matte).
    const backdrop = background && shouldRemoveBackground(options, themeId)
        ? await createImageBitmap(new Blob([background.data as BlobPart], { type: 'image/jpeg' }))
        : null;

    // The end-page design loads alongside everything else.
    const lastPage = options.lastPage ? loadLastPage(options.lastPage, callbacks.onWarning) : null;

    // Which pages exist is decided in catalogLayout.ts, shared with the
    // studio's live preview so the two can't drift apart. Photos for the next
    // few pages are prepared while the current one is drawn; pages are still
    // added strictly in order.
    const pages = planCatalogPages(artworks, options);
    const photos: (Promise<PdfImageInfo | null> | null)[] = [];
    const prepare = (k: number) => {
        const page = pages[k];
        photos[k] ??= loadImageInfo(page.imgUrl, themeId, options, callbacks.onWarning, page.art.title,
            { colour: palette.bg, backdrop, imgBoxH: imageBoxHeight(page, options) });
    };
    const ctx: CatalogDrawContext = {
        doc, options, palette, background, logo, catalogName, pageCount: { value: 0 },
        framed: THEME_STYLES[themeId].framedImages,
    };
    const depth = prefetchDepth();
    for (let k = 0; k < pages.length; k++) {
        for (let ahead = k; ahead < Math.min(pages.length, k + depth); ahead++) prepare(ahead);
        callbacks.onProgress({ stage: 'pages', done: k, total: pages.length, title: pages[k].art.title });
        const photo = await photos[k];
        photos[k] = null; // drawn: let its bytes go
        drawPlannedPage(ctx, pages[k], photo);
    }

    callbacks.onProgress({ stage: 'pages', done: pages.length, total: pages.length });
    if (lastPage) drawLastPage(doc, await lastPage, background, palette, ctx.pageCount);

    backdrop?.close();
    callbacks.onProgress({ stage: 'assembling' });
    return doc.output('arraybuffer');
};
