import React, { useState, useEffect, useMemo, lazy, Suspense } from 'react';
import { Lock } from 'lucide-react';

import toast, { Toaster } from 'react-hot-toast';
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
import { syncService } from './services/syncService';
import { canOpenView, makeCan, permissionsOf } from './access';
import { SIGNED_OUT_EVENT } from './services/apiClient';
import { PageRoot, PageHeader, PageBody, EmptyState, Button } from './components/ui';

/** Views a push-notification click may deep-link into. */
const PUSH_VIEWS = ['messaging', 'inquiry', 'payments'] as const;
type PushView = typeof PUSH_VIEWS[number];

/** View requested by a push-notification click when the app was closed (e.g. /?view=messaging). */
const getPushLaunchView = (): PushView | null => {
    const view = new URLSearchParams(globalThis.location.search).get('view');
    return (PUSH_VIEWS as readonly string[]).includes(view || '') ? view as PushView : null;
};

// Code-split: only Login and Home are needed for first paint; every other
// view loads on demand. Heavy deps (jsPDF, background removal) are dynamic
// imports *inside* the views, so warming a view never pulls them in.
const viewLoaders = {
    ArtworksView: () => import('./views/ArtworksView'),
    CatalogsView: () => import('./views/CatalogsView'),
    InvoiceView: () => import('./views/InvoiceView'),
    CollectionsView: () => import('./views/CollectionsView'),
    ProfileView: () => import('./views/ProfileView'),
    ArtworkDetailView: () => import('./views/ArtworkDetailView'),
    InquiryView: () => import('./views/InquiryView'),
    MessagingView: () => import('./views/MessagingView'),
    ActivityLogView: () => import('./views/ActivityLogView'),
    PaymentsView: () => import('./views/PaymentsView'),
    ContactsView: () => import('./views/ContactsView'),
    CalendarView: () => import('./views/CalendarView'),
    AttendanceView: () => import('./views/AttendanceView'),
};

const ArtworksView = lazy(() => viewLoaders.ArtworksView().then(m => ({ default: m.ArtworksView })));
const CatalogsView = lazy(() => viewLoaders.CatalogsView().then(m => ({ default: m.CatalogsView })));
const InvoiceView = lazy(() => viewLoaders.InvoiceView().then(m => ({ default: m.InvoiceView })));
const CollectionsView = lazy(() => viewLoaders.CollectionsView().then(m => ({ default: m.CollectionsView })));
const ProfileView = lazy(() => viewLoaders.ProfileView().then(m => ({ default: m.ProfileView })));
const ArtworkDetailView = lazy(() => viewLoaders.ArtworkDetailView().then(m => ({ default: m.ArtworkDetailView })));
const InquiryView = lazy(() => viewLoaders.InquiryView().then(m => ({ default: m.InquiryView })));
const MessagingView = lazy(() => viewLoaders.MessagingView().then(m => ({ default: m.MessagingView })));
const ActivityLogView = lazy(() => viewLoaders.ActivityLogView().then(m => ({ default: m.ActivityLogView })));
const PaymentsView = lazy(() => viewLoaders.PaymentsView().then(m => ({ default: m.PaymentsView })));
const ContactsView = lazy(() => viewLoaders.ContactsView().then(m => ({ default: m.ContactsView })));
const CalendarView = lazy(() => viewLoaders.CalendarView().then(m => ({ default: m.CalendarView })));
const AttendanceView = lazy(() => viewLoaders.AttendanceView().then(m => ({ default: m.AttendanceView })));

/** Warm every view chunk once the app is idle after sign-in, one per idle
 *  slot, so the first tap on a tab renders at once instead of showing the
 *  spinner while its chunk downloads. Skipped on Save-Data / 2G. */
const prefetchViews = () => {
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (conn?.saveData || /2g/.test(conn?.effectiveType ?? '')) return;
    const idle = (cb: () => void) =>
        'requestIdleCallback' in globalThis ? requestIdleCallback(cb, { timeout: 3000 }) : setTimeout(cb, 300);
    const queue = Object.values(viewLoaders);
    const next = () => {
        const load = queue.shift();
        if (!load) return;
        load().catch(() => { /* offline or a new deploy: the tap will retry */ }).finally(() => idle(next));
    };
    idle(next);
};

