import React, { useState, useRef } from 'react';
import { Plus, Image as ImageIcon, X, Trash2, Loader2, Camera, Folder } from 'lucide-react';
import { SearchBar } from '../components/SearchBar';
import { PageRoot, PageHeader, PageBody, PrimaryIconButton, EmptyState } from '../components/ui';
import { Artwork } from '../types';
import toast from 'react-hot-toast';
import storageService, { getThumbUrl } from '../services/storageService';
import { fileKeyOf } from '../services/workspace';
import { IfCan } from '../components/Layout';


interface ArtworksViewProps {
    artworks: Artwork[];
    onAddArtwork: (artwork: Omit<Artwork, 'id' | 'createdAt'>) => void;
    onArtworkClick: (artwork: Artwork) => void;
}

export const ArtworksView: React.FC<ArtworksViewProps> = ({ artworks, onAddArtwork, onArtworkClick }) => {
    const [isAdding, setIsAdding] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');

    const filteredArtworks = artworks.filter(art =>
        art.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        art.customId.toLowerCase().includes(searchQuery.toLowerCase())
    );

    return (
        <PageRoot>
            <PageHeader
                title="Inventory"
                actions={<IfCan section="inventory"><PrimaryIconButton onClick={() => setIsAdding(true)} label="Add artwork" icon={<Plus size={16} />} /></IfCan>}
            >
                <SearchBar value={searchQuery} onChange={setSearchQuery} placeholder="Search artworks..." />
            </PageHeader>

            {/* List */}
            <PageBody columns="gallery">
                {filteredArtworks.map((artwork: Artwork, index: number) => {
                    let statusText = 'text-yellow-700 dark:text-yellow-400';
                    if (artwork.status === 'Available') statusText = 'text-green-700 dark:text-green-400';
                    else if (artwork.status === 'Sold') statusText = 'text-red-700 dark:text-red-400';

                    const meta = [artwork.artist, artwork.customId, artwork.medium].filter(Boolean).join(' · ');
                    const imageCount = artwork.imageUrls.length;

                    return (
                        <button
                            key={artwork.id}
                            type="button"
                            onClick={() => onArtworkClick(artwork)}
                            className="neu-tile neu-tile-interactive w-full animate-fade-in-up cursor-pointer active-scale"
                            style={{ animationDelay: `${Math.min(index, 12) * 45}ms` }}
                        >
                            {/* Photo, set into the card */}
                            <div className="neu-picture-well neu-picture-well-sm w-full aspect-[4/3] rounded-[1rem]">
                                {imageCount > 0 ? (
                                    <img loading="lazy" decoding="async" src={getThumbUrl(artwork.imageUrls[0])} alt={artwork.title} className="w-full h-full object-cover" />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center text-[var(--neu-text-dim)]">
                                        <ImageIcon size={28} strokeWidth={1} />
                                    </div>
                                )}
                                <span className={`neu-chip-float top-2 left-2 ${statusText}`}>
                                    <span className="w-1.5 h-1.5 rounded-full bg-current" />
                                    {artwork.status}
                                </span>
                                {imageCount > 1 && (
                                    <span className="neu-chip-float bottom-2 right-2 text-[var(--neu-text)] tracking-normal">
                                        <ImageIcon size={11} /> {imageCount}
                                    </span>
                                )}
                            </div>

                            <div className="flex-1 flex flex-col px-1.5 pt-3 pb-1 min-w-0">
                                <h3 className="font-serif text-[15px] leading-snug text-[var(--neu-text)] line-clamp-2">{artwork.title}</h3>
                                {meta && <p className="mt-1 text-[10.5px] uppercase tracking-wider text-[var(--neu-text-dim)] truncate">{meta}</p>}
                                <div className="mt-auto pt-2.5 flex items-baseline justify-between gap-2">
                                    <p className="text-sm font-semibold text-[var(--neu-gold)] whitespace-nowrap">
                                        ₹{artwork.price.toLocaleString('en-IN')}
                                        {artwork.plusGst && <span className="ml-1 text-[10px] font-medium text-[var(--neu-text-dim)]">+GST</span>}
                                    </p>
                                    {artwork.dimensions && <p className="text-[10.5px] text-[var(--neu-text-dim)] truncate min-w-0">{artwork.dimensions}</p>}
                                </div>
                            </div>
                        </button>
                    );
                })}
                {filteredArtworks.length === 0 && (
                    <EmptyState
                        icon={<ImageIcon size={22} strokeWidth={1.25} />}
                        title="No artworks found"
                        message="Add your first artwork with the + button above."
                    />
                )}
            </PageBody>

            {/* Add Modal */}
            {isAdding && (
                <ArtworkFormModal
                    onClose={() => setIsAdding(false)}
                    onSave={(newArt) => {
                        onAddArtwork(newArt);
                        setIsAdding(false);
                    }}
                />
            )}
        </PageRoot>
    );
};

