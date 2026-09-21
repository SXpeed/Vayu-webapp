import { jsPDF } from 'jspdf';
import type { Artwork, CatalogTheme, PdfOptions } from '../../types';
import { planArtworkPages, getThemePalette, ThemePalette } from './catalogLayout';

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

/** For non-logos, scale down large images to max 2500px to save PDF size while keeping extreme detail. */
const scaleDownIfNeeded = (canvas: OffscreenCanvas, isPng = false): OffscreenCanvas => {
    let scale = 1;
    if (canvas.width > 2500 || canvas.height > 2500) {
        scale = Math.min(2500 / canvas.width, 2500 / canvas.height);
    }

    // Truncate like assigning to <canvas>.width did.
    const tempCanvas = new OffscreenCanvas(Math.trunc(canvas.width * scale), Math.trunc(canvas.height * scale));
    const tCtx = tempCanvas.getContext('2d');
    if (tCtx) {
        if (!isPng) {
            tCtx.fillStyle = '#ffffff'; // White bg for JPEG
            tCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
        }
        tCtx.drawImage(canvas, 0, 0, tempCanvas.width, tempCanvas.height);
        return tempCanvas;
    }
    return canvas;
};

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
): Promise<PdfImageInfo> => {
    const bitmap = await decode(source);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        bitmap.close();
        throw new Error('Failed to get canvas context');
    }

    if (radiusPx > 0) {
        applyRoundedCorners(ctx, bitmap.width, bitmap.height);
    }
    if (addShadow) {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
        ctx.shadowBlur = 15;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 8;
    }

    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    if (addShadow) {
        // Reset shadow so it doesn't affect subsequent drawings if any
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
    }

    const usePng = isLogo || isPng;
    const finalCanvas = isLogo ? canvas : scaleDownIfNeeded(canvas, isPng);

    return {
        data: await encode(finalCanvas, usePng ? 'image/png' : 'image/jpeg'),
        width: finalCanvas.width,
        height: finalCanvas.height,
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

const generateTheme2Background = (): Promise<Uint8Array | null> => paintBackground(ctx => {
    const grad = ctx.createLinearGradient(0, 0, 0, 1188);
    grad.addColorStop(0, '#fcfcfc');
    grad.addColorStop(1, '#e0e0e0');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 840, 1188);
});

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
    if (options.gradientStyle && options.gradientStyle !== 'Solid') {
        const data = await generateDynamicBackground(palette.bg, options.gradientStyle);
        return data ? { data, alias: `bg_${options.gradientStyle}_${palette.bg.join('')}_${Math.round(PAGE_H)}` } : null;
    }
    if ((themeId === 2 || themeId === 5) && (!options.colorPalette || options.colorPalette === 'Default')) {
        const data = await generateTheme2Background();
        return data ? { data, alias: 'theme2bg' } : null;
    }
    return null;
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
    options.removeBackground ?? themeId === 5;

/** Progress + non-fatal problems, relayed to the page by the worker. */
export interface CatalogPdfCallbacks {
    onProgress: (message: string) => void;
    /** Something went wrong but the PDF can still be produced. */
    onWarning: (message: string) => void;
}

const loadImageInfo = async (
    imgUrl: string | undefined,
    themeId: CatalogTheme,
    options: PdfOptions,
    onProgress: (message: string) => void,
    onWarning: (message: string) => void,
    artworkTitle: string,
): Promise<PdfImageInfo | null> => {
    if (!imgUrl) return null;
    try {
        let source: string | Blob = imgUrl;
        let isPng = urlLooksPng(imgUrl);
        let isCutout = false;

        if (shouldRemoveBackground(options, themeId)) {
            try {
                const { removeBackgroundToBlob } = await import('../../services/imageCutoutService');
                source = await removeBackgroundToBlob(imgUrl, onProgress);
                isPng = true; // cutouts are transparent PNGs
                isCutout = true;
            } catch (e) {
                console.error("Background removal failed, falling back to original image", e);
                onWarning('Background removal failed — using the original photo.');
            }
        }

        // Pass to canvas logic to add rounded corners or shadow if needed
        const cornerRadius = isCutout || themeId === 1 ? 0 : 20;
        const alias = `img|${isCutout ? 'cutout' : 'photo'}|r${cornerRadius}|s${options.imageShadow ? 1 : 0}|${imgUrl}`;
        return await prepareImage(source, isPng, alias, cornerRadius, false, options.imageShadow);
    } catch (e) {
        console.error("Failed to load image for PDF", e);
        onWarning(`Couldn't load a photo of “${artworkTitle || 'Untitled'}” — that page has no image.`);
        return null;
    }
};

