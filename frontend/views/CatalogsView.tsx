import React, { useState } from 'react';
import { Plus, X, Check, Image as ImageIcon, Download, ArrowLeft, Search, Edit2, Trash2 } from 'lucide-react';
import { Catalog, Artwork } from '../types';
import { jsPDF } from 'jspdf';

interface CatalogsViewProps {
    catalogs: Catalog[];
    artworks: Artwork[];
    onAddCatalog: (catalog: Omit<Catalog, 'id' | 'createdAt'>) => void;
    onUpdateCatalog: (catalog: Catalog) => void;
    onDeleteCatalog: (id: string) => void;
    onArtworkClick: (artwork: Artwork) => void;
}

interface PdfOptions {
    showCatalogName: boolean;
    showTitle: boolean;
    showDimensions: boolean;
    showPrice: boolean;
}

type CatalogTheme = 1 | 2 | 3 | 4;

const THEME_INFO: { id: CatalogTheme; name: string; desc: string; bg: string; fg: string; accent: string }[] = [
    { id: 1, name: 'Classic', desc: 'White & gradient', bg: '#ffffff', fg: '#1a1a1a', accent: '#e0e0e0' },
    { id: 2, name: 'Grey & Gold', desc: 'Luxury feel', bg: '#3a3a3a', fg: '#C9A84C', accent: '#C9A84C' },
    { id: 3, name: 'Edge Gradient', desc: 'Full-page gradient', bg: '#2c3e50', fg: '#ffffff', accent: '#8e44ad' },
    { id: 4, name: 'Dark & Gold', desc: 'Premium dark', bg: '#2a2a2a', fg: '#C9A84C', accent: '#C9A84C' },
];

const getBase64ImageWithGradient = (url: string, radiusPx: number = 0): Promise<{ dataUrl: string, width: number, height: number, gradientDataUrl: string, fullPageGradientDataUrl: string, edgeR: number, edgeG: number, edgeB: number }> => {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'Anonymous';
        img.onload = () => {
            // 1. Extract average color from the image border
            const colorCanvas = document.createElement('canvas');
            const colorCtx = colorCanvas.getContext('2d');
            colorCanvas.width = 50;
            colorCanvas.height = 50;
            let r = 255, g = 255, b = 255;

            if (colorCtx) {
                colorCtx.drawImage(img, 0, 0, 50, 50);
                try {
                    const data = colorCtx.getImageData(0, 0, 50, 50).data;
                    let count = 0;
                    let tr = 0, tg = 0, tb = 0;

                    // Sample the outer 10% border
                    for (let x = 0; x < 50; x++) {
                        for (let y = 0; y < 50; y++) {
                            if (x < 5 || x > 45 || y < 5 || y > 45) {
                                const i = (y * 50 + x) * 4;
                                tr += data[i];
                                tg += data[i + 1];
                                tb += data[i + 2];
                                count++;
                            }
                        }
                    }
                    if (count > 0) {
                        r = Math.floor(tr / count);
                        g = Math.floor(tg / count);
                        b = Math.floor(tb / count);
                    }
                } catch (e) {
                    console.warn("Could not extract border color", e);
                }
            }

            // 2. Create Radial Gradient Canvas (Theme 1 - Classic)
            const gradCanvas = document.createElement('canvas');
            gradCanvas.width = 840;
            gradCanvas.height = 1188;
            const gradCtx = gradCanvas.getContext('2d');
            if (gradCtx) {
                gradCtx.fillStyle = '#ffffff';
                gradCtx.fillRect(0, 0, 840, 1188);
                const gradient = gradCtx.createRadialGradient(420, 594, 50, 420, 594, 700);
                gradient.addColorStop(0, `rgba(${r},${g},${b},0.35)`);
                gradient.addColorStop(1, `rgba(255,255,255,1)`);
                gradCtx.fillStyle = gradient;
                gradCtx.fillRect(0, 0, 840, 1188);
            }

            // 3. Create Full-Page Linear Gradient Canvas (Theme 3 - Edge Gradient)
            const fullGradCanvas = document.createElement('canvas');
            fullGradCanvas.width = 840;
            fullGradCanvas.height = 1188;
            const fullGradCtx = fullGradCanvas.getContext('2d');
            if (fullGradCtx) {
                const darkerR = Math.max(0, Math.floor(r * 0.3));
                const darkerG = Math.max(0, Math.floor(g * 0.3));
                const darkerB = Math.max(0, Math.floor(b * 0.3));
                const fullGrad = fullGradCtx.createLinearGradient(0, 0, 0, 1188);
                fullGrad.addColorStop(0, `rgb(${r},${g},${b})`);
                fullGrad.addColorStop(0.5, `rgb(${Math.floor((r + darkerR) / 2)},${Math.floor((g + darkerG) / 2)},${Math.floor((b + darkerB) / 2)})`);
                fullGrad.addColorStop(1, `rgb(${darkerR},${darkerG},${darkerB})`);
                fullGradCtx.fillStyle = fullGrad;
                fullGradCtx.fillRect(0, 0, 840, 1188);
            }

            // 4. Process original image (rounded corners)
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            if (ctx) {
                if (radiusPx > 0) {
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
                }
                ctx.drawImage(img, 0, 0);
                resolve({
                    dataUrl: canvas.toDataURL('image/png'),
                    width: img.width,
                    height: img.height,
                    gradientDataUrl: gradCanvas.toDataURL('image/jpeg', 0.8),
                    fullPageGradientDataUrl: fullGradCanvas.toDataURL('image/jpeg', 0.8),
                    edgeR: r, edgeG: g, edgeB: b
                });
            } else {
                reject(new Error('Failed to get canvas context'));
            }
        };
        img.onerror = reject;
        img.src = url.startsWith('data:image') ? url : url;
    });
};

