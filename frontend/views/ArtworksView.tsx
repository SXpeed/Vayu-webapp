import React, { useState, useRef } from 'react';
import { Plus, Search, Image as ImageIcon, X, Trash2, Loader2, Camera, Folder } from 'lucide-react';
import { Artwork } from '../types';
import storageService from '../services/storageService';


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
        <div className="h-full flex flex-col bg-[#faf9f6] dark:bg-[#121212] transition-colors duration-500 animate-fade-in">
            {/* Header - Compact */}
            <div className="bg-white dark:bg-[#1a1a1a] px-[6px] pb-[6px] shadow-sm z-10 border-b border-gray-100 dark:border-gray-800" style={{ paddingTop: 'calc(1.75rem + env(safe-area-inset-top, 0px))' }}>
                <div className="flex justify-between items-center mb-[6px]">
                    <h1 className="text-xl font-serif text-gray-900 dark:text-white">Inventory</h1>
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
                        placeholder="Search artworks..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2 pl-9 pr-4 text-xs text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                    />
                </div>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto p-[6px] space-y-2 no-scrollbar pb-20">
                {filteredArtworks.map((artwork: Artwork, index: number) => {
                    let statusClass = 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400';
                    if (artwork.status === 'Available') statusClass = 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400';
                    else if (artwork.status === 'Sold') statusClass = 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400';

                    let artistText = '';
                    if (artwork.artist) {
                        artistText = artwork.artist;
                        if (artwork.artworkYear) artistText += `, ${artwork.artworkYear}`;
                        artistText += ' • ';
                    }

                    return (
                        <button
                            key={artwork.id}
                            tabIndex={0}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onArtworkClick(artwork); }}
                            onClick={() => onArtworkClick(artwork)}
                            className="w-full text-left bg-white dark:bg-[#1e1e1e] rounded-[6px] shadow-sm overflow-hidden flex h-28 border border-gray-100 dark:border-gray-800 animate-fade-in-up cursor-pointer active-scale"
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
                                {artwork.imageUrls.length > 1 && (
                                    <div className="absolute bottom-1 right-1 bg-black/60 text-white text-[9px] px-1.5 py-0.5 rounded-[3px] backdrop-blur-sm">
                                        1/{artwork.imageUrls.length}
                                    </div>
                                )}
                            </div>
                            <div className="p-[6px] flex flex-col justify-between flex-1">
                                <div>
                                    <div className="flex justify-between items-start">
                                        <h3 className="font-serif text-gray-900 dark:text-gray-100 line-clamp-1 text-sm">{artwork.title}</h3>
                                        <span className={`text-[8px] px-1.5 py-0.5 rounded-[3px] font-medium uppercase tracking-wider ${statusClass}`}>
                                            {artwork.status}
                                        </span>
                                    </div>
                                    <p className="text-[9px] text-gray-500 dark:text-gray-400 mt-1 uppercase tracking-wider line-clamp-1">
                                        {artistText}
                                        {artwork.customId} • {artwork.medium}
                                    </p>
                                </div>
                                <div className="flex justify-between items-end">
                                    <p className="text-[10px] text-gray-400 dark:text-gray-500 font-light">{artwork.dimensions}</p>
                                    <p className="font-medium text-brand-900 dark:text-gold-400 text-sm">₹{artwork.price.toLocaleString('en-IN')}{artwork.plusGst ? ' + GST' : ''}</p>
                                </div>
                            </div>
                        </button>
                    );
                })}
                {filteredArtworks.length === 0 && (
                    <div className="text-center text-gray-400 dark:text-gray-500 mt-10 font-light text-sm">
                        No artworks found.
                    </div>
                )}
            </div>

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
        </div>
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
        imageUrls: initialData?.imageUrls || [] as string[]
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
                alert('Failed to upload image. Please try again.');
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
        if (urlToRemove?.startsWith('/api/files/')) {
            const key = decodeURIComponent(urlToRemove.slice('/api/files/'.length));
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
        <div className="absolute inset-0 bg-[#faf9f6] dark:bg-[#121212] z-50 flex flex-col animate-fade-in-up">
            <div className="bg-white dark:bg-[#1a1a1a] flex justify-between items-center p-[6px] border-b border-gray-100 dark:border-gray-800 shadow-sm" style={{ paddingTop: 'calc(1rem + env(safe-area-inset-top, 0px))' }}>
                <button onClick={onClose} className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale">
                    <X size={20} />
                </button>
                <h2 className="text-base font-serif text-gray-900 dark:text-white">{initialData ? 'Edit Artwork' : 'New Artwork'}</h2>
                <div className="flex items-center gap-2">
                    {initialData && onDelete && (
                        <button onClick={onDelete} className="p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-full transition-colors active-scale">
                            <Trash2 size={18} />
                        </button>
                    )}
                    <button type="submit" form="add-art-form" className="text-gold-600 dark:text-gold-400 font-medium px-2 py-2 uppercase tracking-wider text-xs active-scale">
                        Save
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-[6px] no-scrollbar relative">
                <form id="add-art-form" onSubmit={handleSubmit} className="space-y-6">

                    {/* Multiple Image Upload Area */}
                    <div>
                        <label className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wider">Photos ({formData.imageUrls.length})</label>
                        <div className="flex gap-2 overflow-x-auto no-scrollbar pb-2 snap-x">
                            {formData.imageUrls.map((url: string, idx: number) => (
                                <div key={url} className="relative w-32 h-32 shrink-0 rounded-[6px] overflow-hidden snap-start border border-gray-200 dark:border-gray-700 shadow-sm animate-scale-in" style={{ animationDelay: `${idx * 50}ms` }}>
                                    <img src={url} alt={`Preview ${idx + 1}`} className="w-full h-full object-cover" />
                                    <button
                                        type="button"
                                        onClick={() => handleRemoveImage(idx)}
                                        className="absolute top-1.5 right-1.5 bg-black/50 text-white p-1 rounded-full hover:bg-black/70 backdrop-blur-sm transition-colors active-scale"
                                    >
                                        <X size={14} />
                                    </button>
                                    {idx === 0 ? (
                                        <div className="absolute bottom-1.5 left-1.5 bg-black/60 text-white text-[8px] px-1.5 py-0.5 rounded-[3px] backdrop-blur-sm uppercase tracking-wider">
                                            Cover
                                        </div>
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={() => handleSetAsCover(idx)}
                                            className="absolute bottom-1.5 left-1.5 bg-black/40 hover:bg-black/60 text-white text-[8px] px-1.5 py-0.5 rounded-[3px] backdrop-blur-sm uppercase tracking-wider transition-colors active-scale"
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
                                className="w-32 h-32 shrink-0 rounded-[6px] border-2 border-dashed border-gray-300 dark:border-gray-700 flex flex-col items-center justify-center text-gray-400 dark:text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 hover:border-gold-400 dark:hover:border-gold-500 transition-colors snap-start active-scale disabled:opacity-60"
                            >
                                {isUploading ? (
                                    <>
                                        <Loader2 size={24} className="mb-1 animate-spin" strokeWidth={1.5} />
                                        <span className="text-[10px] font-medium uppercase tracking-wider">Uploading...</span>
                                    </>
                                ) : (
                                    <>
                                        <Plus size={24} className="mb-1" strokeWidth={1.5} />
                                        <span className="text-[10px] font-medium uppercase tracking-wider">Add Photo</span>
                                    </>
                                )}
                            </button>
                        </div>
                    </div>

                    <div className="space-y-5 bg-white dark:bg-[#1e1e1e] p-5 rounded-[6px] shadow-sm border border-gray-100 dark:border-gray-800 animate-fade-in-up" style={{ animationDelay: '100ms' }}>
                        <div>
                            <label htmlFor="artwork-title" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Title *</label>
                            <input id="artwork-title" required name="title" value={formData.title} onChange={handleChange} className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors font-serif text-base" placeholder="e.g. Starry Night" />
                        </div>

                        <div className="flex gap-[6px]">
                            <div className="flex-[2]">
                                <label htmlFor="artwork-artist" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Artist</label>
                                <input id="artwork-artist" name="artist" value={formData.artist} onChange={handleChange} className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors text-sm" placeholder="e.g. Vincent van Gogh" />
                            </div>
                            <div className="flex-1">
                                <label htmlFor="artwork-year" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Year</label>
                                <input id="artwork-year" name="artworkYear" value={formData.artworkYear} onChange={handleChange} className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors text-sm" placeholder="e.g. 1889" />
                            </div>
                        </div>

                        <div className="flex gap-[6px]">
                            <div className="flex-1">
                                <label htmlFor="artwork-customid" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Inventory ID</label>
                                <input id="artwork-customid" name="customId" value={formData.customId} onChange={handleChange} className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors text-sm" placeholder="ART-001" />
                            </div>
                            <div className="flex-1">
                                <label htmlFor="artwork-price" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Price (₹)</label>
                                <div className="flex items-center gap-2">
                                    <input id="artwork-price" required type="number" name="price" value={formData.price} onChange={handleChange} className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors text-sm" placeholder="0.00" />
                                </div>
                                <div className="mt-2 flex items-center gap-1.5">
                                    <input type="checkbox" id="plusGst" name="plusGst" checked={formData.plusGst} onChange={handleChange} className="accent-gold-500 w-3 h-3" />
                                    <label htmlFor="plusGst" className="text-[10px] text-gray-600 dark:text-gray-400 cursor-pointer">+ GST</label>
                                </div>
                            </div>
                        </div>

                        <div>
                            <label htmlFor="artwork-status" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Status</label>
                            <select id="artwork-status" name="status" value={formData.status} onChange={handleChange} className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors text-sm">
                                <option value="Available" className="dark:bg-gray-800">Available</option>
                                <option value="Sold" className="dark:bg-gray-800">Sold</option>
                                <option value="Reserved" className="dark:bg-gray-800">Reserved</option>
                            </select>
                        </div>

                        <div className="flex gap-[6px]">
                            <div className="flex-1">
                                <label htmlFor="artwork-dimensions" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Dimensions</label>
                                <input id="artwork-dimensions" name="dimensions" value={formData.dimensions} onChange={handleChange} className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors text-sm" placeholder="e.g. 24x36 in" />
                            </div>
                            <div className="flex-1">
                                <label htmlFor="artwork-medium" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Medium</label>
                                <input id="artwork-medium" name="medium" value={formData.medium} onChange={handleChange} className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors text-sm" placeholder="e.g. Oil on Canvas" />
                            </div>
                        </div>

                        <div>
                            <label htmlFor="artwork-location" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Location</label>
                            <input id="artwork-location" name="location" value={formData.location} onChange={handleChange} className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors text-sm" placeholder="e.g. Main Gallery" />
                        </div>

                        <div>
                            <label htmlFor="artwork-description-title" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Description Title</label>
                            <input id="artwork-description-title" name="descriptionTitle" value={formData.descriptionTitle} onChange={handleChange} className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors text-sm mb-3" placeholder="e.g. Provenance or Exhibition History" />

                            <label htmlFor="artwork-description" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wider">Description</label>
                            <textarea id="artwork-description" name="description" value={formData.description} onChange={handleChange} rows={3} className="w-full bg-transparent border border-gray-300 dark:border-gray-700 rounded-[6px] p-2 text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors resize-none text-sm" placeholder="Details about the artwork..."></textarea>
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
                        className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-fade-in"
                        onClick={() => setShowUploadOptions(false)}
                    ></button>
                    <div className="bg-white dark:bg-[#1e1e1e] p-6 relative z-10 animate-fade-in-up shadow-2xl border-t border-gray-200 dark:border-gray-800 pb-28">
                        <div className="w-12 h-1.5 bg-gray-300 dark:bg-gray-700 rounded-full mx-auto mb-6"></div>
                        <h3 className="text-sm font-bold text-gray-900 dark:text-white uppercase tracking-widest mb-6 text-center">Upload Photo</h3>

                        <div className="flex flex-col gap-[6px]">
                            <button
                                type="button"
                                onClick={() => { cameraInputRef.current?.click(); setShowUploadOptions(false); }}
                                className="w-full flex items-center gap-[6px] p-[6px] rounded-[6px] bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors active-scale border border-gray-100 dark:border-gray-700"
                            >
                                <div className="text-brand-900 dark:text-gold-400">
                                    <Camera size={24} strokeWidth={1.5} />
                                </div>
                                <span className="font-medium text-gray-900 dark:text-white text-sm tracking-wide">Take Photo</span>
                            </button>

                            <button
                                type="button"
                                onClick={() => { galleryInputRef.current?.click(); setShowUploadOptions(false); }}
                                className="w-full flex items-center gap-[6px] p-[6px] rounded-[6px] bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors active-scale border border-gray-100 dark:border-gray-700"
                            >
                                <div className="text-brand-900 dark:text-gold-400">
                                    <ImageIcon size={24} strokeWidth={1.5} />
                                </div>
                                <span className="font-medium text-gray-900 dark:text-white text-sm tracking-wide">Choose from Gallery</span>
                            </button>

                            <button
                                type="button"
                                onClick={() => { fileInputRef.current?.click(); setShowUploadOptions(false); }}
                                className="w-full flex items-center gap-[6px] p-[6px] rounded-[6px] bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors active-scale border border-gray-100 dark:border-gray-700"
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
