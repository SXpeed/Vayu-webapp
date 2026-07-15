import React, { useState, useEffect } from 'react';
import localforage from 'localforage';
import { Catalog, Artwork, PdfOptions, CatalogTheme } from '../../types';
import { ChevronLeft, Star, FileText, Check, Layout, Type, Box, Tag, Folder, Upload, AlignLeft, Scissors, Image as ImageIcon, Palette, Paintbrush } from 'lucide-react';
import { THEME_INFO } from '../CatalogsView'; // We will need to export THEME_INFO from CatalogsView
import storageService from '../../services/storageService';
import { settingsService } from '../../services/settingsService';

/** The 12 main color-wheel hues (every 30°), applied at the chosen intensity. */
const MAIN_HUES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];

// At the default intensity the applied color matches the vivid main color shown
// in the swatch row (s≈75, l≈50).
const DEFAULT_INTENSITY = 58;

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
    generationProgress
}) => {
    const [activeTab, setActiveTab] = useState<'Theme' | 'Logo' | 'Content' | 'Preview'>('Theme');
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
        pageOptions: ['Main Image']
    });

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
                            ...(globalSettings.customLogo2 && { customLogo2: globalSettings.customLogo2 })
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

    // Unset = follow the theme default (cutout themes 4 & 5 remove by default).

    const updateOption = (key: keyof PdfOptions, value: any) => {
        setOptions(prev => {
            const newOpts = { ...prev, [key]: value };
            localforage.setItem('vayu-pdf-options', newOpts).catch(console.error);
            return newOpts;
        });
    };

    // Unset = follow the theme default: theme 5 (Gradient Cutout) removes by default.
    const removeBackground = options.removeBackground ?? selectedTheme === 5;
    // Custom page color state: hue picked from the 12 main colors, intensity
    // from the slider. Both are persisted with the rest of the PDF options.
    const [hue, setHue] = useState(30);
    const [intensity, setIntensity] = useState(DEFAULT_INTENSITY);
    const [hexInput, setHexInput] = useState('');

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
            const recentColors = [hex, ...(prev.recentColors || []).filter(c => c !== hex)].slice(0, 6);
            const next = { ...prev, recentColors };
            localforage.setItem('vayu-pdf-options', next).catch(console.error);
            return next;
        });
    };

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
    const imageShadow = options.imageShadow ?? false;
    const colorPalette = options.colorPalette ?? 'Default';
    const gradientStyle = options.gradientStyle ?? 'Solid';

    const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>, opt: 'Select 1' | 'Select 2') => {
        const file = e.target.files?.[0];
        if (file) {
            try {
                // Upload to Cloudflare Storage (R2) via our storageService
                const result = await storageService.upload(file);
                const key = opt === 'Select 1' ? 'customLogo1' : 'customLogo2';
                updateOption(key, result.url);
                // Sync globally
                settingsService.updateSettings({ [key]: result.url }).catch(console.error);
            } catch (err) {
                console.error("Failed to upload logo to Cloudflare Storage:", err);
                alert("Failed to upload logo. Please try again.");
            }
        }
    };

    return (
        <div className="absolute inset-0 bg-[#f9f9f9] dark:bg-[#121212] z-50 flex flex-col animate-fade-in-up pb-[env(safe-area-inset-bottom,0px)]">
            {/* Header */}
            <div className="bg-white dark:bg-[#1a1a1a] flex justify-between items-center p-[10px] border-b border-gray-100 dark:border-gray-800 shadow-sm" style={{ paddingTop: 'calc(1rem + env(safe-area-inset-top, 0px))' }}>
                <button onClick={onClose} className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale">
                    <ChevronLeft size={24} strokeWidth={1.5} />
                </button>
                <div className="text-center">
                    <h2 className="text-lg font-serif text-gray-900 dark:text-white font-medium leading-tight">Catalog Studio</h2>
                    <p className="text-[10px] text-gray-500 dark:text-gray-400">{artworks.length} of {artworks.length}</p>
                </div>
                <div className="w-10"></div>
            </div>

            {/* Tab Bar */}
            <div className="px-4 py-4">
                <div className="flex bg-gray-50 dark:bg-[#1e1e1e] p-1 rounded-[10px] border border-gray-200 dark:border-gray-800">
                    {(['Theme', 'Logo', 'Content', 'Preview'] as const).map(tab => (
                        <button
                            key={tab}
                            onClick={() => {
                                if (tab === 'Preview') {
                                    onGeneratePDF(options, selectedTheme);
                                } else {
                                    setActiveTab(tab);
                                }
                            }}
                            className={`flex-1 py-2 text-xs font-medium rounded-[8px] transition-colors flex items-center justify-center gap-1.5 ${activeTab === tab
                                    ? 'bg-white dark:bg-gray-700 text-gold-600 shadow-sm border border-gold-200 dark:border-gold-800/50'
                                    : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
                                }`}
                        >
                            {tab === 'Theme' && <span className="text-[10px]">🖌</span>}
                            {tab === 'Logo' && <span className="text-[10px]">🛡</span>}
                            {tab === 'Content' && <span className="text-[10px]">📄</span>}
                            {tab === 'Preview' && <span className="text-[10px]">👁</span>}
                            {tab}
                        </button>
                    ))}
                </div>
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto px-4 pb-24 space-y-3 no-scrollbar">

                {activeTab === 'Theme' && (
                    <>
                        {/* Choose Theme Section — compact grid */}
                        <section>
                            <div className="flex items-baseline justify-between mb-2">
                                <h3 className="font-bold text-gray-900 dark:text-white text-sm">Choose Theme</h3>
                                <span className="text-[10px] text-gray-500 dark:text-gray-400">
                                    {THEME_INFO.find(t => t.id === selectedTheme)?.desc}
                                </span>
                            </div>
                            <div className="grid grid-cols-3 gap-2">
                                {THEME_INFO.map(theme => (
                                    <button
                                        type="button"
                                        key={theme.id}
                                        onClick={() => updateTheme(theme.id)}
                                        className={`w-full text-left rounded-[8px] overflow-hidden bg-white dark:bg-[#1e1e1e] border-2 transition-all cursor-pointer active-scale shadow-sm ${selectedTheme === theme.id ? 'border-gold-500' : 'border-transparent'
                                            }`}
                                    >
                                        <div className="h-14 flex flex-col items-center justify-center gap-1 relative" style={{ background: theme.bg }}>
                                            <div className="w-5 h-5 rounded-[3px] border-2 border-current flex items-end justify-center pb-0.5" style={{ color: theme.fg }}>
                                                <div className="w-1.5 h-1.5 bg-current rounded-full" />
                                            </div>
                                            <div className="w-8 h-0.5 rounded-full" style={{ background: theme.fg, opacity: 0.7 }} />
                                            {selectedTheme === theme.id && (
                                                <div className="absolute top-1 right-1 bg-gold-500 text-white rounded-full p-0.5 shadow-sm">
                                                    <Check size={9} strokeWidth={3} />
                                                </div>
                                            )}
                                        </div>
                                        <p className="px-1 py-1.5 text-center text-[9px] font-bold text-gray-900 dark:text-white uppercase tracking-wide leading-tight truncate">
                                            {theme.name}
                                        </p>
                                    </button>
                                ))}
                            </div>
                        </section>

                        {/* Theme Options */}
                        <section className="bg-white dark:bg-[#1e1e1e] p-3 rounded-[10px] border border-gray-100 dark:border-gray-800 shadow-sm space-y-2">
                            <div className="flex items-center gap-1 mb-2">
                                <h3 className="text-[9px] font-bold text-gray-900 dark:text-white uppercase tracking-widest">Image Style</h3>
                            </div>
                            
                            <button
                                type="button"
                                onClick={() => updateOption('removeBackground', !removeBackground)}
                                className="w-full text-left flex items-center justify-between cursor-pointer active-scale py-1"
                            >
                                <div className="flex items-center gap-2.5">
                                    <div className={`w-4 h-4 rounded-[4px] shrink-0 flex items-center justify-center transition-colors ${removeBackground ? 'bg-gold-500 text-white' : 'border border-gray-300 dark:border-gray-600'}`}>
                                        {removeBackground && <Check size={10} strokeWidth={3} />}
                                    </div>
                                    <div>
                                        <p className="text-xs font-medium text-gray-900 dark:text-white select-none">Remove Background</p>
                                    </div>
                                </div>
                                <Scissors size={14} className="text-gray-400 shrink-0 ml-2" />
                            </button>

                            <button
                                type="button"
                                onClick={() => updateOption('imageShadow', !imageShadow)}
                                className="w-full text-left flex items-center justify-between cursor-pointer active-scale py-1"
                            >
                                <div className="flex items-center gap-2.5">
                                    <div className={`w-4 h-4 rounded-[4px] shrink-0 flex items-center justify-center transition-colors ${imageShadow ? 'bg-gold-500 text-white' : 'border border-gray-300 dark:border-gray-600'}`}>
                                        {imageShadow && <Check size={10} strokeWidth={3} />}
                                    </div>
                                    <div>
                                        <p className="text-xs font-medium text-gray-900 dark:text-white select-none">Image Drop Shadow</p>
                                    </div>
                                </div>
                                <ImageIcon size={14} className="text-gray-400 shrink-0 ml-2" />
                            </button>
                        </section>

                        {/* Color Palette Option */}
                        <section className="bg-white dark:bg-[#1e1e1e] p-3 rounded-[10px] border border-gray-100 dark:border-gray-800 shadow-sm">
                            <div className="flex items-center gap-1 mb-3">
                                <h3 className="text-[9px] font-bold text-gray-900 dark:text-white uppercase tracking-widest">Color Palette</h3>
                                <Palette size={10} className="text-gray-400" />
                                {colorPalette !== 'Default' && (
                                    <button
                                        type="button"
                                        onClick={() => updateOption('colorPalette', 'Default')}
                                        className="ml-auto text-[9px] font-medium text-gold-600 dark:text-gold-400 active-scale"
                                    >
                                        Reset
                                    </button>
                                )}
                            </div>

                            {/* 12 main colors in a single line */}
                            <div className="flex justify-between mb-3">
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
                                            aria-label={`Page color ${displayHex}`}
                                            className={`w-5 h-5 rounded-full shrink-0 border flex items-center justify-center cursor-pointer active-scale transition-transform ${
                                                selected ? 'border-gold-500 ring-2 ring-gold-400/60 scale-110' : 'border-gray-200 dark:border-gray-700'
                                            }`}
                                            style={{ background: displayHex }}
                                        >
                                            {selected && (
                                                <Check size={10} strokeWidth={3} className={isLightHex(displayHex) ? 'text-gray-800' : 'text-white'} />
                                            )}
                                        </button>
                                    );
                                })}
                            </div>

                            {/* Intensity slider for the selected color */}
                            <div className="flex items-center gap-2 mb-3">
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
                                    aria-label="Color intensity"
                                    className="hue-slider flex-1"
                                    style={{
                                        background: `linear-gradient(to right, ${hueToHex(hue, 0)}, ${hueToHex(hue, 50)}, ${hueToHex(hue, 100)})`,
                                    }}
                                />
                                <div
                                    className="w-5 h-5 rounded-full shrink-0 border border-gray-200 dark:border-gray-700"
                                    style={{ background: colorPalette.startsWith('#') ? colorPalette : hueToHex(hue, intensity) }}
                                />
                            </div>

                            {/* Recently used colors + hex code entry */}
                            <div className="flex items-center gap-2">
                                <div className="flex gap-1.5">
                                    {Array.from({ length: 6 }).map((_, idx) => {
                                        const recent = (options.recentColors || [])[idx];
                                        if (!recent) {
                                            return (
                                                <div
                                                    key={`empty-${idx}`}
                                                    className="w-5 h-5 rounded-full shrink-0 border border-dashed border-gray-200 dark:border-gray-700"
                                                />
                                            );
                                        }
                                        const selected = colorPalette === recent;
                                        return (
                                            <button
                                                type="button"
                                                key={`${recent}-${idx}`}
                                                onClick={() => applyColor(recent)}
                                                aria-label={`Recent color ${recent}`}
                                                className={`w-5 h-5 rounded-full shrink-0 border flex items-center justify-center cursor-pointer active-scale ${
                                                    selected ? 'border-gold-500 ring-2 ring-gold-400/60' : 'border-gray-200 dark:border-gray-700'
                                                }`}
                                                style={{ background: recent }}
                                            >
                                                {selected && (
                                                    <Check size={10} strokeWidth={3} className={isLightHex(recent) ? 'text-gray-800' : 'text-white'} />
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>
                                <input
                                    type="text"
                                    value={hexInput}
                                    onChange={(e) => setHexInput(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === 'Enter') { handleSaveColor(); (e.target as HTMLInputElement).blur(); } }}
                                    placeholder={colorPalette.startsWith('#') ? colorPalette : '#hex code'}
                                    maxLength={7}
                                    spellCheck={false}
                                    autoCapitalize="off"
                                    className="flex-1 min-w-0 h-7 px-2 rounded-full border border-gray-200 dark:border-gray-700 bg-transparent text-[11px] text-gray-700 dark:text-gray-300 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-gold-500"
                                />
                                <button
                                    type="button"
                                    onClick={handleSaveColor}
                                    aria-label="Save color"
                                    title="Save color"
                                    className="w-7 h-7 rounded-full shrink-0 bg-gold-500 text-white flex items-center justify-center shadow-sm active-scale"
                                >
                                    <Check size={13} strokeWidth={3} />
                                </button>
                            </div>
                        </section>

                        {/* Gradient Style Option */}
                        <section className="bg-white dark:bg-[#1e1e1e] p-3 rounded-[10px] border border-gray-100 dark:border-gray-800 shadow-sm">
                            <div className="flex items-center gap-1 mb-3">
                                <h3 className="text-[9px] font-bold text-gray-900 dark:text-white uppercase tracking-widest">Background Gradient</h3>
                                <Paintbrush size={10} className="text-gray-400" />
                            </div>
                            <div className="grid grid-cols-3 gap-2">
                                {['Solid', 'Linear', 'Radial', 'Diagonal', 'Vignette', 'Spotlight'].map(opt => (
                                    <button
                                        type="button"
                                        key={opt}
                                        onClick={() => updateOption('gradientStyle', opt)}
                                        className={`w-full text-center relative p-2 rounded-lg border-2 flex flex-col items-center justify-center gap-1 cursor-pointer active-scale ${
                                            gradientStyle === opt ? 'border-gold-500 bg-gold-50/10' : 'border-gray-100 dark:border-gray-800 hover:border-gray-200'
                                        }`}
                                    >
                                        <span className="text-[10px] font-medium text-gray-700 dark:text-gray-300">{opt}</span>
                                        {gradientStyle === opt && (
                                            <div className="absolute top-0.5 right-0.5 bg-gold-500 text-white rounded-full p-0.5 z-10">
                                                <Check size={6} strokeWidth={3} />
                                            </div>
                                        )}
                                    </button>
                                ))}
                            </div>
                        </section>

                    </>
                )}

                {activeTab === 'Logo' && (
                    <div className="grid grid-cols-2 gap-3">
                        {/* Logo & Placement Grid */}
                        <section className="bg-white dark:bg-[#1e1e1e] p-3 rounded-[10px] border border-gray-100 dark:border-gray-800 shadow-sm">
                            <div className="flex items-center gap-1 mb-3">
                                <h3 className="text-[9px] font-bold text-gray-900 dark:text-white uppercase tracking-widest">Logo Selection</h3>
                                <div className="w-3 h-3 rounded-full border border-gray-300 text-gray-300 flex items-center justify-center text-[8px]">i</div>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                {(['Select 1', 'Select 2'] as const).map(opt => {
                                    const customLogo = opt === 'Select 1' ? options.customLogo1 : options.customLogo2;
                                    return (
                                        <button
                                            type="button"
                                            key={opt}
                                            onClick={() => updateOption('logoSelection', opt)}
                                            className={`w-full text-left relative p-2 rounded-lg border-2 flex flex-col items-center justify-center gap-2 cursor-pointer active-scale ${options.logoSelection === opt ? 'border-gold-500 bg-gold-50/30' : 'border-gray-100 dark:border-gray-800 hover:border-gray-200'
                                                }`}
                                        >
                                            <div className={`w-12 h-12 ${opt === 'Select 1' ? 'bg-gold-600 text-white' : 'bg-[#151923] text-white'} flex items-center justify-center font-serif text-xl overflow-hidden shadow-inner`}>
                                                {customLogo ? (
                                                    <img loading="lazy" decoding="async" src={customLogo} alt={opt} className="w-full h-full object-cover" />
                                                ) : (
                                                    "A"
                                                )}
                                            </div>
                                            <span className="text-[10px] font-medium text-gray-700 dark:text-gray-300">{opt}</span>
                                            {options.logoSelection === opt && (
                                                <div className="absolute top-1 right-1 bg-gold-500 text-white rounded-full p-0.5 z-10">
                                                    <Check size={8} strokeWidth={3} />
                                                </div>
                                            )}
                                            <label className="absolute bottom-1 right-1 p-1.5 bg-white dark:bg-gray-700 rounded-full shadow-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors z-10">
                                                <Upload size={10} className="text-gray-600 dark:text-gray-300" />
                                                <input type="file" className="hidden" accept="image/*" onChange={(e) => handleLogoUpload(e, opt)} onClick={(e) => e.stopPropagation()} />
                                            </label>
                                        </button>
                                    );
                                })}
                            </div>
                        </section>

                        <section className="bg-white dark:bg-[#1e1e1e] p-3 rounded-[10px] border border-gray-100 dark:border-gray-800 shadow-sm">
                            <div className="flex items-center gap-1 mb-3">
                                <h3 className="text-[9px] font-bold text-gray-900 dark:text-white uppercase tracking-widest">Logo Placement</h3>
                                <div className="w-3 h-3 rounded-full border border-gray-300 text-gray-300 flex items-center justify-center text-[8px]">i</div>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                {['Top Left', 'Top Right'].map(opt => (
                                    <button
                                        type="button"
                                        key={opt}
                                        onClick={() => updateOption('logoPlacement', opt)}
                                        className={`w-full text-left relative p-2 rounded-lg border-2 flex flex-col items-center justify-center gap-2 cursor-pointer active-scale ${options.logoPlacement === opt ? 'border-gold-500 bg-gold-50/30' : 'border-gray-100 dark:border-gray-800 hover:border-gray-200'
                                            }`}
                                    >
                                        <div className="w-full h-10 bg-gray-50 dark:bg-gray-800 rounded flex items-start p-1 relative">
                                            <div className={`w-3 h-3 bg-gold-700 text-white flex items-center justify-center text-[6px] absolute top-1 ${opt === 'Top Left' ? 'left-1' : 'right-1'}`}>A</div>
                                            <div className={`absolute bottom-2 ${opt === 'Top Left' ? 'left-1' : 'right-1'}`}>
                                                <div className="w-6 h-0.5 bg-gray-300 mb-0.5 rounded-full"></div>
                                                <div className="w-4 h-0.5 bg-gray-300 rounded-full"></div>
                                            </div>
                                        </div>
                                        <span className="text-[10px] font-medium text-gray-700 dark:text-gray-300">{opt}</span>
                                        {options.logoPlacement === opt && (
                                            <div className="absolute top-1 right-1 bg-gold-500 text-white rounded-full p-0.5">
                                                <Check size={8} strokeWidth={3} />
                                            </div>
                                        )}
                                    </button>
                                ))}
                            </div>
                        </section>
                    </div>
                )}

                {activeTab === 'Content' && (
                    <div className="grid grid-cols-2 gap-3">
                        {/* Content & Page Option Grid */}
                        <section className="bg-white dark:bg-[#1e1e1e] p-3 rounded-[10px] border border-gray-100 dark:border-gray-800 shadow-sm">
                            <div className="flex items-center gap-1 mb-3">
                                <h3 className="text-[9px] font-bold text-gray-900 dark:text-white uppercase tracking-widest">Content Options</h3>
                                <div className="w-3 h-3 rounded-full border border-gray-300 text-gray-300 flex items-center justify-center text-[8px]">i</div>
                            </div>
                            <div className="space-y-3">
                                {[
                                    { key: 'showCatalogName', label: 'Collection Name', icon: <Folder size={12} className="text-gray-400" /> },
                                    { key: 'showTitle', label: 'Title', icon: <Type size={12} className="text-gray-400" /> },
                                    { key: 'showTitleNote', label: 'Medium', icon: <FileText size={12} className="text-gray-400" /> },
                                    { key: 'showDimensions', label: 'Dimension', icon: <Box size={12} className="text-gray-400" /> },
                                    { key: 'showPrice', label: 'Price', icon: <Tag size={12} className="text-gray-400" /> },
                                    { key: 'showDescription', label: 'Description', icon: <AlignLeft size={12} className="text-gray-400" /> },
                                ].map(item => (
                                    <button type="button" key={item.key} onClick={() => updateOption(item.key as keyof PdfOptions, !options[item.key as keyof PdfOptions])} className="w-full text-left flex items-center justify-between cursor-pointer group active-scale">
                                        <div className="flex items-center gap-2">
                                            <div className={`w-4 h-4 rounded-[4px] flex items-center justify-center transition-colors ${options[item.key as keyof PdfOptions] ? 'bg-gold-500 text-white' : 'border border-gray-300 dark:border-gray-600'}`}>
                                                {options[item.key as keyof PdfOptions] && <Check size={10} strokeWidth={3} />}
                                            </div>
                                            <span className="text-xs text-gray-700 dark:text-gray-300 select-none">{item.label}</span>
                                        </div>
                                        {item.icon}
                                    </button>
                                ))}
                            </div>
                        </section>

                        <section className="bg-white dark:bg-[#1e1e1e] p-3 rounded-[10px] border border-gray-100 dark:border-gray-800 shadow-sm">
                            <div className="flex items-center gap-1 mb-3">
                                <h3 className="text-[9px] font-bold text-gray-900 dark:text-white uppercase tracking-widest">Page Option</h3>
                                <div className="w-3 h-3 rounded-full border border-gray-300 text-gray-300 flex items-center justify-center text-[8px]">i</div>
                            </div>
                            <div className="space-y-2">
                                {[
                                    { id: 'Main Image', label: 'Main Image', desc: 'Apply layout to main image', icon: <FileText size={14} className="text-gray-400" /> },
                                    { id: '2nd Image', label: '2nd Image', desc: 'Add page for 2nd image', icon: <FileText size={14} className="text-gray-400" /> },
                                    { id: 'All Image', label: 'All Image', desc: 'Add pages for all images', icon: <Layout size={14} className="text-gray-400" /> },
                                ].map(opt => (
                                    <button
                                        type="button"
                                        key={opt.id}
                                        onClick={() => {
                                            const current = options.pageOptions || [];
                                            let newOptions;
                                            if (current.includes(opt.id)) {
                                                newOptions = current.filter(id => id !== opt.id);
                                            } else {
                                                newOptions = [...current, opt.id];
                                            }
                                            updateOption('pageOptions', newOptions);
                                        }}
                                        className={`w-full text-left p-2 rounded-lg border flex items-center justify-between cursor-pointer active-scale ${(options.pageOptions || []).includes(opt.id) ? 'border-gold-500 bg-gold-50/20' : 'border-gray-100 dark:border-gray-800'
                                            }`}
                                    >
                                        <div className="flex items-center gap-2">
                                            <div className={`w-4 h-4 rounded-[4px] border-2 flex items-center justify-center ${(options.pageOptions || []).includes(opt.id) ? 'border-gold-500 bg-gold-500' : 'border-gray-300 dark:border-gray-600'}`}>
                                                {(options.pageOptions || []).includes(opt.id) && <Check size={10} className="text-white" strokeWidth={3} />}
                                            </div>
                                            <div>
                                                <p className="text-xs font-medium text-gray-900 dark:text-white select-none">{opt.label}</p>
                                                <p className="text-[8px] text-gray-500 dark:text-gray-400 select-none">{opt.desc}</p>
                                            </div>
                                        </div>
                                        {opt.icon}
                                    </button>
                                ))}
                            </div>
                        </section>
                    </div>
                )}

                <div className="h-2"></div>
            </div>

            {/* Sticky Action Bar */}
            <div className="absolute bottom-[calc(4.5rem+env(safe-area-inset-bottom,0px))] left-0 right-0 p-4 bg-gradient-to-t from-[#f9f9f9] dark:from-[#121212] to-transparent pointer-events-none">
                <button
                    onClick={() => onGeneratePDF(options, selectedTheme)}
                    disabled={isGeneratingPDF}
                    className="w-full bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 rounded-[8px] py-3 text-sm font-medium tracking-wide shadow-lg pointer-events-auto active-scale disabled:opacity-90"
                >
                    {isGeneratingPDF ? (
                        <span className="flex items-center justify-center gap-2">
                            <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin shrink-0" />
                            <span className="truncate">{generationProgress || 'Generating…'}</span>
                        </span>
                    ) : 'Generate PDF'}
                </button>
            </div>
        </div>
    );
};
