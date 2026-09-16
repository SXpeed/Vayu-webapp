import React, { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { TypeDeleteDialog } from '../components/TypeDeleteDialog';
import { Plus, X, Edit2, Trash2, Download, Image as ImageIcon, Check, Search, Loader2, Camera, Upload, FileText, FileDown } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { Catalog, Artwork, PdfOptions, CatalogTheme } from '../types';
import type { jsPDF } from 'jspdf';
import storageService, { getThumbUrl } from '../services/storageService';
import { ArtworkFormModal } from './ArtworksView';

interface CatalogsViewProps {
    catalogs: Catalog[];
    artworks: Artwork[];
    onAddCatalog: (catalog: Omit<Catalog, 'id' | 'createdAt'> & { id?: string }) => Promise<Catalog | void> | void;
    onUpdateCatalog: (catalog: Catalog) => void;
    onDeleteCatalog: (id: string) => void;
    onArtworkClick: (artwork: Artwork) => void;
    onAddArtwork: (artwork: Omit<Artwork, 'id' | 'createdAt'>) => Promise<Artwork>;
}

import { CatalogStudioView } from './CatalogStudio/CatalogStudioView';

export const THEME_INFO: { id: CatalogTheme; name: string; desc: string; bg: string; fg: string; accent: string }[] = [
    { id: 1, name: 'Classic', desc: 'White & gradient', bg: '#ffffff', fg: '#1a1a1a', accent: '#e0e0e0' },
    { id: 2, name: 'Warm Grey', desc: 'Light grey gradient', bg: '#e0e0e0', fg: '#1a1a1a', accent: '#e0e0e0' },
    { id: 3, name: 'Edge Gradient', desc: 'White background', bg: '#ffffff', fg: '#1a1a1a', accent: '#8e44ad' },
    { id: 4, name: 'Dark & Gold', desc: 'Premium dark', bg: '#2a2a2a', fg: '#C9A84C', accent: '#C9A84C' },
    { id: 5, name: 'Gradient Cutout', desc: 'Grey gradient & cutout', bg: '#e0e0e0', fg: '#1a1a1a', accent: '#8e44ad' },
];

/** Clip the canvas context to a rounded-corner path. */
const applyRoundedCorners = (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, img: HTMLImageElement) => {
    const rad = Math.max(img.width, img.height) * 0.02;
    ctx.beginPath();
    ctx.moveTo(rad, 0);
    ctx.lineTo(canvas.width - rad, 0);
    ctx.quadraticCurveTo(canvas.width, 0, canvas.width, rad);
    ctx.lineTo(canvas.width, canvas.height - rad);
    ctx.quadraticCurveTo(canvas.width, canvas.height, canvas.width - rad, canvas.height);
    ctx.lineTo(rad, canvas.height);
    ctx.quadraticCurveTo(0, canvas.height, 0, canvas.height - rad);
    ctx.lineTo(0, rad);
    ctx.quadraticCurveTo(0, 0, rad, 0);
    ctx.closePath();
    ctx.clip();
};

/** For non-logos, scale down large images to max 2500px to save PDF size while keeping extreme detail. */
const scaleDownIfNeeded = (canvas: HTMLCanvasElement, img: HTMLImageElement, isPng = false): HTMLCanvasElement => {
    let scale = 1;
    if (img.width > 2500 || img.height > 2500) {
        scale = Math.min(2500 / img.width, 2500 / img.height);
    }

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = img.width * scale;
    tempCanvas.height = img.height * scale;
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

const getBase64ImageWithGradient = (url: string, radiusPx = 0, isLogo = false, addShadow = false): Promise<{
    dataUrl: string,
    width: number,
    height: number,
    format: string
}> => {
    return new Promise((resolve, reject) => {
        const isPng = url.toLowerCase().includes('.png') || url.toLowerCase().startsWith('data:image/png');
        const img = new Image();
        img.crossOrigin = 'Anonymous';
        img.onload = () => {
            // 2. Process original image (rounded corners)
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                reject(new Error('Failed to get canvas context'));
                return;
            }

            if (radiusPx > 0) {
                applyRoundedCorners(ctx, canvas, img);
            }
            if (addShadow) {
                ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
                ctx.shadowBlur = 15;
                ctx.shadowOffsetX = 0;
                ctx.shadowOffsetY = 8;
            }

            ctx.drawImage(img, 0, 0);

            if (addShadow) {
                // Reset shadow so it doesn't affect subsequent drawings if any
                ctx.shadowColor = 'transparent';
                ctx.shadowBlur = 0;
            }

            const usePng = isLogo || isPng;
            const exportFormat = usePng ? 'image/png' : 'image/jpeg';
            const finalCanvas = isLogo ? canvas : scaleDownIfNeeded(canvas, img, isPng);

            resolve({
                dataUrl: finalCanvas.toDataURL(exportFormat, 0.95),
                width: isLogo ? img.width : finalCanvas.width,
                height: isLogo ? img.height : finalCanvas.height,
                format: usePng ? 'PNG' : 'JPEG'
            });
        };
        img.onerror = reject;
        img.src = url;
    });
};

// ---------------------------------------------------------------------------
// PDF generation helpers (module-level to keep cognitive complexity low)
// ---------------------------------------------------------------------------

interface PdfImageInfo {
    dataUrl: string;
    width: number;
    height: number;
    format: string;
}

interface ThemePalette {
    bg: [number, number, number];
    isDark: boolean;
    ink: [number, number, number];
    softInk: [number, number, number];
    gold: [number, number, number];
    lineColor: [number, number, number];
}

const PAGE_W = 210;
const PAGE_H = 297;

const hexToRgb = (hex: string): [number, number, number] | null => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    const n = Number.parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const generateTheme2Background = (): string => {
    const canvas = document.createElement('canvas');
    canvas.width = 840;
    canvas.height = 1188;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    const grad = ctx.createLinearGradient(0, 0, 0, 1188);
    grad.addColorStop(0, '#fcfcfc');
    grad.addColorStop(1, '#e0e0e0');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 840, 1188);
    return canvas.toDataURL('image/jpeg', 0.95);
};

const generateDynamicBackground = (bg: [number, number, number], style: NonNullable<PdfOptions['gradientStyle']>): string | null => {
    if (style === 'Solid') return null;

    const canvas = document.createElement('canvas');
    canvas.width = 840;
    canvas.height = 1188;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

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
    return canvas.toDataURL('image/jpeg', 0.95);
};

