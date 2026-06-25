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
        <div className="absolute bottom-0 w-full bg-white dark:bg-[#1a1a1a] border-t border-gray-200 dark:border-gray-800 pb-safe z-40 transition-colors duration-300">
            <div className="flex justify-around items-center h-16">
                {navItems.map((item) => {
                    const Icon = item.icon;
                    const isActive = currentView === item.id;
                    return (
                        <button
                            key={item.id}
                            onClick={() => onChangeView(item.id)}
                            className={`flex flex-col items-center justify-center w-full h-full space-y-1 transition-colors ${
                                isActive ? 'text-gold-500 dark:text-gold-400' : 'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300'
                            }`}
                        >
                            <Icon size={24} strokeWidth={isActive ? 2.5 : 2} />
                            <span className="text-[10px] font-medium tracking-wide">{item.label}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
};
