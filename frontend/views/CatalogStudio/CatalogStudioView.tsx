import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import localforage from 'localforage';
import { Catalog, Artwork, PdfOptions, CatalogTheme, LogoPlacement } from '../../types';
import {
    ChevronLeft, ChevronRight, Check, Upload, Eye, X, Loader2, FileText, Folder,
    Type, Box, Tag, AlignLeft, Image as ImageIcon, TriangleAlert, Plus, Trash2, RotateCcw,
} from 'lucide-react';
import { THEME_INFO } from '../CatalogsView';
import storageService, { getThumbUrl } from '../../services/storageService';
import { settingsService } from '../../services/settingsService';
import { ToggleRow } from '../../components/ui';
import {
    planCatalogPages, pageBackgroundCss, pageHasText, rgbCss, pctW, pctH, cqw, ptToMm,
    PAGE_H_MM, PlannedPage, getThemePalette, ThemePalette,
    LOGO_DEFAULT_SIZE_MM, LOGO_MIN_SIZE_MM, LOGO_MAX_SIZE_MM, LOGO_MAX_OFFSET_MM,
    logoBox, logoSizeMm, letterMark,
} from './catalogLayout';
import toast from 'react-hot-toast';
import type { CatalogPdfProgress } from './catalogPdf';

/** Stable keys for the six recent-color swatches (filled or empty). */
const RECENT_COLOR_SLOTS = ['slot-1', 'slot-2', 'slot-3', 'slot-4', 'slot-5', 'slot-6'];

/** The 12 main color-wheel hues (every 30°), applied at the chosen intensity. */
const MAIN_HUES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];

// At the default intensity the applied color matches the vivid main color shown
// in the swatch row (s≈75, l≈50).
const DEFAULT_INTENSITY = 58;

const GRADIENT_STYLES = ['Solid', 'Linear', 'Radial', 'Diagonal', 'Vignette', 'Spotlight'] as const;

/** Reusable end-page designs a workspace can keep. */
const MAX_END_PAGES = 5;
/** Press-and-hold this long on a design to see it enlarged. */
const HOLD_PREVIEW_MS = 350;

const hslToHex = (h: number, s: number, l: number): string => {
    const sat = s / 100;
    const lig = l / 100;
    const k = (n: number) => (n + h / 30) % 12;
    const a = sat * Math.min(lig, 1 - lig);
    const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
    return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
};

/** Map a hue + intensity (0–100) to a page color: low intensity = soft pastel,
 *  high intensity = deep dark. The default intensity lands on the vivid color. */
const hueToHex = (hue: number, intensity: number): string => {
    const s = 60 + intensity * 0.25; // 60..85
    const l = 92 - intensity * 0.72; // 92..20
    return hslToHex(hue, s, l);
};

/** The true vivid main color for a hue — what the swatch row displays. */
const mainColorHex = (hue: number): string => hslToHex(hue, 85, 50);

/** Whether a hex color is light (to pick a readable check-mark color on top). */
const isLightHex = (hex: string): boolean => {
    const n = Number.parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
};

/** Settings are grouped the way the old tabs were, but live in one scroll. */
type Group = 'style' | 'logo' | 'content';
const GROUPS: { id: Group; label: string }[] = [
    { id: 'style', label: 'Style' },
    { id: 'logo', label: 'Logo' },
    { id: 'content', label: 'Content' },
];

const CONTENT_FIELDS: { key: keyof PdfOptions; label: string; icon: React.ElementType }[] = [
    { key: 'showCatalogName', label: 'Catalog name', icon: Folder },
    { key: 'showTitle', label: 'Title', icon: Type },
    { key: 'showTitleNote', label: 'Medium', icon: FileText },
    { key: 'showDimensions', label: 'Size & item code', icon: Box },
    { key: 'showPrice', label: 'Price', icon: Tag },
    { key: 'showDescription', label: 'Description', icon: AlignLeft },
];

interface CatalogStudioViewProps {
    catalog: Catalog;
    artworks: Artwork[];
    onClose: () => void;
    onGeneratePDF: (options: PdfOptions, themeId: CatalogTheme) => void;
    isGeneratingPDF: boolean;
    /** Where the PDF build is while it runs (stage, and how far within it). */
    generationProgress?: CatalogPdfProgress | null;
}