/** Shown in place of a screen the signed-in person's role can't open. */
const NoAccessView: React.FC<{ onHome: () => void }> = ({ onHome }) => (
    <PageRoot>
        <PageHeader title="No access" />
        <PageBody>
            <EmptyState
                icon={<Lock size={22} strokeWidth={1.5} />}
                title="Your role can't open this section"
                message="Ask an admin if you need access."
                action={<Button onClick={onHome}>Back to Home</Button>}
            />
        </PageBody>
    </PageRoot>
);

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
        applyAuthUser, clearAuth, handleUpdateProfile, handleToggleTheme, handleLogout,
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
        events, setEvents,
        contacts, setContacts,
        loadData, syncAll, loadTeamMembers, migrateLocalToD1,
    } = useEntityData(authUser, authUserRef, currentView);

    // ── Handlers ──────────────────────────────────────────────────────────
    const handlers = useHandlers({
        authUser, userProfile, artworks, conversations, teamMembers,
        setArtworks, setCatalogs, setCollections, setInvoices, setInquiries,
        setConversations, setAllMessages, setInquiryMessages, setSelectedArtwork,
        setEvents, setContacts,
    });

    // ── Signed out by the server (device limit) ──────────────────────────
    // Registered before the bootstrap effect so a device that was signed out
    // while closed also gets the explanation on its next start.
    useEffect(() => {
        let shown = false;
        const onSignedOut = (event: Event) => {
            const reason = (event as CustomEvent<{ reason?: string }>).detail?.reason;
            authService.clearLocalSession();
            clearAuth();
            navigateTo('login');
            if (!shown) {
                shown = true;
                let message = 'You were signed out. Please sign in again.';
                if (reason === 'device-limit') message = 'You were signed out because your account was signed in on another device.';
                else if (reason === 'signed-out-remotely') message = 'This device was signed out from another device.';
                else if (reason === 'signed-out-by-admin') message = 'An admin signed this device out. Please sign in again.';
                toast.error(message, { duration: 8000 });
            }
        };
        window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
        return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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
                    await syncAll();
                    await loadTeamMembers();
                    if (migrated) {
                        await syncAll();
                    }
                    backfillThumbnailsQuietly();
                    prefetchViews();
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

    // ── Background & periodic sync registration ───────────────────────────
    useEffect(() => {
        syncService.init();
    }, []);

    // ── Navigate when a push notification is clicked while the app is open ─
    useEffect(() => {
        if (!('serviceWorker' in navigator)) return;
        const onSwMessage = (event: MessageEvent) => {
            const { type, view } = (event.data || {}) as { type?: string; view?: string };
            if (type === 'PUSH_NAVIGATE' && (PUSH_VIEWS as readonly string[]).includes(view || '')) {
                navigateTo(view as PushView);
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
        await syncAll();
        if (migrated) {
            await syncAll();
        }
        prefetchViews();
        backfillThumbnailsQuietly();
    };

    // Hooks must run before the loading early-return below.
    const can = useMemo(() => makeCan(permissionsOf(authUser)), [authUser]);

    if (isLoading) {
        return (
            <div className="h-full bg-black flex items-center justify-center">
                <div className="animate-pulse flex flex-col items-center justify-center">
                    <img src="/icon.png" alt="Vayu Logo" className="w-48 h-48 object-contain rounded-[20px]" />
                </div>
            </div>
        );
    }

    const renderView = () => {
        // Role gate: a screen this role can't open (via a notification link,
        // say, or a role changed while the app was open) explains itself.
        if (authUser && currentView !== 'login' && !canOpenView(can, currentView)) {
            return <NoAccessView onHome={() => navigateTo('home')} />;
        }
        switch (currentView) {
            case 'login':
                return <LoginView onLogin={handleLogin} />;
            case 'home':
                return userProfile ? <HomeView artworks={artworks} catalogs={catalogs} invoices={invoices} events={events} teamMembers={teamMembers} onNavigate={navigateTo} userProfile={userProfile} onCatalogClick={() => navigateTo('catalogs')} onAddEvent={handlers.handleAddEvent} onUpdateEvent={handlers.handleUpdateEvent} onDeleteEvent={handlers.handleDeleteEvent} /> : null;
            case 'artworks':
                return <ArtworksView artworks={artworks} onAddArtwork={handlers.handleAddArtwork} onArtworkClick={handleArtworkClick} />;
            case 'collections':
                return <CollectionsView collections={collections} artworks={artworks} onAddCollection={handlers.handleAddCollection} onUpdateCollection={handlers.handleUpdateCollection} onDeleteCollection={handlers.handleDeleteCollection} onArtworkClick={handleArtworkClick} onAddArtwork={handlers.handleAddArtwork} />;
            case 'catalogs':
                return <CatalogsView catalogs={catalogs} artworks={artworks} onAddCatalog={handlers.handleAddCatalog} onUpdateCatalog={handlers.handleUpdateCatalog} onDeleteCatalog={handlers.handleDeleteCatalog} onArtworkClick={handleArtworkClick} onAddArtwork={handlers.handleAddArtwork} />;
            case 'contacts':
                return (
                    <ContactsView
                        contacts={contacts}
                        inquiries={inquiries}
                        onAddContact={handlers.handleAddContact}
                        onUpdateContact={handlers.handleUpdateContact}
                        onImportContacts={handlers.handleImportContacts}
                        onDeleteContact={handlers.handleDeleteContact}
                    />
                );
            case 'calendar':
                return <CalendarView events={events} onBack={() => navigateTo('home')} />;
            case 'attendance':
                return authUser ? <AttendanceView authUser={authUser} canManage={can('attendance', 'edit')} onBack={() => navigateTo('home')} /> : null;
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
                        invoices={invoices}
                        onAddInvoice={handlers.handleAddInvoice}
                        teamMembers={teamMembers}
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
                        onSendMessage={handlers.handleSendMessage}
                        onRetryMessage={handlers.handleRetryMessage}
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
            case 'payments':
                return <PaymentsView />;
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
        <Layout currentView={currentView} onNavigate={navigateTo} userProfile={authUser}>
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
