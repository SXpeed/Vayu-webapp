import React, { useState, useEffect } from 'react';
import localforage from 'localforage';
import { Catalog, Artwork, PdfOptions, CatalogTheme } from '../../types';
import { ChevronLeft, Star, FileText, Check, Layout, Type, Box, Tag, Folder, Upload, AlignLeft } from 'lucide-react';
import { THEME_INFO } from '../CatalogsView'; // We will need to export THEME_INFO from CatalogsView
import storageService from '../../services/storageService';
import { settingsService } from '../../services/settingsService';

interface CatalogStudioViewProps {
    catalog: Catalog;
    artworks: Artwork[];
    onClose: () => void;
    onGeneratePDF: (options: PdfOptions, themeId: CatalogTheme) => void;
    isGeneratingPDF: boolean;
}

export const CatalogStudioView: React.FC<CatalogStudioViewProps> = ({
    catalog,
    artworks,
    onClose,
    onGeneratePDF,
    isGeneratingPDF
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
            if (savedOptions) setOptions(prev => ({ ...prev, ...savedOptions }));
            
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

    const updateOption = (key: keyof PdfOptions, value: any) => {
        setOptions(prev => {
            const next = { ...prev, [key]: value };
            localforage.setItem('vayu-pdf-options', next);
            return next;
        });
    };

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
                            className={`flex-1 py-2 text-xs font-medium rounded-[8px] transition-colors flex items-center justify-center gap-1.5 ${
                                activeTab === tab
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
            <div className="flex-1 overflow-y-auto px-4 pb-24 space-y-6 no-scrollbar">
                
                {activeTab === 'Theme' && (
                    <>
                        {/* Choose Theme Section */}
                <section>
                    <h3 className="font-bold text-gray-900 dark:text-white text-sm mb-0.5">Choose Theme</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">Select a style to design your catalog</p>
                    <div className="grid grid-cols-2 gap-3">
                        {THEME_INFO.map((theme, idx) => (
                            <button
                                type="button"
                                key={theme.id}
                                onClick={() => updateTheme(theme.id)}
                                className={`w-full text-left rounded-[10px] overflow-hidden bg-white dark:bg-[#1e1e1e] border-2 transition-all cursor-pointer active-scale ${
                                    selectedTheme === theme.id ? 'border-gold-500 shadow-sm' : 'border-transparent shadow-sm'
                                }`}
                            >
                                <div className="h-28 flex flex-col items-center justify-center p-3 relative" style={{ background: theme.bg }}>
                                    <div className="w-12 h-12 rounded-lg bg-white/20 border border-white/30 flex items-center justify-center mb-3">
                                        <div className="w-6 h-6 border-2 border-current rounded-sm flex items-end justify-center pb-0.5" style={{ color: theme.fg }}>
                                            <div className="w-2 h-2 bg-current rounded-full" />
                                        </div>
                                    </div>
                                    <div className="w-16 h-0.5 rounded-full mb-1" style={{ background: theme.fg, opacity: 0.8 }} />
                                    <div className="w-10 h-0.5 rounded-full" style={{ background: theme.fg, opacity: 0.5 }} />
                                    
                                    {selectedTheme === theme.id && (
                                        <div className="absolute top-2 right-2 bg-gold-500 text-white rounded-full p-0.5 shadow-sm">
                                            <Check size={12} strokeWidth={3} />
                                        </div>
                                    )}
                                </div>
                                <div className="p-3 text-center">
                                    <p className="text-[10px] font-bold text-gray-900 dark:text-white uppercase tracking-wider mb-0.5">{theme.name}</p>
                                    <p className="text-[9px] text-gray-500 dark:text-gray-400 leading-tight">{theme.desc}</p>
                                </div>
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
                                    className={`w-full text-left relative p-2 rounded-lg border-2 flex flex-col items-center justify-center gap-2 cursor-pointer active-scale ${
                                        options.logoSelection === opt ? 'border-gold-500 bg-gold-50/30' : 'border-gray-100 dark:border-gray-800 hover:border-gray-200'
                                    }`}
                                >
                                    <div className={`w-12 h-12 ${opt === 'Select 1' ? 'bg-gold-600 text-white' : 'bg-[#151923] text-white'} flex items-center justify-center font-serif text-xl overflow-hidden shadow-inner`}>
                                        {customLogo ? (
                                            <img src={customLogo} alt={opt} className="w-full h-full object-cover" />
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
                                    className={`w-full text-left relative p-2 rounded-lg border-2 flex flex-col items-center justify-center gap-2 cursor-pointer active-scale ${
                                        options.logoPlacement === opt ? 'border-gold-500 bg-gold-50/30' : 'border-gray-100 dark:border-gray-800 hover:border-gray-200'
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
                                { key: 'showTitleNote', label: 'Title Note', icon: <FileText size={12} className="text-gray-400" /> },
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
                                    className={`w-full text-left p-2 rounded-lg border flex items-center justify-between cursor-pointer active-scale ${
                                        (options.pageOptions || []).includes(opt.id) ? 'border-gold-500 bg-gold-50/20' : 'border-gray-100 dark:border-gray-800'
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
                    className="w-full bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 rounded-[8px] py-3 text-sm font-medium tracking-wide shadow-lg pointer-events-auto active-scale"
                >
                    {isGeneratingPDF ? 'Generating...' : 'Generate PDF'}
                </button>
            </div>
        </div>
    );
};
