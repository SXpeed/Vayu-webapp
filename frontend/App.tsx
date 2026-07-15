import React, { useState, useEffect, lazy, Suspense } from 'react';

import { Toaster } from 'react-hot-toast';
import Layout from './components/Layout';
import { LoginView } from './views/LoginView';
import { AuthUser, authService } from './services/authService';
import { HomeView } from './views/HomeView';
import { db } from './services/db';
import storageService from './services/storageService';

/** Fire-and-forget: create small copies for files uploaded before thumbnails existed. */
const backfillThumbnailsQuietly = () => {
    storageService.backfillThumbnails()
        .then(n => { if (n > 0) console.log(`Generated ${n} thumbnail(s) for existing uploads`); })
        .catch(err => console.warn('Thumbnail backfill skipped:', err));
};

import { useNavigation } from './hooks/useNavigation';
import { useAuth } from './hooks/useAuth';
import { useEntityData } from './hooks/useEntityData';
import { useHandlers } from './hooks/useHandlers';
import { pushService } from './services/pushService';

/** View requested by a push-notification click when the app was closed (e.g. /?view=messaging). */
const getPushLaunchView = (): 'messaging' | 'inquiry' | null => {
    const view = new URLSearchParams(globalThis.location.search).get('view');
    return view === 'messaging' || view === 'inquiry' ? view : null;
};

// Code-split: only Login and Home are needed for first paint; every other
// view (including heavy deps like jsPDF and background removal inside
// CatalogsView) loads on demand.
const ArtworksView = lazy(() => import('./views/ArtworksView').then(m => ({ default: m.ArtworksView })));
const CatalogsView = lazy(() => import('./views/CatalogsView').then(m => ({ default: m.CatalogsView })));
const InvoiceView = lazy(() => import('./views/InvoiceView').then(m => ({ default: m.InvoiceView })));
const CollectionsView = lazy(() => import('./views/CollectionsView').then(m => ({ default: m.CollectionsView })));
const ProfileView = lazy(() => import('./views/ProfileView').then(m => ({ default: m.ProfileView })));
const ArtworkDetailView = lazy(() => import('./views/ArtworkDetailView').then(m => ({ default: m.ArtworkDetailView })));
const InquiryView = lazy(() => import('./views/InquiryView').then(m => ({ default: m.InquiryView })));
const MessagingView = lazy(() => import('./views/MessagingView').then(m => ({ default: m.MessagingView })));
const ActivityLogView = lazy(() => import('./views/ActivityLogView').then(m => ({ default: m.ActivityLogView })));

const ViewFallback = () => (
    <div className="h-full flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-gold-400 border-t-transparent rounded-full animate-spin" />
    </div>
);

