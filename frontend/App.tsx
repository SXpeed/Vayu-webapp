import React, { useState, useEffect, useMemo, useCallback, useRef, lazy, Suspense } from 'react';
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
import { PLAN_BLOCKED_EVENT, SIGNED_OUT_EVENT } from './services/apiClient';
import { PlanBlockedView } from './views/PlanBlockedView';
import { PageRoot, PageHeader, PageBody, EmptyState, Button } from './components/ui';
import { APP_NAME } from './brand';
import { useBranding } from './useBranding';
import { authClient, currentWorkspace, refreshCurrentWorkspace } from './services/workspace';
import { emailChangeLanding } from './services/emailChange';

/** Views a push-notification click may deep-link into. */
const PUSH_VIEWS = ['messaging', 'inquiry', 'payments', 'schedule'] as const;
type PushView = typeof PUSH_VIEWS[number];

/** Where a notification tap leads: the page, and the chat or inquiry on it. */
interface PushTarget {
    view: PushView;
    conversationId?: string;
    inquiryId?: string;
    /** An inquiry's chat rather than its details. */
    chat?: boolean;
    /** Set by the service worker; the same tap is never acted on twice. */
    id?: string;
}

const isPushView = (view: unknown): view is PushView => (PUSH_VIEWS as readonly unknown[]).includes(view);

/** A tap target from untrusted data (the URL, a message, the stored record), or null. */
function pushTargetFrom(raw: Record<string, unknown> | null | undefined): PushTarget | null {
    if (!raw || !isPushView(raw.view)) return null;
    const text = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 128 ? v : undefined);
    return { view: raw.view, conversationId: text(raw.conversationId), inquiryId: text(raw.inquiryId), chat: raw.chat === true, id: text(raw.id) };
}

/** Requested by a notification tap that launched the app (e.g. /?view=messaging&conversation=…). */
const getPushLaunchTarget = (): PushTarget | null => {
    const q = new URLSearchParams(globalThis.location.search);
    return pushTargetFrom({ view: q.get('view'), conversationId: q.get('conversation'), inquiryId: q.get('inquiry'), chat: q.get('chat') === '1' });
};

/**
 * A tap the service worker left for the app (sw.js), taken once. On iPhone
 * its message to an app waking from the background can be lost, so the app
 * also looks here whenever it comes to the front. Only a recent one counts.
 */
async function takeStoredPushTarget(): Promise<PushTarget | null> {
    try {
        if (!('caches' in globalThis)) return null;
        const cache = await caches.open('push-nav');
        const res = await cache.match('/__push-nav');
        if (!res) return null;
        await cache.delete('/__push-nav');
        const raw = await res.json() as Record<string, unknown>;
        return typeof raw.at === 'number' && Date.now() - raw.at < 2 * 60_000 ? pushTargetFrom(raw) : null;
    } catch {
        return null;
    }
}

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
    StaffRosterView: () => import('./views/StaffRosterView'),
    SalesView: () => import('./views/SalesView'),
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
const StaffRosterView = lazy(() => viewLoaders.StaffRosterView().then(m => ({ default: m.StaffRosterView })));
const SalesView = lazy(() => viewLoaders.SalesView().then(m => ({ default: m.SalesView })));

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

