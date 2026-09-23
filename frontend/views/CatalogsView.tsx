import React, { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { TypeDeleteDialog } from '../components/TypeDeleteDialog';
import { Plus, X, Edit2, Trash2, Download, Image as ImageIcon, Check, Loader2, Camera, Upload, FileText, FileDown, BookOpen, Lock } from 'lucide-react';
import { SearchBar } from '../components/SearchBar';
import { PageRoot, PageHeader, PageBody, PrimaryIconButton, GhostIconButton, EmptyState } from '../components/ui';
import { toast } from 'react-hot-toast';
import { Catalog, Artwork, PdfOptions, CatalogTheme } from '../types';
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
import { generateCatalogPdf } from './CatalogStudio/catalogPdfClient';
import { FullScreenPortal } from '../components/FullScreenPortal';
import { useIsDesktop } from '../hooks/useMediaQuery';
import { IfCan } from '../components/Layout';
import { ViewingRoomsPanel } from './ViewingRoomsPanel';

export const THEME_INFO: { id: CatalogTheme; name: string; desc: string; bg: string; fg: string; accent: string }[] = [
    { id: 1, name: 'Classic', desc: 'White & gradient', bg: '#ffffff', fg: '#1a1a1a', accent: '#e0e0e0' },
    { id: 2, name: 'Warm Grey', desc: 'Light grey gradient', bg: '#e0e0e0', fg: '#1a1a1a', accent: '#e0e0e0' },
    { id: 3, name: 'Edge Gradient', desc: 'White background', bg: '#ffffff', fg: '#1a1a1a', accent: '#8e44ad' },
    { id: 4, name: 'Dark & Gold', desc: 'Premium dark', bg: '#2a2a2a', fg: '#C9A84C', accent: '#C9A84C' },
    { id: 5, name: 'Gradient Cutout', desc: 'Grey gradient & cutout', bg: '#e0e0e0', fg: '#1a1a1a', accent: '#8e44ad' },
];


/** Hand the browser a file to save — what jsPDF's doc.save() did internally. */
const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
    // Give the browser time to start the download before releasing the blob.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

export const CatalogsView: React.FC<CatalogsViewProps> = ({ catalogs, artworks, onAddCatalog, onUpdateCatalog, onDeleteCatalog }) => {
    const isDesktop = useIsDesktop();
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
    const [showRooms, setShowRooms] = useState(false);
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
            const catalogArtworks = artworks.filter(a => catalogToDownload.artworkIds.includes(a.id));

            if (catalogArtworks.length === 0) {
                toast.error('No artworks in this catalog to generate PDF.');
                setIsGeneratingPDF(false);
                return;
            }

            // The whole build runs in a Web Worker. On the main thread, a big
            // catalog locked the page completely — the final assembly step
            // alone held it for over 45 seconds with 8 artworks.
            const pdfBytes = await generateCatalogPdf(
                {
                    artworks: catalogArtworks, options, themeId,
                    catalogName: catalogToDownload.name, catalogCoverUrl: catalogToDownload.coverImageUrl,
                },
                { onProgress: setPdfProgress, onWarning: (message) => toast.error(message) },
            );
            // Built once and reused for both the upload and the download — the
            // old code serialised the whole document twice.
            const blob = new Blob([pdfBytes], { type: 'application/pdf' });

            setPdfProgress('Saving to Catalogs…');
            // Store the generated PDF so it lives in the Catalogs list.
            try {
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
            downloadBlob(blob, `${catalogToDownload.name.replaceAll(/\s+/g, '_')}.pdf`);
        } catch (error) {
            console.error("Error generating PDF:", error);
            toast.error('Failed to generate PDF.');
        } finally {
            // Stay in the studio after generating so options can be tweaked
            // and the PDF regenerated without re-opening it.
            setIsGeneratingPDF(false);
            setPdfProgress(null);
        }
    };

    return (
        <PageRoot>
            <PageHeader
                title="Catalogs"
                actions={
                    <>
                        <IfCan section="catalogs" level="view"><GhostIconButton
                            onClick={() => setShowRooms(true)}
                            label="Private rooms"
                            icon={<Lock size={16} />}
                        /></IfCan>
                        {tab === 'catalogs' && (
                            <IfCan section="catalogs"><GhostIconButton
                                onClick={() => pdfInputRef.current?.click()}
                                label="Upload catalog PDF"
                                icon={isUploadingPdf ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                                disabled={isUploadingPdf}
                            /></IfCan>
                        )}
                        {tab === 'create' && (
                            <IfCan section="catalogs"><PrimaryIconButton
                                onClick={() => { setFormCatalog(null); setShowForm(true); }}
                                label="Add catalog"
                                icon={<Plus size={16} />}
                            /></IfCan>
                        )}
                        <input ref={pdfInputRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={handleUploadPdf} />
                    </>
                }
            >
                {/* Search — above the tabs, shared by both sections */}
                <SearchBar value={searchQuery} onChange={setSearchQuery} placeholder={tab === 'create' ? 'Search catalogs to edit...' : 'Search catalogs...'} />

                {/* Sections: saved catalogs vs. the create flow */}
                <div className="flex gap-2 lg:w-fit">
                    <button
                        type="button"
                        onClick={() => setTab('catalogs')}
                        className={`flex-1 lg:flex-none lg:px-8 py-2 rounded-full text-[11px] font-bold uppercase tracking-widest transition-colors active-scale ${tab === 'catalogs'
                            ? 'neu-inset text-gold-700 dark:text-gold-300'
                            : 'neu-raised-sm neu-btn text-gray-700 dark:text-gray-300'
                            }`}
                    >
                        Catalogs
                    </button>
                    <button
                        type="button"
                        onClick={() => setTab('create')}
                        className={`flex-1 lg:flex-none lg:px-8 py-2 rounded-full text-[11px] font-bold uppercase tracking-widest transition-colors active-scale ${tab === 'create'
                            ? 'neu-inset text-gold-700 dark:text-gold-300'
                            : 'neu-raised-sm neu-btn text-gray-700 dark:text-gray-300'
                            }`}
                    >
                        Create Catalog
                    </button>
                </div>
            </PageHeader>

            {tab === 'create' ? (
                <PageBody columns="gallery">
                    {/* Every catalog with its selected products — tap to edit */}
                    {editableCatalogs.map((catalog, index) => (
                        <div
                            key={catalog.id}
                            className="neu-tile neu-tile-interactive w-full animate-fade-in-up"
                            style={{ animationDelay: `${Math.min(index, 12) * 45}ms` }}
                        >
                            {/* Card tap target; the action button sits above it (z-[2]). */}
                            <button
                                type="button"
                                onClick={() => { setFormCatalog(catalog); setShowForm(true); }}
                                aria-label={`Edit catalog ${catalog.name}`}
                                className="absolute inset-0 z-[1] w-full h-full rounded-[1.4rem] cursor-pointer"
                            />
                            <div className="neu-picture-well neu-picture-well-sm w-full aspect-[4/3] rounded-[1rem]">
                                <img loading="lazy" decoding="async" src={getThumbUrl(catalog.coverImageUrl)} alt={catalog.name} className="w-full h-full object-cover" />
                                {catalog.pdfUrl && (
                                    <span className="neu-chip-float top-2 left-2 text-[var(--neu-gold)]">
                                        <FileText size={11} /> PDF saved
                                    </span>
                                )}
                            </div>
                            <div className="flex-1 flex flex-col px-1.5 pt-3 pb-1 min-w-0">
                                <h3 className="font-serif text-[15px] leading-snug text-[var(--neu-text)] line-clamp-2">{catalog.name}</h3>
                                <p className="mt-1 text-[10.5px] uppercase tracking-wider text-[var(--neu-text-dim)]">
                                    {catalog.artworkIds.length} {catalog.artworkIds.length === 1 ? 'artwork' : 'artworks'}
                                </p>
                                {catalog.description && (
                                    <p className="mt-1 text-[11px] text-[var(--neu-text-dim)] line-clamp-2">{catalog.description}</p>
                                )}
                                <div className="mt-auto pt-3">
                                    <button
                                        type="button"
                                        onClick={(e) => { e.stopPropagation(); handleDownloadClick(catalog); }}
                                        disabled={isGeneratingPDF}
                                        title="Open PDF generator"
                                        className="relative z-[2] neu-raised-sm neu-btn rounded-full px-3.5 py-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gold-700 dark:text-gold-300 active-scale disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        <Download size={13} /> Make PDF
                                    </button>
                                </div>
                            </div>
                        </div>
                    ))}
                    {editableCatalogs.length === 0 && (
                        <EmptyState
                            icon={<BookOpen size={22} strokeWidth={1.25} />}
                            title="No catalogs yet"
                            message="Tap the + button above to create your first one."
                        />
                    )}
                </PageBody>
            ) : (
            <PageBody columns="gallery">
                {pdfCatalogs.map((catalog, index) => (
                    <div
                        key={catalog.id}
                        className="neu-tile neu-tile-interactive w-full animate-fade-in-up"
                        style={{ animationDelay: `${Math.min(index, 12) * 45}ms` }}
                    >
                        {/* Card tap target; the action buttons sit above it (z-[2]). */}
                        <button
                            type="button"
                            onClick={() => handleOpenPdf(catalog)}
                            aria-label={`Open catalog PDF ${catalog.name}`}
                            className="absolute inset-0 z-[1] w-full h-full rounded-[1.4rem] cursor-pointer"
                        />
                        <div className="neu-picture-well neu-picture-well-sm w-full aspect-[4/3] rounded-[1rem]">
                            {catalog.source === 'uploaded' ? (
                                <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 text-[var(--neu-gold)]">
                                    <FileText size={34} strokeWidth={1.25} />
                                    <span className="text-[10px] font-bold uppercase tracking-widest">Uploaded PDF</span>
                                </div>
                            ) : (
                                <img loading="lazy" decoding="async" src={getThumbUrl(catalog.coverImageUrl)} alt={catalog.name} className="w-full h-full object-cover" />
                            )}
                            <span className="neu-chip-float top-2 left-2 text-[var(--neu-gold)]">
                                <FileText size={11} /> PDF
                            </span>
                        </div>
                        <div className="flex-1 flex flex-col px-1.5 pt-3 pb-1 min-w-0">
                            <h3 className="font-serif text-[15px] leading-snug text-[var(--neu-text)] line-clamp-2">{catalog.name}</h3>
                            <p className="mt-1 text-[10.5px] uppercase tracking-wider text-[var(--neu-text-dim)]">
                                {catalog.source === 'uploaded' ? 'Uploaded' : `${catalog.artworkIds.length} ${catalog.artworkIds.length === 1 ? 'artwork' : 'artworks'}`}
                            </p>
                            {catalog.description && (
                                <p className="mt-1 text-[11px] text-[var(--neu-text-dim)] line-clamp-2">{catalog.description}</p>
                            )}
                            <div className="mt-auto pt-3 flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); setRenameTarget(catalog); setRenameValue(catalog.name); }}
                                    aria-label={`Rename ${catalog.name}`}
                                    title="Rename"
                                    className="neu-icon-btn neu-btn active-scale relative z-[2]"
                                >
                                    <Edit2 size={14} />
                                </button>
                                <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); void handleDownloadPdf(catalog); }}
                                    aria-label={`Download ${catalog.name}`}
                                    title="Download PDF"
                                    className="neu-icon-btn neu-btn active-scale relative z-[2]"
                                >
                                    <FileDown size={14} />
                                </button>
                                <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); setDeletePdfTarget(catalog); }}
                                    aria-label={`Delete ${catalog.name}`}
                                    title="Delete PDF"
                                    className="neu-icon-btn neu-btn active-scale relative z-[2] ml-auto text-red-600 dark:text-red-400"
                                >
                                    <Trash2 size={14} />
                                </button>
                            </div>
                        </div>
                    </div>
                ))}
                {pdfCatalogs.length === 0 && (
                    <EmptyState
                        icon={<FileText size={22} strokeWidth={1.25} />}
                        title="No catalog PDFs yet"
                        message='Upload a PDF, or build one from the "Create Catalog" tab — generated PDFs are saved here automatically.'
                    />
                )}
            </PageBody>
            )}

            {/* Catalog Studio View */}
            {showCatalogStudio && catalogToDownload && (() => {
                const studio = (
                    <CatalogStudioView
                        catalog={catalogToDownload}
                        artworks={artworks}
                        onClose={() => setShowCatalogStudio(false)}
                        onGeneratePDF={(options, themeId) => handleGeneratePDF(options, themeId)}
                        isGeneratingPDF={isGeneratingPDF}
                        generationProgress={pdfProgress}
                    />
                );
                // Rendered inside <main>, whose fade-in animation makes it a
                // stacking context — so on phones the dock (z-40, outside main)
                // was drawn over the studio's Generate button and preview. The
                // portal lifts it above the dock. Desktop has no dock, and
                // staying inline keeps the sidebar visible beside the studio.
                return isDesktop ? studio : <FullScreenPortal>{studio}</FullScreenPortal>;
            })()}

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
                        className="fixed inset-0 neu-scrim border-none p-0 cursor-default"
                        onClick={() => setRenameTarget(null)}
                        aria-label="Close rename dialog"
                    />
                    <div className="relative z-10 w-full max-w-md mx-4 rounded-2xl neu-raised p-5 shadow-xl animate-scale-in">
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
                            className="neu-field"
                        />
                        <div className="mt-4 flex justify-end gap-2">
                            <button
                                type="button"
                                onClick={() => setRenameTarget(null)}
                                className="inline-flex justify-center rounded-md neu-raised-sm neu-btn px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={handleRenameSave}
                                className="neu-button neu-button-active text-sm"
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
            {showRooms && (
                <FullScreenPortal>
                    <ViewingRoomsPanel artworks={artworks} onClose={() => setShowRooms(false)} />
                </FullScreenPortal>
            )}
        </PageRoot>
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