const App: React.FC = () => {
    const [isLoading, setIsLoading] = useState(true);

    // ── Navigation ─────────────────────────────────────────────────────────
    const {
        currentView, setCurrentView, selectedArtwork, setSelectedArtwork,
        navigateTo, handleArtworkClick, handleCloseArtwork,
    } = useNavigation();

    // ── Auth ───────────────────────────────────────────────────────────────
    const {
        authUser, authUserRef, userProfile, theme,
        applyAuthUser, handleUpdateProfile, handleToggleTheme, handleLogout,
    } = useAuth();

    // ── Entity Data ────────────────────────────────────────────────────────
    const {
        artworks, setArtworks,
        catalogs, setCatalogs,
        collections, setCollections,
        invoices, setInvoices,
        inquiries, setInquiries,
        conversations, setConversations,
        allMessages, setAllMessages,
        inquiryMessages, setInquiryMessages,
        teamMembers,
        loadData, loadTeamMembers, migrateLocalToD1,
    } = useEntityData(authUser, authUserRef);

    // ── Handlers ──────────────────────────────────────────────────────────
    const handlers = useHandlers({
        authUser, userProfile, artworks, conversations, teamMembers,
        setArtworks, setCatalogs, setCollections, setInvoices, setInquiries,
        setConversations, setAllMessages, setInquiryMessages, setSelectedArtwork,
    });

    // ── Initialize DB and load data — runs ONCE on mount ──────────────────
    useEffect(() => {
        const initApp = async () => {
            try {
                await db.init();

                const me = await authService.getMe();
                if (me) {
                    applyAuthUser(me);
                    // Land on the view a push-notification click asked for, else home.
                    const launchView = getPushLaunchView();
                    if (launchView) {
                        // Strip ?view= so a refresh doesn't re-trigger the deep link.
                        globalThis.history.replaceState(null, '', globalThis.location.pathname);
                    }
                    setCurrentView(launchView || 'home');
                    globalThis.history.pushState({ view: launchView || 'home' }, '');
                    pushService.syncSubscription();

                    const migrated = await migrateLocalToD1();
                    await loadData(true);
                    await loadTeamMembers();
                    if (migrated) {
                        await loadData(true);
                    }
                    backfillThumbnailsQuietly();
                } else {
                    globalThis.history.pushState({ view: 'login' }, '');
                    await loadData(false);
                }
            } catch (err) {
                console.error('App initialization error:', err);
                await loadData(false);
            } finally {
                setIsLoading(false);
            }
        };
        initApp();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Navigate when a push notification is clicked while the app is open ─
    useEffect(() => {
        if (!('serviceWorker' in navigator)) return;
        const onSwMessage = (event: MessageEvent) => {
            const { type, view } = (event.data || {}) as { type?: string; view?: string };
            if (type === 'PUSH_NAVIGATE' && (view === 'messaging' || view === 'inquiry')) {
                navigateTo(view);
            }
        };
        navigator.serviceWorker.addEventListener('message', onSwMessage);
        return () => navigator.serviceWorker.removeEventListener('message', onSwMessage);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Login Handler (orchestrates auth + data loading) ──────────────────
    const handleLogin = async (user: AuthUser) => {
        applyAuthUser(user);
        navigateTo('home');
        pushService.syncSubscription();
        const migrated = await migrateLocalToD1();
        await loadTeamMembers();
        await loadData(true);
        if (migrated) {
            await loadData(true);
        }
        backfillThumbnailsQuietly();
    };

    if (isLoading) {
        return (
            <div className="h-full bg-black flex items-center justify-center">
                <div className="animate-pulse flex flex-col items-center justify-center">
                    <svg viewBox="0 0 400 400" className="w-48 h-48">
                        <rect width="400" height="400" fill="#000000" rx="20" />
                        <text x="200" y="210" fontFamily="Playfair Display, serif" fontSize="90" fill="#d4af37" textAnchor="middle" fontWeight="bold">VAYU</text>
                        <text x="200" y="260" fontFamily="Inter, sans-serif" fontSize="18" fill="#d4af37" textAnchor="middle" letterSpacing="4">DESIGN FOR LIVING</text>
                    </svg>
                </div>
            </div>
        );
    }

    const renderView = () => {
        switch (currentView) {
            case 'login':
                return <LoginView onLogin={handleLogin} />;
            case 'home':
                return userProfile ? <HomeView artworks={artworks} catalogs={catalogs} invoices={invoices} onNavigate={navigateTo} userProfile={userProfile} onArtworkClick={handleArtworkClick} onCatalogClick={() => navigateTo('catalogs')} /> : null;
            case 'artworks':
                return <ArtworksView artworks={artworks} onAddArtwork={handlers.handleAddArtwork} onArtworkClick={handleArtworkClick} />;
            case 'collections':
                return <CollectionsView collections={collections} artworks={artworks} onAddCollection={handlers.handleAddCollection} onUpdateCollection={handlers.handleUpdateCollection} onDeleteCollection={handlers.handleDeleteCollection} onArtworkClick={handleArtworkClick} onAddArtwork={handlers.handleAddArtwork} />;
            case 'catalogs':
                return <CatalogsView catalogs={catalogs} artworks={artworks} onAddCatalog={handlers.handleAddCatalog} onUpdateCatalog={handlers.handleUpdateCatalog} onDeleteCatalog={handlers.handleDeleteCatalog} onArtworkClick={handleArtworkClick} onAddArtwork={handlers.handleAddArtwork} />;
            case 'invoice':
                return <InvoiceView invoices={invoices} artworks={artworks} onAddInvoice={handlers.handleAddInvoice} onUpdateInvoice={handlers.handleUpdateInvoice} onDeleteInvoice={handlers.handleDeleteInvoice} onArtworkClick={handleArtworkClick} />;
            case 'inquiry':
                return (
                    <InquiryView
                        inquiries={inquiries}
                        artworks={artworks}
                        onAddInquiry={handlers.handleAddInquiry}
                        onUpdateInquiry={handlers.handleUpdateInquiry}
                        onDeleteInquiry={handlers.handleDeleteInquiry}
                        onArtworkClick={handleArtworkClick}
                        inquiryMessages={inquiryMessages}
                        currentUserId={userProfile?.id || authUser?.id || ''}
                        onSendInquiryMessage={handlers.handleSendInquiryMessage}
                    />
                );
            case 'messaging':
                return (
                    <MessagingView
                        conversations={conversations}
                        messages={allMessages}
                        teamMembers={teamMembers}
                        currentUserId={userProfile?.id || authUser?.id || ''}
                        currentUserName={userProfile?.name || authUser?.name || 'You'}
                        isAdmin={authUser?.role === 'admin'}
                        onSendMessage={handlers.handleSendMessage}
                        onCreateConversation={handlers.handleCreateConversation}
                        onCreateGroup={handlers.handleCreateGroup}
                        onUpdateConversationDetails={handlers.handleUpdateConversationDetails}
                        onUpdateGroup={handlers.handleUpdateGroup}
                        onTogglePinConversation={handlers.handleTogglePinConversation}
                        onToggleArchiveConversation={handlers.handleToggleArchiveConversation}
                        onDeleteConversation={handlers.handleDeleteConversation}
                    />
                );
            case 'activity':
                return <ActivityLogView onBack={() => navigateTo('home')} />;
            case 'profile':
                return userProfile ? (
                    <ProfileView
                        profile={userProfile}
                        onUpdateProfile={handleUpdateProfile}
                        theme={theme}
                        onToggleTheme={handleToggleTheme}
                        onLogout={() => handleLogout(navigateTo)}
                    />
                ) : null;
            default:
                return <LoginView onLogin={handleLogin} />;
        }
    };

    return (
        <Layout currentView={currentView} onNavigate={navigateTo} userProfile={authUser} onShowActivity={() => navigateTo('activity')}>
            <Toaster position="top-center" />
            <Suspense fallback={<ViewFallback />}>
                {renderView()}
                {selectedArtwork && (
                    <ArtworkDetailView artwork={selectedArtwork} onClose={handleCloseArtwork} onUpdateArtwork={handlers.handleUpdateArtwork} onDeleteArtwork={handlers.handleDeleteArtwork} />
                )}
            </Suspense>
        </Layout>
    );
};

export default App;