import React, { useState, useRef } from 'react';
import { Plus, X, Check, Image as ImageIcon, Search, Edit2, Trash2, Camera, Loader2 } from 'lucide-react';
import { Collection, Artwork } from '../types';
import storageService from '../services/storageService';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ArtworkFormModal } from './ArtworksView';

interface CollectionsViewProps {
    collections: Collection[];
    artworks: Artwork[];
    onAddCollection: (collection: Omit<Collection, 'id'>) => void;
    onUpdateCollection: (collection: Collection) => void;
    onDeleteCollection: (id: string) => void;
    onArtworkClick: (artwork: Artwork) => void;
    onAddArtwork: (artwork: Omit<Artwork, 'id' | 'createdAt'>) => Promise<Artwork>;
}

export const CollectionsView: React.FC<CollectionsViewProps> = ({ collections, artworks, onAddCollection, onUpdateCollection, onDeleteCollection, onArtworkClick, onAddArtwork }) => {
    const [isAdding, setIsAdding] = useState(false);
    const [selectedCollection, setSelectedCollection] = useState<Collection | null>(null);
    const [searchQuery, setSearchQuery] = useState('');

    React.useEffect(() => {
        const handlePopState = (e: PopStateEvent) => {
            if (e.state?.modal !== 'collection') {
                setSelectedCollection(null);
            }
        };
        globalThis.addEventListener('popstate', handlePopState);
        return () => globalThis.removeEventListener('popstate', handlePopState);
    }, []);

    const handleCollectionClick = (collection: Collection) => {
        setSelectedCollection(collection);
        globalThis.history.pushState({ view: 'collections', modal: 'collection' }, '');
    };

    const handleCloseModal = () => {
        if (globalThis.history.state?.modal === 'collection') {
            globalThis.history.back();
        } else {
            setSelectedCollection(null);
        }
    };

    const filteredCollections = collections.filter(collection =>
        collection.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        collection.description.toLowerCase().includes(searchQuery.toLowerCase())
    );

    const getCoverImage = (collection: Collection) => {
        if (collection.coverImageUrl) return collection.coverImageUrl;
        if (collection.artworkIds.length === 0) return null;
        const firstArt = artworks.find(a => a.id === collection.artworkIds[0]);
        return firstArt?.imageUrls?.[0] || null;
    };

    return (
        <div className="h-full flex flex-col bg-[#faf9f6] dark:bg-[#121212] transition-colors duration-500 animate-fade-in">
            <div className="bg-white dark:bg-[#1a1a1a] px-[6px] pb-[6px] shadow-sm z-10 border-b border-gray-100 dark:border-gray-800" style={{ paddingTop: 'calc(1.75rem + env(safe-area-inset-top, 0px))' }}>
                <div className="flex justify-between items-center mb-[6px]">
                    <h1 className="text-xl font-serif text-gray-900 dark:text-white">Collections</h1>
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
                        placeholder="Search collections..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2 pl-9 pr-4 text-xs text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                    />
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-[6px] space-y-2 no-scrollbar pb-8">
                {filteredCollections.map((collection, index) => {
                    const coverImage = getCoverImage(collection);
                    return (
                        <button
                            type="button"
                            key={collection.id}
                            onClick={() => handleCollectionClick(collection)}
                            className="w-full text-left bg-white dark:bg-[#1e1e1e] rounded-[6px] shadow-sm overflow-hidden flex h-28 border border-gray-100 dark:border-gray-800 animate-fade-in-up cursor-pointer active-scale"
                            style={{ animationDelay: `${index * 50}ms` }}
                        >
                            <div className="w-28 h-full relative shrink-0 bg-gray-50 dark:bg-gray-800">
                                {coverImage ? (
                                    <img src={coverImage} alt={collection.name} className="w-full h-full object-cover" />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center text-gray-300 dark:text-gray-600">
                                        <ImageIcon size={28} strokeWidth={1} />
                                    </div>
                                )}
                            </div>
                            <div className="p-[6px] flex flex-col justify-between flex-1">
                                <div>
                                    <h3 className="font-serif text-gray-900 dark:text-gray-100 line-clamp-1 text-sm">{collection.name}</h3>
                                    <p className="text-[9px] text-gray-500 dark:text-gray-400 mt-1 uppercase tracking-wider">{collection.artworkIds.length} Artworks</p>
                                </div>
                                {collection.description && (
                                    <p className="text-[10px] text-gray-400 dark:text-gray-500 font-light line-clamp-2">{collection.description}</p>
                                )}
                            </div>
                        </button>
                    );
                })}
                {filteredCollections.length === 0 && (
                    <div className="text-center text-gray-400 dark:text-gray-500 mt-10 font-light text-sm">
                        No collections found.
                    </div>
                )}
            </div>

            {isAdding && (
                <CollectionFormModal
                    artworks={artworks}
                    onClose={() => setIsAdding(false)}
                    onSave={(newCol) => {
                        onAddCollection(newCol);
                        setIsAdding(false);
                    }}
                />
            )}

            {selectedCollection && (
                <CollectionDetailModal
                    collection={selectedCollection}
                    artworks={artworks}
                    onClose={handleCloseModal}
                    onArtworkClick={onArtworkClick}
                    onUpdateCollection={(updated) => {
                        onUpdateCollection(updated);
                        setSelectedCollection(updated);
                    }}
                    onDeleteCollection={() => {
                        onDeleteCollection(selectedCollection.id);
                        setSelectedCollection(null);
                    }}
                    onAddArtwork={onAddArtwork}
                />
            )}
        </div>
    );
};