export const CatalogDetailModal: React.FC<CatalogDetailModalProps> = ({ catalog, artworks, onDownloadClick, onArtworkClick, onUpdateCatalog, onDeleteCatalog, isGeneratingPDF, onAddArtwork }) => {
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
            toast.error('Failed to upload cover image.');
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
        <div className="neu-sheet z-50 animate-fade-in-up">
            <div className="px-3 pb-2.5 z-10" style={{ paddingTop: 'calc(1.75rem + env(safe-area-inset-top, 0px))' }}>
                <div className="flex justify-between items-center mb-3">
                    <h2 className="text-xl font-serif text-gray-900 dark:text-white truncate px-1">{catalog.name}</h2>
                    <div className="flex items-center gap-2">
                        <IfCan section="catalogs">
                            <button onClick={() => setIsEditing(true)} className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale">
                                <Edit2 size={18} />
                            </button>
                        </IfCan>
                        <button onClick={onDownloadClick} disabled={isGeneratingPDF} className={`neu-icon-btn text-gold-700 dark:text-gold-300 active-scale ${isGeneratingPDF ? 'opacity-50 cursor-not-allowed' : ''}`}>
                            <Download size={20} />
                        </button>
                        <IfCan section="catalogs">
                            <button onClick={handleDelete} className="neu-icon-btn text-red-500 active-scale">
                                <Trash2 size={18} />
                            </button>
                        </IfCan>
                    </div>
                </div>
                <SearchBar value={detailSearchQuery} onChange={setDetailSearchQuery} placeholder="Search artworks..." />
            </div>

            <div className="flex-1 overflow-y-auto no-scrollbar pb-20 lg:pb-8">
                <div className="w-full aspect-[21/9] relative animate-fade-in group">
                    <img loading="lazy" decoding="async" src={getThumbUrl(catalog.coverImageUrl)} alt={catalog.name} className="w-full h-full object-cover" />
                    {/* Gradient removed as per user request */}

                    <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isUploading}
                        className="absolute top-3 right-4 p-2 bg-black/40 hover:bg-black/60 text-white rounded-full backdrop-blur-sm transition-colors z-10 disabled:opacity-50"
                        title="Upload Cover Image"
                    >
                        {isUploading ? <Loader2 size={18} className="animate-spin" /> : <Camera size={18} />}
                    </button>
                    <input type="file" accept="image/*" ref={fileInputRef} className="hidden" onChange={handleUploadCoverImage} />
                </div>

                <div className="p-4 bg-[var(--neu-bg)] relative z-20 min-h-[50dvh] flex flex-col gap-3">
                    <div className="flex justify-between items-center mb-3">
                        <h3 className="font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest text-[11px]">Artworks in Catalog ({catalogArtworks.length})</h3>
                        <button
                            onClick={() => setIsAddingProduct(true)}
                            className="neu-raised-sm neu-btn text-gold-700 dark:text-gold-300 p-1.5 rounded-full shadow-md transition-colors active-scale"
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
                            className="w-full text-left neu-raised rounded-2xl overflow-hidden flex h-28 animate-fade-in-up cursor-pointer active-scale"
                            style={{ animationDelay: `${index * 45}ms` }}
                        >
                            <div className="w-28 h-full relative shrink-0 neu-inset">
                                {artwork.imageUrls.length > 0 ? (
                                    <img loading="lazy" decoding="async" src={getThumbUrl(artwork.imageUrls[0])} alt={artwork.title} className="w-full h-full object-cover" />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center text-gray-600 dark:text-gray-300">
                                        <ImageIcon size={28} strokeWidth={1} />
                                    </div>
                                )}
                            </div>
                            <div className="p-3 flex flex-col justify-between flex-1">
                                <div>
                                    <h3 className="font-serif text-gray-900 dark:text-gray-100 line-clamp-1 text-sm">{artwork.title}</h3>
                                    <p className="text-[11px] text-gray-700 dark:text-gray-300 mt-1 uppercase tracking-wider line-clamp-1">
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
                                    <p className="text-[11px] text-gray-600 dark:text-gray-300 font-light">{artwork.dimensions}</p>
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
            toast.error('Name is required');
            return null;
        }
        if (selectedArtworks.size === 0) {
            toast.error('Select at least one artwork');
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
            ? 'h-full flex flex-col bg-[var(--neu-bg)]'
            : 'neu-sheet z-[70] animate-fade-in-up'}>
            <div className="flex justify-between items-center p-3 pt-[calc(1.75rem+env(safe-area-inset-top,0px))]">
                <button onClick={onClose} className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale">
                    <X size={20} />
                </button>
                <h2 className="flex-1 text-center text-base font-serif text-gray-900 dark:text-white">{initialData ? 'Edit Catalog' : 'Create Catalog'}</h2>
                <div className="flex items-center gap-0.5">
                    {initialData && onDelete && (
                        <button
                            type="button"
                            onClick={() => setConfirmDelete(true)}
                            aria-label="Delete catalog"
                            title="Delete catalog"
                            className="p-2 text-gray-600 dark:text-gray-300 hover:text-red-500 rounded-full transition-colors active-scale"
                        >
                            <Trash2 size={18} />
                        </button>
                    )}
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
                    <button onClick={handleSubmit} className="text-gold-700 dark:text-gold-300 font-medium px-2 py-2 uppercase tracking-wider text-xs active-scale">
                        Save
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3 no-scrollbar flex flex-col gap-6">
                <div className="space-y-5 neu-card p-5 animate-fade-in-up" style={{ animationDelay: '100ms' }}>
                    <div>
                        <label htmlFor="catalog-name" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Catalog Name *</label>
                        <input
                            id="catalog-name"
                            value={name}
                            onChange={e => setName(e.target.value)}
                            className="neu-field text-base font-serif"
                            placeholder="e.g. Summer Collection 2024"
                        />
                    </div>
                    <div>
                        <label htmlFor="catalog-desc" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-2 uppercase tracking-wider">Description</label>
                        <textarea
                            id="catalog-desc"
                            value={description}
                            onChange={e => setDescription(e.target.value)}
                            rows={1}
                            className="w-full bg-transparent border border-gray-300 dark:border-gray-700 rounded-lg py-1.5 px-2 text-xs text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors resize-none"
                            placeholder="Brief description of this catalog..."
                        ></textarea>
                    </div>
                </div>

                <div className="animate-fade-in-up" style={{ animationDelay: '200ms' }}>
                    <div className="flex justify-between items-end mb-3">
                        <h3 className="font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest text-[11px]">Select Artworks</h3>
                        <span className="text-[11px] text-gray-700 dark:text-gray-300 uppercase tracking-wider">{selectedArtworks.size} selected</span>
                    </div>

                    {/* Search Bar for Artworks */}
                    <SearchBar value={searchQuery} onChange={setSearchQuery} placeholder="Search artworks to add..." className="mb-4" />

                    {/* Selected product tile tray */}
                    {selectedList.length > 0 && (
                        <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1 mb-4">
                            {selectedList.map(art => (
                                <div key={art.id} className="relative w-16 h-16 rounded-lg overflow-hidden border-2 border-gold-500 shrink-0 animate-scale-in">
                                    {art.imageUrls?.[0] ? (
                                        <img loading="lazy" decoding="async" src={getThumbUrl(art.imageUrls[0])} alt={art.title} className="w-full h-full object-cover" />
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center text-gray-600 dark:text-gray-300">
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

                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3 md:gap-4">
                        {filteredArtworks.map((art, index) => {
                            const isSelected = selectedArtworks.has(art.id);
                            const coverImage = art.imageUrls?.[0];
                            return (
                                <button
                                    type="button"
                                    key={art.id}
                                    onClick={() => toggleArtwork(art.id)}
                                    className={`relative w-full text-left rounded-lg overflow-hidden border-2 cursor-pointer transition-all neu-inset animate-scale-in active-scale ${isSelected ? 'border-gold-500 shadow-md' : 'border-transparent shadow-sm'
                                        }`}
                                    style={{ animationDelay: `${index * 30}ms` }}
                                >
                                    {coverImage ? (
                                        <img loading="lazy" decoding="async" src={getThumbUrl(coverImage)} alt={art.title} className="w-full h-32 object-cover" />
                                    ) : (
                                        <div className="w-full h-32 flex items-center justify-center text-gray-600 dark:text-gray-300">
                                            <ImageIcon size={20} strokeWidth={1.5} />
                                        </div>
                                    )}
                                    <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-2 pt-6">
                                        <p className="text-white text-[11px] font-serif truncate">{art.title}</p>
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
                            <div className="col-span-2 text-center text-gray-600 dark:text-gray-300 py-6 text-xs font-light">
                                No artworks found matching "{searchQuery}".
                            </div>
                        )}
                    </div>
                </div>



                {initialData && onDelete && (
                    <button
                        type="button"
                        onClick={() => setConfirmDelete(true)}
                        className="neu-button neu-button-danger w-full"
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