const drawPageBackground = (doc: jsPDF, themeId: CatalogTheme, theme2BgDataUrl: string, palette: ThemePalette, options: PdfOptions, pageH: number) => {
    let customBgUrl = null;
    if (options.gradientStyle && options.gradientStyle !== 'Solid') {
        customBgUrl = generateDynamicBackground(palette.bg, options.gradientStyle);
    }

    // Solid fill first, then bleed the background image 0.5mm past every page
    // edge — placing it at exactly the page size leaves a white hairline at the
    // page edge in most PDF viewers due to rasterization rounding.
    doc.setFillColor(...palette.bg);
    doc.rect(0, 0, PAGE_W, pageH, 'F');

    if (customBgUrl) {
        doc.addImage(customBgUrl, 'JPEG', -0.5, -0.5, PAGE_W + 1, pageH + 1, `bg_${options.gradientStyle}_${palette.bg.join('')}_${Math.round(pageH)}`, 'FAST');
    } else if ((themeId === 2 || themeId === 5) && theme2BgDataUrl && (!options.gradientStyle || options.gradientStyle === 'Solid') && (!options.colorPalette || options.colorPalette === 'Default')) {
        doc.addImage(theme2BgDataUrl, 'JPEG', -0.5, -0.5, PAGE_W + 1, pageH + 1, 'theme2bg', 'FAST');
    }
};

/** Named color-palette presets selectable from the studio. Each entry returns
 *  a complete ThemePalette so the caller can short-circuit. */
const NAMED_PALETTE_PRESETS: Record<string, () => ThemePalette> = {
    'Dark Elegance': () => ({ bg: [24, 24, 27], isDark: true, ink: [240, 240, 240], softInk: [170, 170, 170], gold: [212, 175, 55], lineColor: [60, 60, 60] }),
    'Warm Earth': () => ({ bg: [244, 237, 228], isDark: false, ink: [58, 48, 40], softInk: [110, 95, 80], gold: [184, 115, 51], lineColor: [190, 175, 160] }),
    'Cool Minimal': () => ({ bg: [248, 249, 250], isDark: false, ink: [33, 37, 41], softInk: [108, 117, 125], gold: [108, 117, 125], lineColor: [222, 226, 230] }),
    'Midnight Blue': () => ({ bg: [15, 23, 42], isDark: true, ink: [241, 245, 249], softInk: [148, 163, 184], gold: [203, 172, 102], lineColor: [51, 65, 85] }),
};

/** Build a ThemePalette from a custom hex color, deriving readable text colors
 *  from its brightness. Returns null when the string isn't a usable hex value. */
const buildPaletteFromHex = (hex: string): ThemePalette | null => {
    const rgb = hexToRgb(hex);
    if (!rgb) return null;
    const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
    const dark = lum < 0.5;
    return {
        bg: rgb,
        isDark: dark,
        ink: dark ? [250, 250, 250] : [38, 32, 27],
        softInk: dark ? [180, 180, 180] : [90, 82, 74],
        gold: dark ? [201, 168, 76] : [156, 96, 48],
        lineColor: dark ? [110, 110, 110] : [135, 126, 116],
    };
};

const THEME_BACKGROUNDS: Record<CatalogTheme, [number, number, number]> = {
    1: [250, 248, 244],
    2: [224, 224, 224],
    3: [255, 255, 255],
    4: [42, 42, 42],
    5: [224, 224, 224],
};

const getThemePalette = (themeId: CatalogTheme, options?: PdfOptions): ThemePalette => {
    // 1. Custom hex color takes precedence over everything else.
    if (options?.colorPalette?.startsWith('#')) {
        const fromHex = buildPaletteFromHex(options.colorPalette);
        if (fromHex) return fromHex;
    }

    // 2. Named presets (Dark Elegance, Warm Earth, …).
    if (options?.colorPalette && NAMED_PALETTE_PRESETS[options.colorPalette]) {
        const fromPreset = NAMED_PALETTE_PRESETS[options.colorPalette]();
        if (fromPreset) return fromPreset;
    }

    // 3. Fall back to the built-in theme defaults.
    const bg = THEME_BACKGROUNDS[themeId];

    const isDark = themeId === 4;

    return {
        bg,
        isDark,
        ink: isDark ? [250, 250, 250] : [38, 32, 27],
        softInk: isDark ? [180, 180, 180] : [90, 82, 74],
        gold: isDark ? [201, 168, 76] : [156, 96, 48],
        lineColor: isDark ? [80, 80, 80] : [135, 126, 116],
    };
};

/** Cutout is on by default for theme 5 (Gradient Cutout); the studio checkbox
 *  overrides in either direction for any theme. */
const shouldRemoveBackground = (options: PdfOptions, themeId: CatalogTheme): boolean =>
    options.removeBackground ?? themeId === 5;

const loadImageInfo = async (
    imgUrl: string | undefined,
    themeId: CatalogTheme,
    options: PdfOptions,
    onProgress?: (message: string) => void
): Promise<PdfImageInfo | null> => {
    if (!imgUrl) return null;
    try {
        let finalUrl = imgUrl;
        let isCutout = false;

        if (shouldRemoveBackground(options, themeId)) {
            try {
                const { removeBackgroundImageLocal } = await import('../services/imageCutoutService');
                const info = await removeBackgroundImageLocal(imgUrl, onProgress);
                finalUrl = info.dataUrl;
                isCutout = true;
            } catch (e) {
                console.error("Background removal failed, falling back to original image", e);
                toast.error('Background removal failed — using the original photo.');
            }
        }

        // Pass to canvas logic to add rounded corners or shadow if needed
        const cornerRadius = isCutout || themeId === 1 ? 0 : 20;
        return await getBase64ImageWithGradient(finalUrl, cornerRadius, false, options.imageShadow);
    } catch (e) {
        console.error("Failed to load image for PDF", e);
        return null;
    }
};

// Fit the image inside the page's image box at its natural aspect ratio,
// centered — pages are uniform A4.
let pngAliasCounter = 0;

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

    // PNGs need a unique alias or jsPDF reuses the first image for all of them.
    const alias = imgInfo.format === 'PNG' ? `img_${++pngAliasCounter}` : undefined;
    const compression = imgInfo.format === 'PNG' ? undefined : 'FAST';

    doc.addImage(imgInfo.dataUrl, imgInfo.format, drawX, drawY, drawW, drawH, alias, compression);
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

const drawLogo = async (doc: jsPDF, logoUrl: string | undefined, options: PdfOptions, i: number, gold: [number, number, number]) => {
    if (!logoUrl) {
        drawFallbackLetter(doc, options, i, gold);
        return;
    }
    try {
        const logoInfo = await getBase64ImageWithGradient(logoUrl, 0, true);
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

        doc.addImage(logoInfo.dataUrl, logoInfo.format, lxOff, lyOff, lw, lh, 'logoAlias', 'FAST');
    } catch (e) {
        console.warn('Logo processing failed', e);
        drawFallbackLetter(doc, options, i, gold);
    }
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
    theme2BgDataUrl: string;
    catalogName: string;
    catalogCoverUrl: string;
    onProgress?: (message: string) => void;
};