export const CatalogStudioView: React.FC<CatalogStudioViewProps> = ({
    catalog,
    artworks,
    onClose,
    onGeneratePDF,
    isGeneratingPDF,
    generationProgress,
}) => {
    const [showMobilePreview, setShowMobilePreview] = useState(false);
    const [selectedTheme, setSelectedTheme] = useState<CatalogTheme>(1);
    const [options, setOptions] = useState<PdfOptions>({
        showCatalogName: true,
        showTitle: true,
        showTitleNote: true,
        showDimensions: true,
        showPrice: true,
        showDescription: false,
        logoSelection: 'Select 1',
        logoPlacement: 'Top Right',
        pageOptions: ['Main Image'],
    });
    // Custom page color state: hue picked from the 12 main colors, intensity
    // from the slider. Both are persisted with the rest of the PDF options.
    const [hue, setHue] = useState(30);
    const [intensity, setIntensity] = useState(DEFAULT_INTENSITY);
    const [hexInput, setHexInput] = useState('');
    const [uploadingLogo, setUploadingLogo] = useState<'Select 1' | 'Select 2' | null>(null);

    useEffect(() => {
        const loadInitialData = async () => {
            const savedOptions = await localforage.getItem<PdfOptions>('vayu-pdf-options');
            if (savedOptions) {
                // A placement that no longer exists (the retired 'Center') falls back to the default.
                const placement = PLACEMENT_GRID.includes(savedOptions.logoPlacement) ? savedOptions.logoPlacement : 'Top Right';
                setOptions(prev => ({ ...prev, ...savedOptions, logoPlacement: placement }));
                // Restore the saved hue + intensity so the pickers line up.
                if (typeof savedOptions.colorHue === 'number') setHue(savedOptions.colorHue);
                if (typeof savedOptions.colorIntensity === 'number') setIntensity(savedOptions.colorIntensity);
            }

            try {
                const globalSettings = await settingsService.getSettings();
                // End-page designs are shared like the logos; the local copy
                // only fills in while offline. A selection whose design is
                // gone is dropped.
                if (Array.isArray(globalSettings.endPageDesigns)) {
                    const designs = (globalSettings.endPageDesigns as unknown[])
                        .filter((u): u is string => typeof u === 'string' && !!u)
                        .slice(0, MAX_END_PAGES);
                    setOptions(prev => {
                        const next = {
                            ...prev,
                            endPageDesigns: designs,
                            lastPage: prev.lastPage && designs.includes(prev.lastPage) ? prev.lastPage : undefined,
                        };
                        localforage.setItem('vayu-pdf-options', next);
                        return next;
                    });
                }
                if (globalSettings.customLogo1 || globalSettings.customLogo2) {
                    setOptions(prev => {
                        const next = {
                            ...prev,
                            ...(globalSettings.customLogo1 && { customLogo1: globalSettings.customLogo1 }),
                            ...(globalSettings.customLogo2 && { customLogo2: globalSettings.customLogo2 }),
                        };
                        localforage.setItem('vayu-pdf-options', next);
                        return next;
                    });
                }
            } catch (err) {
                console.error(err);
            }

            const savedTheme = await localforage.getItem<CatalogTheme>('vayu-pdf-theme');
            if (savedTheme) setSelectedTheme(savedTheme);
        };

        loadInitialData();
    }, []);

    const updateTheme = (themeId: CatalogTheme) => {
        setSelectedTheme(themeId);
        localforage.setItem('vayu-pdf-theme', themeId);
    };

    const updateOption = (key: keyof PdfOptions, value: unknown) => {
        setOptions(prev => {
            const newOpts = { ...prev, [key]: value };
            localforage.setItem('vayu-pdf-options', newOpts).catch(console.error);
            return newOpts;
        });
    };

    /** Apply a page color (plus any extra option keys) in one persisted update. */
    const applyColor = (hex: string, extra: Partial<PdfOptions> = {}) => {
        setOptions(prev => {
            const next = { ...prev, ...extra, colorPalette: hex };
            localforage.setItem('vayu-pdf-options', next).catch(console.error);
            return next;
        });
    };

    /** Remember a color in the 6-slot recently-used row. */
    const addRecentColor = (hex: string) => {
        setOptions(prev => {
            const recentColors = [hex, ...(prev.recentColors ?? []).filter(c => c !== hex)].slice(0, 6);
            const next = { ...prev, recentColors };
            localforage.setItem('vayu-pdf-options', next).catch(console.error);
            return next;
        });
    };

    // Unset = follow the theme default: theme 5 (Gradient Cutout) removes by default.
    const removeBackground = options.removeBackground ?? selectedTheme === 5;
    const imageShadow = options.imageShadow ?? false;
    const colorPalette = options.colorPalette ?? 'Default';
    const gradientStyle = options.gradientStyle ?? 'Solid';

    /** Tick button: save the color manually — from the hex box when it holds a
     *  valid code, otherwise the currently active color. */
    const handleSaveColor = () => {
        const typed = `#${hexInput.trim().replace(/^#/, '').toLowerCase()}`;
        let color: string | null = null;
        if (/^#[0-9a-f]{6}$/.test(typed)) {
            color = typed;
        } else if (colorPalette.startsWith('#')) {
            color = colorPalette;
        }
        if (!color) return;
        applyColor(color);
        addRecentColor(color);
        setHexInput('');
    };

    /** Artworks in the catalog — the catalog's own selection when known. */
    const catalogArtworks = useMemo(() => {
        const ids = catalog?.artworkIds ?? [];
        if (ids.length) {
            const filtered = artworks.filter(a => ids.includes(a.id));
            if (filtered.length) return filtered;
        }
        return artworks;
    }, [catalog, artworks]);

    const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>, opt: 'Select 1' | 'Select 2') => {
        const file = e.target.files?.[0];
        e.target.value = ''; // allow re-picking the same file
        if (!file) return;
        setUploadingLogo(opt);
        try {
            // Upload to Cloudflare Storage (R2) via our storageService
            const result = await storageService.upload(file);
            const key = opt === 'Select 1' ? 'customLogo1' : 'customLogo2';
            updateOption(key, result.url);
            updateOption('logoSelection', opt);
            // Sync globally
            settingsService.updateSettings({ [key]: result.url }).catch(console.error);
        } catch (err) {
            console.error('Failed to upload logo to Cloudflare Storage:', err);
            toast.error('Failed to upload logo. Please try again.');
        } finally {
            setUploadingLogo(null);
        }
    };

    // ── Last page designs ─────────────────────────────────────────────────
    const endPageDesigns = options.endPageDesigns ?? [];
    /** Slot being uploaded into: an index to replace, or 'new'. */
    const [uploadingEndPage, setUploadingEndPage] = useState<number | 'new' | null>(null);

    /** Save the design list (here and for the whole workspace) and the selection. */
    const saveEndPages = (designs: string[], lastPage: string | undefined) => {
        setOptions(prev => {
            const next = { ...prev, endPageDesigns: designs, lastPage };
            localforage.setItem('vayu-pdf-options', next).catch(console.error);
            return next;
        });
        settingsService.updateSettings({ endPageDesigns: designs }).catch(console.error);
    };

    const handleEndPageUpload = async (e: React.ChangeEvent<HTMLInputElement>, replaceIndex: number | null) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // allow re-picking the same file
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            toast.error('Choose an image (JPG, PNG or WebP) for the last page.');
            return;
        }
        if (replaceIndex === null && endPageDesigns.length >= MAX_END_PAGES) return;
        setUploadingEndPage(replaceIndex ?? 'new');
        try {
            const { url } = await storageService.upload(file);
            const designs = [...endPageDesigns];
            let lastPage = options.lastPage;
            if (replaceIndex === null) {
                designs.push(url);
                lastPage = url; // a new design is usually meant for this catalog
            } else {
                if (lastPage === designs[replaceIndex]) lastPage = url;
                designs[replaceIndex] = url;
            }
            saveEndPages(designs, lastPage);
            toast.success(replaceIndex === null ? 'Last page design saved' : 'Design replaced');
        } catch (err) {
            console.error('Failed to upload the last page design:', err);
            toast.error('Failed to upload the design. Please try again.');
        } finally {
            setUploadingEndPage(null);
        }
    };

    const handleEndPageDelete = (index: number) => {
        const removed = endPageDesigns[index];
        const designs = endPageDesigns.filter((_, i) => i !== index);
        saveEndPages(designs, options.lastPage === removed ? undefined : options.lastPage);
        toast.success('Design deleted');
    };

    /** Enlarged design: held open by a press ('hold') or opened from the keyboard ('dialog'). */
    const [endPagePreview, setEndPagePreview] = useState<{ url: string; mode: 'hold' | 'dialog' } | null>(null);

    // ── Logo geometry ─────────────────────────────────────────────────────
    const logoSize = logoSizeMm(options);
    const logoOffsetX = options.logoOffsetX ?? 0;
    const logoOffsetY = options.logoOffsetY ?? 0;
    const logoTuned = logoSize !== LOGO_DEFAULT_SIZE_MM || logoOffsetX !== 0 || logoOffsetY !== 0;

    // ── What the PDF will contain ─────────────────────────────────────────
    // Same palette, background and page plan the generator uses, so the
    // preview and the page count are the real thing, not a mock.
    const palette = getThemePalette(selectedTheme, options);
    const pageBg = pageBackgroundCss(selectedTheme, palette.bg, options);
    const activeThemeInfo = THEME_INFO.find(t => t.id === selectedTheme) ?? THEME_INFO[0];
    const pages = useMemo(
        () => planCatalogPages(catalogArtworks, options),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [catalogArtworks, options.pageOptions],
    );
    const artPageCount = pages.length;
    // The chosen end-page design follows every artwork page, once.
    const previewPages = useMemo<PreviewPage[]>(() => [
        ...pages.map(page => ({ kind: 'art' as const, page })),
        ...(options.lastPage ? [{ kind: 'end' as const, url: options.lastPage }] : []),
    ], [pages, options.lastPage]);
    const pageCount = previewPages.length;

    /** How many pages each page option contributes, shown beside it. */
    const pageContribution = useMemo(() => ({
        'Main Image': catalogArtworks.length,
        '2nd Image': catalogArtworks.filter(a => !!a.imageUrls?.[1]).length,
        'All Image': catalogArtworks.reduce((n, a) => n + Math.max(0, (a.imageUrls?.length ?? 0) - 2), 0),
    }), [catalogArtworks]);

    const selectedLogo = options.logoSelection === 'Select 1' ? options.customLogo1 : options.customLogo2;
    // The generator falls back to the catalog cover, then to a letter mark.
    const logoUrl = selectedLogo || catalog?.coverImageUrl || undefined;

    // The logo's natural size: the preview sizes and places it from this with
    // the same function the generator uses. Only the aspect ratio matters.
    const [logoNatural, setLogoNatural] = useState<{ url: string; w: number; h: number } | null>(null);
    useEffect(() => {
        if (!logoUrl) return;
        let live = true;
        const probe = new Image();
        probe.onload = () => { if (live) setLogoNatural({ url: logoUrl, w: probe.naturalWidth, h: probe.naturalHeight }); };
        probe.src = getThumbUrl(logoUrl);
        return () => { live = false; };
    }, [logoUrl]);
    const logoSizePx = logoNatural && logoNatural.url === logoUrl ? logoNatural : null;

    // ── Page navigation in the preview ────────────────────────────────────
    const [pageIdx, setPageIdx] = useState(0);
    useEffect(() => {
        setPageIdx(i => Math.min(i, Math.max(0, pageCount - 1)));
    }, [pageCount]);
    const goPage = useCallback((delta: number) => {
        setPageIdx(i => Math.max(0, Math.min(pageCount - 1, i + delta)));
    }, [pageCount]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const el = e.target as HTMLElement | null;
            if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
            if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); goPage(1); }
            else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); goPage(-1); }
            else if (e.key === 'Escape' && showMobilePreview) setShowMobilePreview(false);
        };
        globalThis.addEventListener('keydown', onKey);
        return () => globalThis.removeEventListener('keydown', onKey);
    }, [goPage, showMobilePreview]);

    // ── Section jump bar + scroll-spy ─────────────────────────────────────
    const scrollRef = useRef<HTMLDivElement>(null);
    const groupRefs = useRef<Record<Group, HTMLElement | null>>({ style: null, logo: null, content: null });
    const [activeGroup, setActiveGroup] = useState<Group>('style');

    const onSettingsScroll = () => {
        const root = scrollRef.current;
        if (!root) return;
        // At the very bottom the last group can't reach the top edge, so it
        // would never light up — treat the bottom as belonging to it.
        if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) {
            setActiveGroup('content');
            return;
        }
        const top = root.getBoundingClientRect().top;
        let current: Group = 'style';
        for (const { id } of GROUPS) {
            const el = groupRefs.current[id];
            if (el && el.getBoundingClientRect().top - top <= 48) current = id;
        }
        setActiveGroup(current);
    };

    const jumpTo = (id: Group) => {
        const root = scrollRef.current;
        const el = groupRefs.current[id];
        if (!root || !el) return;
        setActiveGroup(id);
        root.scrollTo({ top: el.offsetTop - 8, behavior: 'smooth' });
    };

    const currentPage: PreviewPage | undefined = previewPages[pageIdx];
    const catalogName = catalog?.name || 'Catalog';
    const artworkCountLabel = `${catalogArtworks.length} artwork${catalogArtworks.length === 1 ? '' : 's'}`;
    const pageCountLabel = `${pageCount} page${pageCount === 1 ? '' : 's'}`;
    const descriptionHidden = !!options.showDescription && !(options.pageOptions || []).includes('2nd Image');

    const previewProps = {
        palette, pageBg, options, logoUrl, logoSizePx, catalogName, imageShadow, themeId: selectedTheme,
    };

    return (
        <div className="absolute inset-0 bg-[var(--neu-bg)] z-50 flex flex-col lg:flex-row animate-fade-in-up">

            {/* ═══════════════════ Settings column ═══════════════════ */}
            <div className="flex flex-col flex-1 min-w-0 min-h-0 lg:flex-none lg:w-[27rem] xl:w-[29rem] lg:shrink-0 lg:h-full lg:border-r lg:border-gray-200/60 dark:lg:border-white/5">

                {/* Header */}
                <div className="flex items-center gap-3 px-4 pb-3 pt-[calc(1rem+var(--safe-top))] lg:pt-5">
                    <button onClick={onClose} className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale" aria-label="Back to catalogs">
                        <ChevronLeft size={20} strokeWidth={1.8} />
                    </button>
                    <div className="min-w-0 flex-1">
                        <h2 className="text-xl font-serif leading-tight tracking-wide text-gold-700 dark:text-gold-300 truncate">Catalog Studio</h2>
                        <p className="text-[11px] uppercase tracking-[0.12em] text-gray-600 dark:text-gray-400 font-light truncate">
                            {catalogName} · {artworkCountLabel}
                        </p>
                    </div>
                </div>

                {/* Jump bar — every setting stays on screen; this just scrolls to a group */}
                <div className="px-4 pb-3">
                    <div className="flex neu-inset p-1 rounded-full" role="tablist" aria-label="Settings sections">
                        {GROUPS.map(g => (
                            <button
                                key={g.id}
                                role="tab"
                                aria-selected={activeGroup === g.id}
                                onClick={() => jumpTo(g.id)}
                                className={`flex-1 py-1.5 text-xs font-medium rounded-full transition-all ${activeGroup === g.id
                                    ? 'neu-raised-sm text-gold-700 dark:text-gold-300'
                                    : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'
                                    }`}
                            >
                                {g.label}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Settings */}
                <div
                    ref={scrollRef}
                    onScroll={onSettingsScroll}
                    className="relative flex-1 min-h-0 overflow-y-auto no-scrollbar px-4 pb-6 space-y-4"
                >
                    {/* ─────────── STYLE ─────────── */}
                    {/* Groups carry no heading of their own: the jump bar above
                        already names them and lights up the one in view. */}
                    <div ref={el => { groupRefs.current.style = el; }} className="space-y-4 pt-1">
                        <StudioSection title="Theme" hint={activeThemeInfo.desc}>
                            <div className="grid grid-cols-5 gap-2">
                                {THEME_INFO.map(theme => {
                                    const selected = selectedTheme === theme.id;
                                    return (
                                        <button
                                            key={theme.id}
                                            type="button"
                                            onClick={() => updateTheme(theme.id)}
                                            aria-pressed={selected}
                                            aria-label={`${theme.name} theme`}
                                            className="group flex flex-col items-center gap-1.5 active-scale"
                                        >
                                            <ThemeThumb themeId={theme.id} selected={selected} sample={catalogArtworks[0]} />
                                            <span className={`text-[10px] leading-tight text-center ${selected ? 'font-semibold text-gold-700 dark:text-gold-300' : 'text-gray-600 dark:text-gray-400'}`}>
                                                {theme.name}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        </StudioSection>

                        <StudioSection
                            title="Page colour"
                            hint={colorPalette === 'Default' ? 'Using the theme colour' : colorPalette}
                        >
                            {/* Theme default + 12 main colours */}
                            <div className="grid grid-cols-[repeat(13,minmax(0,1fr))] gap-1.5 mb-4">
                                <button
                                    type="button"
                                    onClick={() => updateOption('colorPalette', 'Default')}
                                    aria-label="Use the theme colour"
                                    title="Theme colour"
                                    aria-pressed={colorPalette === 'Default'}
                                    className={`aspect-square rounded-full overflow-hidden active-scale ${colorPalette === 'Default' ? 'ring-2 ring-gold-500 ring-offset-2 ring-offset-[var(--neu-bg)]' : 'neu-raised-sm'}`}
                                    style={{ background: `linear-gradient(135deg, ${activeThemeInfo.bg} 50%, ${activeThemeInfo.fg} 50%)` }}
                                />
                                {MAIN_HUES.map(h => {
                                    const displayHex = mainColorHex(h);
                                    const appliedHex = hueToHex(h, intensity);
                                    const selected = hue === h && colorPalette === appliedHex;
                                    return (
                                        <button
                                            type="button"
                                            key={h}
                                            onClick={() => {
                                                setHue(h);
                                                applyColor(appliedHex, { colorHue: h, colorIntensity: intensity });
                                            }}
                                            aria-label={`Page colour ${displayHex}`}
                                            aria-pressed={selected}
                                            className={`aspect-square rounded-full flex items-center justify-center active-scale ${selected ? 'ring-2 ring-gold-500 ring-offset-2 ring-offset-[var(--neu-bg)]' : 'neu-raised-sm'}`}
                                            style={{ background: displayHex }}
                                        >
                                            {selected && (
                                                <Check size={10} strokeWidth={3} className={isLightHex(displayHex) ? 'text-gray-800' : 'text-white'} />
                                            )}
                                        </button>
                                    );
                                })}
                            </div>

                            {/* Intensity */}
                            <div className="flex items-center gap-3 mb-4">
                                <span className="text-[10px] uppercase tracking-[0.12em] text-gray-600 dark:text-gray-400 w-14 shrink-0">Depth</span>
                                <input
                                    type="range"
                                    min={0}
                                    max={100}
                                    value={intensity}
                                    onChange={(e) => {
                                        const i = Number(e.target.value);
                                        setIntensity(i);
                                        applyColor(hueToHex(hue, i), { colorHue: hue, colorIntensity: i });
                                    }}
                                    aria-label="Colour depth"
                                    className="hue-slider flex-1"
                                    style={{
                                        background: `linear-gradient(to right, ${hueToHex(hue, 0)}, ${hueToHex(hue, 50)}, ${hueToHex(hue, 100)})`,
                                    }}
                                />
                                <span
                                    className="w-6 h-6 rounded-full shrink-0 neu-raised-sm"
                                    style={{ background: colorPalette.startsWith('#') ? colorPalette : hueToHex(hue, intensity) }}
                                />
                            </div>

                            {/* Recent colours + hex entry */}
                            <div className="flex items-center gap-3">
                                <span className="text-[10px] uppercase tracking-[0.12em] text-gray-600 dark:text-gray-400 w-14 shrink-0">Recent</span>
                                <div className="flex gap-1.5 shrink-0">
                                    {RECENT_COLOR_SLOTS.map((slotId, idx) => {
                                        const recent = options.recentColors?.[idx];
                                        if (!recent) {
                                            return <span key={slotId} className="w-5 h-5 rounded-full neu-inset shrink-0" />;
                                        }
                                        const selected = colorPalette === recent;
                                        return (
                                            <button
                                                type="button"
                                                key={recent}
                                                onClick={() => applyColor(recent)}
                                                aria-label={`Recent colour ${recent}`}
                                                aria-pressed={selected}
                                                className={`w-5 h-5 rounded-full shrink-0 flex items-center justify-center active-scale ${selected ? 'ring-2 ring-gold-500 ring-offset-1 ring-offset-[var(--neu-bg)]' : 'neu-raised-sm'}`}
                                                style={{ background: recent }}
                                            >
                                                {selected && (
                                                    <Check size={9} strokeWidth={3} className={isLightHex(recent) ? 'text-gray-800' : 'text-white'} />
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>
                                <div className="flex flex-1 min-w-0 items-center gap-1.5">
                                    <input
                                        type="text"
                                        value={hexInput}
                                        onChange={(e) => setHexInput(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === 'Enter') { handleSaveColor(); (e.target as HTMLInputElement).blur(); } }}
                                        placeholder="#hex"
                                        aria-label="Hex colour code"
                                        maxLength={7}
                                        spellCheck={false}
                                        autoCapitalize="off"
                                        className="neu-field min-w-0 flex-1 py-1 px-2.5 text-xs rounded-full"
                                    />
                                    <button
                                        type="button"
                                        onClick={handleSaveColor}
                                        aria-label="Apply and save colour"
                                        title="Apply and save colour"
                                        className="neu-icon-btn-sm text-gold-700 dark:text-gold-300 active-scale"
                                    >
                                        <Check size={13} strokeWidth={2.5} />
                                    </button>
                                </div>
                            </div>
                        </StudioSection>

                        <StudioSection title="Background" hint="How the colour falls across the page">
                            <div className="grid grid-cols-6 gap-2">
                                {GRADIENT_STYLES.map(opt => {
                                    const selected = gradientStyle === opt;
                                    return (
                                        <button
                                            key={opt}
                                            type="button"
                                            onClick={() => updateOption('gradientStyle', opt)}
                                            aria-pressed={selected}
                                            className="flex flex-col items-center gap-1.5 active-scale"
                                        >
                                            <span
                                                className={`w-full aspect-[210/297] rounded-md ${selected ? 'ring-2 ring-gold-500 ring-offset-2 ring-offset-[var(--neu-bg)]' : 'neu-raised-sm'}`}
                                                style={{ background: pageBackgroundCss(selectedTheme, palette.bg, { ...options, gradientStyle: opt }) }}
                                            />
                                            <span className={`text-[10px] leading-none ${selected ? 'font-semibold text-gold-700 dark:text-gold-300' : 'text-gray-600 dark:text-gray-400'}`}>
                                                {opt}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        </StudioSection>

                        <StudioSection title="Images">
                            <div className="space-y-1">
                                <ToggleRow
                                    title="Remove background"
                                    description={selectedTheme === 5 ? 'On by default for Gradient Cutout' : 'Cuts each artwork out of its photo'}
                                    checked={removeBackground}
                                    onChange={() => updateOption('removeBackground', !removeBackground)}
                                />
                                <ToggleRow
                                    title="Drop shadow"
                                    description="A soft shadow under each image"
                                    checked={imageShadow}
                                    onChange={() => updateOption('imageShadow', !imageShadow)}
                                />
                            </div>
                        </StudioSection>
                    </div>

                    {/* ─────────── LOGO ─────────── */}
                    <div ref={el => { groupRefs.current.logo = el; }} className="space-y-4 pt-4">
                        <StudioSection title="Logo" hint="Upload up to two and pick one per catalog">
                            <div className="grid grid-cols-2 gap-3">
                                {(['Select 1', 'Select 2'] as const).map((opt, i) => {
                                    const custom = opt === 'Select 1' ? options.customLogo1 : options.customLogo2;
                                    const selected = options.logoSelection === opt;
                                    const shown = custom || catalog?.coverImageUrl;
                                    let caption = 'Letter mark';
                                    if (custom) caption = `Logo ${i + 1}`;
                                    else if (catalog?.coverImageUrl) caption = 'Catalog cover';
                                    return (
                                        <div key={opt} className="relative">
                                            <button
                                                type="button"
                                                onClick={() => updateOption('logoSelection', opt)}
                                                aria-pressed={selected}
                                                aria-label={`Use ${custom ? `logo ${i + 1}` : caption.toLowerCase()}`}
                                                className={`w-full rounded-xl p-2.5 text-left active-scale transition-shadow ${selected ? 'neu-inset ring-1 ring-gold-500/60' : 'neu-raised-sm'}`}
                                            >
                                                <span className="block w-full aspect-[16/10] rounded-lg neu-inset overflow-hidden flex items-center justify-center p-2">
                                                    {shown ? (
                                                        <img src={getThumbUrl(shown)} alt="" className="max-w-full max-h-full object-contain" />
                                                    ) : (
                                                        <span className="font-serif text-2xl" style={{ color: rgbCss(palette.gold) }}>A.</span>
                                                    )}
                                                </span>
                                                <span className="flex items-center gap-1.5 mt-2 pr-8">
                                                    <span className={`w-3.5 h-3.5 rounded-full ${selected ? 'neu-check-on' : 'neu-check'}`}>
                                                        {selected && <Check size={8} strokeWidth={3.5} />}
                                                    </span>
                                                    <span className={`text-[11px] truncate ${selected ? 'font-semibold text-gold-700 dark:text-gold-300' : 'text-gray-700 dark:text-gray-300'}`}>
                                                        {caption}
                                                    </span>
                                                </span>
                                            </button>
                                            {/* Upload is a sibling of the select button, not nested
                                                inside it — nested controls can't be told apart. */}
                                            <label
                                                title={custom ? `Replace logo ${i + 1}` : `Upload logo ${i + 1}`}
                                                className="absolute bottom-2 right-2 neu-icon-btn-sm text-gray-600 dark:text-gray-300 cursor-pointer active-scale"
                                            >
                                                {uploadingLogo === opt ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                                                <span className="sr-only">{custom ? `Replace logo ${i + 1}` : `Upload logo ${i + 1}`}</span>
                                                <input type="file" className="hidden" accept="image/*" disabled={!!uploadingLogo} onChange={(e) => handleLogoUpload(e, opt)} />
                                            </label>
                                        </div>
                                    );
                                })}
                            </div>
                        </StudioSection>

                        <StudioSection
                            title="Placement"
                            hint={`${options.logoPlacement ?? 'Top Right'} · ${formatMm(logoSize)} mm${logoTuned ? ' · adjusted' : ''}`}
                        >
                            <div className="flex gap-4">
                                {/* Mini page: tap where the logo goes */}
                                <div
                                    role="radiogroup"
                                    aria-label="Logo placement"
                                    className="relative w-[4.75rem] aspect-[210/297] rounded-md neu-inset shrink-0 grid grid-cols-3 grid-rows-3 p-1.5 gap-1"
                                >
                                    {PLACEMENT_GRID.map((cell, idx) => {
                                        if (!cell) return <span key={`gap-${idx}`} aria-hidden="true" />;
                                        const selected = (options.logoPlacement ?? 'Top Right') === cell;
                                        return (
                                            <button
                                                key={cell}
                                                type="button"
                                                role="radio"
                                                aria-checked={selected}
                                                aria-label={cell}
                                                title={cell}
                                                onClick={() => setOptions(prev => {
                                                    // A new spot starts without the old spot's nudge.
                                                    const next = { ...prev, logoPlacement: cell, logoOffsetX: 0, logoOffsetY: 0 };
                                                    localforage.setItem('vayu-pdf-options', next).catch(console.error);
                                                    return next;
                                                })}
                                                className="flex items-center justify-center rounded-[3px] active-scale"
                                            >
                                                <span
                                                    className={`w-full aspect-square rounded-[2px] transition-colors ${selected ? '' : 'bg-gray-400/35 dark:bg-white/15'}`}
                                                    style={selected ? { background: rgbCss(palette.gold) } : undefined}
                                                />
                                            </button>
                                        );
                                    })}
                                </div>

                                <div className="flex-1 min-w-0 space-y-2.5">
                                    <MmSlider
                                        id="logo-size"
                                        label="Size"
                                        value={logoSize}
                                        min={LOGO_MIN_SIZE_MM}
                                        max={LOGO_MAX_SIZE_MM}
                                        onChange={v => updateOption('logoSize', v)}
                                    />
                                    <MmSlider
                                        id="logo-offset-x"
                                        label="Left – right"
                                        value={logoOffsetX}
                                        min={-LOGO_MAX_OFFSET_MM}
                                        max={LOGO_MAX_OFFSET_MM}
                                        onChange={v => updateOption('logoOffsetX', v)}
                                    />
                                    <MmSlider
                                        id="logo-offset-y"
                                        label="Up – down"
                                        value={logoOffsetY}
                                        min={-LOGO_MAX_OFFSET_MM}
                                        max={LOGO_MAX_OFFSET_MM}
                                        onChange={v => updateOption('logoOffsetY', v)}
                                    />
                                </div>
                            </div>
                            <div className="mt-3 flex items-center justify-between gap-3">
                                <p className="text-[11px] text-gray-600 dark:text-gray-400 font-light">
                                    Keeps its proportions and stays inside the page border.
                                </p>
                                <button
                                    type="button"
                                    disabled={!logoTuned}
                                    onClick={() => setOptions(prev => {
                                        const next = { ...prev, logoSize: LOGO_DEFAULT_SIZE_MM, logoOffsetX: 0, logoOffsetY: 0 };
                                        localforage.setItem('vayu-pdf-options', next).catch(console.error);
                                        return next;
                                    })}
                                    className="shrink-0 inline-flex items-center gap-1 text-[11px] font-medium text-gold-700 dark:text-gold-300 disabled:opacity-40 active-scale"
                                >
                                    <RotateCcw size={11} /> Reset
                                </button>
                            </div>
                        </StudioSection>
                    </div>

                    {/* ─────────── CONTENT ─────────── */}
                    <div ref={el => { groupRefs.current.content = el; }} className="space-y-4 pt-4">
                        <StudioSection title="Details on the page" hint="Printed under each artwork's main image">
                            <div className="grid grid-cols-2 gap-2">
                                {CONTENT_FIELDS.map(({ key, label, icon: Icon }) => {
                                    const on = !!options[key];
                                    return (
                                        <button
                                            key={key}
                                            type="button"
                                            onClick={() => updateOption(key, !on)}
                                            aria-pressed={on}
                                            className={`flex items-center gap-2 rounded-xl px-3 py-2.5 text-left active-scale transition-colors ${on
                                                ? 'neu-inset text-gold-700 dark:text-gold-300'
                                                : 'neu-raised-sm text-gray-600 dark:text-gray-400'
                                                }`}
                                        >
                                            <Icon size={14} strokeWidth={on ? 2 : 1.6} className="shrink-0" />
                                            <span className={`text-xs truncate ${on ? 'font-medium' : ''}`}>{label}</span>
                                        </button>
                                    );
                                })}
                            </div>
                            {descriptionHidden && (
                                <p className="mt-3 flex items-start gap-2 text-[11px] text-amber-700 dark:text-amber-400">
                                    <TriangleAlert size={13} className="shrink-0 mt-px" />
                                    Descriptions print on the second-image page — turn on <span className="font-semibold">Second image</span> below.
                                </p>
                            )}
                        </StudioSection>

                        <StudioSection title="Pages" hint="Which photos of each artwork get a page">
                            <div className="space-y-2">
                                {([
                                    { id: 'Main Image', label: 'Main image', desc: 'With title, medium, size and price' },
                                    { id: '2nd Image', label: 'Second image', desc: 'Its own page, with the description' },
                                    { id: 'All Image', label: 'Remaining images', desc: 'One page per photo from the 3rd on' },
                                ] as const).map(opt => {
                                    const on = (options.pageOptions || []).includes(opt.id);
                                    const adds = pageContribution[opt.id];
                                    return (
                                        <button
                                            key={opt.id}
                                            type="button"
                                            onClick={() => {
                                                const current = options.pageOptions || [];
                                                updateOption('pageOptions', on ? current.filter(id => id !== opt.id) : [...current, opt.id]);
                                            }}
                                            aria-pressed={on}
                                            className={`w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left active-scale ${on ? 'neu-inset' : 'neu-raised-sm'}`}
                                        >
                                            <span className={`w-[18px] h-[18px] rounded-[5px] shrink-0 ${on ? 'neu-check-on' : 'neu-check'}`}>
                                                {on && <Check size={11} strokeWidth={3} />}
                                            </span>
                                            <span className="flex-1 min-w-0">
                                                <span className={`block text-xs ${on ? 'font-semibold text-gold-700 dark:text-gold-300' : 'font-medium text-gray-800 dark:text-gray-200'}`}>{opt.label}</span>
                                                <span className="block text-[11px] text-gray-600 dark:text-gray-400 font-light truncate">{opt.desc}</span>
                                            </span>
                                            <span className="neu-badge shrink-0 tabular-nums">+{adds}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </StudioSection>

                        <LastPageSection
                            designs={endPageDesigns}
                            selected={options.lastPage}
                            pageBg={pageBg}
                            uploading={uploadingEndPage}
                            onSelect={url => updateOption('lastPage', url)}
                            onUpload={handleEndPageUpload}
                            onDelete={handleEndPageDelete}
                            onPreview={setEndPagePreview}
                        />
                    </div>
                </div>

                {/* Footer — generate. Its bottom padding tucks into the iPhone
                    home-indicator strip like the dock does; clearing the whole
                    strip (on the page root) left a band of dead space under it. */}
                <div className="shrink-0 border-t border-gray-200/70 dark:border-white/5 px-4 pt-3 pb-[calc(0.75rem+var(--safe-bottom-tucked))] bg-[var(--neu-bg)]">
                    {artPageCount === 0 && (
                        <p className="mb-2 flex items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                            <TriangleAlert size={12} className="shrink-0" />
                            These page options produce no pages for this catalog.
                        </p>
                    )}
                    {isGeneratingPDF && (
                        <GenerationProgress progress={generationProgress ?? null} removeBackground={removeBackground} />
                    )}
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => setShowMobilePreview(true)}
                            className="lg:hidden neu-button px-3.5 py-3 shrink-0"
                            aria-label="Preview pages"
                        >
                            <Eye size={17} strokeWidth={1.8} />
                        </button>
                        <button
                            onClick={() => onGeneratePDF(options, selectedTheme)}
                            disabled={isGeneratingPDF || artPageCount === 0}
                            className="neu-button neu-button-primary flex-1 py-3 text-sm tracking-wide active-scale disabled:opacity-60"
                        >
                            {isGeneratingPDF ? (
                                <span className="flex items-center justify-center gap-2 min-w-0">
                                    <Loader2 size={15} className="animate-spin shrink-0" />
                                    <span className="truncate">Creating… {Math.round(overallProgress(generationProgress ?? null, removeBackground) * 100)}%</span>
                                </span>
                            ) : (
                                <span className="flex items-center justify-center gap-2">
                                    Generate PDF
                                    <span className="text-[11px] font-normal opacity-70">· {pageCountLabel}</span>
                                </span>
                            )}
                        </button>
                    </div>
                </div>
            </div>

            {/* ═══════════════════ Preview (desktop) ═══════════════════ */}
            <div className="hidden lg:flex flex-col flex-1 min-w-0 h-full">
                <PreviewToolbar
                    themeName={activeThemeInfo.name}
                    pageCountLabel={pageCountLabel}
                    page={currentPage}
                    pageIdx={pageIdx}
                    pageCount={pageCount}
                    removeBackground={removeBackground}
                    onPrev={() => goPage(-1)}
                    onNext={() => goPage(1)}
                />
                <div className="flex-1 min-h-0 px-8 pb-8 pt-2" style={{ containerType: 'size' }}>
                    <div className="w-full h-full flex items-center justify-center">
                        {currentPage
                            ? <AnyPagePreview page={currentPage} hiRes {...previewProps} />
                            : <EmptyPreview />}
                    </div>
                </div>
            </div>

            {/* ═══════════════════ Preview (phone overlay) ═══════════════════ */}
            {showMobilePreview && (
                <div className="absolute inset-0 z-[80] bg-black/70 backdrop-blur-sm lg:hidden flex flex-col animate-fade-in">
                    <div className="flex justify-between items-center px-3 pt-[calc(0.75rem+var(--safe-top))] pb-2">
                        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/80 pl-2">
                            {activeThemeInfo.name} · {pageCountLabel}
                        </span>
                        <button className="w-9 h-9 rounded-full bg-white/10 text-white flex items-center justify-center active-scale" aria-label="Close preview" onClick={() => setShowMobilePreview(false)}>
                            <X size={18} />
                        </button>
                    </div>
                    <div className="flex-1 min-h-0 px-4" style={{ containerType: 'size' }}>
                        <div className="w-full h-full flex items-center justify-center">
                            {currentPage
                                ? <AnyPagePreview page={currentPage} {...previewProps} />
                                : <EmptyPreview dark />}
                        </div>
                    </div>
                    {pageCount > 0 && (
                        <div className="flex items-center justify-center gap-4 py-4 pb-[calc(1rem+var(--safe-bottom-ui))]">
                            <button onClick={() => goPage(-1)} disabled={pageIdx === 0} className="w-10 h-10 rounded-full bg-white/10 text-white flex items-center justify-center disabled:opacity-30 active-scale" aria-label="Previous page">
                                <ChevronLeft size={20} />
                            </button>
                            <span className="text-xs text-white/80 tabular-nums">Page {pageIdx + 1} of {pageCount}</span>
                            <button onClick={() => goPage(1)} disabled={pageIdx >= pageCount - 1} className="w-10 h-10 rounded-full bg-white/10 text-white flex items-center justify-center disabled:opacity-30 active-scale" aria-label="Next page">
                                <ChevronRight size={20} />
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* Enlarged end-page design (press-and-hold, or the preview button) */}
            {endPagePreview && (
                <EndPagePreviewOverlay
                    url={endPagePreview.url}
                    dialog={endPagePreview.mode === 'dialog'}
                    pageBg={pageBg}
                    onClose={() => setEndPagePreview(null)}
                />
            )}
        </div>
    );
};

/* ------------------------------------------------------------------ */
/*  Generation progress                                                */
/* ------------------------------------------------------------------ */

type ProgressStep = 'model' | 'pages' | 'assembling' | 'saving';

/** How much of the whole job each step is, roughly by how long it takes. */
const stepWeights = (removeBackground: boolean): Record<ProgressStep, number> => (removeBackground
    ? { model: 0.25, pages: 0.65, assembling: 0.05, saving: 0.05 }
    : { model: 0, pages: 0.86, assembling: 0.07, saving: 0.07 });

const STEP_ORDER: ProgressStep[] = ['model', 'pages', 'assembling', 'saving'];

/** How far through its own step the build is (0–1); steps without a count show some movement. */
const stepFraction = (progress: CatalogPdfProgress): number => {
    if (progress.stage === 'model') return progress.fraction;
    if (progress.stage === 'pages') return progress.total ? progress.done / progress.total : 0;
    return 0.4;
};

/** The whole job, 0–1: finished steps plus the part of the current one. */
const overallProgress = (progress: CatalogPdfProgress | null, removeBackground: boolean): number => {
    if (!progress || progress.stage === 'preparing') return 0;
    const weights = stepWeights(removeBackground);
    const current = STEP_ORDER.indexOf(progress.stage);
    const done = STEP_ORDER.slice(0, current).reduce((sum, step) => sum + weights[step], 0);
    return Math.min(1, done + weights[progress.stage] * stepFraction(progress));
};

/** What the current step is doing, in plain words. */
const stepDetail = (progress: CatalogPdfProgress): string => {
    switch (progress.stage) {
        case 'model':
            return progress.fraction < 1
                ? `Downloading · ${Math.round(progress.fraction * 100)}% (first time on this device only)`
                : 'Starting it up…';
        case 'pages': {
            const page = Math.min(progress.done + 1, progress.total);
            return `Page ${page} of ${progress.total}${progress.title ? ` · ${progress.title}` : ''}`;
        }
        case 'assembling':
            return 'Putting the pages together';
        case 'saving':
            return 'Uploading so it appears in Catalogs';
        default:
            return 'Getting started…';
    }
};

type StepState = 'done' | 'current' | 'waiting';
const STEP_TEXT: Record<StepState, string> = {
    done: 'text-gray-700 dark:text-gray-300',
    current: 'font-semibold text-gray-900 dark:text-gray-100',
    waiting: 'text-gray-500 dark:text-gray-400',
};
const STEP_SPOKEN: Record<StepState, string> = { done: 'done', current: 'in progress', waiting: 'waiting' };

const stepState = (i: number, currentIdx: number): StepState => {
    if (i < currentIdx) return 'done';
    return i === currentIdx ? 'current' : 'waiting';
};

/** Progress panel above the Generate button: one bar for the whole job, then the steps. */
const GenerationProgress: React.FC<{ progress: CatalogPdfProgress | null; removeBackground: boolean }> = ({ progress, removeBackground }) => {
    const steps: { id: ProgressStep; label: string }[] = [
        ...(removeBackground ? [{ id: 'model' as const, label: 'Get the AI model ready' }] : []),
        { id: 'pages', label: removeBackground ? 'Remove backgrounds and lay out pages' : 'Lay out pages' },
        { id: 'assembling', label: 'Build the PDF' },
        { id: 'saving', label: 'Save to Catalogs' },
    ];
    const stage = progress?.stage ?? 'preparing';
    const currentIdx = stage === 'preparing' ? -1 : steps.findIndex(step => step.id === stage);
    const pct = Math.round(overallProgress(progress, removeBackground) * 100);

    return (
        <div className="mb-3 rounded-2xl neu-inset p-3.5" aria-live="polite">
            <div className="flex items-baseline justify-between gap-3">
                <p className="text-xs font-semibold text-gray-800 dark:text-gray-100">Creating your catalog</p>
                <p className="text-sm font-semibold tabular-nums text-gold-700 dark:text-gold-300">{pct}%</p>
            </div>
            <div
                role="progressbar"
                aria-label="Catalog PDF progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
                className="mt-2 h-2 rounded-full bg-gray-300/50 dark:bg-white/10 overflow-hidden"
            >
                <div
                    className="h-full rounded-full bg-gradient-to-r from-gold-400 to-gold-600 transition-[width] duration-500 ease-out"
                    style={{ width: `${Math.max(pct, 3)}%` }}
                />
            </div>
            <ol className="mt-3 space-y-1.5">
                {steps.map((step, i) => {
                    const state = stepState(i, currentIdx);
                    return (
                        <li key={step.id} className="flex items-start gap-2 min-w-0">
                            <span className="mt-px w-4 h-4 shrink-0 flex items-center justify-center">
                                {state === 'done' && (
                                    <span className="w-4 h-4 rounded-full neu-check-on flex items-center justify-center">
                                        <Check size={9} strokeWidth={3.5} />
                                    </span>
                                )}
                                {state === 'current' && <Loader2 size={14} className="animate-spin text-gold-700 dark:text-gold-300" />}
                                {state === 'waiting' && <span className="w-3 h-3 rounded-full border border-gray-400/70 dark:border-white/25" />}
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className={`block text-[11px] leading-4 ${STEP_TEXT[state]}`}>
                                    <span className="sr-only">{`Step ${i + 1}, ${STEP_SPOKEN[state]}: `}</span>
                                    {step.label}
                                </span>
                                {state === 'current' && progress && (
                                    <span className="block text-[11px] leading-4 text-gray-600 dark:text-gray-400 truncate">{stepDetail(progress)}</span>
                                )}
                            </span>
                        </li>
                    );
                })}
            </ol>
        </div>
    );
};

/* ------------------------------------------------------------------ */
/*  Settings layout pieces                                             */
/* ------------------------------------------------------------------ */

const StudioSection: React.FC<{ title: string; hint?: string; children?: React.ReactNode }> = ({ title, hint, children }) => (
    <section className="neu-card p-4">
        <div className="mb-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-800 dark:text-gray-100">{title}</h3>
            {hint && <p className="mt-0.5 text-[11px] text-gray-600 dark:text-gray-400 font-light truncate">{hint}</p>}
        </div>
        {children}
    </section>
);

/** The six logo spots, laid out on a mini page: a top row and a bottom row. */
const PLACEMENT_GRID: (LogoPlacement | null)[] = [
    'Top Left', 'Top Center', 'Top Right',
    null, null, null,
    'Bottom Left', 'Bottom Center', 'Bottom Right',
];

const formatMm = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(1));

/** A millimetre value: slider plus a number box, kept in step. */
const MmSlider: React.FC<{
    id: string; label: string; value: number; min: number; max: number; step?: number;
    onChange: (value: number) => void;
}> = ({ id, label, value, min, max, step = 0.5, onChange }) => {
    // What is being typed; committed on Enter or when the box loses focus.
    const [draft, setDraft] = useState<string | null>(null);
    const commit = (raw: string) => {
        setDraft(null);
        const n = Number(raw);
        if (raw.trim() === '' || !Number.isFinite(n)) return;
        onChange(Math.min(max, Math.max(min, Math.round(n / step) * step)));
    };
    return (
        <div className="flex items-center gap-2">
            <label htmlFor={`${id}-range`} className="text-[10px] uppercase tracking-[0.1em] leading-tight text-gray-600 dark:text-gray-400 w-[4.25rem] shrink-0">
                {label}
            </label>
            <input
                id={`${id}-range`}
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={e => onChange(Number(e.target.value))}
                className="flex-1 min-w-0 accent-[var(--neu-gold)]"
            />
            <input
                type="number"
                inputMode="decimal"
                min={min}
                max={max}
                step={step}
                value={draft ?? formatMm(value)}
                onChange={e => setDraft(e.target.value)}
                onBlur={e => commit(e.target.value)}
                onKeyDown={e => {
                    if (e.key !== 'Enter') return;
                    commit(e.currentTarget.value);
                    e.currentTarget.blur();
                }}
                aria-label={`${label}, millimetres`}
                className="neu-field w-16 shrink-0 py-1 px-1 text-xs text-center rounded-lg tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
        </div>
    );
};

type EndPagePreviewRequest = { url: string; mode: 'hold' | 'dialog' } | null;

/** "Last page": up to five saved end-page designs, one of them (or none) chosen. */
const LastPageSection: React.FC<{
    designs: string[];
    selected?: string;
    pageBg: string;
    uploading: number | 'new' | null;
    onSelect: (url: string | undefined) => void;
    onUpload: (e: React.ChangeEvent<HTMLInputElement>, replaceIndex: number | null) => void;
    onDelete: (index: number) => void;
    onPreview: (request: EndPagePreviewRequest) => void;
}> = ({ designs, selected, pageBg, uploading, onSelect, onUpload, onDelete, onPreview }) => {
    // Delete asks for a second tap; the question lapses after a few seconds.
    const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
    useEffect(() => {
        if (confirmDelete === null) return;
        const timer = setTimeout(() => setConfirmDelete(null), 4000);
        return () => clearTimeout(timer);
    }, [confirmDelete]);

    const none = !selected;
    return (
        <StudioSection title="Last page" hint={selected ? 'Added once, after every other page' : 'The catalog ends with its last artwork'}>
            <div className="grid grid-cols-3 gap-3">
                <div className="flex flex-col items-center gap-1.5 min-w-0">
                    <button
                        type="button"
                        onClick={() => onSelect(undefined)}
                        aria-pressed={none}
                        aria-label="No last page"
                        className={`w-full aspect-[210/297] rounded-md flex items-center justify-center active-scale text-gray-500 dark:text-gray-400 ${none ? 'neu-inset ring-2 ring-gold-500 ring-offset-2 ring-offset-[var(--neu-bg)]' : 'neu-raised-sm'}`}
                    >
                        <X size={16} strokeWidth={1.6} />
                    </button>
                    <span className={`text-[10px] leading-tight text-center ${none ? 'font-semibold text-gold-700 dark:text-gold-300' : 'text-gray-600 dark:text-gray-400'}`}>No last page</span>
                </div>

                {designs.map((url, index) => (
                    <EndPageTile
                        key={url}
                        url={url}
                        index={index}
                        selected={selected === url}
                        pageBg={pageBg}
                        busy={uploading === index}
                        disabled={uploading !== null}
                        confirmingDelete={confirmDelete === index}
                        onSelect={() => onSelect(url)}
                        onReplace={e => onUpload(e, index)}
                        onDeleteTap={() => {
                            if (confirmDelete === index) {
                                setConfirmDelete(null);
                                onDelete(index);
                            } else {
                                setConfirmDelete(index);
                            }
                        }}
                        onPreview={onPreview}
                    />
                ))}

                {designs.length < MAX_END_PAGES && (
                    <div className="flex flex-col items-center gap-1.5 min-w-0">
                        <label className="w-full aspect-[210/297] rounded-md neu-inset flex items-center justify-center cursor-pointer active-scale text-gray-500 dark:text-gray-400 focus-within:ring-2 focus-within:ring-gold-500">
                            {uploading === 'new' ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} strokeWidth={1.8} />}
                            <span className="sr-only">Add a last page design</span>
                            <input type="file" accept="image/*" className="sr-only" disabled={uploading !== null} onChange={e => onUpload(e, null)} />
                        </label>
                        <span className="text-[10px] leading-tight text-center text-gray-600 dark:text-gray-400">Add design</span>
                    </div>
                )}
            </div>
            <p className="mt-3 text-[11px] text-gray-600 dark:text-gray-400 font-light">
                {designs.length} of {MAX_END_PAGES} saved · press and hold a design to see it larger
            </p>
        </StudioSection>
    );
};

/** One saved design: tap to choose, press and hold to enlarge; preview, replace and delete below. */
const EndPageTile: React.FC<{
    url: string;
    index: number;
    selected: boolean;
    pageBg: string;
    busy: boolean;
    disabled: boolean;
    confirmingDelete: boolean;
    onSelect: () => void;
    onReplace: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onDeleteTap: () => void;
    onPreview: (request: EndPagePreviewRequest) => void;
}> = ({ url, index, selected, pageBg, busy, disabled, confirmingDelete, onSelect, onReplace, onDeleteTap, onPreview }) => {
    const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** A hold opened the preview: the click that follows the release must not select. */
    const held = useRef(false);
    const showing = useRef(false);

    const endHold = () => {
        if (holdTimer.current) {
            clearTimeout(holdTimer.current);
            holdTimer.current = null;
        }
        if (showing.current) {
            showing.current = false;
            onPreview(null);
        }
    };
    const endHoldRef = useRef(endHold);
    endHoldRef.current = endHold;
    useEffect(() => () => endHoldRef.current(), []);

    const name = `Design ${index + 1}`;
    return (
        <div className="flex flex-col items-center gap-1.5 min-w-0">
            <button
                type="button"
                aria-pressed={selected}
                aria-label={`${name}: use as the last page`}
                onClick={() => {
                    if (held.current) {
                        held.current = false;
                        return;
                    }
                    onSelect();
                }}
                onPointerDown={e => {
                    held.current = false;
                    if (e.pointerType === 'mouse' && e.button !== 0) return;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    holdTimer.current = setTimeout(() => {
                        holdTimer.current = null;
                        held.current = true;
                        showing.current = true;
                        onPreview({ url, mode: 'hold' });
                    }, HOLD_PREVIEW_MS);
                }}
                onPointerUp={endHold}
                onPointerCancel={endHold}
                onLostPointerCapture={endHold}
                onContextMenu={e => e.preventDefault()}
                className={`relative w-full aspect-[210/297] rounded-md overflow-hidden select-none active-scale ${selected ? 'ring-2 ring-gold-500 ring-offset-2 ring-offset-[var(--neu-bg)]' : 'neu-raised-sm'}`}
                style={{ background: pageBg, WebkitTouchCallout: 'none' }}
            >
                <img src={getThumbUrl(url)} alt="" draggable={false} className="absolute inset-0 w-full h-full object-contain pointer-events-none" />
                {selected && (
                    <span className="absolute top-1 right-1 w-4 h-4 rounded-full neu-check-on flex items-center justify-center">
                        <Check size={9} strokeWidth={3.5} />
                    </span>
                )}
            </button>
            <div className="flex items-center gap-1">
                <button
                    type="button"
                    onClick={() => onPreview({ url, mode: 'dialog' })}
                    aria-label={`Preview ${name.toLowerCase()}`}
                    title="Preview"
                    className="neu-icon-btn-sm text-gray-600 dark:text-gray-300 active-scale"
                >
                    <Eye size={11} />
                </button>
                <label
                    title="Replace"
                    className="neu-icon-btn-sm text-gray-600 dark:text-gray-300 cursor-pointer active-scale focus-within:ring-2 focus-within:ring-gold-500"
                >
                    {busy ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
                    <span className="sr-only">Replace {name.toLowerCase()}</span>
                    <input type="file" accept="image/*" className="sr-only" disabled={disabled} onChange={onReplace} />
                </label>
                <button
                    type="button"
                    onClick={onDeleteTap}
                    aria-label={confirmingDelete ? `Tap again to delete ${name.toLowerCase()}` : `Delete ${name.toLowerCase()}`}
                    title={confirmingDelete ? 'Tap again to delete' : 'Delete'}
                    className={`neu-icon-btn-sm active-scale ${confirmingDelete ? 'text-red-600 dark:text-red-400 ring-1 ring-red-500/60' : 'text-gray-600 dark:text-gray-300'}`}
                >
                    <Trash2 size={11} />
                </button>
            </div>
        </div>
    );
};

/** A saved design, enlarged: held open by a press, or a dialog from the preview button. */
const EndPagePreviewOverlay: React.FC<{ url: string; dialog: boolean; pageBg: string; onClose: () => void }> = ({ url, dialog, pageBg, onClose }) => {
    const closeRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (!dialog) return;
        closeRef.current?.focus();
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            onClose();
        };
        // Capture: ahead of the studio's own Escape handling.
        globalThis.addEventListener('keydown', onKey, true);
        return () => globalThis.removeEventListener('keydown', onKey, true);
    }, [dialog, onClose]);

    return (
        <div
            className={`absolute inset-0 z-[90] bg-black/70 backdrop-blur-sm flex flex-col animate-fade-in ${dialog ? '' : 'pointer-events-none'}`}
            role={dialog ? 'dialog' : undefined}
            aria-modal={dialog || undefined}
            aria-label="Last page design"
        >
            {dialog && (
                <button type="button" tabIndex={-1} aria-hidden="true" className="absolute inset-0 cursor-default" onClick={onClose} />
            )}
            <div className="relative flex justify-end px-3 pt-[calc(0.75rem+var(--safe-top))] pb-2 min-h-12">
                {dialog && (
                    <button ref={closeRef} type="button" className="w-9 h-9 rounded-full bg-white/10 text-white flex items-center justify-center active-scale" aria-label="Close preview" onClick={onClose}>
                        <X size={18} />
                    </button>
                )}
            </div>
            <div className="relative flex-1 min-h-0 px-6 pb-[calc(1.5rem+var(--safe-bottom-ui))] pointer-events-none" style={{ containerType: 'size' }}>
                <div className="w-full h-full flex items-center justify-center">
                    <div className="relative overflow-hidden shrink-0" style={{ ...PAGE_FRAME_STYLE, background: pageBg }}>
                        <img src={url} alt="Last page design" draggable={false} className="absolute inset-0 w-full h-full object-contain" />
                    </div>
                </div>
            </div>
        </div>
    );
};

/** Miniature of a theme's default page — its real background, palette ink and
 *  gold, and the catalog's own first image — so the choice is visual. */
const ThemeThumb: React.FC<{ themeId: CatalogTheme; selected: boolean; sample?: Artwork }> = ({ themeId, selected, sample }) => {
    const pal = getThemePalette(themeId);
    const bg = pageBackgroundCss(themeId, pal.bg, { gradientStyle: 'Solid', colorPalette: 'Default' });
    const img = sample?.imageUrls?.[0];
    return (
        <span
            className={`relative w-full aspect-[210/297] rounded-md overflow-hidden transition-shadow ${selected ? 'ring-2 ring-gold-500 ring-offset-2 ring-offset-[var(--neu-bg)]' : 'neu-raised-sm'}`}
            style={{ background: bg }}
        >
            <span className="absolute inset-x-[8%] top-[6%] h-[64%] flex items-center justify-center">
                {img ? (
                    <img src={getThumbUrl(img)} alt="" loading="lazy" className={`max-w-full max-h-full object-contain ${themeId === 1 ? '' : 'rounded-[2px]'}`} />
                ) : (
                    <span className="w-full h-full rounded-[2px]" style={{ background: rgbCss(pal.lineColor), opacity: 0.25 }} />
                )}
            </span>
            <span className="absolute inset-x-[10%] top-[76%] h-px" style={{ background: rgbCss(pal.lineColor) }} />
            <span className="absolute left-[10%] top-[81%] w-[55%] h-[4%] rounded-full" style={{ background: rgbCss(pal.ink), opacity: 0.8 }} />
            <span className="absolute left-[10%] top-[89%] w-[35%] h-[3%] rounded-full" style={{ background: rgbCss(pal.gold) }} />
        </span>
    );
};

/* ------------------------------------------------------------------ */
/*  Preview                                                            */
/* ------------------------------------------------------------------ */

/** A page of the preview: an artwork page, or the chosen end-page design. */
type PreviewPage = { kind: 'art'; page: PlannedPage } | { kind: 'end'; url: string };

const pageLabel = (page: PlannedPage): string => {
    if (page.pageIndex === 0) return 'Main image';
    if (page.pageIndex === 1) return 'Second image';
    return `Image ${page.pageIndex + 1}`;
};

/** What the toolbar says about the page on screen. */
const describePage = (page: PreviewPage): React.ReactNode => {
    if (page.kind === 'end') return <span className="font-normal">Last page</span>;
    return <><span className="font-normal">{page.page.art.title || 'Untitled'}</span> — {pageLabel(page.page).toLowerCase()}</>;
};

const PreviewToolbar: React.FC<{
    themeName: string;
    pageCountLabel: string;
    page?: PreviewPage;
    pageIdx: number;
    pageCount: number;
    removeBackground: boolean;
    onPrev: () => void;
    onNext: () => void;
}> = ({ themeName, pageCountLabel, page, pageIdx, pageCount, removeBackground, onPrev, onNext }) => (
    <div className="flex items-center justify-between gap-4 px-8 pt-5 pb-3">
        <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-700 dark:text-gray-200">Live preview</p>
            <p className="text-[11px] text-gray-600 dark:text-gray-400 font-light truncate">
                {themeName} · A4 portrait · {pageCountLabel}
                {page && <> · {describePage(page)}</>}
            </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
            {/* The preview can't run the cutout model, so say so rather than fake it. */}
            {removeBackground && (
                <span className="neu-badge text-gold-700 dark:text-gold-300">Background removed on export</span>
            )}
            {pageCount > 0 && (
                <div className="flex items-center gap-2">
                    <button onClick={onPrev} disabled={pageIdx === 0} className="neu-icon-btn-sm active-scale" aria-label="Previous page" title="Previous page (←)">
                        <ChevronLeft size={15} />
                    </button>
                    <span className="text-xs text-gray-700 dark:text-gray-300 tabular-nums min-w-[5.5rem] text-center">
                        Page {pageIdx + 1} of {pageCount}
                    </span>
                    <button onClick={onNext} disabled={pageIdx >= pageCount - 1} className="neu-icon-btn-sm active-scale" aria-label="Next page" title="Next page (→)">
                        <ChevronRight size={15} />
                    </button>
                </div>
            )}
        </div>
    </div>
);

const EmptyPreview: React.FC<{ dark?: boolean }> = ({ dark = false }) => (
    <div className={`text-center max-w-xs ${dark ? 'text-white/80' : 'text-gray-600 dark:text-gray-400'}`}>
        <div className={`mx-auto mb-3 w-12 h-12 rounded-full flex items-center justify-center ${dark ? 'bg-white/10' : 'neu-inset'}`}>
            <FileText size={20} strokeWidth={1.5} />
        </div>
        <p className="font-serif text-base">No pages to preview</p>
        <p className="text-xs font-light mt-1">Turn on at least one page option that this catalog's artworks have photos for.</p>
    </div>
);

const TIMES = "'Times New Roman', Times, serif";

/** A preview page, fitted to its stage: as wide as it allows, unless the height runs out first. */
const PAGE_FRAME_STYLE: React.CSSProperties = {
    width: 'min(100cqw, calc(100cqh * 210 / 297))',
    aspectRatio: '210 / 297',
    boxShadow: '0 30px 60px -18px rgba(0,0,0,0.38), 0 2px 6px rgba(0,0,0,0.08)',
};

/** How far a text box shifts left to put its `align` point on x (as jsPDF aligns). */
const ALIGN_SHIFT = { left: '0%', center: '-50%', right: '-100%' } as const;

/** Absolutely-placed text whose *baseline* sits at (xMm, yMm), as jsPDF draws it. */
const PdfText: React.FC<{
    x: number; y: number; pt: number; color: string;
    italic?: boolean; spacingMm?: number; align?: 'left' | 'center' | 'right'; children?: React.ReactNode;
}> = ({ x, y, pt, color, italic = false, spacingMm = 0, align = 'left', children }) => (
    <span
        className="absolute whitespace-nowrap leading-none"
        style={{
            left: pctW(x),
            top: pctH(y),
            // Times: baseline ≈ 0.8em below the top of a 1em line box.
            transform: `translate(${ALIGN_SHIFT[align]}, -80%)`,
            fontSize: cqw(ptToMm(pt)),
            letterSpacing: spacingMm ? cqw(spacingMm) : undefined,
            fontStyle: italic ? 'italic' : undefined,
            color,
        }}
    >
        {children}
    </span>
);

/**
 * One page exactly as the generator lays it out (see drawSinglePage and
 * drawPage0Text / drawPage1Text in CatalogsView): image box above a hairline
 * at 252mm, logo in a corner, a thin border, and the text block beneath. Every
 * position is converted from the generator's millimetres; type is sized in
 * container units so the whole page scales as one.
 */
const PagePreview: React.FC<{
    page: PlannedPage;
    palette: ThemePalette;
    pageBg: string;
    options: PdfOptions;
    logoUrl?: string;
    /** The logo's natural size, once known; the logo is placed from it. */
    logoSizePx: { w: number; h: number } | null;
    catalogName: string;
    imageShadow: boolean;
    themeId: CatalogTheme;
    /** Full-size image on desktop; the phone overlay uses the thumbnail. */
    hiRes?: boolean;
}> = ({ page, palette, pageBg, options, logoUrl, logoSizePx, catalogName, imageShadow, themeId, hiRes = false }) => {
    const { art } = page;
    const hasText = pageHasText(page, options);
    const imgBoxH = hasText ? 250 : PAGE_H_MM - 4;
    const ink = rgbCss(palette.ink);
    const gold = rgbCss(palette.gold);
    const line = rgbCss(palette.lineColor);
    const logo = logoUrl && logoSizePx ? logoBox(options, logoSizePx.w, logoSizePx.h) : null;
    const mark = letterMark(options);
    const rounded = !(themeId === 1 || (options.removeBackground ?? themeId === 5));

    // Page 0 text rows, stepping y exactly as drawPage0Text does.
    const rows: React.ReactNode[] = [];
    if (page.pageIndex === 0) {
        let y = 258;
        if (options.showCatalogName) {
            rows.push(<PdfText key="cat" x={13} y={y} pt={12} color={gold} italic>{catalogName}</PdfText>);
            y += 6;
        }
        y += 2;
        if (options.showTitle) {
            rows.push(<PdfText key="title" x={13} y={y} pt={20} color={ink} spacingMm={2.2}>{(art.title || '').toUpperCase()}</PdfText>);
            y += 9;
        }
        if (options.showTitleNote && art.medium) {
            rows.push(
                <React.Fragment key="med">
                    <PdfText x={13} y={y} pt={14} color={gold}>MEDIUM</PdfText>
                    <PdfText x={46} y={y} pt={16} color={ink}>{art.medium}</PdfText>
                </React.Fragment>,
            );
            y += 9;
        }
        if (options.showDimensions && art.dimensions) {
            rows.push(
                <React.Fragment key="dim">
                    <PdfText x={13} y={y} pt={14} color={gold}>DIMENSIONS</PdfText>
                    <PdfText x={46} y={y} pt={16} color={ink}>{art.dimensions} inch</PdfText>
                    <PdfText x={106} y={y} pt={14} color={gold}>|</PdfText>
                    <PdfText x={114} y={y} pt={14} color={gold}>ITEM CODE</PdfText>
                    <PdfText x={144} y={y} pt={16} color={ink}>{art.customId || ''}</PdfText>
                </React.Fragment>,
            );
            y += 9;
        }
        if (options.showPrice) {
            const price = `${Number(art.price || 0).toLocaleString('en-IN')}${art.plusGst ? ' +GST' : ''}`;
            rows.push(
                <React.Fragment key="price">
                    <PdfText x={13} y={y} pt={14} color={gold}>PRICE</PdfText>
                    <PdfText x={46} y={y} pt={16} color={ink}>{price}</PdfText>
                </React.Fragment>,
            );
        }
    }

    const img = page.imgUrl ? (hiRes ? page.imgUrl : getThumbUrl(page.imgUrl)) : undefined;

    return (
        <div
            className="relative overflow-hidden shrink-0 transition-[background] duration-300"
            style={{ ...PAGE_FRAME_STYLE, background: pageBg, containerType: 'inline-size', fontFamily: TIMES }}
        >
            {/* Image box — x 2mm, y 2mm, 206mm wide, 250mm (or full) tall */}
            <div
                className="absolute flex items-center justify-center"
                style={{ left: pctW(2), top: pctH(2), width: pctW(206), height: pctH(imgBoxH) }}
            >
                {img ? (
                    <img
                        key={img}
                        src={img}
                        alt={art.title}
                        className="max-w-full max-h-full object-contain"
                        style={{
                            borderRadius: rounded ? cqw(3) : undefined,
                            filter: imageShadow ? 'drop-shadow(0 1.4cqw 2.2cqw rgba(0,0,0,0.32))' : undefined,
                        }}
                    />
                ) : (
                    <span className="flex flex-col items-center gap-1 opacity-40" style={{ color: ink, fontSize: cqw(4) }}>
                        <ImageIcon style={{ width: cqw(14), height: cqw(14) }} strokeWidth={1.2} />
                        <span style={{ fontFamily: 'inherit' }}>No image</span>
                    </span>
                )}
            </div>

            {/* Logo — the generator's own box (placement, offsets, size); letter mark as fallback */}
            {logoUrl && logo && (
                <img
                    src={getThumbUrl(logoUrl)}
                    alt=""
                    className="absolute"
                    style={{ left: pctW(logo.x), top: pctH(logo.y), width: pctW(logo.w), height: pctH(logo.h) }}
                />
            )}
            {!logoUrl && (
                <PdfText x={mark.x} y={mark.y} pt={mark.pt} color={gold} align={mark.align}>
                    {`${String.fromCodePoint(65 + page.artIndex)}.`}
                </PdfText>
            )}

            {/* Page border — 2mm inset */}
            <div
                className="absolute pointer-events-none"
                style={{ left: pctW(2), top: pctH(2), right: pctW(2), bottom: pctH(2), border: '1px solid rgb(210, 202, 192)' }}
            />

            {/* Text zone */}
            {hasText && (
                <>
                    <div className="absolute" style={{ left: pctW(13), right: pctW(13), top: pctH(252), height: 1, background: line }} />
                    {rows}
                    {page.pageIndex === 1 && (
                        <>
                            <PdfText x={13} y={258} pt={16} color={gold} spacingMm={2}>DESCRIPTION</PdfText>
                            <p
                                className="absolute"
                                style={{
                                    left: pctW(13),
                                    width: pctW(184),
                                    top: `calc(${pctH(268)} - ${cqw(ptToMm(14) * 0.8)})`,
                                    fontSize: cqw(ptToMm(14)),
                                    lineHeight: 1.15,
                                    color: ink,
                                }}
                            >
                                {art.description}
                            </p>
                        </>
                    )}
                </>
            )}
        </div>
    );
};

type PagePreviewProps = React.ComponentProps<typeof PagePreview>;

/** An artwork page, or the end-page design fitted inside the page as the PDF draws it. */
const AnyPagePreview: React.FC<Omit<PagePreviewProps, 'page'> & { page: PreviewPage }> = ({ page, ...rest }) => {
    if (page.kind === 'art') return <PagePreview page={page.page} {...rest} />;
    return (
        <div className="relative overflow-hidden shrink-0" style={{ ...PAGE_FRAME_STYLE, background: rest.pageBg }}>
            <img src={rest.hiRes ? page.url : getThumbUrl(page.url)} alt="Last page design" className="absolute inset-0 w-full h-full object-contain" />
        </div>
    );
};
