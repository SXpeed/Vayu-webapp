import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import localforage from 'localforage';
import { Catalog, Artwork, PdfOptions, CatalogTheme } from '../../types';
import {
    ChevronLeft, ChevronRight, Check, Upload, Eye, X, Loader2, FileText, Folder,
    Type, Box, Tag, AlignLeft, Image as ImageIcon, TriangleAlert,
} from 'lucide-react';
import { THEME_INFO } from '../CatalogsView';
import storageService, { getThumbUrl } from '../../services/storageService';
import { settingsService } from '../../services/settingsService';
import { ToggleRow } from '../../components/ui';
import {
    planCatalogPages, pageBackgroundCss, pageHasText, rgbCss, pctW, pctH, cqw, ptToMm,
    PAGE_H_MM, PlannedPage, getThemePalette, ThemePalette,
} from './catalogLayout';
import toast from 'react-hot-toast';

/** Stable keys for the six recent-color swatches (filled or empty). */
const RECENT_COLOR_SLOTS = ['slot-1', 'slot-2', 'slot-3', 'slot-4', 'slot-5', 'slot-6'];

/** The 12 main color-wheel hues (every 30°), applied at the chosen intensity. */
const MAIN_HUES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];

// At the default intensity the applied color matches the vivid main color shown
// in the swatch row (s≈75, l≈50).
const DEFAULT_INTENSITY = 58;

