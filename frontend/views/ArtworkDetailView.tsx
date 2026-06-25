import React, { useState, useRef, useEffect } from 'react';
import { ArrowLeft, MapPin, Ruler, Palette, Tag, Info, Edit2, X, ChevronLeft, ChevronRight, Image as ImageIcon, Trash2 } from 'lucide-react';
import { Artwork } from '../types';
import { ArtworkFormModal } from './ArtworksView';

// Helper function to extract dominant color from an image URL
const getDominantColor = (imageUrl: string): Promise<string> => {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "Anonymous";
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                resolve('rgba(0,0,0,0.1)');
                return;
            }
            canvas.width = 50;
            canvas.height = 50;
            ctx.drawImage(img, 0, 0, 50, 50);
            
            try {
                const imageData = ctx.getImageData(0, 0, 50, 50).data;
                let r = 0, g = 0, b = 0;
                let count = 0;
                
                for (let i = 0; i < imageData.length; i += 16) {
                    r += imageData[i];
                    g += imageData[i + 1];
                    b += imageData[i + 2];
                    count++;
                }
                
                r = Math.floor(r / count);
                g = Math.floor(g / count);
                b = Math.floor(b / count);
                
                resolve(`rgba(${r}, ${g}, ${b}, 0.4)`);
            } catch (e) {
                resolve('rgba(0,0,0,0.1)');
            }
        };
        img.onerror = () => resolve('rgba(0,0,0,0.1)');
        img.src = imageUrl;
    });
};

interface ArtworkDetailViewProps {
    artwork: Artwork;
    onClose: () => void;
    onUpdateArtwork: (artwork: Artwork) => void;
    onDeleteArtwork: (id: string) => void;
}

