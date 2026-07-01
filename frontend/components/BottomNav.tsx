import React from 'react';
import { Home, Image, Library, BookOpen, MessageCircle, Search } from 'lucide-react';
import { ViewState } from '../types';

interface BottomNavProps {
    currentView: ViewState;
    onChangeView: (view: ViewState) => void;
}

export const BottomNav: React.FC<BottomNavProps> = ({ currentView, onChangeView }) => {
    const navItems: { id: ViewState; label: string; icon: React.ElementType }[] = [
        { id: 'home', label: 'Home', icon: Home },
        { id: 'artworks', label: 'Artworks', icon: Image },
        { id: 'collections', label: 'Collections', icon: Library },
        { id: 'catalogs', label: 'Catalogs', icon: BookOpen },
        { id: 'messaging', label: 'Messages', icon: MessageCircle },
        { id: 'inquiry', label: 'Inquiry', icon: Search },
    ];

    return (
        <div
            className="absolute bottom-0 w-full bg-white dark:bg-[#1a1a1a] border-t border-gray-200 dark:border-gray-800 z-40 transition-colors duration-300"
            style={{ paddingBottom: 'max(0px, env(safe-area-inset-bottom))' }}
        >
            <div className="flex justify-around items-center h-14">
                {navItems.map((item) => {
                    const Icon = item.icon;
                    const isActive = currentView === item.id;
                    return (
                        <button
                            key={item.id}
                            onClick={() => onChangeView(item.id)}
                            className={`flex flex-col items-center justify-center min-w-[44px] w-full h-full gap-0.5 transition-colors ${
                                isActive ? 'text-gold-500 dark:text-gold-400' : 'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300'
                            }`}
                        >
                            <Icon size={20} strokeWidth={isActive ? 2.5 : 1.8} />
                            <span className="text-[9px] font-medium tracking-wide leading-none">{item.label}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
};