const GRADIENT_STYLES = ['Solid', 'Linear', 'Radial', 'Diagonal', 'Vignette', 'Spotlight'] as const;

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
    /** Live status while the PDF is generating (e.g. "Image 2 of 5 — Downloading AI model 45%"). */
    generationProgress?: string | null;
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
                setOptions(prev => ({ ...prev, ...savedOptions }));
                // Restore the saved hue + intensity so the pickers line up.
                if (typeof savedOptions.colorHue === 'number') setHue(savedOptions.colorHue);
                if (typeof savedOptions.colorIntensity === 'number') setIntensity(savedOptions.colorIntensity);
            }

            try {
                const globalSettings = await settingsService.getSettings();
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
    const pageCount = pages.length;

    /** How many pages each page option contributes, shown beside it. */
    const pageContribution = useMemo(() => ({
        'Main Image': catalogArtworks.length,
        '2nd Image': catalogArtworks.filter(a => !!a.imageUrls?.[1]).length,
        'All Image': catalogArtworks.reduce((n, a) => n + Math.max(0, (a.imageUrls?.length ?? 0) - 2), 0),
    }), [catalogArtworks]);

    const selectedLogo = options.logoSelection === 'Select 1' ? options.customLogo1 : options.customLogo2;
    // The generator falls back to the catalog cover, then to a letter mark.
    const logoUrl = selectedLogo || catalog?.coverImageUrl || undefined;

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

    const currentPage: PlannedPage | undefined = pages[pageIdx];
    const catalogName = catalog?.name || 'Catalog';
    const artworkCountLabel = `${catalogArtworks.length} artwork${catalogArtworks.length === 1 ? '' : 's'}`;
    const pageCountLabel = `${pageCount} page${pageCount === 1 ? '' : 's'}`;
    const descriptionHidden = !!options.showDescription && !(options.pageOptions || []).includes('2nd Image');

    const previewProps = {
        palette, pageBg, options, logoUrl, catalogName, imageShadow, themeId: selectedTheme,
    };

    return (
        <div className="absolute inset-0 bg-[var(--neu-bg)] z-50 flex flex-col lg:flex-row animate-fade-in-up pb-[var(--safe-bottom,env(safe-area-inset-bottom,0px))]">

            {/* ═══════════════════ Settings column ═══════════════════ */}
            <div className="flex flex-col flex-1 min-w-0 min-h-0 lg:flex-none lg:w-[27rem] xl:w-[29rem] lg:shrink-0 lg:h-full lg:border-r lg:border-gray-200/60 dark:lg:border-white/5">

                {/* Header */}
                <div className="flex items-center gap-3 px-4 pb-3 pt-[calc(1rem+env(safe-area-inset-top,0px))] lg:pt-5">
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

                        <StudioSection title="Placement">
                            <div className="grid grid-cols-2 gap-3">
                                {(['Top Left', 'Top Right'] as const).map(opt => {
                                    const selected = options.logoPlacement === opt;
                                    return (
                                        <button
                                            key={opt}
                                            type="button"
                                            onClick={() => updateOption('logoPlacement', opt)}
                                            aria-pressed={selected}
                                            className={`rounded-xl p-2.5 flex items-center gap-3 active-scale ${selected ? 'neu-inset ring-1 ring-gold-500/60' : 'neu-raised-sm'}`}
                                        >
                                            {/* Mini page: logo square in the chosen corner */}
                                            <span className="relative w-8 aspect-[210/297] rounded-[3px] neu-inset shrink-0">
                                                <span
                                                    className={`absolute top-[8%] w-[34%] aspect-square rounded-[1px] ${opt === 'Top Left' ? 'left-[10%]' : 'right-[10%]'}`}
                                                    style={{ background: rgbCss(palette.gold) }}
                                                />
                                                <span className="absolute left-[12%] right-[12%] bottom-[14%] h-[5%] rounded-full bg-gray-400/50" />
                                            </span>
                                            <span className={`text-xs ${selected ? 'font-semibold text-gold-700 dark:text-gold-300' : 'text-gray-700 dark:text-gray-300'}`}>
                                                {opt}
                                            </span>
                                        </button>
                                    );
                                })}
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
                    </div>
                </div>

                {/* Footer — generate */}
                <div className="shrink-0 border-t border-gray-200/70 dark:border-white/5 px-4 py-3 bg-[var(--neu-bg)]">
                    {pageCount === 0 && (
                        <p className="mb-2 flex items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                            <TriangleAlert size={12} className="shrink-0" />
                            These page options produce no pages for this catalog.
                        </p>
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
                            disabled={isGeneratingPDF || pageCount === 0}
                            className="neu-button neu-button-primary flex-1 py-3 text-sm tracking-wide active-scale disabled:opacity-60"
                        >
                            {isGeneratingPDF ? (
                                <span className="flex items-center justify-center gap-2 min-w-0">
                                    <Loader2 size={15} className="animate-spin shrink-0" />
                                    <span className="truncate">{generationProgress || 'Generating…'}</span>
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
                            ? <PagePreview page={currentPage} hiRes {...previewProps} />
                            : <EmptyPreview />}
                    </div>
                </div>
            </div>

            {/* ═══════════════════ Preview (phone overlay) ═══════════════════ */}
            {showMobilePreview && (
                <div className="absolute inset-0 z-[80] bg-black/70 backdrop-blur-sm lg:hidden flex flex-col animate-fade-in">
                    <div className="flex justify-between items-center px-3 pt-[calc(0.75rem+env(safe-area-inset-top,0px))] pb-2">
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
                                ? <PagePreview page={currentPage} {...previewProps} />
                                : <EmptyPreview dark />}
                        </div>
                    </div>
                    {pageCount > 0 && (
                        <div className="flex items-center justify-center gap-4 py-4 pb-[calc(1rem+var(--safe-bottom,env(safe-area-inset-bottom,0px)))]">
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

const pageLabel = (page: PlannedPage): string => {
    if (page.pageIndex === 0) return 'Main image';
    if (page.pageIndex === 1) return 'Second image';
    return `Image ${page.pageIndex + 1}`;
};

const PreviewToolbar: React.FC<{
    themeName: string;
    pageCountLabel: string;
    page?: PlannedPage;
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
                {page && <> · <span className="font-normal">{page.art.title || 'Untitled'}</span> — {pageLabel(page).toLowerCase()}</>}
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

/** Absolutely-placed text whose *baseline* sits at (xMm, yMm), as jsPDF draws it. */
const PdfText: React.FC<{
    x: number; y: number; pt: number; color: string;
    italic?: boolean; spacingMm?: number; align?: 'left' | 'right'; children?: React.ReactNode;
}> = ({ x, y, pt, color, italic = false, spacingMm = 0, align = 'left', children }) => (
    <span
        className="absolute whitespace-nowrap leading-none"
        style={{
            [align === 'right' ? 'right' : 'left']: pctW(x),
            top: pctH(y),
            transform: 'translateY(-80%)', // Times: baseline ≈ 0.8em below the top of a 1em line box
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
    catalogName: string;
    imageShadow: boolean;
    themeId: CatalogTheme;
    /** Full-size image on desktop; the phone overlay uses the thumbnail. */
    hiRes?: boolean;
}> = ({ page, palette, pageBg, options, logoUrl, catalogName, imageShadow, themeId, hiRes = false }) => {
    const { art } = page;
    const hasText = pageHasText(page, options);
    const imgBoxH = hasText ? 250 : PAGE_H_MM - 4;
    const ink = rgbCss(palette.ink);
    const gold = rgbCss(palette.gold);
    const line = rgbCss(palette.lineColor);
    const rightLogo = options.logoPlacement === 'Top Right';
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
            style={{
                // Fit the stage: as wide as it allows, unless the height runs out first.
                width: 'min(100cqw, calc(100cqh * 210 / 297))',
                aspectRatio: '210 / 297',
                background: pageBg,
                containerType: 'inline-size',
                fontFamily: TIMES,
                boxShadow: '0 30px 60px -18px rgba(0,0,0,0.38), 0 2px 6px rgba(0,0,0,0.08)',
            }}
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

            {/* Logo — 32.4mm box, 5mm in from the chosen corner; letter mark as fallback */}
            {logoUrl ? (
                <img
                    src={getThumbUrl(logoUrl)}
                    alt=""
                    className="absolute object-contain"
                    style={{
                        top: pctH(5),
                        [rightLogo ? 'right' : 'left']: pctW(5),
                        maxWidth: pctW(32.4),
                        maxHeight: pctH(32.4),
                        objectPosition: rightLogo ? 'right top' : 'left top',
                    }}
                />
            ) : (
                <PdfText x={5} y={9} pt={24} color={gold} align={rightLogo ? 'right' : 'left'}>
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
