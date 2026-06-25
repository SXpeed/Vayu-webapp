import React, { useRef, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Renders children into a dedicated container appended to #app-shell,
 * escaping <main>'s overflow-y-auto so full-screen overlays sit above
 * BottomNav's z-40.
 *
 * Each FullScreenPortal instance creates its own wrapper <div> inside
 * #app-shell. React fully owns this wrapper, preventing the
 * "removeChild" DOMException that occurred when the portal wrote
 * directly into a node React was also reconciling.
 */
export const FullScreenPortal: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        const shell = document.getElementById('app-shell');
        if (!shell) return;

        const el = document.createElement('div');
        // absolute + inset-0 + z-50 mirrors the overlay styles the modals expect
        el.style.position = 'absolute';
        el.style.inset = '0';
        el.style.zIndex = '50';
        shell.appendChild(el);
        containerRef.current = el;
        setMounted(true);

        return () => {
            // Guard: only remove if still a child (prevents removeChild crash)
            if (el.parentNode === shell) {
                shell.removeChild(el);
            }
            containerRef.current = null;
        };
    }, []);

    if (!mounted || !containerRef.current) return null;
    return createPortal(children, containerRef.current);
};