export const ArtworkDetailView: React.FC<ArtworkDetailViewProps> = ({ artwork, onClose, onUpdateArtwork, onDeleteArtwork }) => {
    const [activeImageIndex, setActiveImageIndex] = useState(0);
    const [isEditing, setIsEditing] = useState(false);
    const [isFullScreen, setIsFullScreen] = useState(false);
    const [glowColor, setGlowColor] = useState<string>('rgba(0,0,0,0.05)');

    const mainCarouselRef = useRef<HTMLDivElement>(null);
    const fullScreenCarouselRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (artwork.imageUrls.length > 0) {
            getDominantColor(artwork.imageUrls[activeImageIndex]).then(color => {
                setGlowColor(color);
            });
        }
    }, [activeImageIndex, artwork.imageUrls]);

    const handleSaveEdit = (updatedData: Omit<Artwork, 'id' | 'createdAt'>) => {
        onUpdateArtwork({
            ...updatedData,
            id: artwork.id,
            createdAt: artwork.createdAt
        });
        setIsEditing(false);
    };

    const handleDelete = () => {
        if (window.confirm(`Are you sure you want to delete "${artwork.title}"?`)) {
            onDeleteArtwork(artwork.id);
            onClose(); // Close the detail view after deletion
        }
    };

    const scrollPrev = (ref: React.RefObject<HTMLDivElement>) => {
        if (ref.current) {
            ref.current.scrollBy({ left: -ref.current.clientWidth, behavior: 'smooth' });
        }
    };

    const scrollNext = (ref: React.RefObject<HTMLDivElement>) => {
        if (ref.current) {
            ref.current.scrollBy({ left: ref.current.clientWidth, behavior: 'smooth' });
        }
    };

    return (
        <div className="absolute inset-0 bg-[#faf9f6] dark:bg-[#121212] z-[60] flex flex-col animate-fade-in-up">
            {/* Header with Back & Edit Buttons */}
            <div className="px-3 pt-4 pb-2 flex justify-between items-center bg-[#faf9f6] dark:bg-[#121212] shrink-0 z-20">
                <button 
                    onClick={onClose} 
                    className="w-9 h-9 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors active-scale"
                >
                    <ArrowLeft size={18} />
                </button>
                {artwork.imageUrls.length > 1 && (
                    <span className="text-xs text-gray-500 dark:text-gray-400 font-medium tracking-widest">
                        {activeImageIndex + 1} / {artwork.imageUrls.length}
                    </span>
                )}
                <button 
                    onClick={() => setIsEditing(true)}
                    className="w-9 h-9 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors active-scale"
                >
                    <Edit2 size={16} />
                </button>
            </div>

            <div className="flex-1 overflow-y-auto no-scrollbar">
                {/* Image Carousel with Dynamic Glow */}
                <div className="w-full h-[60vh] relative bg-[#faf9f6] dark:bg-[#121212] shrink-0 flex flex-col overflow-hidden">
                    {/* Glow Background */}
                    <div 
                        className="absolute inset-0 transition-colors duration-700 ease-in-out z-0"
                        style={{ background: `radial-gradient(circle at center, ${glowColor} 0%, transparent 70%)` }}
                    />

                    {artwork.imageUrls.length > 0 ? (
                        <div 
                            ref={mainCarouselRef}
                            className="flex-1 w-full flex overflow-x-auto snap-x snap-mandatory no-scrollbar relative z-10" 
                            onScroll={(e) => {
                                const scrollLeft = (e.target as HTMLElement).scrollLeft;
                                const width = (e.target as HTMLElement).clientWidth;
                                setActiveImageIndex(Math.round(scrollLeft / width));
                            }}
                        >
                            {artwork.imageUrls.map((url, idx) => (
                                <div key={idx} className="w-full h-full flex items-center justify-center snap-center shrink-0">
                                    <img 
                                        src={url} 
                                        alt={`${artwork.title} - ${idx + 1}`} 
                                        className="w-full h-full object-cover cursor-pointer" 
                                        onClick={() => setIsFullScreen(true)}
                                    />
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="flex-1 w-full flex items-center justify-center text-gray-300 dark:text-gray-600 relative z-10">
                            <ImageIcon size={64} strokeWidth={1} />
                        </div>
                    )}
                </div>

                {/* Details Section */}
                <div className="p-4 bg-[#faf9f6] dark:bg-[#121212] relative z-30 space-y-4 -mt-4 rounded-t-[7px]">
                    
                    <div className="flex justify-between items-start">
                        <div className="flex-1 min-w-0 mr-3">
                            <h1 className="text-lg font-serif text-gray-900 dark:text-white leading-snug">{artwork.title}</h1>
                            <p className="text-[9px] text-gray-400 dark:text-gray-500 uppercase tracking-widest mt-0.5">{artwork.customId}</p>
                        </div>
                        <p className="text-base font-semibold text-gold-600 dark:text-gold-400 shrink-0">₹{artwork.price.toLocaleString('en-IN')}</p>
                    </div>

                    <div className="w-full h-px bg-gray-100 dark:bg-gray-800"></div>

                    <div className="grid grid-cols-2 gap-y-3 gap-x-4">
                        <div>
                            <p className="text-[9px] text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-0.5">Medium</p>
                            <p className="text-xs text-gray-800 dark:text-gray-200">{artwork.medium}</p>
                        </div>
                        <div>
                            <p className="text-[9px] text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-0.5">Dimensions</p>
                            <p className="text-xs text-gray-800 dark:text-gray-200">{artwork.dimensions}</p>
                        </div>
                        <div>
                            <p className="text-[9px] text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-0.5">Location</p>
                            <p className="text-xs text-gray-800 dark:text-gray-200">{artwork.location}</p>
                        </div>
                        <div>
                            <p className="text-[9px] text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-0.5">Status</p>
                            <span className={`text-[9px] px-1.5 py-0.5 rounded-[3px] font-medium uppercase tracking-wider ${
                                artwork.status === 'Available' ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400' :
                                artwork.status === 'Sold' ? 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400' :
                                'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400'
                            }`}>
                                {artwork.status}
                            </span>
                        </div>
                    </div>

                    {(artwork.description) && (
                        <>
                            <div className="w-full h-px bg-gray-100 dark:bg-gray-800"></div>
                            <div>
                                <p className="text-[9px] text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-1">About this piece</p>
                                <p className="text-xs text-gray-600 dark:text-gray-400 leading-relaxed font-light whitespace-pre-wrap">
                                    {artwork.description}
                                </p>
                            </div>
                        </>
                    )}
                    
                    <div className="h-8"></div>
                </div>
            </div>

            {/* Full Screen Image Viewer */}
            {isFullScreen && artwork.imageUrls.length > 0 && (
                <div className="absolute inset-0 z-[100] bg-[#faf9f6] dark:bg-[#121212] flex flex-col animate-fade-in overflow-hidden">
                    {/* Full Screen Glow Background */}
                    <div 
                        className="absolute inset-0 transition-colors duration-700 ease-in-out z-0"
                        style={{ background: `radial-gradient(circle at center, ${glowColor.replace(/[\d.]+\)$/g, '0.3)')} 0%, transparent 80%)` }}
                    />

                    <div className="px-3 pt-4 pb-2 z-20 flex justify-between items-center">
                        <div className="w-9"></div>
                        {artwork.imageUrls.length > 1 ? (
                            <span className="text-xs text-gray-500 dark:text-gray-400 font-medium tracking-widest">
                                {activeImageIndex + 1} / {artwork.imageUrls.length}
                            </span>
                        ) : <div />}
                        <button 
                            onClick={() => setIsFullScreen(false)} 
                            className="w-9 h-9 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors active-scale"
                        >
                            <X size={16} />
                        </button>
                    </div>
                    
                    <div 
                        ref={fullScreenCarouselRef}
                        className="flex-1 w-full h-full flex overflow-x-auto snap-x snap-mandatory no-scrollbar pb-[72px] relative z-10" 
                        onScroll={(e) => {
                            const scrollLeft = (e.target as HTMLElement).scrollLeft;
                            const width = (e.target as HTMLElement).clientWidth;
                            setActiveImageIndex(Math.round(scrollLeft / width));
                        }}
                    >
                        {artwork.imageUrls.map((url, idx) => (
                            <div key={idx} className="w-full h-full flex items-center justify-center snap-center shrink-0 p-4">
                                <img 
                                    src={url} 
                                    alt={`${artwork.title} - ${idx + 1}`} 
                                    className="max-w-full max-h-full object-contain drop-shadow-2xl" 
                                />
                            </div>
                        ))}
                    </div>


                </div>
            )}

            {isEditing && (
                <ArtworkFormModal 
                    initialData={artwork}
                    onClose={() => setIsEditing(false)}
                    onSave={handleSaveEdit}
                    onDelete={handleDelete}
                />
            )}
        </div>
    );
};