const drawSinglePage = async (
    ctx: PageDrawContext,
    imgUrl: string | undefined,
    pageIndex: number,
    pagesAdded: number
): Promise<number> => {
    const { doc, art, artIndex, options, themeId, theme2BgDataUrl, catalogName, catalogCoverUrl, onProgress } = ctx;

    const imgInfo = await loadImageInfo(imgUrl, themeId, options, onProgress);
    const palette = getThemePalette(themeId, options);

    const hasBottomText = pageIndex === 0 || (pageIndex === 1 && options.showDescription && art.description);

    // Uniform A4 pages; the image fits inside the image box above the text zone.
    if (artIndex > 0 || pagesAdded > 0) doc.addPage();
    const pagesAddedNow = pagesAdded + 1;

    drawPageBackground(doc, themeId, theme2BgDataUrl, palette, options, PAGE_H);

    const imgBoxH = hasBottomText ? 250 : PAGE_H - 4;
    drawProductImage(doc, imgInfo, imgBoxH);

    const customLogo = options.logoSelection === 'Select 1' ? options.customLogo1 : options.customLogo2;
    const logoUrl = customLogo || catalogCoverUrl;
    await drawLogo(doc, logoUrl, options, artIndex, palette.gold);

    drawPageBorder(doc, PAGE_H);

    if (pageIndex === 0) {
        drawPage0Text(doc, art, options, catalogName, palette, PAGE_H);
    } else if (pageIndex === 1) {
        drawPage1Text(doc, art, options, palette, PAGE_H);
    }

    return pagesAddedNow;
};

const drawArtworkPages = async (pageCtx: PageDrawContext): Promise<void> => {
    const { doc, art, artIndex, options, themeId, theme2BgDataUrl } = pageCtx;
    let pagesAdded = 0;
    const pageOpts = options.pageOptions || [];

    if (pageOpts.includes('Main Image') || pageOpts.length === 0) {
        pagesAdded = await drawSinglePage(pageCtx, art.imageUrls?.[0], 0, pagesAdded);
    }
    if (pageOpts.includes('2nd Image')) {
        // Only add the 2nd page when the artwork actually has a 2nd image —
        // never emit an image-less page just to carry the description.
        const imgUrl = art.imageUrls && art.imageUrls.length > 1 ? art.imageUrls[1] : undefined;
        if (imgUrl) {
            pagesAdded = await drawSinglePage(pageCtx, imgUrl, 1, pagesAdded);
        }
    }
    if (pageOpts.includes('All Image')) {
        if (art.imageUrls && art.imageUrls.length > 2) {
            for (let j = 2; j < art.imageUrls.length; j++) {
                pagesAdded = await drawSinglePage(pageCtx, art.imageUrls[j], j, pagesAdded);
            }
        }
    }
};

