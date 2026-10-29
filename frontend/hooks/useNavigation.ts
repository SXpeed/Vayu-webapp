import { useState, useEffect } from 'react';
import { ViewState, Artwork } from '../types';
import { artworkThumb, withSharedElement, withViewTransition } from '../appStyle';

/**
 * Manages navigation state: current view, selected artwork overlay,
 * browser back-button handling, and the navigateTo helper.
 * Under the Atelier style, screen changes run as view transitions (appStyle.ts).
 */
export function useNavigation() {
    const [currentView, setCurrentView] = useState<ViewState>('login');
    const [selectedArtwork, setSelectedArtwork] = useState<Artwork | null>(null);

    // Custom navigation handler to manage browser history
    const navigateTo = (view: ViewState) => {
        // Re-tapping the open tab must not add a Back step that goes nowhere.
        if (view === currentView) return;
        withViewTransition(() => setCurrentView(view));
        globalThis.history.pushState({ view }, '');
    };

    const handleArtworkClick = (artwork: Artwork) => {
        withSharedElement(() => setSelectedArtwork(artwork), { from: artworkThumb(artwork.id) });
        globalThis.history.pushState({ view: currentView, modal: 'artwork' }, '');
    };

    const handleCloseArtwork = () => {
        globalThis.history.back(); // This triggers popstate, which clears selectedArtwork
    };

    // Handle Browser/Phone Back Button
    useEffect(() => {
        const handlePopState = (event: PopStateEvent) => {
            const state = event.state;
            let nextView: ViewState | null = null;
            if (state?.view) {
                nextView = state.view;
            } else if (!state && currentView !== 'home' && currentView !== 'login') {
                // Fallback for initial load state if no view is set
                nextView = 'home';
            }
            const closingArtwork = !!selectedArtwork && state?.modal !== 'artwork';

            const update = () => {
                if (nextView) setCurrentView(nextView);
                if (state?.modal !== 'artwork') setSelectedArtwork(null);
            };
            // Closing an artwork shrinks its picture back into its tile; a real
            // screen change blurs across; anything else just applies.
            if (closingArtwork && (!nextView || nextView === currentView)) withSharedElement(update, { to: artworkThumb(selectedArtwork.id) });
            else if (nextView && nextView !== currentView) withViewTransition(update);
            else update();
        };

        globalThis.addEventListener('popstate', handlePopState);
        return () => globalThis.removeEventListener('popstate', handlePopState);
    }, [currentView, selectedArtwork]);

    return {
        currentView,
        setCurrentView,
        selectedArtwork,
        setSelectedArtwork,
        navigateTo,
        handleArtworkClick,
        handleCloseArtwork,
    };
}
