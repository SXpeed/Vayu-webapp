import { useState, useEffect } from 'react';
import { ViewState, Artwork } from '../types';

/**
 * Manages navigation state: current view, selected artwork overlay,
 * browser back-button handling, and the navigateTo helper.
 */
export function useNavigation() {
    const [currentView, setCurrentView] = useState<ViewState>('login');
    const [selectedArtwork, setSelectedArtwork] = useState<Artwork | null>(null);

    // Custom navigation handler to manage browser history
    const navigateTo = (view: ViewState) => {
        setCurrentView(view);
        globalThis.history.pushState({ view }, '');
    };

    const handleArtworkClick = (artwork: Artwork) => {
        setSelectedArtwork(artwork);
        globalThis.history.pushState({ view: currentView, modal: 'artwork' }, '');
    };

    const handleCloseArtwork = () => {
        globalThis.history.back(); // This triggers popstate, which clears selectedArtwork
    };

    // Handle Browser/Phone Back Button
    useEffect(() => {
        const handlePopState = (event: PopStateEvent) => {
            const state = event.state;
            
            if (state?.view) {
                setCurrentView(state.view);
            } else if (!state && currentView !== 'home' && currentView !== 'login') {
                // Fallback for initial load state if no view is set
                setCurrentView('home');
            }

            if (!state?.modal || state.modal !== 'artwork') {
                setSelectedArtwork(null);
            }
        };

        globalThis.addEventListener('popstate', handlePopState);
        return () => globalThis.removeEventListener('popstate', handlePopState);
    }, [currentView]);

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