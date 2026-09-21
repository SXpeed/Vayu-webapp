import type { Artwork, CatalogTheme, PdfOptions } from '../../types';

/* ------------------------------------------------------------------ */
/*  Catalog PDF page layout, shared by the generator and the preview.  */
/*                                                                     */
/*  The studio's live preview used to be its own hand-drawn mock (three */
/*  artworks listed per page), which looked nothing like the PDF — one  */
/*  artwork per page, image on top, text block at the foot. Anything    */
/*  that decides *which* pages exist or *where* things sit now lives    */
/*  here, so the preview and the generator read from the same source.   */
/* ------------------------------------------------------------------ */

/** A4 portrait, in millimetres — the units jsPDF draws in. */
export const PAGE_W_MM = 210;
export const PAGE_H_MM = 297;

/** One page the generator will emit. */
export interface PlannedPage {
    art: Artwork;
    /** Position of the artwork in the catalog — drives the fallback logo letter. */
    artIndex: number;
    /** Image drawn on this page (may be missing when the artwork has none). */
    imgUrl: string | undefined;
    /** 0 = main page (full text block), 1 = 2nd image (description), 2+ = image only. */
    pageIndex: number;
}

/**
 * The pages one artwork produces for the chosen page options.
 *
 * - Main image page when "Main Image" is on, or when nothing is selected.
 * - A 2nd-image page only when the artwork actually has a second image.
 * - "All Image" adds one page per image from the third onward.
 */
export const planArtworkPages = (
    art: Artwork,
    options: Pick<PdfOptions, 'pageOptions'>,
): Array<{ imgUrl: string | undefined; pageIndex: number }> => {
    const pageOpts = options.pageOptions || [];
    const images = art.imageUrls ?? [];
    const pages: Array<{ imgUrl: string | undefined; pageIndex: number }> = [];

    if (pageOpts.includes('Main Image') || pageOpts.length === 0) {
        pages.push({ imgUrl: images[0], pageIndex: 0 });
    }
    // Never emit an image-less page just to carry the description — this is a
    // truthiness check, so an empty-string URL in slot 2 is skipped too.
    if (pageOpts.includes('2nd Image') && images[1]) {
        pages.push({ imgUrl: images[1], pageIndex: 1 });
    }
    if (pageOpts.includes('All Image') && images.length > 2) {
        for (let j = 2; j < images.length; j++) {
            pages.push({ imgUrl: images[j], pageIndex: j });
        }
    }
    return pages;
};

/** Every page of the catalog, in the order the PDF will contain them. */
export const planCatalogPages = (
    artworks: Artwork[],
    options: Pick<PdfOptions, 'pageOptions'>,
): PlannedPage[] =>
    artworks.flatMap((art, artIndex) =>
        planArtworkPages(art, options).map(p => ({ ...p, art, artIndex })),
    );

/* ----------------------------- Colours ------------------------------ */

type Rgb = [number, number, number];

export const rgbCss = ([r, g, b]: Rgb): string => `rgb(${r}, ${g}, ${b})`;

const shift = ([r, g, b]: Rgb, d: number): string =>
    rgbCss([
        Math.max(0, Math.min(255, r + d)),
        Math.max(0, Math.min(255, g + d)),
        Math.max(0, Math.min(255, b + d)),
    ]);

/**
 * CSS equivalent of the page background the generator paints.
 *
 * Mirrors `generateDynamicBackground` (canvas 840×1188) stop for stop. The
 * radial stops are re-expressed against `farthest-corner`, which is what CSS
 * measures percentages from: from the page centre that corner is ~727px on
 * the canvas, and from the Spotlight origin (420,120) it is ~1148px.
 */
export const pageBackgroundCss = (
    themeId: CatalogTheme,
    bg: Rgb,
    options: Pick<PdfOptions, 'gradientStyle' | 'colorPalette'>,
): string => {
    const style = options.gradientStyle ?? 'Solid';
    const base = rgbCss(bg);
    const lighter = shift(bg, 30);
    const darker = shift(bg, -20);
    const deeper = shift(bg, -45);

    switch (style) {
        case 'Linear':
            return `linear-gradient(to bottom, ${lighter}, ${darker})`;
        case 'Radial':
            // r 0→700 on the canvas; the farthest corner sits at ~727.
            return `radial-gradient(circle farthest-corner at 50% 50%, ${lighter} 0%, ${darker} 96%)`;
        case 'Diagonal':
            // The canvas runs (0,0)→(840,1188). `to bottom right` would tilt the
            // isolines to the other diagonal on a non-square page; 144.7° is
            // that exact vector, and its CSS gradient length (W·sin + H·cos)
            // equals the diagonal, so 0% and 100% land on the same corners.
            return `linear-gradient(144.7deg, ${lighter}, ${base} 50%, ${darker})`;
        case 'Vignette':
            // r 200→1150 with stops at 0 / 0.65 / 1 of that span.
            return `radial-gradient(circle farthest-corner at 50% 50%, ${base} 27%, ${darker} 112%, ${deeper} 158%)`;
        case 'Spotlight':
            // Origin (420,120) = 50% / 10%; r 0→1300 with stops at 0 / 0.45 / 1.
            return `radial-gradient(circle farthest-corner at 50% 10%, ${shift(bg, 50)} 0%, ${base} 51%, ${deeper} 113%)`;
        default:
            break;
    }

    // Warm Grey and Gradient Cutout paint a fixed light-grey sweep when the
    // page colour and gradient are both left on their defaults.
    const isDefaultColour = !options.colorPalette || options.colorPalette === 'Default';
    if ((themeId === 2 || themeId === 5) && isDefaultColour) {
        return 'linear-gradient(to bottom, #fcfcfc, #e0e0e0)';
    }
    return base;
};

/* ----------------------------- Geometry ----------------------------- */

/** Millimetres → percentage of page width / height. */
export const pctW = (mm: number): string => `${(mm / PAGE_W_MM) * 100}%`;
export const pctH = (mm: number): string => `${(mm / PAGE_H_MM) * 100}%`;

/**
 * Millimetres → container-query width units, for type that must scale with
 * the page. The preview page is a size container, so 1mm = 100/210 cqw.
 */
export const cqw = (mm: number): string => `${(mm / PAGE_W_MM) * 100}cqw`;

/** jsPDF font sizes are points; 1pt = 0.3528mm. */
export const ptToMm = (pt: number): number => pt * 0.3528;

/** Whether this page carries a text block under the image. */
export const pageHasText = (page: Pick<PlannedPage, 'pageIndex' | 'art'>, options: Pick<PdfOptions, 'showDescription'>): boolean =>
    page.pageIndex === 0 || (page.pageIndex === 1 && !!options.showDescription && !!page.art.description);

/* ----------------------------- Palette ------------------------------ */
/*  Page colours, shared by the generator and the preview. Moved here   */
/*  from the generator so the preview can use them without pulling      */
/*  jsPDF into the page bundle.                                         */

export interface ThemePalette {
    bg: [number, number, number];
    isDark: boolean;
    ink: [number, number, number];
    softInk: [number, number, number];
    gold: [number, number, number];
    lineColor: [number, number, number];
}

const hexToRgb = (hex: string): [number, number, number] | null => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    const n = Number.parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
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

export const getThemePalette = (themeId: CatalogTheme, options?: PdfOptions): ThemePalette => {
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