export const CatalogsView: React.FC<CatalogsViewProps> = ({ catalogs, artworks, onAddCatalog, onUpdateCatalog, onDeleteCatalog, onArtworkClick }) => {
    const [isAdding, setIsAdding] = useState(false);
    const [selectedCatalog, setSelectedCatalog] = useState<Catalog | null>(null);
    const [isGeneratingPDF, setIsGeneratingPDF] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');

    const [showPdfOptions, setShowPdfOptions] = useState(false);
    const [catalogToDownload, setCatalogToDownload] = useState<Catalog | null>(null);
    const [selectedTheme, setSelectedTheme] = useState<CatalogTheme>(1);
    const [pdfOptions, setPdfOptions] = useState<PdfOptions>({
        showCatalogName: true,
        showTitle: true,
        showDimensions: true,
        showPrice: true
    });

    const filteredCatalogs = catalogs.filter(catalog =>
        catalog.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        catalog.description.toLowerCase().includes(searchQuery.toLowerCase())
    );

    const handleDownloadClick = (catalog: Catalog) => {
        setCatalogToDownload(catalog);
        setShowPdfOptions(true);
    };

    const handleGeneratePDF = async () => {
        if (!catalogToDownload || isGeneratingPDF) return;
        setIsGeneratingPDF(true);

        try {
            const doc = new jsPDF();
            const catalogArtworks = artworks.filter(a => catalogToDownload.artworkIds.includes(a.id));

            if (catalogArtworks.length === 0) {
                alert("No artworks in this catalog to generate PDF.");
                setIsGeneratingPDF(false);
                return;
            }

            // Gold color RGB for themes 2 & 4
            const goldR = 201, goldG = 168, goldB = 76; // #C9A84C

            for (let i = 0; i < catalogArtworks.length; i++) {
                const art = catalogArtworks[i];
                if (i > 0) doc.addPage();

                let imgInfo = null;
                if (art.imageUrls && art.imageUrls.length > 0) {
                    try {
                        imgInfo = await getBase64ImageWithGradient(art.imageUrls[0], selectedTheme === 1 ? 0 : 20);
                    } catch (e) {
                        console.error("Failed to load image for PDF", e);
                    }
                }

                // ====================================================================
                // THEME 1: Editorial Catalog Layout (matching reference design)
                // ====================================================================
                if (selectedTheme === 1) {
                    const pageW = 210;
                    const pageH = 297;
                    const marginL = 15;
                    const marginR = 15;
                    const contentW = pageW - marginL - marginR;

                    // -- Background: light grey gradient (top to bottom)
                    const bgCanvas = document.createElement('canvas');
                    bgCanvas.width = 840;
                    bgCanvas.height = 1188;
                    const bgCtx = bgCanvas.getContext('2d');
                    if (bgCtx) {
                        const bgGrad = bgCtx.createLinearGradient(0, 0, 0, 1188);
                        bgGrad.addColorStop(0, '#f2f2f2');
                        bgGrad.addColorStop(1, '#d9d9d9');
                        bgCtx.fillStyle = bgGrad;
                        bgCtx.fillRect(0, 0, 840, 1188);
                    }
                    doc.addImage(bgCanvas.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, pageW, pageH);

                    // -- Image section (top ~70% of page, large and centered)
                    let cursorY = 15;
                    const imgAreaMaxH = 195; // ~66% of 297mm

                    if (imgInfo) {
                        let imgW = imgInfo.width;
                        let imgH = imgInfo.height;
                        const ratio = Math.min(contentW / imgW, imgAreaMaxH / imgH);
                        imgW = imgW * ratio;
                        imgH = imgH * ratio;
                        const imgX = marginL + (contentW - imgW) / 2;
                        const imgY = cursorY + (imgAreaMaxH - imgH) / 2; // Center vertically
                        doc.addImage(imgInfo.dataUrl, 'PNG', imgX, imgY, imgW, imgH);
                        cursorY = cursorY + imgAreaMaxH + 10;
                    } else {
                        cursorY = 160;
                    }

                    // -- Artwork title (large, left-aligned, directly below image)
                    if (pdfOptions.showTitle) {
                        doc.setFont("times", "normal");
                        doc.setFontSize(26);
                        doc.setTextColor(30, 30, 30);
                        const titleLines = doc.splitTextToSize(art.title, contentW);
                        doc.text(titleLines, marginL, cursorY);
                        cursorY += (titleLines.length * 10) + 6;
                    }

                    // -- Detail fields: thin line above, then bold label + value
                    const addDetailField = (label: string, value: string) => {
                        // Thin separator line above each field
                        doc.setDrawColor(180, 180, 180);
                        doc.setLineWidth(0.2);
                        doc.line(marginL, cursorY, marginL + contentW * 0.45, cursorY);
                        cursorY += 5;

                        // Bold label
                        doc.setFont("helvetica", "bold");
                        doc.setFontSize(7);
                        doc.setTextColor(40, 40, 40);
                        doc.text(label.toUpperCase(), marginL, cursorY, { charSpace: 0.8 });
                        cursorY += 4;

                        // Value
                        doc.setFont("helvetica", "normal");
                        doc.setFontSize(9.5);
                        doc.setTextColor(70, 70, 70);
                        const lines = doc.splitTextToSize(value, contentW * 0.5);
                        doc.text(lines, marginL, cursorY);
                        cursorY += (lines.length * 4.2) + 4;
                    };

                    // Medium
                    if (art.medium) {
                        addDetailField('Material', art.medium);
                    }

                    // Dimensions
                    if (pdfOptions.showDimensions && art.dimensions) {
                        addDetailField('Dimensions', art.dimensions);
                    }

                    // Price
                    if (pdfOptions.showPrice) {
                        addDetailField('Price', `\u20B9${art.price.toLocaleString('en-IN')}`);
                    }

                    continue; // Skip the shared rendering below
                }

                // ====================================================================
                // THEMES 2, 3, 4: Centered layout
                // ====================================================================

                // -- Background
                if (selectedTheme === 2) {
                    doc.setFillColor(58, 58, 58); // #3a3a3a
                    doc.rect(0, 0, 210, 297, 'F');
                } else if (selectedTheme === 3 && imgInfo) {
                    doc.addImage(imgInfo.fullPageGradientDataUrl, 'JPEG', 0, 0, 210, 297);
                } else if (selectedTheme === 4) {
                    doc.setFillColor(42, 42, 42); // #2a2a2a
                    doc.rect(0, 0, 210, 297, 'F');
                }

                // -- Text color helper
                const setThemeTextColor = () => {
                    if (selectedTheme === 2 || selectedTheme === 4) {
                        doc.setTextColor(goldR, goldG, goldB);
                    } else if (selectedTheme === 3) {
                        doc.setTextColor(255, 255, 255);
                    }
                };

                // -- Top: Catalog Name & Title (centered)
                let topY = 20;
                if (pdfOptions.showCatalogName) {
                    doc.setFont("helvetica", "bold");
                    doc.setFontSize(16);
                    setThemeTextColor();
                    doc.text(catalogToDownload.name.toUpperCase(), 105, topY, { align: "center" });
                    topY += 10;
                }

                if (pdfOptions.showTitle) {
                    doc.setFont("helvetica", "normal");
                    doc.setFontSize(20);
                    setThemeTextColor();
                    doc.text(art.title, 105, topY, { align: "center" });
                }

                // -- Middle: Image (centered)
                if (imgInfo) {
                    const maxWidth = selectedTheme === 4 ? 190 : 170;
                    const maxHeight = selectedTheme === 4 ? 220 : 210;
                    let imgW = imgInfo.width;
                    let imgH = imgInfo.height;
                    const ratio = Math.min(maxWidth / imgW, maxHeight / imgH);
                    imgW = imgW * ratio;
                    imgH = imgH * ratio;

                    const x = (210 - imgW) / 2;
                    const y = 35.64 + (225.72 - imgH) / 2;

                    doc.addImage(imgInfo.dataUrl, 'PNG', x, y, imgW, imgH);
                } else if (art.imageUrls && art.imageUrls.length > 0) {
                    doc.setFont("helvetica", "italic");
                    doc.setFontSize(12);
                    doc.setTextColor(150, 150, 150);
                    doc.text("[Image could not be loaded]", 105, 148, { align: "center" });
                }

                // -- Bottom: Dimensions & Price (centered)
                let bottomY = 275;
                if (pdfOptions.showDimensions) {
                    doc.setFont("helvetica", "normal");
                    doc.setFontSize(12);
                    setThemeTextColor();
                    doc.text(`Dimensions: ${art.dimensions}`, 105, bottomY, { align: "center" });
                    bottomY += 8;
                }

                if (pdfOptions.showPrice) {
                    doc.setFont("helvetica", "bold");
                    doc.setFontSize(14);
                    setThemeTextColor();
                    doc.text(`Price: INR ${art.price.toLocaleString('en-IN')}`, 105, bottomY, { align: "center" });
                }
            }

            doc.save(`${catalogToDownload.name.replace(/\s+/g, '_')}.pdf`);
        } catch (error) {
            console.error("Error generating PDF:", error);
            alert("Failed to generate PDF.");
        } finally {
            setIsGeneratingPDF(false);
            setShowPdfOptions(false);
            setCatalogToDownload(null);
        }
    };

    return (
        <div className="h-full flex flex-col bg-[#faf9f6] dark:bg-[#121212] transition-colors duration-500 animate-fade-in">
            <div className="bg-white dark:bg-[#1a1a1a] px-4 pt-8 pb-3 shadow-sm z-10 border-b border-gray-100 dark:border-gray-800">
                <div className="flex justify-between items-center mb-3">
                    <h1 className="text-xl font-serif text-gray-900 dark:text-white">Catalogs</h1>
                    <button
                        onClick={() => setIsAdding(true)}
                        className="bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 p-1.5 rounded-full shadow-md hover:bg-brand-800 dark:hover:bg-gold-400 transition-colors active-scale"
                    >
                        <Plus size={20} />
                    </button>
                </div>
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 dark:text-gray-500" size={16} />
                    <input
                        type="text"
                        placeholder="Search catalogs..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[7px] py-2 pl-9 pr-4 text-xs text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                    />
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-2 no-scrollbar pb-24">
                {filteredCatalogs.map((catalog, index) => (
                    <div
                        key={catalog.id}
                        onClick={() => setSelectedCatalog(catalog)}
                        className="bg-white dark:bg-[#1e1e1e] rounded-[7px] shadow-sm overflow-hidden flex h-28 border border-gray-100 dark:border-gray-800 animate-fade-in-up cursor-pointer active-scale"
                        style={{ animationDelay: `${index * 50}ms` }}
                    >
                        <div className="w-28 h-full relative shrink-0 bg-gray-50 dark:bg-gray-800">
                            <img src={catalog.coverImageUrl} alt={catalog.name} className="w-full h-full object-cover" />
                        </div>
                        <div className="p-3 flex flex-col justify-between flex-1">
                            <div>
                                <div className="flex justify-between items-start">
                                    <h3 className="font-serif text-gray-900 dark:text-gray-100 line-clamp-1 text-sm flex-1 mr-2">{catalog.name}</h3>
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleDownloadClick(catalog);
                                        }}
                                        disabled={isGeneratingPDF}
                                        className={`p-1.5 text-gray-400 dark:text-gray-500 hover:text-gold-600 dark:hover:text-gold-400 rounded-full transition-colors active-scale shrink-0 ${isGeneratingPDF ? 'opacity-50 cursor-not-allowed' : ''}`}
                                        title="Download PDF"
                                    >
                                        <Download size={14} />
                                    </button>
                                </div>
                                <p className="text-[9px] text-gray-500 dark:text-gray-400 mt-1 uppercase tracking-wider">{catalog.artworkIds.length} Artworks</p>
                            </div>
                            {catalog.description && (
                                <p className="text-[10px] text-gray-400 dark:text-gray-500 font-light line-clamp-2">{catalog.description}</p>
                            )}
                        </div>
                    </div>
                ))}
                {filteredCatalogs.length === 0 && (
                    <div className="text-center text-gray-400 dark:text-gray-500 mt-10 font-light text-sm">
                        No catalogs found.
                    </div>
                )}
            </div>

            {isAdding && (
                <CatalogFormModal
                    artworks={artworks}
                    onClose={() => setIsAdding(false)}
                    onSave={(newCat) => {
                        onAddCatalog(newCat);
                        setIsAdding(false);
                    }}
                />
            )}

            {selectedCatalog && (
                <CatalogDetailModal
                    catalog={selectedCatalog}
                    artworks={artworks}
                    onClose={() => setSelectedCatalog(null)}
                    onDownloadClick={() => handleDownloadClick(selectedCatalog)}
                    onArtworkClick={onArtworkClick}
                    onUpdateCatalog={(updated) => {
                        onUpdateCatalog(updated);
                        setSelectedCatalog(updated);
                    }}
                    onDeleteCatalog={() => {
                        onDeleteCatalog(selectedCatalog.id);
                        setSelectedCatalog(null);
                    }}
                    isGeneratingPDF={isGeneratingPDF}
                />
            )}

            {/* PDF Options Modal */}
            {showPdfOptions && catalogToDownload && (
                <div className="absolute inset-0 z-[100] flex flex-col justify-end overflow-hidden">
                    <div className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={() => setShowPdfOptions(false)}></div>
                    <div className="bg-white dark:bg-[#1e1e1e] rounded-t-[1.5rem] p-6 relative z-10 animate-fade-in-up shadow-2xl border-t border-gray-200 dark:border-gray-800 pb-12 max-h-[85vh] overflow-y-auto no-scrollbar">
                        <div className="w-12 h-1.5 bg-gray-300 dark:bg-gray-700 rounded-full mx-auto mb-6"></div>
                        <h3 className="text-sm font-bold text-gray-900 dark:text-white uppercase tracking-widest mb-5 text-center">Choose Theme</h3>

                        {/* Theme Selector Grid */}
                        <div className="grid grid-cols-2 gap-3 mb-6">
                            {THEME_INFO.map(theme => (
                                <button
                                    key={theme.id}
                                    onClick={() => setSelectedTheme(theme.id)}
                                    className={`relative rounded-xl overflow-hidden border-2 transition-all duration-200 active-scale ${
                                        selectedTheme === theme.id
                                            ? 'border-gold-500 shadow-lg shadow-gold-500/20 scale-[1.02]'
                                            : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                                    }`}
                                >
                                    {/* Mini Preview */}
                                    <div
                                        className="h-24 flex flex-col items-center justify-center gap-1 p-2"
                                        style={{ background: theme.bg }}
                                    >
                                        {/* Mini image placeholder */}
                                        <div className="w-10 h-10 rounded-md bg-white/20 border border-white/30 flex items-center justify-center">
                                            <ImageIcon size={16} style={{ color: theme.fg }} strokeWidth={1.5} />
                                        </div>
                                        {/* Mini text lines */}
                                        <div className="flex flex-col items-center gap-0.5 mt-1">
                                            <div className="h-[3px] w-12 rounded-full" style={{ background: theme.fg, opacity: 0.8 }}></div>
                                            <div className="h-[2px] w-8 rounded-full" style={{ background: theme.fg, opacity: 0.5 }}></div>
                                        </div>
                                    </div>
                                    {/* Theme Label */}
                                    <div className="px-2 py-2 bg-gray-50 dark:bg-[#252525]">
                                        <p className="text-[10px] font-bold text-gray-800 dark:text-gray-200 uppercase tracking-wider">{theme.name}</p>
                                        <p className="text-[9px] text-gray-400 dark:text-gray-500">{theme.desc}</p>
                                    </div>
                                    {/* Selected Checkmark */}
                                    {selectedTheme === theme.id && (
                                        <div className="absolute top-1.5 right-1.5 bg-gold-500 text-white rounded-full p-0.5 shadow">
                                            <Check size={10} strokeWidth={3} />
                                        </div>
                                    )}
                                </button>
                            ))}
                        </div>

                        <h3 className="text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-widest mb-3">Content Options</h3>
                        <div className="space-y-3 mb-6 px-1">
                            <label className="flex items-center gap-3 cursor-pointer">
                                <input type="checkbox" checked={pdfOptions.showCatalogName} onChange={e => setPdfOptions({ ...pdfOptions, showCatalogName: e.target.checked })} className="w-5 h-5 rounded-[7px] text-gold-500 focus:ring-gold-500 border-gray-300 dark:border-gray-600 dark:bg-gray-800" />
                                <span className="text-sm text-gray-700 dark:text-gray-300">Include Collection Name</span>
                            </label>
                            <label className="flex items-center gap-3 cursor-pointer">
                                <input type="checkbox" checked={pdfOptions.showTitle} onChange={e => setPdfOptions({ ...pdfOptions, showTitle: e.target.checked })} className="w-5 h-5 rounded-[7px] text-gold-500 focus:ring-gold-500 border-gray-300 dark:border-gray-600 dark:bg-gray-800" />
                                <span className="text-sm text-gray-700 dark:text-gray-300">Include Title</span>
                            </label>
                            <label className="flex items-center gap-3 cursor-pointer">
                                <input type="checkbox" checked={pdfOptions.showDimensions} onChange={e => setPdfOptions({ ...pdfOptions, showDimensions: e.target.checked })} className="w-5 h-5 rounded-[7px] text-gold-500 focus:ring-gold-500 border-gray-300 dark:border-gray-600 dark:bg-gray-800" />
                                <span className="text-sm text-gray-700 dark:text-gray-300">Include Dimensions</span>
                            </label>
                            <label className="flex items-center gap-3 cursor-pointer">
                                <input type="checkbox" checked={pdfOptions.showPrice} onChange={e => setPdfOptions({ ...pdfOptions, showPrice: e.target.checked })} className="w-5 h-5 rounded-[7px] text-gold-500 focus:ring-gold-500 border-gray-300 dark:border-gray-600 dark:bg-gray-800" />
                                <span className="text-sm text-gray-700 dark:text-gray-300">Include Pricing</span>
                            </label>
                        </div>

                        <button
                            onClick={handleGeneratePDF}
                            disabled={isGeneratingPDF}
                            className={`w-full bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 rounded-[7px] py-3 text-sm font-medium tracking-wide transition-colors active-scale ${isGeneratingPDF ? 'opacity-50 cursor-not-allowed' : 'hover:bg-brand-800 dark:hover:bg-gold-400'}`}
                        >
                            {isGeneratingPDF ? 'Generating...' : 'Generate PDF'}
                        </button>
                    </div>
                </div>
            )}
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
}

