import React, { useState, useEffect } from 'react';

import { Toaster } from 'react-hot-toast';
import Layout from './components/Layout';
import { LoginView } from './views/LoginView';
import { authService, AuthUser } from './services/authService';
import { HomeView } from './views/HomeView';
import { ArtworksView } from './views/ArtworksView';
import { CatalogsView } from './views/CatalogsView';
import { InvoiceView } from './views/InvoiceView';
import { CollectionsView } from './views/CollectionsView';
import { ProfileView } from './views/ProfileView';
import { ArtworkDetailView } from './views/ArtworkDetailView';
import { InquiryView } from './views/InquiryView';
import { MessagingView } from './views/MessagingView';
import { ActivityLogView } from './views/ActivityLogView';
import { db } from './services/db';

import { useNavigation } from './hooks/useNavigation';
import { useAuth } from './hooks/useAuth';
import { useEntityData } from './hooks/useEntityData';
import { useHandlers } from './hooks/useHandlers';

const VAPID_PUBLIC_KEY = 'BJEA9asM3-1QWxLYPlAl8YERsdYA_TuWuGi4je3Txs3rHESUgY1fGzqMYELT_WKV4od-_Lm3I3F2THD9KXHvm2g';

function urlBase64ToUint8Array(base64String: string) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replaceAll('-', '+').replaceAll('_', '/');
    const rawData = globalThis.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.codePointAt(i) || 0;
    }
    return outputArray;
}

async function subscribeToWebPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in globalThis)) return;
    try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
        });
        await fetch('/api/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sub)
        });
        console.log('Web Push registered successfully');
    } catch (e) {
        console.error('Failed to subscribe to Web Push:', e);
    }
}

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
                    if ('Notification' in globalThis) {
                        if (Notification.permission === 'default') {
                            await Notification.requestPermission();
                        }
                        if (Notification.permission === 'granted') {
                            subscribeToWebPush();
                        }
                    }
                    applyAuthUser(me);
                    setCurrentView('home');
                    globalThis.history.pushState({ view: 'home' }, '');

                    const migrated = await migrateLocalToD1();
                    await loadData(true);
                    await loadTeamMembers();
                    if (migrated) {
                        await loadData(true);
                    }
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

    // ── Login Handler (orchestrates auth + data loading) ──────────────────
    const handleLogin = async (user: AuthUser) => {
        if ('Notification' in globalThis) {
            if (Notification.permission === 'default') {
                await Notification.requestPermission();
            }
            if (Notification.permission === 'granted') {
                subscribeToWebPush();
            }
        }
        applyAuthUser(user);
        navigateTo('home');
        const migrated = await migrateLocalToD1();
        await loadTeamMembers();
        await loadData(true);
        if (migrated) {
            await loadData(true);
        }
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
            {renderView()}
            {selectedArtwork && (
                <ArtworkDetailView artwork={selectedArtwork} onClose={handleCloseArtwork} onUpdateArtwork={handlers.handleUpdateArtwork} onDeleteArtwork={handlers.handleDeleteArtwork} />
            )}
        </Layout>
    );
};

export default App;