import React, { useEffect, useState } from 'react';
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
export const FullScreenPortal: React.FC<{ readonly children: React.ReactNode }> = ({ children }) => {
    const [container, setContainer] = useState<HTMLDivElement | null>(null);

    useEffect(() => {
        const shell = document.getElementById('app-shell');
        if (!shell) return;

        const el = document.createElement('div');
        // absolute + inset-0 + z-50 mirrors the overlay styles the modals expect
        el.style.position = 'absolute';
        el.style.inset = '0';
        el.style.zIndex = '50';
        // On desktop the sheets inside are centred dialogs rather than
        // full-screen, so the wrapper supplies the backdrop behind them.
        el.className = 'neu-portal-scrim';
        shell.append(el);
        setContainer(el);

        return () => {
            // remove() is a no-op when the node is already detached, so this
            // can't throw the old removeChild DOMException.
            el.remove();
        };
    }, []);

    return container ? createPortal(children, container) : null;
};
