import React, { useEffect, useRef } from 'react';
import { Search, X } from 'lucide-react';
import { useHeaderTools } from './ui';

interface SearchBarProps {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    /** Extra classes for the outer wrapper — margins, width, etc. */
    className?: string;
}

/**
 * Shared fancy search field: raised pill with an etched icon well and an
 * inline clear button. On focus the whole pill flips the other way — it
 * presses in, the caret goes gold, and the icon chip lights up gold (the
 * app's "active" accent). No outline ring: a gold ring reads as a hard line.
 *
 * If the field is rendered inside a PageHeader's tools row, it registers
 * itself with that header (see HeaderToolsContext): that is what lets the
 * folded row leave its magnifier on the title line, and what that magnifier
 * focuses when tapped. Anywhere else — sheets, dialogs — the register call
 * lands on a no-op.
 */
export const SearchBar: React.FC<SearchBarProps> = ({ value, onChange, placeholder = 'Search…', className = '' }) => {
    const inputRef = useRef<HTMLInputElement>(null);
    const { registerSearch } = useHeaderTools();

    useEffect(() => {
        registerSearch(inputRef.current);
        return () => registerSearch(null);
    }, [registerSearch]);

    return (
        <div className={`relative search-group ${className}`}>
            <div className="search-chip absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full neu-inset flex items-center justify-center pointer-events-none">
                <Search size={14} className="text-gold-700 dark:text-gold-300" />
            </div>
            <input
                ref={inputRef}
                type="text"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                className="neu-search w-full rounded-full py-2.5 pl-12 pr-10 text-sm text-gray-800 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none"
            />
            {value.length > 0 && (
                <button
                    type="button"
                    onClick={() => onChange('')}
                    aria-label="Clear search"
                    className="absolute right-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full neu-raised-sm text-gray-700 dark:text-gray-200 flex items-center justify-center active-scale"
                >
                    <X size={11} strokeWidth={2.5} />
                </button>
            )}
        </div>
    );
};