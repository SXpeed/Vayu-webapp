import { useEffect, useState } from 'react';

/**
 * Tracks a CSS media query from React.
 *
 * Needed where a breakpoint changes *which component renders*, not just how it
 * looks — e.g. Messaging renders its thread inline beside the list on desktop
 * but as a full-screen overlay on phones, which Tailwind's `lg:` variants
 * can't express on their own.
 */
export const useMediaQuery = (query: string): boolean => {
    const [matches, setMatches] = useState(() => {
        if (typeof globalThis.matchMedia !== 'function') return false;
        return globalThis.matchMedia(query).matches;
    });

    useEffect(() => {
        if (typeof globalThis.matchMedia !== 'function') return;
        const mql = globalThis.matchMedia(query);
        const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
        setMatches(mql.matches);
        mql.addEventListener('change', onChange);
        return () => mql.removeEventListener('change', onChange);
    }, [query]);

    return matches;
};

/** Tailwind's `lg` breakpoint — where the app switches to its desktop shell. */
export const useIsDesktop = (): boolean => useMediaQuery('(min-width: 1024px)');