// Fit the image inside the page's image box at its natural aspect ratio,
// centered — pages are uniform A4.
const drawProductImage = (doc: jsPDF, imgInfo: PdfImageInfo | null, imgBoxH: number) => {
    if (!imgInfo) return;
    const imgX = 2, imgY = 2, imgBoxW = PAGE_W - 4;
    const imgRatio = imgInfo.width / imgInfo.height;
    const boxRatio = imgBoxW / imgBoxH;
    let drawW: number, drawH: number;
    if (imgRatio > boxRatio) {
        drawW = imgBoxW;
        drawH = imgBoxW / imgRatio;
    } else {
        drawH = imgBoxH;
        drawW = imgBoxH * imgRatio;
    }
    const drawX = imgX + (imgBoxW - drawW) / 2;
    const drawY = imgY + (imgBoxH - drawH) / 2;

    const compression = imgInfo.format === 'PNG' ? undefined : 'FAST';

    doc.addImage(imgInfo.data, imgInfo.format, drawX, drawY, drawW, drawH, imgInfo.alias, compression);
};

const drawFallbackLetter = (doc: jsPDF, options: PdfOptions, i: number, gold: [number, number, number]) => {
    doc.setFont("times", "normal");
    doc.setFontSize(24);
    doc.setTextColor(...gold);
    const marginX = 5;
    const marginY = 9;
    const letterX = options.logoPlacement === 'Top Right' ? PAGE_W - marginX : marginX;
    doc.text(`${String.fromCodePoint(65 + i)}.`, letterX, marginY,
        options.logoPlacement === 'Top Right' ? { align: 'right' } : undefined);
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
    const logoSize = 32.4; // Maximum bounding box dimension (reduced by 10% from 36)
    const marginX = 5;
    const marginY = 5;

    let lw = logoInfo.width, lh = logoInfo.height;
    const lr = Math.min(logoSize / lw, logoSize / lh);
    lw *= lr;
    lh *= lr;

    let lxOff = marginX;
    if (options.logoPlacement === 'Top Right') {
        lxOff = PAGE_W - marginX - lw;
    }
    const lyOff = marginY;

    doc.addImage(logoInfo.data, logoInfo.format, lxOff, lyOff, lw, lh, logoInfo.alias, 'FAST');
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

interface PageDrawContext {
    doc: jsPDF;
    art: Artwork;
    artIndex: number;
    options: PdfOptions;
    themeId: CatalogTheme;
    background: PageBackground | null;
    logo: PdfImageInfo | null;
    catalogName: string;
    onProgress: (message: string) => void;
    onWarning: (message: string) => void;
    /** Pages already in the document — shared across artworks. */
    pageCount: { value: number };
}

const drawSinglePage = async (
    ctx: PageDrawContext,
    imgUrl: string | undefined,
    pageIndex: number,
): Promise<void> => {
    const { doc, art, artIndex, options, themeId, background, logo, catalogName, onProgress, onWarning, pageCount } = ctx;

    const imgInfo = await loadImageInfo(imgUrl, themeId, options, onProgress, onWarning, art.title);
    const palette = getThemePalette(themeId, options);

    const hasBottomText = pageIndex === 0 || (pageIndex === 1 && options.showDescription && art.description);

    // Uniform A4 pages; the image fits inside the image box above the text zone.
    // jsPDF starts with one empty page, so only later pages need adding. This
    // counts pages in the whole document: it used to go by artwork index,
    // which left page 1 blank when the first artwork produced no pages.
    if (pageCount.value > 0) doc.addPage();
    pageCount.value += 1;

    drawPageBackground(doc, background, palette, PAGE_H);

    const imgBoxH = hasBottomText ? 250 : PAGE_H - 4;
    drawProductImage(doc, imgInfo, imgBoxH);

    drawLogo(doc, logo, options, artIndex, palette.gold);

    drawPageBorder(doc, PAGE_H);

    if (pageIndex === 0) {
        drawPage0Text(doc, art, options, catalogName, palette, PAGE_H);
    } else if (pageIndex === 1) {
        drawPage1Text(doc, art, options, palette, PAGE_H);
    }
};

const drawArtworkPages = async (pageCtx: PageDrawContext): Promise<void> => {
    // Which pages exist is decided in catalogLayout.ts, shared with the
    // studio's live preview so the two can't drift apart.
    for (const page of planArtworkPages(pageCtx.art, pageCtx.options)) {
        await drawSinglePage(pageCtx, page.imgUrl, page.pageIndex);
    }
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
    const { artworks, options, themeId, catalogName, catalogCoverUrl } = job;
    const doc = new jsPDF();
    const palette = getThemePalette(themeId, options);

    callbacks.onProgress('Preparing…');
    const customLogo = options.logoSelection === 'Select 1' ? options.customLogo1 : options.customLogo2;
    const [background, logo] = await Promise.all([
        resolvePageBackground(themeId, palette, options),
        resolveLogo(customLogo || catalogCoverUrl),
    ]);

    const pageCount = { value: 0 };
    for (let i = 0; i < artworks.length; i++) {
        const prefix = `Image ${i + 1} of ${artworks.length}`;
        callbacks.onProgress(prefix);
        await drawArtworkPages({
            doc, art: artworks[i], artIndex: i, options, themeId, background, logo, catalogName, pageCount,
            onProgress: (message) => callbacks.onProgress(`${prefix} — ${message}`),
            onWarning: callbacks.onWarning,
        });
    }

    callbacks.onProgress('Assembling PDF…');
    return doc.output('arraybuffer');
};
