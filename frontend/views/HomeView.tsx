import React, { useMemo } from 'react';
import { Artwork, Catalog, Invoice, ViewState, UserProfile } from '../types';
import { Image as ImageIcon, BookOpen, MessageCircle, Receipt, TrendingUp, Palette, ArrowRight } from 'lucide-react';

interface HomeViewProps {
    artworks: Artwork[];
    catalogs: Catalog[];
    invoices: Invoice[];
    userProfile: UserProfile;
    onNavigate: (view: ViewState) => void;
    onArtworkClick: (artwork: Artwork) => void;
    onCatalogClick: (catalog: Catalog) => void;
}

export const HomeView: React.FC<HomeViewProps> = ({ artworks, catalogs, invoices, userProfile, onNavigate, onArtworkClick, onCatalogClick }) => {
    const availableArtworks = useMemo(() => artworks.filter(a => a.status === 'Available').length, [artworks]);
    const totalRevenue = useMemo(() => invoices.reduce((sum, inv) => sum + inv.total, 0), [invoices]);
    const recentArtworks = useMemo(() => [...artworks].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5), [artworks]);
    const recentCatalogs = useMemo(() => [...catalogs].sort((a, b) => b.createdAt - a.createdAt).slice(0, 2), [catalogs]);

    return (
        <div className="h-full flex flex-col bg-[#faf9f6] dark:bg-[#121212] overflow-y-auto no-scrollbar pb-24 transition-colors duration-500 animate-fade-in">
            {/* Top Stats */}
            <div className="px-4 pt-4">
                <div className="flex gap-3 animate-fade-in-up" style={{ animationDelay: '100ms' }}>
                    <div className="flex-1 bg-white dark:bg-[#1e1e1e] rounded-[7px] p-4 shadow-sm border border-gray-100 dark:border-gray-800">
                        <div className="flex items-center gap-2 mb-1.5">
                            <TrendingUp size={14} className="text-gold-500" />
                            <span className="text-[9px] font-medium uppercase tracking-widest text-gray-500 dark:text-gray-400">Revenue</span>
                        </div>
                        <p className="text-xl font-serif text-gray-900 dark:text-white">₹{totalRevenue.toLocaleString('en-IN')}</p>
                    </div>
                    <div className="flex-1 bg-white dark:bg-[#1e1e1e] rounded-[7px] p-4 shadow-sm border border-gray-100 dark:border-gray-800">
                        <div className="flex items-center gap-2 mb-1.5">
                            <Palette size={14} className="text-gold-500" />
                            <span className="text-[9px] font-medium uppercase tracking-widest text-gray-500 dark:text-gray-400">Available</span>
                        </div>
                        <p className="text-xl font-serif text-gray-900 dark:text-white">{availableArtworks} <span className="text-xs font-sans text-gray-400">/ {artworks.length}</span></p>
                    </div>
                </div>
            </div>

            <div className="px-4 mt-6 space-y-8">
                {/* Quick Actions */}
                <section className="animate-fade-in-up" style={{ animationDelay: '200ms' }}>
                    <h2 className="text-xs font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest mb-3 px-2">Quick Actions</h2>
                    <div className="grid grid-cols-4 gap-2.5">
                        <button 
                            onClick={() => onNavigate('artworks')}
                            className="bg-white dark:bg-[#1e1e1e] p-3 rounded-[7px] shadow-sm border border-gray-100 dark:border-gray-800 flex flex-col items-center justify-center gap-2 hover:border-gold-500 dark:hover:border-gold-500 transition-colors active-scale"
                        >
                            <div className="text-brand-900 dark:text-gold-400">
                                <ImageIcon size={22} strokeWidth={1.5} />
                            </div>
                            <span className="text-[9px] font-medium text-gray-600 dark:text-gray-300 uppercase tracking-wider">Inventory</span>
                        </button>
                        <button 
                            onClick={() => onNavigate('catalogs')}
                            className="bg-white dark:bg-[#1e1e1e] p-3 rounded-[7px] shadow-sm border border-gray-100 dark:border-gray-800 flex flex-col items-center justify-center gap-2 hover:border-gold-500 dark:hover:border-gold-500 transition-colors active-scale"
                        >
                            <div className="text-brand-900 dark:text-gold-400">
                                <BookOpen size={22} strokeWidth={1.5} />
                            </div>
                            <span className="text-[9px] font-medium text-gray-600 dark:text-gray-300 uppercase tracking-wider">Catalogs</span>
                        </button>
                        <button 
                            onClick={() => onNavigate('invoice')}
                            className="bg-white dark:bg-[#1e1e1e] p-3 rounded-[7px] shadow-sm border border-gray-100 dark:border-gray-800 flex flex-col items-center justify-center gap-2 hover:border-gold-500 dark:hover:border-gold-500 transition-colors active-scale"
                        >
                            <div className="text-brand-900 dark:text-gold-400">
                                <Receipt size={22} strokeWidth={1.5} />
                            </div>
                            <span className="text-[9px] font-medium text-gray-600 dark:text-gray-300 uppercase tracking-wider">Invoice</span>
                        </button>
                        <button 
                            onClick={() => onNavigate('messaging')}
                            className="bg-white dark:bg-[#1e1e1e] p-3 rounded-[7px] shadow-sm border border-gray-100 dark:border-gray-800 flex flex-col items-center justify-center gap-2 hover:border-gold-500 dark:hover:border-gold-500 transition-colors active-scale"
                        >
                            <div className="text-brand-900 dark:text-gold-400">
                                <MessageCircle size={22} strokeWidth={1.5} />
                            </div>
                            <span className="text-[9px] font-medium text-gray-600 dark:text-gray-300 uppercase tracking-wider">Messages</span>
                        </button>
                    </div>
                </section>

                {/* Recent Artworks */}
                <section className="animate-fade-in-up" style={{ animationDelay: '250ms' }}>
                    <div className="flex justify-between items-end mb-3 px-2">
                        <h2 className="text-xs font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest">Recently Added</h2>
                        <button onClick={() => onNavigate('artworks')} className="text-[9px] font-medium text-gold-600 dark:text-gold-400 uppercase tracking-wider flex items-center gap-1 active-scale">
                            View All <ArrowRight size={10} />
                        </button>
                    </div>
                    <div className="flex overflow-x-auto gap-2 pb-4 px-2 no-scrollbar snap-x">
                        {recentArtworks.map((art, index) => {
                            const coverImage = art.imageUrls?.[0];
                            return (
                                <div 
                                    key={art.id} 
                                    onClick={() => onArtworkClick(art)}
                                    className="snap-start shrink-0 w-40 bg-white dark:bg-[#1e1e1e] rounded-[7px] shadow-sm overflow-hidden border border-gray-100 dark:border-gray-800 animate-scale-in cursor-pointer active-scale" 
                                    style={{ animationDelay: `${300 + index * 50}ms` }}
                                >
                                    {coverImage ? (
                                        <img src={coverImage} alt={art.title} className="w-full h-36 object-cover" />
                                    ) : (
                                        <div className="w-full h-36 bg-gray-50 dark:bg-gray-800 flex items-center justify-center text-gray-300 dark:text-gray-600">
                                            <ImageIcon size={28} strokeWidth={1} />
                                        </div>
                                    )}
                                    <div className="p-3">
                                        <h3 className="font-serif text-gray-900 dark:text-gray-100 text-sm line-clamp-1">{art.title}</h3>
                                        <p className="text-[9px] text-gray-500 dark:text-gray-400 mt-1 uppercase tracking-wider">{art.medium}</p>
                                        <div className="mt-2 flex justify-between items-center">
                                            <span className="font-medium text-brand-900 dark:text-gold-400 text-xs">₹{art.price.toLocaleString('en-IN')}</span>
                                            <div className={`w-1.5 h-1.5 rounded-full ${art.status === 'Available' ? 'bg-green-500' : art.status === 'Sold' ? 'bg-red-500' : 'bg-yellow-500'}`}></div>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                        {recentArtworks.length === 0 && (
                            <div className="w-full text-center py-8 text-gray-400 dark:text-gray-500 text-xs bg-white dark:bg-[#1e1e1e] rounded-[7px] border border-gray-100 dark:border-gray-800 font-light">
                                No artworks added yet.
                            </div>
                        )}
                    </div>
                </section>

                {/* Recent Catalogs */}
                {recentCatalogs.length > 0 && (
                    <section className="animate-fade-in-up" style={{ animationDelay: '350ms' }}>
                        <div className="flex justify-between items-end mb-3 px-2">
                            <h2 className="text-xs font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest">Latest Catalogs</h2>
                            <button onClick={() => onNavigate('catalogs')} className="text-[9px] font-medium text-gold-600 dark:text-gold-400 uppercase tracking-wider flex items-center gap-1 active-scale">
                                View All <ArrowRight size={10} />
                            </button>
                        </div>
                        <div className="space-y-3 px-2">
                            {recentCatalogs.map((catalog, index) => (
                                <div 
                                    key={catalog.id} 
                                    onClick={() => onCatalogClick(catalog)}
                                    className="bg-white dark:bg-[#1e1e1e] rounded-[7px] shadow-sm overflow-hidden border border-gray-100 dark:border-gray-800 flex h-24 animate-scale-in cursor-pointer active-scale" 
                                    style={{ animationDelay: `${400 + index * 50}ms` }}
                                >
                                    <img src={catalog.coverImageUrl} alt={catalog.name} className="w-24 h-full object-cover" />
                                    <div className="p-3 flex flex-col justify-center flex-1">
                                        <h3 className="font-serif text-gray-900 dark:text-gray-100 text-sm line-clamp-1">{catalog.name}</h3>
                                        <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-1 line-clamp-1 font-light">{catalog.description}</p>
                                        <p className="text-[9px] font-medium text-gold-600 dark:text-gold-400 mt-2 uppercase tracking-widest">
                                            {catalog.artworkIds.length} Items
                                        </p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>
                )}
            </div>
        </div>
    );
};