export const CatalogDetailModal: React.FC<CatalogDetailModalProps> = ({ catalog, artworks, onClose, onDownloadClick, onArtworkClick, onUpdateCatalog, onDeleteCatalog, isGeneratingPDF }) => {
    const [isEditing, setIsEditing] = useState(false);
    const catalogArtworks = artworks.filter(a => catalog.artworkIds.includes(a.id));

    const handleSaveEdit = (updatedData: Omit<Catalog, 'id' | 'createdAt'>) => {
        onUpdateCatalog({
            ...updatedData,
            id: catalog.id,
            createdAt: catalog.createdAt
        });
        setIsEditing(false);
    };

    const handleDelete = () => {
        if (window.confirm(`Are you sure you want to delete catalog "${catalog.name}"?`)) {
            onDeleteCatalog();
        }
    };

    return (
        <div className="absolute inset-0 bg-[#faf9f6] dark:bg-[#121212] z-50 flex flex-col animate-fade-in-up">
            <div className="bg-white dark:bg-[#1a1a1a] flex justify-between items-center p-4 border-b border-gray-100 dark:border-gray-800 pt-8 shadow-sm z-10">
                <button onClick={onClose} className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full flex items-center gap-2 transition-colors active-scale">
                    <ArrowLeft size={20} />
                </button>
                <h2 className="text-base font-serif text-gray-900 dark:text-white truncate px-4">{catalog.name}</h2>
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

            <div className="flex-1 overflow-y-auto no-scrollbar pb-24">
                <div className="w-full h-64 relative animate-fade-in">
                    <img src={catalog.coverImageUrl} alt={catalog.name} className="w-full h-full object-cover" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent"></div>
                    <div className="absolute bottom-5 left-5 right-5 text-white">
                        <h1 className="text-2xl font-serif mb-1">{catalog.name}</h1>
                        <p className="text-xs text-gray-300 font-light">{catalog.description}</p>
                    </div>
                </div>

                <div className="p-4 space-y-3 mt-2">
                    <h3 className="font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest text-[10px] mb-3 px-1">Artworks in Catalog ({catalogArtworks.length})</h3>
                    {catalogArtworks.map((artwork, index) => (
                        <div
                            key={artwork.id}
                            onClick={() => onArtworkClick(artwork)}
                            className="bg-white dark:bg-[#1e1e1e] rounded-[7px] shadow-sm overflow-hidden flex h-28 border border-gray-100 dark:border-gray-800 animate-fade-in-up cursor-pointer active-scale"
                            style={{ animationDelay: `${index * 50}ms` }}
                        >
                            <div className="w-28 h-full relative shrink-0 bg-gray-50 dark:bg-gray-800">
                                {artwork.imageUrls.length > 0 ? (
                                    <img src={artwork.imageUrls[0]} alt={artwork.title} className="w-full h-full object-cover" />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center text-gray-300 dark:text-gray-600">
                                        <ImageIcon size={28} strokeWidth={1} />
                                    </div>
                                )}
                            </div>
                            <div className="p-3 flex flex-col justify-between flex-1">
                                <div>
                                    <h3 className="font-serif text-gray-900 dark:text-gray-100 line-clamp-1 text-sm">{artwork.title}</h3>
                                    <p className="text-[9px] text-gray-500 dark:text-gray-400 mt-1 uppercase tracking-wider">{artwork.customId} • {artwork.medium}</p>
                                </div>
                                <div className="flex justify-between items-end">
                                    <p className="text-[10px] text-gray-400 dark:text-gray-500 font-light">{artwork.dimensions}</p>
                                    <p className="font-medium text-brand-900 dark:text-gold-400 text-sm">₹{artwork.price.toLocaleString('en-IN')}</p>
                                </div>
                            </div>
                        </div>
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
        </div>
    );
};

export interface CatalogFormModalProps {
    initialData?: Catalog;
    artworks: Artwork[];
    onClose: () => void;
    onSave: (catalog: Omit<Catalog, 'id' | 'createdAt'>) => void;
}

export const CatalogFormModal: React.FC<CatalogFormModalProps> = ({ initialData, artworks, onClose, onSave }) => {
    const [name, setName] = useState(initialData?.name || '');
    const [description, setDescription] = useState(initialData?.description || '');
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedArtworks, setSelectedArtworks] = useState<Set<string>>(new Set(initialData?.artworkIds || []));

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

    const handleSubmit = () => {
        if (!name.trim()) return alert("Name is required");
        if (selectedArtworks.size === 0) return alert("Select at least one artwork");

        onSave({
            name,
            description,
            artworkIds: Array.from(selectedArtworks),
            coverImageUrl: initialData?.coverImageUrl || `https://picsum.photos/seed/${name}/800/600`
        });
    };

    return (
        <div className="absolute inset-0 bg-[#faf9f6] dark:bg-[#121212] z-[70] flex flex-col animate-fade-in-up">
            <div className="bg-white dark:bg-[#1a1a1a] flex justify-between items-center p-4 border-b border-gray-100 dark:border-gray-800 pt-8 shadow-sm">
                <button onClick={onClose} className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale">
                    <X size={20} />
                </button>
                <h2 className="text-base font-serif text-gray-900 dark:text-white">{initialData ? 'Edit Catalog' : 'Create Catalog'}</h2>
                <button onClick={handleSubmit} className="text-gold-600 dark:text-gold-400 font-medium px-2 py-2 uppercase tracking-wider text-xs active-scale">
                    Save
                </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 no-scrollbar flex flex-col gap-6">
                <div className="space-y-5 bg-white dark:bg-[#1e1e1e] p-5 rounded-[7px] shadow-sm border border-gray-100 dark:border-gray-800 animate-fade-in-up" style={{ animationDelay: '100ms' }}>
                    <div>
                        <label className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Catalog Name *</label>
                        <input
                            value={name}
                            onChange={e => setName(e.target.value)}
                            className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-base font-serif text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors"
                            placeholder="e.g. Summer Collection 2024"
                        />
                    </div>
                    <div>
                        <label className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wider">Description</label>
                        <textarea
                            value={description}
                            onChange={e => setDescription(e.target.value)}
                            rows={2}
                            className="w-full bg-transparent border border-gray-300 dark:border-gray-700 rounded-[7px] p-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors resize-none"
                            placeholder="Brief description of this catalog..."
                        ></textarea>
                    </div>
                </div>

                <div className="animate-fade-in-up" style={{ animationDelay: '200ms' }}>
                    <div className="flex justify-between items-end mb-3">
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
                            className="w-full bg-white dark:bg-[#1e1e1e] border border-gray-200 dark:border-gray-800 rounded-[7px] py-2 pl-9 pr-4 text-xs text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors shadow-sm"
                        />
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                        {filteredArtworks.map((art, index) => {
                            const isSelected = selectedArtworks.has(art.id);
                            const coverImage = art.imageUrls?.[0];
                            return (
                                <div
                                    key={art.id}
                                    onClick={() => toggleArtwork(art.id)}
                                    className={`relative rounded-[7px] overflow-hidden border-2 cursor-pointer transition-all bg-gray-50 dark:bg-gray-800 animate-scale-in active-scale ${isSelected ? 'border-gold-500 shadow-md' : 'border-transparent shadow-sm'
                                        }`}
                                    style={{ animationDelay: `${index * 30}ms` }}
                                >
                                    {coverImage ? (
                                        <img src={coverImage} alt={art.title} className="w-full h-32 object-cover" />
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
                                </div>
                            );
                        })}
                        {filteredArtworks.length === 0 && (
                            <div className="col-span-2 text-center text-gray-400 dark:text-gray-500 py-6 text-xs font-light">
                                No artworks found matching "{searchQuery}".
                            </div>
                        )}
                    </div>
                </div>
                <div className="h-10"></div>
            </div>
        </div>
    );
};