export interface CollectionDetailModalProps {
    collection: Collection;
    artworks: Artwork[];
    onClose: () => void;
    onArtworkClick: (artwork: Artwork) => void;
    onUpdateCollection: (collection: Collection) => void;
    onDeleteCollection: (id: string) => void;
    onAddArtwork: (artwork: Omit<Artwork, 'id' | 'createdAt'>) => Promise<Artwork>;
}

export const CollectionDetailModal: React.FC<CollectionDetailModalProps> = ({ collection, artworks, onClose, onArtworkClick, onUpdateCollection, onDeleteCollection, onAddArtwork }) => {
    const [isEditing, setIsEditing] = useState(false);
    const [isAddingProduct, setIsAddingProduct] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [detailSearchQuery, setDetailSearchQuery] = useState('');
    const collectionArtworks = artworks.filter(a => collection.artworkIds.includes(a.id));
    const filteredCollectionArtworks = collectionArtworks.filter(a => 
        a.title.toLowerCase().includes(detailSearchQuery.toLowerCase()) || 
        (a.customId?.toLowerCase().includes(detailSearchQuery.toLowerCase()))
    );
    const coverImage = collection.coverImageUrl || (collectionArtworks.length > 0 ? collectionArtworks[0].imageUrls?.[0] : null);

    const handleUploadCoverImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setIsUploading(true);
        try {
            const result = await storageService.upload(file);
            onUpdateCollection({ ...collection, coverImageUrl: result.url });
        } catch (error) {
            console.error('Upload failed:', error);
            alert('Failed to upload cover image.');
        } finally {
            setIsUploading(false);
        }
        e.target.value = '';
    };

    const handleSaveEdit = (updatedData: Omit<Collection, 'id'>) => {
        onUpdateCollection({
            ...updatedData,
            id: collection.id
        });
        setIsEditing(false);
    };

    const [confirmOpen, setConfirmOpen] = useState(false);

    const handleDelete = () => {
        setConfirmOpen(true);
    };

    return (
        <div className="absolute inset-0 bg-[#faf9f6] dark:bg-[#121212] z-50 flex flex-col animate-fade-in-up">
            <div className="bg-white dark:bg-[#1a1a1a] px-[6px] pb-[6px] shadow-sm z-10 border-b border-gray-100 dark:border-gray-800" style={{ paddingTop: 'calc(1.75rem + env(safe-area-inset-top, 0px))' }}>
                <div className="flex justify-between items-center mb-[6px]">
                    <h2 className="text-xl font-serif text-gray-900 dark:text-white truncate px-1">{collection.name}</h2>
                    <div className="flex items-center gap-2">
                        <button onClick={() => setIsEditing(true)} className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale">
                            <Edit2 size={18} />
                        </button>
                        <button onClick={handleDelete} className="p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-full transition-colors active-scale">
                            <Trash2 size={18} />
                        </button>
                    </div>
                </div>
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 dark:text-gray-500" size={16} />
                    <input
                        type="text"
                        placeholder="Search artworks..."
                        value={detailSearchQuery}
                        onChange={(e) => setDetailSearchQuery(e.target.value)}
                        className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2 pl-9 pr-4 text-xs text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                    />
                </div>
            </div>

            <div className="flex-1 overflow-y-auto no-scrollbar pb-20">
                <div className="w-full aspect-[21/9] relative bg-gray-100 dark:bg-gray-800 animate-fade-in group">
                    {coverImage ? (
                        <img src={coverImage} alt={collection.name} className="w-full h-full object-cover" />
                    ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-300 dark:text-gray-600">
                            <ImageIcon size={40} strokeWidth={1} />
                        </div>
                    )}
                    {/* Gradient removed as per user request */}
                    
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isUploading}
                        className="absolute top-[6px] right-4 p-2 bg-black/40 hover:bg-black/60 text-white rounded-full backdrop-blur-sm transition-colors z-10 disabled:opacity-50"
                        title="Upload Cover Image"
                    >
                        {isUploading ? <Loader2 size={18} className="animate-spin" /> : <Camera size={18} />}
                    </button>
                    <input type="file" accept="image/*" ref={fileInputRef} className="hidden" onChange={handleUploadCoverImage} />
                </div>

                <div className="p-[6px] bg-[#faf9f6] dark:bg-[#121212] relative z-20 min-h-[50dvh] flex flex-col gap-[6px]">
                    <div className="flex justify-between items-center mb-[6px]">
                        <h3 className="font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest text-[10px]">Artworks in Collection ({collectionArtworks.length})</h3>
                        <button
                            onClick={() => setIsAddingProduct(true)}
                            className="bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 p-1.5 rounded-full shadow-md hover:bg-brand-800 dark:hover:bg-gold-400 transition-colors active-scale"
                            title="Add New Product to Collection"
                        >
                            <Plus size={16} />
                        </button>
                    </div>

                    {filteredCollectionArtworks.map((artwork, index) => {
                        let artistText = '';
                        if (artwork.artist) {
                            artistText = artwork.artist;
                            if (artwork.artworkYear) artistText += `, ${artwork.artworkYear}`;
                            artistText += ' • ';
                        }

                        return (
                            <button
                                type="button"
                                key={artwork.id}
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
                                </div>
                                <div className="p-[6px] flex flex-col justify-between flex-1">
                                    <div>
                                        <h3 className="font-serif text-gray-900 dark:text-gray-100 line-clamp-1 text-sm">{artwork.title}</h3>
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

                </div>
            </div>

            {isEditing && (
                <CollectionFormModal
                    initialData={collection}
                    artworks={artworks}
                    onClose={() => setIsEditing(false)}
                    onSave={handleSaveEdit}
                />
            )}

            <ConfirmDialog
                isOpen={confirmOpen}
                title="Delete Collection"
                message={`Are you sure you want to delete collection "${collection.name}"?`}
                onClose={() => setConfirmOpen(false)}
                onConfirm={() => {
                    onDeleteCollection(collection.id);
                    setConfirmOpen(false);
                }}
            />

            {isAddingProduct && (
                <ArtworkFormModal
                    onClose={() => setIsAddingProduct(false)}
                    onSave={async (newArt) => {
                        const savedArt = await onAddArtwork(newArt);
                        onUpdateCollection({
                            ...collection,
                            artworkIds: [...collection.artworkIds, savedArt.id]
                        });
                        setIsAddingProduct(false);
                    }}
                />
            )}
        </div>
    );
};

export interface CollectionFormModalProps {
    initialData?: Collection;
    artworks: Artwork[];
    onClose: () => void;
    onSave: (collection: Omit<Collection, 'id'>) => void;
}

export const CollectionFormModal: React.FC<CollectionFormModalProps> = ({ initialData, artworks, onClose, onSave }) => {
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
            coverImageUrl: initialData?.coverImageUrl || undefined
        });
    };

    return (
        <div className="absolute inset-0 bg-[#faf9f6] dark:bg-[#121212] z-[70] flex flex-col animate-fade-in-up">
            <div className="bg-white dark:bg-[#1a1a1a] flex justify-between items-center p-[6px] border-b border-gray-100 dark:border-gray-800 pt-[calc(1.75rem+env(safe-area-inset-top,0px))] shadow-sm">
                <button onClick={onClose} className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale">
                    <X size={20} />
                </button>
                <h2 className="text-base font-serif text-gray-900 dark:text-white">{initialData ? 'Edit Collection' : 'Create Collection'}</h2>
                <button onClick={handleSubmit} className="text-gold-600 dark:text-gold-400 font-medium px-2 py-2 uppercase tracking-wider text-xs active-scale">
                    Save
                </button>
            </div>

            <div className="flex-1 overflow-y-auto p-[6px] no-scrollbar flex flex-col gap-6">
                <div className="space-y-5 bg-white dark:bg-[#1e1e1e] p-5 rounded-[6px] shadow-sm border border-gray-100 dark:border-gray-800 animate-fade-in-up" style={{ animationDelay: '100ms' }}>
                    <div>
                        <label htmlFor="collection-name" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Collection Name *</label>
                        <input
                            id="collection-name"
                            value={name}
                            onChange={e => setName(e.target.value)}
                            className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-base font-serif text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors"
                            placeholder="e.g. Modern Abstracts"
                        />
                    </div>
                    <div>
                        <label htmlFor="collection-desc" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wider">Description</label>
                        <textarea
                            id="collection-desc"
                            value={description}
                            onChange={e => setDescription(e.target.value)}
                            rows={2}
                            className="w-full bg-transparent border border-gray-300 dark:border-gray-700 rounded-[6px] p-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors resize-none"
                            placeholder="Brief description of this collection..."
                        ></textarea>
                    </div>
                </div>

                <div className="animate-fade-in-up" style={{ animationDelay: '200ms' }}>
                    <div className="flex justify-between items-end mb-[6px]">
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
                            className="w-full bg-white dark:bg-[#1e1e1e] border border-gray-200 dark:border-gray-800 rounded-[6px] py-2 pl-9 pr-4 text-xs text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors shadow-sm"
                        />
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                        {filteredArtworks.map((art, index) => {
                            const isSelected = selectedArtworks.has(art.id);
                            const coverImage = art.imageUrls?.[0];
                            return (
                                <button
                                    type="button"
                                    key={art.id}
                                    onClick={() => toggleArtwork(art.id)}
                                    className={`relative w-full text-left rounded-[6px] overflow-hidden border-2 cursor-pointer transition-all bg-gray-50 dark:bg-gray-800 animate-scale-in active-scale ${isSelected ? 'border-gold-500 shadow-md' : 'border-transparent shadow-sm'
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
                                </button>
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