export const CatalogsView: React.FC<CatalogsViewProps> = ({ catalogs, artworks, onAddCatalog, onUpdateCatalog, onDeleteCatalog, onArtworkClick, onAddArtwork }) => {
    const [isGeneratingPDF, setIsGeneratingPDF] = useState(false);
    const [pdfProgress, setPdfProgress] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [tab, setTab] = useState<'catalogs' | 'create'>('catalogs');
    const [isUploadingPdf, setIsUploadingPdf] = useState(false);
    const [deletePdfTarget, setDeletePdfTarget] = useState<Catalog | null>(null);
    const [renameTarget, setRenameTarget] = useState<Catalog | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const [formCatalog, setFormCatalog] = useState<Catalog | null>(null);
    const [showForm, setShowForm] = useState(false);
    const pdfInputRef = useRef<HTMLInputElement>(null);

    const [showCatalogStudio, setShowCatalogStudio] = useState(false);
    const [catalogToDownload, setCatalogToDownload] = useState<Catalog | null>(null);

    // The Catalogs tab lists only entries that actually hold a PDF
    // (uploaded files + generated PDFs saved from the studio).
    const pdfCatalogs = catalogs
        .filter(catalog => !!catalog.pdfUrl)
        .filter(catalog =>
            catalog.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            catalog.description.toLowerCase().includes(searchQuery.toLowerCase())
        );

    // Catalogs available in the Create tab — filtered by the shared search bar.
    const editableCatalogs = catalogs.filter(catalog =>
        catalog.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        catalog.description.toLowerCase().includes(searchQuery.toLowerCase())
    );

    const handleDownloadClick = (catalog: Catalog) => {
        setCatalogToDownload(catalog);
        setShowCatalogStudio(true);
    };

    /** Fetches a stored catalog PDF as a blob — bypasses SW/PWA navigation quirks. */
    const fetchPdfBlob = async (catalog: Catalog): Promise<Blob> => {
        const res = await fetch(catalog.pdfUrl!);
        if (!res.ok) throw new Error('Could not load the PDF');
        return res.blob();
    };

    const saveBlobAsPdf = (blob: Blob, name: string) => {
        const url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `${name.trim().replaceAll(/\s+/g, '_') || 'catalog'}.pdf`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
    };

    /** Opens the stored PDF in a new tab; falls back to a download when popups are blocked (installed PWAs). */
    const handleOpenPdf = async (catalog: Catalog) => {
        if (!catalog.pdfUrl) return;
        const toastId = toast.loading('Opening PDF…');
        try {
            const blob = await fetchPdfBlob(catalog);
            const url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
            const win = globalThis.open(url, '_blank');
            if (!win) {
                saveBlobAsPdf(blob, catalog.name);
                toast.success('PDF ready — check your downloads');
            }
            toast.dismiss(toastId);
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
        } catch (e) {
            toast.dismiss(toastId);
            toast.error((e as Error).message || 'Could not open the PDF');
        }
    };

    const handleDownloadPdf = async (catalog: Catalog) => {
        if (!catalog.pdfUrl) return;
        const toastId = toast.loading('Preparing download…');
        try {
            const blob = await fetchPdfBlob(catalog);
            saveBlobAsPdf(blob, catalog.name);
            toast.dismiss(toastId);
            toast.success('PDF downloaded');
        } catch (e) {
            toast.dismiss(toastId);
            toast.error((e as Error).message || 'Download failed');
        }
    };

    const handleRenameSave = () => {
        if (!renameTarget) return;
        const name = renameValue.trim();
        if (!name) { toast.error('Name is required'); return; }
        onUpdateCatalog({ ...renameTarget, name });
        setRenameTarget(null);
        toast.success('Renamed');
    };

    /** Uploads a PDF file and stores it as its own catalog entry. */
    const handleUploadPdf = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        if (file.type && file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
            toast.error('Please choose a PDF file');
            return;
        }
        setIsUploadingPdf(true);
        const toastId = toast.loading('Uploading catalog…');
        try {
            const result = await storageService.upload(file);
            const name = file.name.replace(/\.pdf$/i, '').trim() || 'Uploaded catalog';
            onAddCatalog({
                id: `cat_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
                name,
                description: '',
                artworkIds: [],
                coverImageUrl: '',
                pdfUrl: result.url,
                source: 'uploaded',
            });
            toast.success('Catalog uploaded', { id: toastId });
        } catch (error) {
            console.error('Catalog PDF upload failed:', error);
            toast.error('Upload failed — try again', { id: toastId });
        } finally {
            setIsUploadingPdf(false);
        }
    };

    const handleGeneratePDF = async (options: PdfOptions, themeId: CatalogTheme) => {
        if (!catalogToDownload || isGeneratingPDF) return;
        setIsGeneratingPDF(true);
        setPdfProgress('Preparing…');

        try {
            // Loaded on demand so jsPDF stays out of the initial bundle.
            const { jsPDF } = await import('jspdf');
            const doc = new jsPDF();
            const catalogArtworks = artworks.filter(a => catalogToDownload.artworkIds.includes(a.id));

            if (catalogArtworks.length === 0) {
                alert("No artworks in this catalog to generate PDF.");
                setIsGeneratingPDF(false);
                return;
            }

            const theme2BgDataUrl = generateTheme2Background();

            for (let i = 0; i < catalogArtworks.length; i++) {
                const prefix = `Image ${i + 1} of ${catalogArtworks.length}`;
                setPdfProgress(prefix);
                await drawArtworkPages({
                    doc, art: catalogArtworks[i], artIndex: i, options, themeId, theme2BgDataUrl,
                    catalogName: catalogToDownload.name, catalogCoverUrl: catalogToDownload.coverImageUrl,
                    onProgress: (message) => setPdfProgress(`${prefix} — ${message}`),
                });
            }

            setPdfProgress('Saving to Catalogs…');
            // Store the generated PDF so it lives in the Catalogs list.
            try {
                const blob = doc.output('blob');
                const pdfFile = new File([blob], `${catalogToDownload.name.trim().replaceAll(/\s+/g, '_')}.pdf`, { type: 'application/pdf' });
                const uploaded = await storageService.upload(pdfFile);
                const updated: Catalog = { ...catalogToDownload, pdfUrl: uploaded.url, source: 'generated' };
                onUpdateCatalog(updated);
                setCatalogToDownload(updated);
                toast.success('Catalog PDF saved to Catalogs');
            } catch (uploadError) {
                console.error('Saving generated catalog PDF failed:', uploadError);
                toast.error('Generated PDF downloaded, but saving to Catalogs failed');
            }

            setPdfProgress('Saving PDF…');
            doc.save(`${catalogToDownload.name.replaceAll(/\s+/g, '_')}.pdf`);
        } catch (error) {
            console.error("Error generating PDF:", error);
            alert("Failed to generate PDF.");
        } finally {
            // Stay in the studio after generating so options can be tweaked
            // and the PDF regenerated without re-opening it.
            setIsGeneratingPDF(false);
            setPdfProgress(null);
        }
    };

    return (
        <div className="h-full flex flex-col bg-[#faf9f6] dark:bg-[#121212] transition-colors duration-500 animate-fade-in">
            <div className="bg-white dark:bg-[#1a1a1a] px-[6px] pt-[calc(1.75rem+env(safe-area-inset-top,0px))] pb-[6px] shadow-sm z-10 border-b border-gray-100 dark:border-gray-800">
                <div className="flex justify-between items-center mb-[6px]">
                    <h1 className="text-xl font-serif text-gray-900 dark:text-white">Catalogs</h1>
                    {tab === 'catalogs' && (
                        <button
                            onClick={() => pdfInputRef.current?.click()}
                            disabled={isUploadingPdf}
                            aria-label="Upload catalog PDF"
                            title="Upload catalog PDF"
                            className="bg-gray-100 dark:bg-[#2a2a2a] text-gray-600 dark:text-gray-300 p-1.5 rounded-full shadow-sm hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors active-scale disabled:opacity-40"
                        >
                            {isUploadingPdf ? <Loader2 size={20} className="animate-spin" /> : <Upload size={20} />}
                        </button>
                    )}
                    {tab === 'create' && (
                        <button
                            onClick={() => { setFormCatalog(null); setShowForm(true); }}
                            aria-label="Add catalog"
                            title="Add catalog"
                            className="bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 p-1.5 rounded-full shadow-md hover:bg-brand-800 dark:hover:bg-gold-400 transition-colors active-scale"
                        >
                            <Plus size={20} />
                        </button>
                    )}
                    <input ref={pdfInputRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={handleUploadPdf} />
                </div>

                {/* Search — above the tabs, shared by both sections */}
                <div className="relative mb-[6px]">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 dark:text-gray-500" size={16} />
                    <input
                        type="text"
                        placeholder={tab === 'create' ? 'Search catalogs to edit...' : 'Search catalogs...'}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2 pl-9 pr-4 text-xs text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                    />
                </div>

                {/* Sections: saved catalogs vs. the create flow */}
                <div className="flex gap-1.5">
                    <button
                        type="button"
                        onClick={() => setTab('catalogs')}
                        className={`flex-1 py-1.5 rounded-full text-[9px] font-bold uppercase tracking-widest transition-colors active-scale ${tab === 'catalogs'
                            ? 'bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 shadow-sm'
                            : 'bg-gray-100 dark:bg-[#2a2a2a] text-gray-500 dark:text-gray-400'
                            }`}
                    >
                        Catalogs
                    </button>
                    <button
                        type="button"
                        onClick={() => setTab('create')}
                        className={`flex-1 py-1.5 rounded-full text-[9px] font-bold uppercase tracking-widest transition-colors active-scale ${tab === 'create'
                            ? 'bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 shadow-sm'
                            : 'bg-gray-100 dark:bg-[#2a2a2a] text-gray-500 dark:text-gray-400'
                            }`}
                    >
                        Create Catalog
                    </button>
                </div>
            </div>

            {tab === 'create' ? (
                <div className="flex-1 overflow-y-auto p-[6px] space-y-2 no-scrollbar pb-20">
                    {/* All catalogs with their selected products — list like Collections */}
                    {editableCatalogs.map((catalog, index) => (
                        <div
                            key={catalog.id}
                            className="relative w-full text-left bg-white dark:bg-[#1e1e1e] rounded-[6px] shadow-sm overflow-hidden flex h-28 border border-gray-100 dark:border-gray-800 animate-fade-in-up cursor-pointer active-scale"
                            style={{ animationDelay: `${index * 25}ms` }}
                        >
                            {/* Row tap target; inner action buttons sit above it (z-[2]). */}
                            <button
                                type="button"
                                onClick={() => { setFormCatalog(catalog); setShowForm(true); }}
                                aria-label={`Edit catalog ${catalog.name}`}
                                className="absolute inset-0 z-[1] w-full h-full rounded-[6px] cursor-pointer"
                            />
                            <div className="w-28 h-full relative shrink-0 bg-gray-50 dark:bg-gray-800">
                                <img loading="lazy" decoding="async" src={getThumbUrl(catalog.coverImageUrl)} alt={catalog.name} className="w-full h-full object-cover" />
                            </div>
                            <div className="p-[6px] flex flex-col justify-between flex-1">
                                <div>
                                    <div className="flex justify-between items-start">
                                        <h3 className="font-serif text-gray-900 dark:text-gray-100 line-clamp-1 text-sm flex-1 mr-2">{catalog.name}</h3>
                                        <button type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                handleDownloadClick(catalog);
                                            }}
                                            disabled={isGeneratingPDF}
                                            className={`relative z-[2] p-1.5 text-gray-400 dark:text-gray-500 hover:text-gold-600 dark:hover:text-gold-400 rounded-full transition-colors active-scale shrink-0 ${isGeneratingPDF ? 'opacity-50 cursor-not-allowed' : ''}`}
                                            title="Open PDF generator"
                                        >
                                            <Download size={14} />
                                        </button>
                                    </div>
                                    <p className="text-[9px] text-gray-500 dark:text-gray-400 mt-1 uppercase tracking-wider">
                                        {catalog.artworkIds.length} Artworks{catalog.pdfUrl ? ' · PDF saved' : ''}
                                    </p>
                                </div>
                                {catalog.description && (
                                    <p className="text-[10px] text-gray-400 dark:text-gray-500 font-light line-clamp-2">{catalog.description}</p>
                                )}
                            </div>
                        </div>
                    ))}
                    {editableCatalogs.length === 0 && (
                        <div className="text-center text-gray-400 dark:text-gray-500 mt-10 font-light text-sm px-6">
                            No catalogs yet — tap the + button above to create your first one.
                        </div>
                    )}
                </div>
            ) : (
            <div className="flex-1 overflow-y-auto p-[6px] space-y-2 no-scrollbar pb-20">
                {pdfCatalogs.map((catalog, index) => (
                    <div
                        key={catalog.id}
                        className="relative w-full text-left bg-white dark:bg-[#1e1e1e] rounded-[6px] shadow-sm overflow-hidden flex h-28 border border-gray-100 dark:border-gray-800 animate-fade-in-up cursor-pointer active-scale"
                        style={{ animationDelay: `${index * 25}ms` }}
                    >
                        {/* Row tap target; inner action buttons sit above it (z-[2]). */}
                        <button
                            type="button"
                            onClick={() => handleOpenPdf(catalog)}
                            aria-label={`Open catalog PDF ${catalog.name}`}
                            className="absolute inset-0 z-[1] w-full h-full rounded-[6px] cursor-pointer"
                        />
                        <div className="w-28 h-full relative shrink-0 bg-gray-50 dark:bg-gray-800">
                            {catalog.source === 'uploaded' ? (
                                <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-gold-600 dark:text-gold-400">
                                    <FileText size={26} strokeWidth={1.25} />
                                    <span className="text-[7px] font-bold uppercase tracking-widest">PDF</span>
                                </div>
                            ) : (
                                <img loading="lazy" decoding="async" src={getThumbUrl(catalog.coverImageUrl)} alt={catalog.name} className="w-full h-full object-cover" />
                            )}
                        </div>
                        <div className="p-[6px] flex flex-col justify-between flex-1">
                            <div>
                                <div className="flex justify-between items-start">
                                    <h3 className="font-serif text-gray-900 dark:text-gray-100 line-clamp-1 text-sm flex-1 mr-2">{catalog.name}</h3>
                                    <div className="flex items-center gap-2 shrink-0">
                                        <button type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setRenameTarget(catalog);
                                                setRenameValue(catalog.name);
                                            }}
                                            className="relative z-[2] p-1.5 text-gray-400 dark:text-gray-500 hover:text-gold-600 dark:hover:text-gold-400 rounded-full transition-colors active-scale"
                                            title="Rename"
                                        >
                                            <Edit2 size={14} />
                                        </button>
                                        <button type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                void handleDownloadPdf(catalog);
                                            }}
                                            className="relative z-[2] p-1.5 text-gray-400 dark:text-gray-500 hover:text-gold-600 dark:hover:text-gold-400 rounded-full transition-colors active-scale"
                                            title="Download PDF"
                                        >
                                            <FileDown size={14} />
                                        </button>
                                        <button type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setDeletePdfTarget(catalog);
                                            }}
                                            className="relative z-[2] p-1.5 text-gray-300 dark:text-gray-600 hover:text-red-500 rounded-full transition-colors active-scale ml-1.5"
                                            title="Delete PDF"
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                </div>
                                <p className="text-[9px] text-gray-500 dark:text-gray-400 mt-1 uppercase tracking-wider">
                                    {catalog.source === 'uploaded' ? 'PDF · Uploaded' : `PDF · ${catalog.artworkIds.length} Artworks`}
                                </p>
                            </div>
                            {catalog.description && (
                                <p className="text-[10px] text-gray-400 dark:text-gray-500 font-light line-clamp-2">{catalog.description}</p>
                            )}
                        </div>
                    </div>
                ))}
                {pdfCatalogs.length === 0 && (
                    <div className="text-center text-gray-400 dark:text-gray-500 mt-10 font-light text-sm px-6">
                        No catalog PDFs yet. Upload a PDF, or build one from the "Create Catalog" tab — generated PDFs are saved here automatically.
                    </div>
                )}
            </div>
            )}

            {/* Catalog Studio View */}
            {showCatalogStudio && catalogToDownload && (
                <CatalogStudioView
                    catalog={catalogToDownload}
                    artworks={artworks}
                    onClose={() => setShowCatalogStudio(false)}
                    onGeneratePDF={(options, themeId) => handleGeneratePDF(options, themeId)}
                    isGeneratingPDF={isGeneratingPDF}
                    generationProgress={pdfProgress}
                />
            )}

            {/* Add / Edit catalog page (old modal format) — opened from the Create tab */}
            {showForm && (
                <CatalogFormModal
                    initialData={formCatalog ?? undefined}
                    artworks={artworks}
                    onClose={() => setShowForm(false)}
                    onDelete={formCatalog ? () => {
                        onDeleteCatalog(formCatalog.id);
                        setShowForm(false);
                        toast.success('Catalog deleted');
                    } : undefined}
                    onSave={async (data) => {
                        if (formCatalog) {
                            onUpdateCatalog({ ...formCatalog, ...data, id: formCatalog.id, createdAt: formCatalog.createdAt });
                            toast.success('Catalog updated');
                        } else {
                            const full: Catalog = { ...data, id: `cat_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`, createdAt: Date.now() };
                            await onAddCatalog(full);
                            toast.success('Catalog created');
                        }
                        setShowForm(false);
                    }}
                    onGenerate={async (data) => {
                        let cat: Catalog;
                        if (formCatalog) {
                            cat = { ...formCatalog, ...data, id: formCatalog.id, createdAt: formCatalog.createdAt };
                            onUpdateCatalog(cat);
                        } else {
                            cat = { ...data, id: `cat_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`, createdAt: Date.now() };
                            await onAddCatalog(cat);
                        }
                        // Open the PDF generator page — generated PDFs land in the Catalogs tab.
                        setShowForm(false);
                        handleDownloadClick(cat);
                    }}
                />
            )}

            {/* Rename catalog dialog */}
            {renameTarget && createPortal(
                <div className="fixed inset-0 z-[90] flex items-center justify-center">
                    <button
                        type="button"
                        className="fixed inset-0 bg-black/40 border-none p-0 cursor-default"
                        onClick={() => setRenameTarget(null)}
                        aria-label="Close rename dialog"
                    />
                    <div className="relative z-10 w-full max-w-md mx-4 rounded-2xl bg-white dark:bg-[#1e1e1e] p-5 shadow-xl animate-scale-in">
                        <h3 className="text-base font-serif text-gray-900 dark:text-white mb-3">Rename catalog</h3>
                        <input
                            type="text"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') handleRenameSave(); }}
                            placeholder="Catalog name"
                            autoComplete="off"
                            spellCheck={false}
                            ref={(el) => { el?.focus(); el?.select(); }}
                            className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2.5 px-3.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                        />
                        <div className="mt-4 flex justify-end gap-2">
                            <button
                                type="button"
                                onClick={() => setRenameTarget(null)}
                                className="inline-flex justify-center rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-[#2a2a2a] px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={handleRenameSave}
                                className="inline-flex justify-center rounded-md border border-transparent bg-brand-900 dark:bg-gold-500 px-3 py-2 text-sm font-medium text-white dark:text-brand-950 hover:bg-brand-800 dark:hover:bg-gold-400 transition-colors"
                            >
                                Save
                            </button>
                        </div>
                    </div>
                </div>,
                document.body
            )}

            {/* Delete confirmation for a catalog PDF — must type "Delete" */}
            <TypeDeleteDialog
                isOpen={!!deletePdfTarget}
                title="Delete catalog PDF"
                itemName={deletePdfTarget?.name || ''}
                message="the stored PDF is archived for admin review"
                onClose={() => setDeletePdfTarget(null)}
                onConfirm={() => {
                    if (deletePdfTarget) onDeleteCatalog(deletePdfTarget.id);
                    setDeletePdfTarget(null);
                    toast.success('Catalog PDF deleted');
                }}
            />
        </div>
    );
};

export interface CatalogDetailModalProps {
    catalog: Catalog;
    artworks: Artwork[];
    onClose: () => void;
    onDownloadClick: () => void;
    onArtworkClick: (artwork: Artwork) => void;
    onUpdateCatalog: (catalog: Catalog) => void;
    onDeleteCatalog: () => void;
    isGeneratingPDF: boolean;
    onAddArtwork: (artwork: Omit<Artwork, 'id' | 'createdAt'>) => Promise<Artwork>;
}

export const CatalogDetailModal: React.FC<CatalogDetailModalProps> = ({ catalog, artworks, onClose, onDownloadClick, onArtworkClick, onUpdateCatalog, onDeleteCatalog, isGeneratingPDF, onAddArtwork }) => {
    const [isEditing, setIsEditing] = useState(false);
    const [isAddingProduct, setIsAddingProduct] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [detailSearchQuery, setDetailSearchQuery] = useState('');
    const catalogArtworks = artworks.filter(a => catalog.artworkIds.includes(a.id));
    const filteredCatalogArtworks = catalogArtworks.filter(a =>
        a.title.toLowerCase().includes(detailSearchQuery.toLowerCase()) ||
        a.customId?.toLowerCase().includes(detailSearchQuery.toLowerCase())
    );

    const handleUploadCoverImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setIsUploading(true);
        try {
            const result = await storageService.upload(file);
            onUpdateCatalog({ ...catalog, coverImageUrl: result.url });
        } catch (error) {
            console.error('Upload failed:', error);
            alert('Failed to upload cover image.');
        } finally {
            setIsUploading(false);
        }
        e.target.value = '';
    };

    const handleSaveEdit = (updatedData: Omit<Catalog, 'id' | 'createdAt'>) => {
        onUpdateCatalog({
            ...updatedData,
            id: catalog.id,
            createdAt: catalog.createdAt
        });
        setIsEditing(false);
    };

    const [confirmOpen, setConfirmOpen] = useState(false);

    const handleDelete = () => {
        setConfirmOpen(true);
    };

    return (
        <div className="absolute inset-0 bg-[#faf9f6] dark:bg-[#121212] z-50 flex flex-col animate-fade-in-up">
            <div className="bg-white dark:bg-[#1a1a1a] px-[6px] pb-[6px] shadow-sm z-10 border-b border-gray-100 dark:border-gray-800" style={{ paddingTop: 'calc(1.75rem + env(safe-area-inset-top, 0px))' }}>
                <div className="flex justify-between items-center mb-[6px]">
                    <h2 className="text-xl font-serif text-gray-900 dark:text-white truncate px-1">{catalog.name}</h2>
                    <div className="flex items-center gap-2">
                        <button onClick={() => setIsEditing(true)} className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale">
                            <Edit2 size={18} />
                        </button>
                        <button onClick={onDownloadClick} disabled={isGeneratingPDF} className={`p-2 text-gold-600 dark:text-gold-400 rounded-full transition-colors active-scale ${isGeneratingPDF ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-100 dark:hover:bg-gray-800'}`}>
                            <Download size={20} />
                        </button>
                        <button onClick={handleDelete} className="p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-full transition-colors active-scale">
                            <Trash2 size={18} />
                        </button>
                    </div>
                </div>
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 dark:text-gray-500" size={16} />
                    <input
                        type="text"
                        placeholder="Search artworks..."
                        value={detailSearchQuery}
                        onChange={(e) => setDetailSearchQuery(e.target.value)}
                        className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2 pl-9 pr-4 text-xs text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                    />
                </div>
            </div>

            <div className="flex-1 overflow-y-auto no-scrollbar pb-20">
                <div className="w-full aspect-[21/9] relative animate-fade-in group">
                    <img loading="lazy" decoding="async" src={getThumbUrl(catalog.coverImageUrl)} alt={catalog.name} className="w-full h-full object-cover" />
                    {/* Gradient removed as per user request */}

                    <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isUploading}
                        className="absolute top-[6px] right-4 p-2 bg-black/40 hover:bg-black/60 text-white rounded-full backdrop-blur-sm transition-colors z-10 disabled:opacity-50"
                        title="Upload Cover Image"
                    >
                        {isUploading ? <Loader2 size={18} className="animate-spin" /> : <Camera size={18} />}
                    </button>
                    <input type="file" accept="image/*" ref={fileInputRef} className="hidden" onChange={handleUploadCoverImage} />
                </div>

                <div className="p-[6px] bg-[#faf9f6] dark:bg-[#121212] relative z-20 min-h-[50dvh] flex flex-col gap-[6px]">
                    <div className="flex justify-between items-center mb-[6px]">
                        <h3 className="font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest text-[10px]">Artworks in Catalog ({catalogArtworks.length})</h3>
                        <button
                            onClick={() => setIsAddingProduct(true)}
                            className="bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 p-1.5 rounded-full shadow-md hover:bg-brand-800 dark:hover:bg-gold-400 transition-colors active-scale"
                            title="Add New Product to Catalog"
                        >
                            <Plus size={16} />
                        </button>
                    </div>
                    {filteredCatalogArtworks.map((artwork, index) => (
                        <button
                            type="button"
                            key={artwork.id}
                            onClick={() => onArtworkClick(artwork)}
                            className="w-full text-left bg-white dark:bg-[#1e1e1e] rounded-[6px] shadow-sm overflow-hidden flex h-28 border border-gray-100 dark:border-gray-800 animate-fade-in-up cursor-pointer active-scale"
                            style={{ animationDelay: `${index * 25}ms` }}
                        >
                            <div className="w-28 h-full relative shrink-0 bg-gray-50 dark:bg-gray-800">
                                {artwork.imageUrls.length > 0 ? (
                                    <img loading="lazy" decoding="async" src={getThumbUrl(artwork.imageUrls[0])} alt={artwork.title} className="w-full h-full object-cover" />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center text-gray-300 dark:text-gray-600">
                                        <ImageIcon size={28} strokeWidth={1} />
                                    </div>
                                )}
                            </div>
                            <div className="p-[6px] flex flex-col justify-between flex-1">
                                <div>
                                    <h3 className="font-serif text-gray-900 dark:text-gray-100 line-clamp-1 text-sm">{artwork.title}</h3>
                                    <p className="text-[9px] text-gray-500 dark:text-gray-400 mt-1 uppercase tracking-wider line-clamp-1">
                                        {artwork.artist && (
                                            <>
                                                {artwork.artist}
                                                {artwork.artworkYear ? `, ${artwork.artworkYear}` : ''}
                                                {' • '}
                                            </>
                                        )}
                                        {artwork.customId} • {artwork.medium}
                                    </p>
                                </div>
                                <div className="flex justify-between items-end">
                                    <p className="text-[10px] text-gray-400 dark:text-gray-500 font-light">{artwork.dimensions}</p>
                                    <p className="font-medium text-brand-900 dark:text-gold-400 text-sm">₹{artwork.price.toLocaleString('en-IN')}{artwork.plusGst ? ' + GST' : ''}</p>
                                </div>
                            </div>
                        </button>
                    ))}
                </div>
            </div>

            {isEditing && (
                <CatalogFormModal
                    initialData={catalog}
                    artworks={artworks}
                    onClose={() => setIsEditing(false)}
                    onSave={handleSaveEdit}
                />
            )}

            {isAddingProduct && (
                <ArtworkFormModal
                    onClose={() => setIsAddingProduct(false)}
                    onSave={async (newArt) => {
                        const savedArt = await onAddArtwork(newArt);
                        onUpdateCatalog({
                            ...catalog,
                            artworkIds: [...catalog.artworkIds, savedArt.id]
                        });
                        setIsAddingProduct(false);
                    }}
                />
            )}

            <TypeDeleteDialog
                isOpen={confirmOpen}
                title="Delete catalog"
                itemName={catalog.name}
                message="it will be archived for admin review"
                onClose={() => setConfirmOpen(false)}
                onConfirm={() => {
                    onDeleteCatalog();
                    setConfirmOpen(false);
                }}
            />
        </div>
    );
};

export interface CatalogFormModalProps {
    initialData?: Catalog;
    artworks: Artwork[];
    /** Rendered inline inside a tab body instead of as a full-screen overlay. */
    inline?: boolean;
    onClose: () => void;
    onSave: (catalog: Omit<Catalog, 'id' | 'createdAt'> & { id?: string }) => void | Promise<void>;
    /** Provided by the Create tab — saves, then opens the PDF generator. */
    onGenerate?: (catalog: Omit<Catalog, 'id' | 'createdAt'> & { id?: string }) => void | Promise<void>;
    /** Shown when editing — type-gated delete for the catalog itself. */
    onDelete?: () => void;
}

export const CatalogFormModal: React.FC<CatalogFormModalProps> = ({ initialData, artworks, onClose, onSave, inline, onGenerate, onDelete }) => {
    const [name, setName] = useState(initialData?.name || '');
    const [description, setDescription] = useState(initialData?.description || '');
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedArtworks, setSelectedArtworks] = useState<Set<string>>(new Set(initialData?.artworkIds ?? []));
    const [confirmDelete, setConfirmDelete] = useState(false);

    const filteredArtworks = artworks.filter(art =>
        art.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        art.customId.toLowerCase().includes(searchQuery.toLowerCase())
    );

    const toggleArtwork = (id: string) => {
        const newSet = new Set(selectedArtworks);
        if (newSet.has(id)) {
            newSet.delete(id);
        } else {
            newSet.add(id);
        }
        setSelectedArtworks(newSet);
    };

    /** Currently selected products, in artwork order — shown as a tile tray. */
    const selectedList = artworks.filter(art => selectedArtworks.has(art.id));

    const buildPayload = (): (Omit<Catalog, 'id' | 'createdAt'> & { id?: string }) | null => {
        if (!name.trim()) {
            alert("Name is required");
            return null;
        }
        if (selectedArtworks.size === 0) {
            alert("Select at least one artwork");
            return null;
        }
        return {
            name,
            description,
            artworkIds: Array.from(selectedArtworks),
            coverImageUrl: initialData?.coverImageUrl || `https://picsum.photos/seed/${name}/800/600`
        };
    };

    const handleSubmit = () => {
        const payload = buildPayload();
        if (!payload) return;
        void onSave(payload);
    };

    /** Saves, then hands the catalog to the PDF generator page. */
    const handleGenerate = async () => {
        const payload = buildPayload();
        if (!payload) return;
        await onSave(payload);
        await onGenerate?.(payload);
    };

    return (
        <div className={inline
            ? 'h-full flex flex-col bg-[#faf9f6] dark:bg-[#121212]'
            : 'absolute inset-0 bg-[#faf9f6] dark:bg-[#121212] z-[70] flex flex-col animate-fade-in-up'}>
            <div className="bg-white dark:bg-[#1a1a1a] flex justify-between items-center p-[6px] border-b border-gray-100 dark:border-gray-800 pt-[calc(1.75rem+env(safe-area-inset-top,0px))] shadow-sm">
                <button onClick={onClose} className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale">
                    <X size={20} />
                </button>
                <h2 className="text-base font-serif text-gray-900 dark:text-white">{initialData ? 'Edit Catalog' : 'Create Catalog'}</h2>
                {onGenerate && (
                    <button
                        type="button"
                        onClick={() => { void handleGenerate(); }}
                        title="Save and open the PDF generator"
                        className="text-gray-600 dark:text-gray-300 font-medium px-2 py-2 uppercase tracking-wider text-xs active-scale flex items-center gap-1"
                    >
                        <Download size={13} /> PDF
                    </button>
                )}
                <button onClick={handleSubmit} className="text-gold-600 dark:text-gold-400 font-medium px-2 py-2 uppercase tracking-wider text-xs active-scale">
                    Save
                </button>
            </div>

            <div className="flex-1 overflow-y-auto p-[6px] no-scrollbar flex flex-col gap-6">
                <div className="space-y-5 bg-white dark:bg-[#1e1e1e] p-5 rounded-[6px] shadow-sm border border-gray-100 dark:border-gray-800 animate-fade-in-up" style={{ animationDelay: '100ms' }}>
                    <div>
                        <label htmlFor="catalog-name" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Catalog Name *</label>
                        <input
                            id="catalog-name"
                            value={name}
                            onChange={e => setName(e.target.value)}
                            className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-base font-serif text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors"
                            placeholder="e.g. Summer Collection 2024"
                        />
                    </div>
                    <div>
                        <label htmlFor="catalog-desc" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wider">Description</label>
                        <textarea
                            id="catalog-desc"
                            value={description}
                            onChange={e => setDescription(e.target.value)}
                            rows={1}
                            className="w-full bg-transparent border border-gray-300 dark:border-gray-700 rounded-[6px] py-1.5 px-2 text-xs text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors resize-none"
                            placeholder="Brief description of this catalog..."
                        ></textarea>
                    </div>
                </div>

                <div className="animate-fade-in-up" style={{ animationDelay: '200ms' }}>
                    <div className="flex justify-between items-end mb-[6px]">
                        <h3 className="font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest text-[10px]">Select Artworks</h3>
                        <span className="text-[9px] text-gray-500 dark:text-gray-400 uppercase tracking-wider">{selectedArtworks.size} selected</span>
                    </div>

                    {/* Search Bar for Artworks */}
                    <div className="relative mb-4">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 dark:text-gray-500" size={16} />
                        <input
                            type="text"
                            placeholder="Search artworks to add..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full bg-white dark:bg-[#1e1e1e] border border-gray-200 dark:border-gray-800 rounded-[6px] py-2 pl-9 pr-4 text-xs text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors shadow-sm"
                        />
                    </div>

                    {/* Selected product tile tray */}
                    {selectedList.length > 0 && (
                        <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1 mb-4">
                            {selectedList.map(art => (
                                <div key={art.id} className="relative w-16 h-16 rounded-[6px] overflow-hidden border-2 border-gold-500 shrink-0 animate-scale-in">
                                    {art.imageUrls?.[0] ? (
                                        <img loading="lazy" decoding="async" src={getThumbUrl(art.imageUrls[0])} alt={art.title} className="w-full h-full object-cover" />
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center text-gray-300 dark:text-gray-600">
                                            <ImageIcon size={14} />
                                        </div>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => toggleArtwork(art.id)}
                                        aria-label={`Remove ${art.title}`}
                                        className="absolute top-0.5 right-0.5 bg-black/70 text-white rounded-full p-0.5 active-scale"
                                    >
                                        <X size={9} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    <div className="grid grid-cols-2 gap-2">
                        {filteredArtworks.map((art, index) => {
                            const isSelected = selectedArtworks.has(art.id);
                            const coverImage = art.imageUrls?.[0];
                            return (
                                <button
                                    type="button"
                                    key={art.id}
                                    onClick={() => toggleArtwork(art.id)}
                                    className={`relative w-full text-left rounded-[6px] overflow-hidden border-2 cursor-pointer transition-all bg-gray-50 dark:bg-gray-800 animate-scale-in active-scale ${isSelected ? 'border-gold-500 shadow-md' : 'border-transparent shadow-sm'
                                        }`}
                                    style={{ animationDelay: `${index * 30}ms` }}
                                >
                                    {coverImage ? (
                                        <img loading="lazy" decoding="async" src={getThumbUrl(coverImage)} alt={art.title} className="w-full h-32 object-cover" />
                                    ) : (
                                        <div className="w-full h-32 flex items-center justify-center text-gray-300 dark:text-gray-600">
                                            <ImageIcon size={20} strokeWidth={1.5} />
                                        </div>
                                    )}
                                    <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-2 pt-6">
                                        <p className="text-white text-[10px] font-serif truncate">{art.title}</p>
                                    </div>
                                    {isSelected && (
                                        <div className="absolute top-1.5 right-1.5 bg-gold-500 text-white rounded-full p-1 shadow-sm">
                                            <Check size={12} strokeWidth={3} />
                                        </div>
                                    )}
                                </button>
                            );
                        })}
                        {filteredArtworks.length === 0 && (
                            <div className="col-span-2 text-center text-gray-400 dark:text-gray-500 py-6 text-xs font-light">
                                No artworks found matching "{searchQuery}".
                            </div>
                        )}
                    </div>
                </div>



                {initialData && onDelete && (
                    <button
                        type="button"
                        onClick={() => setConfirmDelete(true)}
                        className="w-full rounded-[6px] py-2.5 text-sm font-medium tracking-wide transition-colors active-scale flex items-center justify-center gap-2 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900/40 hover:bg-red-50 dark:hover:bg-red-900/20"
                    >
                        <Trash2 size={14} /> Delete Catalog
                    </button>
                )}

                <div className="h-10"></div>
            </div>

            <TypeDeleteDialog
                isOpen={confirmDelete}
                title="Delete catalog"
                itemName={initialData ? `${initialData.name}` : ''}
                message="its PDF is archived for admin review"
                onClose={() => setConfirmDelete(false)}
                onConfirm={() => {
                    setConfirmDelete(false);
                    onDelete?.();
                }}
            />
        </div>
    );
};
