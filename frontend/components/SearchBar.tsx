import React from 'react';
import { Search, X } from 'lucide-react';

interface SearchBarProps {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    /** Extra classes for the outer wrapper — margins, width, etc. */
    className?: string;
}

/**
 * Shared fancy search field: pill shape, gold icon chip, subtle shadow,
 * gold focus ring and an inline clear button. Used app-wide.
 */
export const SearchBar: React.FC<SearchBarProps> = ({ value, onChange, placeholder = 'Search…', className = '' }) => {
    return (
        <div className={`relative ${className}`}>
            <div className="absolute left-1.5 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-gold-500/10 dark:bg-gold-500/15 flex items-center justify-center pointer-events-none">
                <Search size={13} className="text-gold-600 dark:text-gold-400" />
            </div>
            <input
                type="text"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                className="w-full bg-white dark:bg-[#1e1e1e] border border-gray-200 dark:border-gray-800 rounded-full py-2 pl-11 pr-9 text-xs text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 shadow-sm focus:outline-none focus:border-gold-500 focus:ring-2 focus:ring-gold-500/20 transition-all"
            />
            {value.length > 0 && (
                <button
                    type="button"
                    onClick={() => onChange('')}
                    aria-label="Clear search"
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-300 flex items-center justify-center active-scale"
                >
                    <X size={10} strokeWidth={2.5} />
                </button>
            )}
        </div>
    );
};