export interface ArtworkFormModalProps {
    initialData?: Artwork;
    onClose: () => void;
    onSave: (artwork: Omit<Artwork, 'id' | 'createdAt'>) => void;
    onDelete?: () => void;
}

export const ArtworkFormModal: React.FC<ArtworkFormModalProps> = ({ initialData, onClose, onSave, onDelete }) => {
    const [formData, setFormData] = useState({
        title: initialData?.title || '',
        artist: initialData?.artist || '',
        artworkYear: initialData?.artworkYear || '',
        customId: initialData?.customId || '',
        descriptionTitle: initialData?.descriptionTitle || '',
        description: initialData?.description || '',
        dimensions: initialData?.dimensions || '',
        medium: initialData?.medium || '',
        status: initialData?.status || 'Available',
        location: initialData?.location || '',
        price: initialData?.price?.toString() || '',
        plusGst: initialData?.plusGst || false,
        imageUrls: initialData?.imageUrls ?? []
    });
    const [showUploadOptions, setShowUploadOptions] = useState(false);

    const [isUploading, setIsUploading] = useState(false);

    const cameraInputRef = useRef<HTMLInputElement>(null);
    const galleryInputRef = useRef<HTMLInputElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleSubmit = (e: React.SyntheticEvent<HTMLFormElement>) => {
        e.preventDefault();
        onSave({
            ...formData,
            price: Number(formData.price) || 0
        });
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
        const { name, value, type } = e.target;
        if (type === 'checkbox') {
            const checked = (e.target as HTMLInputElement).checked;
            setFormData(prev => ({ ...prev, [name]: checked }));
        } else {
            setFormData(prev => ({ ...prev, [name]: value }));
        }
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) {
            e.target.value = '';
            return;
        }
        setIsUploading(true);
        storageService.upload(file)
            .then((result) => {
                setFormData(prev => ({
                    ...prev,
                    imageUrls: [...prev.imageUrls, result.url]
                }));
            })
            .catch((error) => {
                console.error('Upload failed:', error);
                toast.error('Failed to upload image. Please try again.');
            })
            .finally(() => {
                setIsUploading(false);
                // Reset input value so the same file can be selected again if needed
                e.target.value = '';
            });
    };

    const handleRemoveImage = async (indexToRemove: number) => {
        const urlToRemove = formData.imageUrls[indexToRemove];
        // Only attempt R2 deletion for R2-hosted files (not legacy data URLs)
        const key = urlToRemove ? fileKeyOf(urlToRemove) : null;
        if (key) {
            try {
                await storageService.delete(key);
            } catch (error) {
                console.error('Failed to delete from R2:', error);
            }
        }
        setFormData(prev => ({
            ...prev,
            imageUrls: prev.imageUrls.filter((_, index) => index !== indexToRemove)
        }));
    };

    const handleSetAsCover = (indexToCover: number) => {
        if (indexToCover === 0) return;
        setFormData(prev => {
            const newImageUrls = [...prev.imageUrls];
            const coverImage = newImageUrls.splice(indexToCover, 1)[0];
            newImageUrls.unshift(coverImage);
            return {
                ...prev,
                imageUrls: newImageUrls
            };
        });
    };

    return (
        <div className="neu-sheet z-50 animate-fade-in-up">
            <div className="flex justify-between items-center p-3" style={{ paddingTop: 'calc(1rem + var(--safe-top))' }}>
                <button onClick={onClose} className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale">
                    <X size={20} />
                </button>
                <h2 className="text-base font-serif text-gray-900 dark:text-white">{initialData ? 'Edit Artwork' : 'New Artwork'}</h2>
                <div className="flex items-center gap-2">
                    {initialData && onDelete && (
                        <button onClick={onDelete} className="neu-icon-btn text-red-500 active-scale">
                            <Trash2 size={18} />
                        </button>
                    )}
                    <button type="submit" form="add-art-form" className="text-gold-700 dark:text-gold-300 font-medium px-2 py-2 uppercase tracking-wider text-xs active-scale">
                        Save
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3 no-scrollbar relative">
                <form id="add-art-form" onSubmit={handleSubmit} className="space-y-6">

                    {/* Multiple Image Upload Area */}
                    <div>
                        <label className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-2 uppercase tracking-wider">Photos ({formData.imageUrls.length})</label>
                        <div className="flex gap-2 overflow-x-auto no-scrollbar pb-2 snap-x">
                            {formData.imageUrls.map((url: string, idx: number) => (
                                <div key={url} className="relative w-32 h-32 shrink-0 rounded-lg overflow-hidden snap-start shadow-sm animate-scale-in" style={{ animationDelay: `${idx * 50}ms` }}>
                                    <img loading="lazy" decoding="async" src={getThumbUrl(url)} alt={`Preview ${idx + 1}`} className="w-full h-full object-cover" />
                                    <button
                                        type="button"
                                        onClick={() => handleRemoveImage(idx)}
                                        className="absolute top-1.5 right-1.5 bg-black/50 text-white p-1 rounded-full hover:bg-black/70 backdrop-blur-sm transition-colors active-scale"
                                    >
                                        <X size={14} />
                                    </button>
                                    {idx === 0 ? (
                                        <div className="absolute bottom-1.5 left-1.5 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded-[3px] backdrop-blur-sm uppercase tracking-wider">
                                            Cover
                                        </div>
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={() => handleSetAsCover(idx)}
                                            className="absolute bottom-1.5 left-1.5 bg-black/40 hover:bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded-[3px] backdrop-blur-sm uppercase tracking-wider transition-colors active-scale"
                                        >
                                            Set Cover
                                        </button>
                                    )}
                                </div>
                            ))}

                            <button
                                type="button"
                                onClick={() => setShowUploadOptions(true)}
                                disabled={isUploading}
                                className="w-32 h-32 shrink-0 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-700 flex flex-col items-center justify-center text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 hover:border-gold-400 dark:hover:border-gold-500 transition-colors snap-start active-scale disabled:opacity-60"
                            >
                                {isUploading ? (
                                    <>
                                        <Loader2 size={24} className="mb-1 animate-spin" strokeWidth={1.5} />
                                        <span className="text-[11px] font-medium uppercase tracking-wider">Uploading...</span>
                                    </>
                                ) : (
                                    <>
                                        <Plus size={24} className="mb-1" strokeWidth={1.5} />
                                        <span className="text-[11px] font-medium uppercase tracking-wider">Add Photo</span>
                                    </>
                                )}
                            </button>
                        </div>
                    </div>

                    <div className="space-y-5 neu-card p-5 animate-fade-in-up" style={{ animationDelay: '100ms' }}>
                        <div>
                            <label htmlFor="artwork-title" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Title *</label>
                            <input id="artwork-title" required name="title" value={formData.title} onChange={handleChange} className="neu-field text-base font-serif" placeholder="e.g. Starry Night" />
                        </div>

                        <div className="flex gap-3">
                            <div className="flex-[2]">
                                <label htmlFor="artwork-artist" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Artist</label>
                                <input id="artwork-artist" name="artist" value={formData.artist} onChange={handleChange} className="neu-field" placeholder="e.g. Vincent van Gogh" />
                            </div>
                            <div className="flex-1">
                                <label htmlFor="artwork-year" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Year</label>
                                <input id="artwork-year" name="artworkYear" value={formData.artworkYear} onChange={handleChange} className="neu-field" placeholder="e.g. 1889" />
                            </div>
                        </div>

                        <div className="flex gap-3">
                            <div className="flex-1">
                                <label htmlFor="artwork-customid" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Inventory ID</label>
                                <input id="artwork-customid" name="customId" value={formData.customId} onChange={handleChange} className="neu-field" placeholder="ART-001" />
                            </div>
                            <div className="flex-1">
                                <label htmlFor="artwork-price" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Price (₹)</label>
                                <div className="flex items-center gap-2">
                                    <input id="artwork-price" required type="number" name="price" value={formData.price} onChange={handleChange} className="neu-field" placeholder="0.00" />
                                </div>
                                <div className="mt-2 flex items-center gap-1.5">
                                    <input type="checkbox" id="plusGst" name="plusGst" checked={formData.plusGst} onChange={handleChange} className="accent-gold-500 w-3 h-3" />
                                    <label htmlFor="plusGst" className="text-[11px] text-gray-600 dark:text-gray-400 cursor-pointer">+ GST</label>
                                </div>
                            </div>
                        </div>

                        <div>
                            <label htmlFor="artwork-status" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Status</label>
                            <select id="artwork-status" name="status" value={formData.status} onChange={handleChange} className="neu-field">
                                <option value="Available" className="dark:bg-gray-800">Available</option>
                                <option value="Sold" className="dark:bg-gray-800">Sold</option>
                                <option value="Reserved" className="dark:bg-gray-800">Reserved</option>
                            </select>
                        </div>

                        <div className="flex gap-3">
                            <div className="flex-1">
                                <label htmlFor="artwork-dimensions" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Dimensions</label>
                                <input id="artwork-dimensions" name="dimensions" value={formData.dimensions} onChange={handleChange} className="neu-field" placeholder="e.g. 24x36 in" />
                            </div>
                            <div className="flex-1">
                                <label htmlFor="artwork-medium" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Medium</label>
                                <input id="artwork-medium" name="medium" value={formData.medium} onChange={handleChange} className="neu-field" placeholder="e.g. Oil on Canvas" />
                            </div>
                        </div>

                        <div>
                            <label htmlFor="artwork-location" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Location</label>
                            <input id="artwork-location" name="location" value={formData.location} onChange={handleChange} className="neu-field" placeholder="e.g. Main Gallery" />
                        </div>

                        <div>
                            <label htmlFor="artwork-description-title" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Description Title</label>
                            <input id="artwork-description-title" name="descriptionTitle" value={formData.descriptionTitle} onChange={handleChange} className="neu-field mb-3" placeholder="e.g. Provenance or Exhibition History" />

                            <label htmlFor="artwork-description" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-2 uppercase tracking-wider">Description</label>
                            <textarea id="artwork-description" name="description" value={formData.description} onChange={handleChange} rows={3} className="w-full bg-transparent border border-gray-300 dark:border-gray-700 rounded-lg p-2 text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors resize-none text-sm" placeholder="Details about the artwork..."></textarea>
                        </div>
                    </div>
                    <div className="h-10"></div> {/* Spacer */}
                </form>
            </div>

            {/* Upload Options Action Sheet */}
            {showUploadOptions && (
                <div className="absolute inset-0 z-[100] flex flex-col justify-end overflow-hidden">
                    <button
                        tabIndex={0}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setShowUploadOptions(false); }}
                        className="absolute inset-0 neu-scrim animate-fade-in"
                        onClick={() => setShowUploadOptions(false)}
                    ></button>
                    <div className="neu-raised p-6 relative z-10 animate-fade-in-up shadow-2xl pb-28 lg:pb-8">
                        <div className="w-12 h-1.5 bg-gray-300 dark:bg-gray-700 rounded-full mx-auto mb-6"></div>
                        <h3 className="text-sm font-bold text-gray-900 dark:text-white uppercase tracking-widest mb-6 text-center">Upload Photo</h3>

                        <div className="flex flex-col gap-3">
                            <button
                                type="button"
                                onClick={() => { cameraInputRef.current?.click(); setShowUploadOptions(false); }}
                                className="w-full flex items-center gap-3 p-3 rounded-lg neu-inset hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors active-scale border border-gray-100 dark:border-gray-700"
                            >
                                <div className="text-brand-900 dark:text-gold-400">
                                    <Camera size={24} strokeWidth={1.5} />
                                </div>
                                <span className="font-medium text-gray-900 dark:text-white text-sm tracking-wide">Take Photo</span>
                            </button>

                            <button
                                type="button"
                                onClick={() => { galleryInputRef.current?.click(); setShowUploadOptions(false); }}
                                className="w-full flex items-center gap-3 p-3 rounded-lg neu-inset hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors active-scale border border-gray-100 dark:border-gray-700"
                            >
                                <div className="text-brand-900 dark:text-gold-400">
                                    <ImageIcon size={24} strokeWidth={1.5} />
                                </div>
                                <span className="font-medium text-gray-900 dark:text-white text-sm tracking-wide">Choose from Gallery</span>
                            </button>

                            <button
                                type="button"
                                onClick={() => { fileInputRef.current?.click(); setShowUploadOptions(false); }}
                                className="w-full flex items-center gap-3 p-3 rounded-lg neu-inset hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors active-scale border border-gray-100 dark:border-gray-700"
                            >
                                <div className="text-brand-900 dark:text-gold-400">
                                    <Folder size={24} strokeWidth={1.5} />
                                </div>
                                <span className="font-medium text-gray-900 dark:text-white text-sm tracking-wide">Browse Files</span>
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Hidden Inputs MOVED OUTSIDE THE CONDITIONAL RENDER */}
            <input type="file" accept="image/*" capture="environment" ref={cameraInputRef} className="hidden" onChange={handleFileChange} />
            <input type="file" accept="image/*" ref={galleryInputRef} className="hidden" onChange={handleFileChange} />
            <input type="file" accept="*" ref={fileInputRef} className="hidden" onChange={handleFileChange} />
        </div>
    );
};