/** How long the splash waits for the first sync before opening on the saved copy. */
const BOOT_SYNC_WAIT_MS = 3500;
/** After this, the splash says what it is waiting on and offers a reload. */
const BOOT_STALL_MS = 8000;

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const App: React.FC = () => {
    const [isLoading, setIsLoading] = useState(true);
    // The workspace's plan isn't active: the app shows only its plan, to pay.
    const [planBlocked, setPlanBlocked] = useState(false);
    // Arriving from an email-change link (services/emailChange.ts): say what happened.
    useEffect(() => {
        emailChangeLanding(authClient).then(result => {
            if (result) toast[result.ok ? 'success' : 'error'](result.message, { duration: 10_000 });
        }).catch(() => { /* offline: nothing to say */ });
    }, []);
    useEffect(() => {
        const onBlocked = () => setPlanBlocked(true);
        window.addEventListener(PLAN_BLOCKED_EVENT, onBlocked);
        return () => window.removeEventListener(PLAN_BLOCKED_EVENT, onBlocked);
    }, []);
    // What start-up is waiting on — shown on the splash if it runs long, so a
    // stuck start says where it is stuck instead of pulsing forever.
    const [bootStep, setBootStep] = useState('Starting');
    const [bootStalled, setBootStalled] = useState(false);
    useEffect(() => {
        if (!isLoading) return;
        const timer = setTimeout(() => setBootStalled(true), BOOT_STALL_MS);
        return () => clearTimeout(timer);
    }, [isLoading]);

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
    /** The chat or inquiry a notification tap asked for, until its page has opened it. */
    const [pushTarget, setPushTarget] = useState<PushTarget | null>(null);
    /**
     * A tap that launched the app, read once at start. Sign-in also honours
     * it: the sign-in screen shows briefly at start and, finding the person
     * signed in already, used to send them Home over the top of it, so a
     * tap that opened the app never got past Home. Tapped while signed out,
     * it is where signing in leads.
     */
    const launchTargetRef = useRef<PushTarget | null>(getPushLaunchTarget());

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
            // Signed out: this device shows none of that person's notifications now.
            void pushService.setIdentity(null);
            navigateTo('login');
            if (!shown) {
                shown = true;
                let message = 'You were signed out. Please sign in again.';
                if (reason === 'device-limit') message = 'You were signed out because your account was signed in on another device.';
                else if (reason === 'signed-out-remotely') message = 'This device was signed out from another device.';
                else if (reason === 'signed-out-by-admin') message = 'An admin signed this device out. Please sign in again.';
                else if (reason === 'original-signin-closed') message = 'Sign-in has moved to your email account. Sign in with your email and the same password.';
                toast.error(message, { duration: 8000 });
            }
        };
        window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
        return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Initialize DB and load data — runs ONCE on mount ──────────────────
    // The splash used to wait for the whole first sync. Every read has a 20s
    // timeout and a sync can take many pages, so on a slow phone connection
    // it could sit on the logo for minutes — it looked stuck. Now it opens on
    // the device's saved copy once the sync has had BOOT_SYNC_WAIT_MS to
    // finish, and the sync carries on in the background.
    useEffect(() => {
        const initApp = async () => {
            let signedInAtStart = false;
            try {
                setBootStep('Starting');
                await db.init();

                setBootStep('Checking your sign-in');
                const me = await authService.getMe();
                if (me) {
                    signedInAtStart = true;
                    applyAuthUser(me);
                    // Land where a notification tap asked for, else home.
                    const launch = launchTargetRef.current;
                    if (launch) {
                        // Strip ?view= so a refresh doesn't re-trigger the deep link.
                        globalThis.history.replaceState(null, '', globalThis.location.pathname);
                        // The same tap is also stored for the app (sw.js): already handled.
                        void takeStoredPushTarget();
                        setPushTarget(launch);
                    }
                    setCurrentView(launch?.view || 'home');
                    globalThis.history.pushState({ view: launch?.view || 'home' }, '');
                    pushService.syncSubscription();
                    // Picks up a logo changed in the control centre, for next launch.
                    void refreshCurrentWorkspace();

                    // Saved copy first (local, instant): what shows if the
                    // sync below is still running when the splash lifts.
                    await loadData(false);

                    setBootStep('Syncing');
                    const firstSync = (async () => {
                        const migrated = await migrateLocalToD1();
                        await syncAll();
                        await loadTeamMembers();
                        if (migrated) {
                            await syncAll();
                        }
                    })().catch(err => console.error('First sync failed:', err));
                    void firstSync.then(() => {
                        backfillThumbnailsQuietly();
                        prefetchViews();
                    });
                    await Promise.race([firstSync, delay(BOOT_SYNC_WAIT_MS)]);
                } else {
                    globalThis.history.pushState({ view: 'login' }, '');
                    await loadData(false);
                }
            } catch (err) {
                console.error('App initialization error:', err);
                await loadData(false).catch(() => undefined);
            } finally {
                // Used now; a later sign-in is a fresh start, not this tap.
                if (signedInAtStart) launchTargetRef.current = null;
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

    // ── Navigate when a push notification is tapped while the app is open ─
    // Straight away from the service worker's message, or, when iOS lost
    // that message while waking the app, from the record it also left.
    const handledTaps = useRef(new Set<string>());
    const goToPushTarget = useCallback((target: PushTarget | null) => {
        if (!target || !authUserRef.current) return;
        if (target.id) {
            if (handledTaps.current.has(target.id)) return;
            handledTaps.current.add(target.id);
        }
        setPushTarget(target);
        navigateTo(target.view);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    useEffect(() => {
        const fromStore = () => {
            if (document.visibilityState === 'visible') void takeStoredPushTarget().then(goToPushTarget);
        };
        const onSwMessage = (event: MessageEvent) => {
            const data = (event.data || {}) as Record<string, unknown>;
            if (data.type !== 'PUSH_NAVIGATE') return;
            void takeStoredPushTarget(); // the same tap: drop the stored copy
            goToPushTarget(pushTargetFrom(data));
        };
        navigator.serviceWorker?.addEventListener('message', onSwMessage);
        document.addEventListener('visibilitychange', fromStore);
        globalThis.addEventListener('focus', fromStore);
        return () => {
            navigator.serviceWorker?.removeEventListener('message', onSwMessage);
            document.removeEventListener('visibilitychange', fromStore);
            globalThis.removeEventListener('focus', fromStore);
        };
    }, [goToPushTarget]);

    // Who is signed in here, for the service worker's notification check.
    useEffect(() => {
        if (authUser?.id) void pushService.setIdentity(authUser.id);
    }, [authUser?.id]);

    // ── Login Handler (orchestrates auth + data loading) ──────────────────
    const handleLogin = async (user: AuthUser) => {
        applyAuthUser(user);
        const launch = launchTargetRef.current;
        launchTargetRef.current = null;
        if (launch) setPushTarget(launch);
        navigateTo(launch?.view ?? 'home');
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
    const branding = useBranding();

    if (isLoading) {
        // On the page colour of the current theme, with the workspace's own
        // logo (saved with the workspace, so it is there before any network)
        // or else the platform's — both uploaded with a transparent
        // background. Used to be the old app icon, a logo baked onto black.
        const splashLogo = currentWorkspace()?.logoUrl ?? branding.logoUrl;
        return (
            <div className="h-full bg-[var(--neu-bg)] flex flex-col items-center justify-center">
                <div className="animate-pulse flex flex-col items-center justify-center px-10">
                    {splashLogo ? (
                        <img src={splashLogo} alt={`${currentWorkspace()?.name ?? branding.appName} logo`}
                            className="w-56 max-w-full h-40 object-contain" />
                    ) : (
                        <span className="font-serif text-4xl tracking-wide text-gold-700 dark:text-gold-300">
                            {branding.appName || APP_NAME}
                        </span>
                    )}
                </div>
                {bootStalled && (
                    <div className="mt-8 flex flex-col items-center gap-3 text-center px-8 animate-fade-in">
                        <p className="text-sm text-gray-600 dark:text-gray-300">{bootStep}… this is taking longer than usual.</p>
                        <button
                            type="button"
                            onClick={() => globalThis.location.reload()}
                            className="neu-button px-5 py-2 text-sm active-scale"
                        >
                            Reload
                        </button>
                    </div>
                )}
            </div>
        );
    }

    if (planBlocked && currentWorkspace()) {
        return (
            <>
                <Toaster position="top-center" />
                <PlanBlockedView />
            </>
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
                return userProfile ? <HomeView artworks={artworks} catalogs={catalogs} events={events} teamMembers={teamMembers} onNavigate={navigateTo} userProfile={userProfile} onAddEvent={handlers.handleAddEvent} onUpdateEvent={handlers.handleUpdateEvent} onDeleteEvent={handlers.handleDeleteEvent} /> : null;
            case 'artworks':
                return <ArtworksView artworks={artworks} onAddArtwork={handlers.handleAddArtwork} onArtworkClick={handleArtworkClick} />;
            case 'collections':
                return <CollectionsView collections={collections} artworks={artworks} onAddCollection={handlers.handleAddCollection} onUpdateCollection={handlers.handleUpdateCollection} onDeleteCollection={handlers.handleDeleteCollection} onArtworkClick={handleArtworkClick} onAddArtwork={handlers.handleAddArtwork} />;
            case 'catalogs':
                return <CatalogsView catalogs={catalogs} artworks={artworks} onAddCatalog={handlers.handleAddCatalog} onUpdateCatalog={handlers.handleUpdateCatalog} onDeleteCatalog={handlers.handleDeleteCatalog} onArtworkClick={handleArtworkClick} onAddArtwork={handlers.handleAddArtwork} />;
            case 'schedule':
                return <StaffRosterView />;
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
                return <CalendarView events={events} onBack={() => navigateTo('home')} onUpdateEvent={handlers.handleUpdateEvent} teamMembers={teamMembers} canEdit={can('calendar', 'edit')} />;
            case 'attendance':
                return authUser ? <AttendanceView authUser={authUser} canManage={can('attendance', 'edit')} onBack={() => navigateTo('home')} /> : null;
            case 'invoice':
                return <InvoiceView invoices={invoices} artworks={artworks} onAddInvoice={handlers.handleAddInvoice} onUpdateInvoice={handlers.handleUpdateInvoice} onDeleteInvoice={handlers.handleDeleteInvoice} onArtworkClick={handleArtworkClick} />;
            case 'inquiry':
                return (
                    <InquiryView
                        openInquiry={pushTarget?.view === 'inquiry' && pushTarget.inquiryId ? { id: pushTarget.inquiryId, chat: !!pushTarget.chat } : undefined}
                        onOpenedInquiry={() => setPushTarget(null)}
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
                        isAdmin={authUser?.role === 'admin'}
                        onSendMessage={handlers.handleSendMessage}
                        onRetryMessage={handlers.handleRetryMessage}
                        onReactToMessage={handlers.handleReactToMessage}
                        openConversationId={pushTarget?.view === 'messaging' ? pushTarget.conversationId : undefined}
                        onOpenedConversation={() => setPushTarget(null)}
                        onMarkMessagesRead={handlers.handleMarkMessagesRead}
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
                return <PaymentsView invoices={invoices} />;
            case 'sales':
                return <SalesView artworks={artworks} contacts={contacts} />;
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
