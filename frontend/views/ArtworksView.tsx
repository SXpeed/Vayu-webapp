import React, { useState, useRef } from 'react';
import { Plus, X, Search, Image as ImageIcon, Camera, Folder, Trash2, Loader2 } from 'lucide-react';
import { Artwork, ArtworkStatus } from '../types';
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
            <div className="bg-white dark:bg-[#1a1a1a] px-4 pb-3 shadow-sm z-10 border-b border-gray-100 dark:border-gray-800" style={{ paddingTop: 'calc(2rem + env(safe-area-inset-top, 0px))' }}>
                <div className="flex justify-between items-center mb-3">
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
                        className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[7px] py-2 pl-9 pr-4 text-xs text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                    />
                </div>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2 no-scrollbar pb-24">
                {filteredArtworks.map((artwork, index) => (
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
                            {artwork.imageUrls.length > 1 && (
                                <div className="absolute bottom-1 right-1 bg-black/60 text-white text-[9px] px-1.5 py-0.5 rounded-[3px] backdrop-blur-sm">
                                    1/{artwork.imageUrls.length}
                                </div>
                            )}
                        </div>
                        <div className="p-3 flex flex-col justify-between flex-1">
                            <div>
                                <div className="flex justify-between items-start">
                                    <h3 className="font-serif text-gray-900 dark:text-gray-100 line-clamp-1 text-sm">{artwork.title}</h3>
                                    <span className={`text-[8px] px-1.5 py-0.5 rounded-[3px] font-medium uppercase tracking-wider ${artwork.status === 'Available' ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400' :
                                        artwork.status === 'Sold' ? 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400' :
                                            'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400'
                                        }`}>
                                        {artwork.status}
                                    </span>
                                </div>
                                <p className="text-[9px] text-gray-500 dark:text-gray-400 mt-1 uppercase tracking-wider">{artwork.customId} • {artwork.medium}</p>
                            </div>
                            <div className="flex justify-between items-end">
                                <p className="text-[10px] text-gray-400 dark:text-gray-500 font-light">{artwork.dimensions}</p>
                                <p className="font-medium text-brand-900 dark:text-gold-400 text-sm">₹{artwork.price.toLocaleString('en-IN')}</p>
                            </div>
                        </div>
                    </div>
                ))}
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
        customId: initialData?.customId || '',
        description: initialData?.description || '',
        dimensions: initialData?.dimensions || '',
        medium: initialData?.medium || '',
        status: initialData?.status || 'Available' as ArtworkStatus,
        location: initialData?.location || '',
        price: initialData?.price?.toString() || '',
        imageUrls: initialData?.imageUrls || [] as string[]
    });
    const [showUploadOptions, setShowUploadOptions] = useState(false);

    const [isUploading, setIsUploading] = useState(false);

    const cameraInputRef = useRef<HTMLInputElement>(null);
    const galleryInputRef = useRef<HTMLInputElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSave({
            ...formData,
            price: Number(formData.price) || 0
        });
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
    };

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            setIsUploading(true);
            try {
                const result = await storageService.upload(file);
                setFormData(prev => ({
                    ...prev,
                    imageUrls: [...prev.imageUrls, result.url]
                }));
            } catch (error) {
                console.error('Upload failed:', error);
                alert('Failed to upload image. Please try again.');
            } finally {
                setIsUploading(false);
            }
        }
        // Reset input value so the same file can be selected again if needed
        e.target.value = '';
    };

    const handleRemoveImage = async (indexToRemove: number) => {
        const urlToRemove = formData.imageUrls[indexToRemove];
        // Only attempt R2 deletion for R2-hosted files (not legacy data URLs)
        if (urlToRemove && urlToRemove.startsWith('/api/files/')) {
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

    return (
        <div className="absolute inset-0 bg-[#faf9f6] dark:bg-[#121212] z-50 flex flex-col animate-fade-in-up">
            <div className="bg-white dark:bg-[#1a1a1a] flex justify-between items-center p-4 border-b border-gray-100 dark:border-gray-800 shadow-sm" style={{ paddingTop: 'calc(1rem + env(safe-area-inset-top, 0px))' }}>
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
                    <button onClick={handleSubmit} className="text-gold-600 dark:text-gold-400 font-medium px-2 py-2 uppercase tracking-wider text-xs active-scale">
                        Save
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 no-scrollbar relative">
                <form id="add-art-form" onSubmit={handleSubmit} className="space-y-6">

                    {/* Multiple Image Upload Area */}
                    <div>
                        <label className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wider">Photos ({formData.imageUrls.length})</label>
                        <div className="flex gap-2 overflow-x-auto no-scrollbar pb-2 snap-x">
                            {formData.imageUrls.map((url, idx) => (
                                <div key={idx} className="relative w-32 h-32 shrink-0 rounded-[7px] overflow-hidden snap-start border border-gray-200 dark:border-gray-700 shadow-sm animate-scale-in" style={{ animationDelay: `${idx * 50}ms` }}>
                                    <img src={url} alt={`Preview ${idx + 1}`} className="w-full h-full object-cover" />
                                    <button
                                        type="button"
                                        onClick={() => handleRemoveImage(idx)}
                                        className="absolute top-1.5 right-1.5 bg-black/50 text-white p-1 rounded-full hover:bg-black/70 backdrop-blur-sm transition-colors active-scale"
                                    >
                                        <X size={14} />
                                    </button>
                                    {idx === 0 && (
                                        <div className="absolute bottom-1.5 left-1.5 bg-black/60 text-white text-[8px] px-1.5 py-0.5 rounded-[3px] backdrop-blur-sm uppercase tracking-wider">
                                            Cover
                                        </div>
                                    )}
                                </div>
                            ))}

                            <button
                                type="button"
                                onClick={() => setShowUploadOptions(true)}
                                disabled={isUploading}
                                className="w-32 h-32 shrink-0 rounded-[7px] border-2 border-dashed border-gray-300 dark:border-gray-700 flex flex-col items-center justify-center text-gray-400 dark:text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 hover:border-gold-400 dark:hover:border-gold-500 transition-colors snap-start active-scale disabled:opacity-60"
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

                    <div className="space-y-5 bg-white dark:bg-[#1e1e1e] p-5 rounded-[7px] shadow-sm border border-gray-100 dark:border-gray-800 animate-fade-in-up" style={{ animationDelay: '100ms' }}>
                        <div>
                            <label className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Title *</label>
                            <input required name="title" value={formData.title} onChange={handleChange} className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors font-serif text-base" placeholder="e.g. Starry Night" />
                        </div>

                        <div className="flex gap-4">
                            <div className="flex-1">
                                <label className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Inventory ID</label>
                                <input name="customId" value={formData.customId} onChange={handleChange} className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors text-sm" placeholder="ART-001" />
                            </div>
                            <div className="flex-1">
                                <label className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Price (₹)</label>
                                <input required type="number" name="price" value={formData.price} onChange={handleChange} className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors text-sm" placeholder="0.00" />
                            </div>
                        </div>

                        <div>
                            <label className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Status</label>
                            <select name="status" value={formData.status} onChange={handleChange} className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors text-sm">
                                <option value="Available" className="dark:bg-gray-800">Available</option>
                                <option value="Sold" className="dark:bg-gray-800">Sold</option>
                                <option value="Reserved" className="dark:bg-gray-800">Reserved</option>
                            </select>
                        </div>

                        <div className="flex gap-4">
                            <div className="flex-1">
                                <label className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Dimensions</label>
                                <input name="dimensions" value={formData.dimensions} onChange={handleChange} className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors text-sm" placeholder="e.g. 24x36 in" />
                            </div>
                            <div className="flex-1">
                                <label className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Medium</label>
                                <input name="medium" value={formData.medium} onChange={handleChange} className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors text-sm" placeholder="e.g. Oil on Canvas" />
                            </div>
                        </div>

                        <div>
                            <label className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Location</label>
                            <input name="location" value={formData.location} onChange={handleChange} className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors text-sm" placeholder="e.g. Main Gallery" />
                        </div>

                        <div>
                            <label className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wider">Description</label>
                            <textarea name="description" value={formData.description} onChange={handleChange} rows={3} className="w-full bg-transparent border border-gray-300 dark:border-gray-700 rounded-[7px] p-2 text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors resize-none text-sm" placeholder="Details about the artwork..."></textarea>
                        </div>
                    </div>
                    <div className="h-10"></div> {/* Spacer */}
                </form>
            </div>

            {/* Upload Options Action Sheet */}
            {showUploadOptions && (
                <div className="absolute inset-0 z-[100] flex flex-col justify-end overflow-hidden">
                    <div className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={() => setShowUploadOptions(false)}></div>
                    <div className="bg-white dark:bg-[#1e1e1e] rounded-t-[1.5rem] p-6 relative z-10 animate-fade-in-up shadow-2xl border-t border-gray-200 dark:border-gray-800 pb-12">
                        <div className="w-12 h-1.5 bg-gray-300 dark:bg-gray-700 rounded-full mx-auto mb-6"></div>
                        <h3 className="text-sm font-bold text-gray-900 dark:text-white uppercase tracking-widest mb-6 text-center">Upload Photo</h3>

                        <div className="flex flex-col gap-3">
                            <button
                                type="button"
                                onClick={() => { cameraInputRef.current?.click(); setShowUploadOptions(false); }}
                                className="w-full flex items-center gap-4 p-4 rounded-[7px] bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors active-scale border border-gray-100 dark:border-gray-700"
                            >
                                <div className="text-brand-900 dark:text-gold-400">
                                    <Camera size={24} strokeWidth={1.5} />
                                </div>
                                <span className="font-medium text-gray-900 dark:text-white text-sm tracking-wide">Take Photo</span>
                            </button>

                            <button
                                type="button"
                                onClick={() => { galleryInputRef.current?.click(); setShowUploadOptions(false); }}
                                className="w-full flex items-center gap-4 p-4 rounded-[7px] bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors active-scale border border-gray-100 dark:border-gray-700"
                            >
                                <div className="text-brand-900 dark:text-gold-400">
                                    <ImageIcon size={24} strokeWidth={1.5} />
                                </div>
                                <span className="font-medium text-gray-900 dark:text-white text-sm tracking-wide">Choose from Gallery</span>
                            </button>

                            <button
                                type="button"
                                onClick={() => { fileInputRef.current?.click(); setShowUploadOptions(false); }}
                                className="w-full flex items-center gap-4 p-4 rounded-[7px] bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors active-scale border border-gray-100 dark:border-gray-700"
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
