import React, { useState, useRef } from 'react';
import { Plus, X, Check, Image as ImageIcon, Edit2, Trash2, Camera, Loader2 } from 'lucide-react';
import { SearchBar } from '../components/SearchBar';
import { PageRoot, PageHeader, PageBody, PrimaryIconButton, EmptyState } from '../components/ui';
import { Collection, Artwork } from '../types';
import storageService, { getThumbUrl } from '../services/storageService';
import { TypeDeleteDialog } from '../components/TypeDeleteDialog';
import { ArtworkFormModal } from './ArtworksView';
import toast from 'react-hot-toast';
import { IfCan } from '../components/Layout';

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

    /** Up to three pictures for the tile: the chosen cover, then the
     *  collection's artworks in order (first photo of each, no repeats). */
    const getMosaicImages = (collection: Collection): string[] => {
        const urls: string[] = [];
        if (collection.coverImageUrl) urls.push(collection.coverImageUrl);
        for (const id of collection.artworkIds) {
            if (urls.length >= 3) break;
            const url = artworks.find(a => a.id === id)?.imageUrls?.[0];
            if (url && !urls.includes(url)) urls.push(url);
        }
        return urls;
    };

    return (
        <PageRoot>
            <PageHeader
                title="Collections"
                actions={<IfCan section="collections"><PrimaryIconButton onClick={() => setIsAdding(true)} label="Add collection" icon={<Plus size={16} />} /></IfCan>}
            >
                <SearchBar value={searchQuery} onChange={setSearchQuery} placeholder="Search collections..." />
            </PageHeader>

            <PageBody columns="gallery">
                {filteredCollections.map((collection, index) => {
                    const images = getMosaicImages(collection);
                    const count = collection.artworkIds.length;
                    return (
                        <button
                            type="button"
                            key={collection.id}
                            onClick={() => handleCollectionClick(collection)}
                            className="neu-tile neu-tile-interactive w-full animate-fade-in-up cursor-pointer active-scale"
                            style={{ animationDelay: `${Math.min(index, 12) * 45}ms` }}
                        >
                            {/* Cover mosaic, set into the card — the well shows through the seams */}
                            <div className="neu-picture-well neu-picture-well-sm w-full aspect-[4/3] rounded-[1rem]">
                                {images.length === 0 && (
                                    <div className="w-full h-full flex items-center justify-center text-[var(--neu-text-dim)]">
                                        <ImageIcon size={28} strokeWidth={1} />
                                    </div>
                                )}
                                {images.length > 0 && images.length < 3 && (
                                    <img loading="lazy" decoding="async" src={getThumbUrl(images[0])} alt={collection.name} className="w-full h-full object-cover" />
                                )}
                                {images.length >= 3 && (
                                    <div className="w-full h-full grid grid-cols-3 grid-rows-2 gap-[3px]">
                                        {images.map((url, i) => (
                                            <img
                                                key={url}
                                                loading="lazy"
                                                decoding="async"
                                                src={getThumbUrl(url)}
                                                alt={i === 0 ? collection.name : ''}
                                                className={`w-full h-full object-cover ${i === 0 ? 'col-span-2 row-span-2' : ''}`}
                                            />
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div className="flex-1 flex flex-col px-1.5 pt-3 pb-1 min-w-0">
                                <h3 className="font-serif text-[15px] leading-snug text-[var(--neu-text)] line-clamp-2">{collection.name}</h3>
                                {collection.description && (
                                    <p className="mt-1 text-[11px] text-[var(--neu-text-dim)] line-clamp-2">{collection.description}</p>
                                )}
                                <div className="mt-auto pt-2.5">
                                    <span className="neu-status px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--neu-gold)]">
                                        {count} {count === 1 ? 'artwork' : 'artworks'}
                                    </span>
                                </div>
                            </div>
                        </button>
                    );
                })}
                {filteredCollections.length === 0 && (
                    <EmptyState
                        icon={<ImageIcon size={22} strokeWidth={1.25} />}
                        title="No collections found"
                        message="Create a collection with the + button above."
                    />
                )}

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
        </PageBody>
        </PageRoot>
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

export const CollectionDetailModal: React.FC<CollectionDetailModalProps> = ({ collection, artworks, onArtworkClick, onUpdateCollection, onDeleteCollection, onAddArtwork }) => {
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
            toast.error('Failed to upload cover image.');
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
        <div className="neu-sheet z-50 animate-fade-in-up">
            <div className="px-3 pb-2.5 z-10" style={{ paddingTop: 'calc(1.75rem + var(--safe-top))' }}>
                <div className="flex justify-between items-center mb-3">
                    <h2 className="text-xl font-serif text-gray-900 dark:text-white truncate px-1">{collection.name}</h2>
                    <div className="flex items-center gap-2">
                        <IfCan section="collections">
                            <button onClick={() => setIsEditing(true)} className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale">
                                <Edit2 size={18} />
                            </button>
                        </IfCan>
                        <IfCan section="collections">
                            <button onClick={handleDelete} className="neu-icon-btn text-red-500 active-scale">
                                <Trash2 size={18} />
                            </button>
                        </IfCan>
                    </div>
                </div>
                <SearchBar value={detailSearchQuery} onChange={setDetailSearchQuery} placeholder="Search artworks..." />
            </div>

            <div className="flex-1 overflow-y-auto no-scrollbar pb-20 lg:pb-8">
                <div className="w-full aspect-[21/9] relative neu-inset animate-fade-in group">
                    {coverImage ? (
                        <img loading="lazy" decoding="async" src={getThumbUrl(coverImage)} alt={collection.name} className="w-full h-full object-cover" />
                    ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-600 dark:text-gray-300">
                            <ImageIcon size={40} strokeWidth={1} />
                        </div>
                    )}
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
                        <h3 className="font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest text-[11px]">Artworks in Collection ({collectionArtworks.length})</h3>
                        <button
                            onClick={() => setIsAddingProduct(true)}
                            className="neu-raised-sm neu-btn text-gold-700 dark:text-gold-300 p-1.5 rounded-full shadow-md transition-colors active-scale"
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
                                className="w-full text-left neu-raised rounded-2xl overflow-hidden flex h-28 animate-fade-in-up cursor-pointer active-scale"
                                style={{ animationDelay: `${index * 50}ms` }}
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
                                            {artistText}
                                            {artwork.customId} • {artwork.medium}
                                        </p>
                                    </div>
                                    <div className="flex justify-between items-end">
                                        <p className="text-[11px] text-gray-600 dark:text-gray-300 font-light">{artwork.dimensions}</p>
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

            <TypeDeleteDialog
                isOpen={confirmOpen}
                title="Delete collection"
                itemName={collection.name}
                message="it will be archived for admin review"
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
    const [selectedArtworks, setSelectedArtworks] = useState<Set<string>>(new Set(initialData?.artworkIds ?? []));

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
        if (!name.trim()) { toast.error('Name is required'); return; }
        if (selectedArtworks.size === 0) { toast.error('Select at least one artwork'); return; }

        onSave({
            name,
            description,
            artworkIds: Array.from(selectedArtworks),
            coverImageUrl: initialData?.coverImageUrl || undefined
        });
    };

    return (
        <div className="neu-sheet z-[70] animate-fade-in-up">
            <div className="flex justify-between items-center p-3 pt-[calc(1.75rem+var(--safe-top))]">
                <button onClick={onClose} className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale">
                    <X size={20} />
                </button>
                <h2 className="text-base font-serif text-gray-900 dark:text-white">{initialData ? 'Edit Collection' : 'Create Collection'}</h2>
                <button onClick={handleSubmit} className="text-gold-700 dark:text-gold-300 font-medium px-2 py-2 uppercase tracking-wider text-xs active-scale">
                    Save
                </button>
            </div>

            <div className="flex-1 overflow-y-auto p-3 no-scrollbar flex flex-col gap-6">
                <div className="space-y-5 neu-card p-5 animate-fade-in-up" style={{ animationDelay: '100ms' }}>
                    <div>
                        <label htmlFor="collection-name" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Collection Name *</label>
                        <input
                            id="collection-name"
                            value={name}
                            onChange={e => setName(e.target.value)}
                            className="neu-field text-base font-serif"
                            placeholder="e.g. Modern Abstracts"
                        />
                    </div>
                    <div>
                        <label htmlFor="collection-desc" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-2 uppercase tracking-wider">Description</label>
                        <textarea
                            id="collection-desc"
                            value={description}
                            onChange={e => setDescription(e.target.value)}
                            rows={2}
                            className="w-full bg-transparent border border-gray-300 dark:border-gray-700 rounded-lg p-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors resize-none"
                            placeholder="Brief description of this collection..."
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



                <div className="h-10"></div>
            </div>
        </div>
    );
};
