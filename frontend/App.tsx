import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ViewState, Artwork, Catalog, Invoice, Collection, Inquiry, Conversation, ConversationDetails, Message, MessageTag, MessageReplyTo, MessageAttachment, InquiryMessage, UserProfile } from './types';
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
import { messagingService } from './services/messagingService';
import { artworkService } from './services/artworkService';
import { collectionService } from './services/collectionService';
import { catalogService } from './services/catalogService';
import { inquiryService } from './services/inquiryService';
import storageService from './services/storageService';

const App: React.FC = () => {
    const [currentView, setCurrentView] = useState<ViewState>('login');
    const [theme, setTheme] = useState<'light' | 'dark'>('light');
    const [isLoading, setIsLoading] = useState(true);
    const [selectedArtwork, setSelectedArtwork] = useState<Artwork | null>(null);

    // Global State
    const [artworks, setArtworks] = useState<Artwork[]>([]);
    const [catalogs, setCatalogs] = useState<Catalog[]>([]);
    const [collections, setCollections] = useState<Collection[]>([]);
    const [invoices, setInvoices] = useState<Invoice[]>([]);
    const [inquiries, setInquiries] = useState<Inquiry[]>([]);
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [allMessages, setAllMessages] = useState<Message[]>([]);
    const [inquiryMessages, setInquiryMessages] = useState<InquiryMessage[]>([]);
    const [teamMembers, setTeamMembers] = useState<UserProfile[]>([]);
    const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
    const [authUser, setAuthUser] = useState<AuthUser | null>(null);

    // Ref to access current authUser inside callbacks without adding it as a
    // dependency. This prevents the infinite loop that occurred when loadData
    // depended on [authUser] → init effect re-ran → getMe() → setAuthUser → ...
    const authUserRef = useRef<AuthUser | null>(null);

    // loadData takes isAuthenticated as a parameter instead of reading from
    // state/closure, so it has NO state dependencies and a stable reference.
    const loadData = useCallback(async (isAuthenticated: boolean) => {
        // Always load invoices from local DB (not cloud-synced)
        const loadedInvoices = await db.getInvoices();
        setInvoices(loadedInvoices);

        // Load artworks, conversations, messages, collections, catalogs,
        // inquiries & inquiry messages from D1 (cloud) when authenticated
        if (isAuthenticated) {
            try {
                const [
                    loadedArtworks, loadedConversations, loadedMessages,
                    loadedCollections, loadedCatalogs, loadedInquiries, loadedInquiryMessages
                ] = await Promise.all([
                    artworkService.getArtworks(),
                    messagingService.getConversations(),
                    messagingService.getMessages(),
                    collectionService.getCollections(),
                    catalogService.getCatalogs(),
                    inquiryService.getInquiries(),
                    inquiryService.getInquiryMessages(),
                ]);
                setArtworks(loadedArtworks);
                setConversations(loadedConversations);
                setAllMessages(loadedMessages);
                setCollections(loadedCollections);
                setCatalogs(loadedCatalogs);
                setInquiries(loadedInquiries);
                setInquiryMessages(loadedInquiryMessages);
                // Cache artworks locally for offline fallback
                for (const art of loadedArtworks) await db.saveArtwork(art);
            } catch (err) {
                console.error('Failed to load cloud data from D1:', err);
                // Fallback to local DB
                setArtworks(await db.getArtworks());
                setConversations(await db.getConversations());
                setAllMessages(await db.getMessages());
                setCollections(await db.getCollections());
                setCatalogs(await db.getCatalogs());
                setInquiries(await db.getInquiries());
                setInquiryMessages(await db.getInquiryMessages());
            }
        } else {
            // Not authenticated — load everything from local DB
            setArtworks(await db.getArtworks());
            setConversations(await db.getConversations());
            setAllMessages(await db.getMessages());
            setCollections(await db.getCollections());
            setCatalogs(await db.getCatalogs());
            setInquiries(await db.getInquiries());
            setInquiryMessages(await db.getInquiryMessages());
        }
    }, []);

    // Load team members from the auth service (Worker/KV) and map to UserProfile.
    // Also merges online presence so the messaging view shows live status.
    const loadTeamMembers = useCallback(async () => {
        try {
            const [team, presence] = await Promise.all([
                authService.getTeamMembers(),
                authService.getPresence().catch(() => ({})),
            ]);
            const presenceMap = presence as Record<string, { isOnline?: boolean; lastSeen?: number }>;
            const mapped: UserProfile[] = team.map(u => ({
                id: u.id,
                name: u.name,
                email: u.email,
                phone: '',
                address: '',
                isOnline: presenceMap[u.id]?.isOnline ?? false,
            }));
            setTeamMembers(mapped);
        } catch (err) {
            console.error('Failed to load team members:', err);
            setTeamMembers([]);
        }
    }, []);

    // One-time migration: push any local-only data to D1
    // Handles users who created data before D1 sync was implemented.
    // Returns true if any items were migrated (caller should reload).
    const migrateLocalToD1 = useCallback(async (): Promise<boolean> => {
        const MIGRATION_KEY = 'vayu_d1_migrated';
        if (localStorage.getItem(MIGRATION_KEY)) return false;

        try {
            const [
                localArtworks, localCatalogs, localCollections, localInquiries,
                localConversations, localMessages, localInquiryMessages
            ] = await Promise.all([
                db.getArtworks(), db.getCatalogs(), db.getCollections(), db.getInquiries(),
                db.getConversations(), db.getMessages(), db.getInquiryMessages(),
            ]);

            const [
                d1Artworks, d1Catalogs, d1Collections, d1Inquiries,
                d1Conversations, d1Messages, d1InquiryMessages
            ] = await Promise.all([
                artworkService.getArtworks(), catalogService.getCatalogs(),
                collectionService.getCollections(), inquiryService.getInquiries(),
                messagingService.getConversations(), messagingService.getMessages(),
                inquiryService.getInquiryMessages(),
            ]);

            const idSet = (arr: { id: string }[]) => new Set(arr.map(x => x.id));
            const d1ArtworkIds = idSet(d1Artworks);
            const d1CatalogIds = idSet(d1Catalogs);
            const d1CollectionIds = idSet(d1Collections);
            const d1InquiryIds = idSet(d1Inquiries);
            const d1ConvIds = idSet(d1Conversations);
            const d1MsgIds = idSet(d1Messages);
            const d1InqMsgIds = idSet(d1InquiryMessages);

            const migrations: Promise<unknown>[] = [];

            for (const art of localArtworks) {
                if (!d1ArtworkIds.has(art.id))
                    migrations.push(artworkService.saveArtwork(art).catch(e => console.error('Migration failed (artwork):', e)));
            }
            for (const cat of localCatalogs) {
                if (!d1CatalogIds.has(cat.id))
                    migrations.push(catalogService.saveCatalog(cat).catch(e => console.error('Migration failed (catalog):', e)));
            }
            for (const col of localCollections) {
                if (!d1CollectionIds.has(col.id))
                    migrations.push(collectionService.saveCollection(col).catch(e => console.error('Migration failed (collection):', e)));
            }
            for (const inq of localInquiries) {
                if (!d1InquiryIds.has(inq.id))
                    migrations.push(inquiryService.saveInquiry(inq).catch(e => console.error('Migration failed (inquiry):', e)));
            }
            for (const conv of localConversations) {
                if (!d1ConvIds.has(conv.id))
                    migrations.push(messagingService.createConversation(conv).catch(e => console.error('Migration failed (conversation):', e)));
            }
            for (const msg of localMessages) {
                if (!d1MsgIds.has(msg.id))
                    migrations.push(messagingService.sendMessage(msg).catch(e => console.error('Migration failed (message):', e)));
            }
            for (const inqMsg of localInquiryMessages) {
                if (!d1InqMsgIds.has(inqMsg.id))
                    migrations.push(inquiryService.saveInquiryMessage(inqMsg).catch(e => console.error('Migration failed (inquiry message):', e)));
            }

            if (migrations.length > 0) {
                console.log(`D1 migration: pushing ${migrations.length} local-only items to D1...`);
                await Promise.all(migrations);
            }
            localStorage.setItem(MIGRATION_KEY, 'true');
            console.log('D1 migration complete');
            return migrations.length > 0;
        } catch (err) {
            console.error('D1 migration failed:', err);
            return false;
        }
    }, []);

    // Initialize DB and load data — runs ONCE on mount (empty deps)
    useEffect(() => {
        const initApp = async () => {
            try {
                await db.init();

                // Check for existing auth token
                const me = await authService.getMe();
                if (me) {
                    authUserRef.current = me;
                    setAuthUser(me);
                    const savedTheme = (localStorage.getItem('vayu_theme') as 'light' | 'dark') || 'light';
                    const profile: UserProfile = {
                        id: me.id,
                        name: me.name,
                        email: me.email,
                        phone: '',
                        address: '',
                        theme: savedTheme,
                    };
                    setUserProfile(profile);
                    setTheme(savedTheme);
                    setCurrentView('home');
                    window.history.pushState({ view: 'home' }, '');

                    // Authenticated — run one-time migration then load from D1
                    const migrated = await migrateLocalToD1();
                    await loadData(true);
                    await loadTeamMembers();
                    if (migrated) {
                        // Re-load after migration to pick up pushed items
                        await loadData(true);
                    }
                } else {
                    window.history.pushState({ view: 'login' }, '');
                    // Not authenticated — load local data only
                    await loadData(false);
                }
            } catch (err) {
                console.error('App initialization error:', err);
                // On error, still load local data so the app is usable
                await loadData(false);
            } finally {
                setIsLoading(false);
            }
        };
        initApp();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Handle Browser/Phone Back Button
    useEffect(() => {
        const handlePopState = (event: PopStateEvent) => {
            // If an artwork is selected, close it first
            if (selectedArtwork) {
                setSelectedArtwork(null);
                // Push the current view back to history so we don't actually go back
                window.history.pushState({ view: currentView }, '');
                return;
            }

            // If we are not on home or login, go back to home
            if (currentView !== 'home' && currentView !== 'login') {
                setCurrentView('home');
                // Push home to history
                window.history.pushState({ view: 'home' }, '');
                return;
            }
        };

        window.addEventListener('popstate', handlePopState);
        return () => window.removeEventListener('popstate', handlePopState);
    }, [currentView, selectedArtwork]);

    // Custom navigation handler to manage history
    const navigateTo = (view: ViewState) => {
        setCurrentView(view);
        window.history.pushState({ view }, '');
    };

    // Presence heartbeat: ping the backend every 30 seconds so the admin
    // presence panel can show who's currently online. Also marks offline
    // when the tab is closed or the user navigates away.
    useEffect(() => {
        if (!authUser) return;
        let cancelled = false;

        const beat = async () => {
            if (cancelled) return;
            try { await authService.heartbeat(); } catch { /* silent */ }
        };
        beat();
        const interval = setInterval(beat, 30000);

        const onUnload = () => { authService.setOffline(); };
        window.addEventListener('beforeunload', onUnload);

        return () => {
            cancelled = true;
            clearInterval(interval);
            window.removeEventListener('beforeunload', onUnload);
            authService.setOffline();
        };
    }, [authUser]);

    // Listen for Cloud Sync events (BroadcastChannel)
    useEffect(() => {
        const channel = new BroadcastChannel('vayu_cloud_sync');
        channel.onmessage = (event) => {
            if (event.data.type === 'SYNC_REQUIRED') {
                console.log('Cloud sync triggered, reloading data...');
                loadData(!!authUserRef.current);
                loadTeamMembers();
            }
        };
        return () => channel.close();
    }, [loadData, loadTeamMembers]);

    // ── Polling: fetch conversations & messages from D1 every 15 seconds ──
    // This enables near-real-time messaging across devices/browsers.
    // Uses authUserRef to avoid re-creating the interval on every authUser change.
    useEffect(() => {
        if (!authUser) return;
        let cancelled = false;

        const poll = async () => {
            if (cancelled) return;
            try {
                const remoteConversations = await messagingService.getConversations();
                const remoteMessages = await messagingService.getMessages();
                if (!cancelled) {
                    setConversations(remoteConversations);
                    setAllMessages(remoteMessages);
                }
            } catch (err) {
                // Silent fail — will retry next poll cycle
            }
        };

        poll(); // Initial fetch
        const interval = setInterval(poll, 15000);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [authUser]);

    // ── Polling: fetch inquiry messages from D1 every 15 seconds ──
    // This enables near-real-time inquiry chat across devices/browsers.
    useEffect(() => {
        if (!authUser) return;
        let cancelled = false;

        const pollInquiry = async () => {
            if (cancelled) return;
            try {
                const remoteInquiryMessages = await inquiryService.getInquiryMessages();
                if (!cancelled) {
                    setInquiryMessages(remoteInquiryMessages);
                }
            } catch (err) {
                // Silent fail — will retry next poll cycle
            }
        };

        pollInquiry(); // Initial fetch
        const interval = setInterval(pollInquiry, 15000);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [authUser]);

    // ── Polling: fetch collections, catalogs & inquiries from D1 every 15s ──
    // This enables cross-device sync for these entities (no real-time needed,
    // but polling ensures new items created on other devices appear quickly).
    useEffect(() => {
        if (!authUser) return;
        let cancelled = false;

        const pollEntities = async () => {
            if (cancelled) return;
            try {
                const [remoteArtworks, remoteCollections, remoteCatalogs, remoteInquiries] = await Promise.all([
                    artworkService.getArtworks(),
                    collectionService.getCollections(),
                    catalogService.getCatalogs(),
                    inquiryService.getInquiries(),
                ]);
                if (!cancelled) {
                    setArtworks(remoteArtworks);
                    setCollections(remoteCollections);
                    setCatalogs(remoteCatalogs);
                    setInquiries(remoteInquiries);
                }
            } catch (err) {
                // Silent fail — will retry next poll cycle
            }
        };

        pollEntities(); // Initial fetch
        const interval = setInterval(pollEntities, 15000);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [authUser]);

    // Apply Theme
    useEffect(() => {
        if (theme === 'dark') {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
    }, [theme]);

    // Handlers
    const handleLogin = async (user: AuthUser) => {
        authUserRef.current = user;
        setAuthUser(user);
        const savedTheme = (localStorage.getItem('vayu_theme') as 'light' | 'dark') || 'light';
        const profile: UserProfile = {
            id: user.id,
            name: user.name,
            email: user.email,
            phone: '',
            address: '',
            theme: savedTheme,
        };
        setUserProfile(profile);
        setTheme(savedTheme);
        navigateTo('home');
        // Run one-time migration then load team members & cloud data
        const migrated = await migrateLocalToD1();
        await loadTeamMembers();
        await loadData(true);
        if (migrated) {
            // Re-load after migration to pick up pushed items
            await loadData(true);
        }
    };

    const handleUpdateProfile = async (updatedProfile: UserProfile) => {
        setUserProfile(updatedProfile);
        await db.saveUser(updatedProfile);
    };

    const handleToggleTheme = async () => {
        const newTheme: 'light' | 'dark' = theme === 'light' ? 'dark' : 'light';
        setTheme(newTheme);
        if (userProfile) {
            const updated = { ...userProfile, theme: newTheme };
            setUserProfile(updated);
            await db.saveUser(updated);
        }
    };

    const handleAddArtwork = async (newArt: Omit<Artwork, 'id' | 'createdAt'>) => {
        const artwork: Artwork = {
            ...newArt,
            id: `art_${Date.now()}`,
            createdAt: Date.now(),
        };
        // Save to D1 (cloud) and cache locally
        try { await artworkService.saveArtwork(artwork); } catch (e) { console.error('D1 sync failed (add artwork):', e); }
        await db.saveArtwork(artwork);
        setArtworks((prev: Artwork[]) => [artwork, ...prev]);
    };

    const handleUpdateArtwork = async (updatedArt: Artwork) => {
        // Sync to D1 (cloud) and update local cache
        try { await artworkService.updateArtwork(updatedArt); } catch (e) { console.error('D1 sync failed (update artwork):', e); }
        await db.saveArtwork(updatedArt);
        setArtworks((prev: Artwork[]) => prev.map((a: Artwork) => a.id === updatedArt.id ? updatedArt : a));
        if (selectedArtwork?.id === updatedArt.id) {
            setSelectedArtwork(updatedArt);
        }
    };

    const handleDeleteArtwork = async (id: string) => {
        // Delete from D1 (worker also cleans up associated R2 images)
        try { await artworkService.deleteArtwork(id); } catch (e) { console.error('D1 sync failed (delete artwork):', e); }
        await db.deleteArtwork(id);
        setArtworks((prev: Artwork[]) => prev.filter((a: Artwork) => a.id !== id));
        if (selectedArtwork?.id === id) {
            setSelectedArtwork(null);
        }
    };

    const handleAddCatalog = async (newCat: Omit<Catalog, 'id' | 'createdAt'>) => {
        const catalog: Catalog = {
            ...newCat,
            id: `cat_${Date.now()}`,
            createdAt: Date.now(),
        };
        try { await catalogService.saveCatalog(catalog); } catch (e) { console.error('D1 sync failed (add catalog):', e); }
        await db.saveCatalog(catalog);
        setCatalogs((prev: Catalog[]) => [catalog, ...prev]);
    };

    const handleUpdateCatalog = async (updatedCat: Catalog) => {
        try { await catalogService.updateCatalog(updatedCat); } catch (e) { console.error('D1 sync failed (update catalog):', e); }
        await db.saveCatalog(updatedCat);
        setCatalogs((prev: Catalog[]) => prev.map((c: Catalog) => c.id === updatedCat.id ? updatedCat : c));
    };

    const handleDeleteCatalog = async (id: string) => {
        try { await catalogService.deleteCatalog(id); } catch (e) { console.error('D1 sync failed (delete catalog):', e); }
        await db.deleteCatalog(id);
        setCatalogs((prev: Catalog[]) => prev.filter((c: Catalog) => c.id !== id));
    };

    const handleAddCollection = async (newCol: Omit<Collection, 'id'>) => {
        const collection: Collection = {
            ...newCol,
            id: `col_${Date.now()}`
        };
        try { await collectionService.saveCollection(collection); } catch (e) { console.error('D1 sync failed (add collection):', e); }
        await db.saveCollection(collection);
        setCollections((prev: Collection[]) => [collection, ...prev]);
    };

    const handleUpdateCollection = async (updatedCol: Collection) => {
        try { await collectionService.updateCollection(updatedCol); } catch (e) { console.error('D1 sync failed (update collection):', e); }
        await db.saveCollection(updatedCol);
        setCollections((prev: Collection[]) => prev.map((c: Collection) => c.id === updatedCol.id ? updatedCol : c));
    };

    const handleDeleteCollection = async (id: string) => {
        try { await collectionService.deleteCollection(id); } catch (e) { console.error('D1 sync failed (delete collection):', e); }
        await db.deleteCollection(id);
        setCollections((prev: Collection[]) => prev.filter((c: Collection) => c.id !== id));
    };

    const handleAddInvoice = async (newInv: Omit<Invoice, 'id' | 'date'>) => {
        const invoice: Invoice = {
            ...newInv,
            id: `inv_${Date.now()}`,
            date: Date.now(),
        };
        await db.saveInvoice(invoice);
        setInvoices((prev: Invoice[]) => [invoice, ...prev]);

        const invoicedArtIds = new Set(invoice.items.map(item => item.artworkId));

        // Update artwork status in D1, local DB, and state
        const updatedArtworks = artworks.map(art => {
            if (invoicedArtIds.has(art.id)) {
                const updatedArt = { ...art, status: 'Sold' as const };
                artworkService.updateArtwork(updatedArt).catch(e => console.error('D1 sync failed (invoice artwork status):', e));
                db.saveArtwork(updatedArt); // Fire and forget
                return updatedArt;
            }
            return art;
        });
        setArtworks(updatedArtworks);
    };

    const handleUpdateInvoice = async (updatedInv: Invoice) => {
        await db.saveInvoice(updatedInv);
        setInvoices((prev: Invoice[]) => prev.map((i: Invoice) => i.id === updatedInv.id ? updatedInv : i));
    };

    const handleDeleteInvoice = async (id: string) => {
        await db.deleteInvoice(id);
        setInvoices((prev: Invoice[]) => prev.filter((i: Invoice) => i.id !== id));
    };

    const handleAddInquiry = async (newInq: Omit<Inquiry, 'id' | 'date'>) => {
        const inquiry: Inquiry = {
            ...newInq,
            id: `inq_${Date.now()}`,
            date: Date.now(),
        };
        try { await inquiryService.saveInquiry(inquiry); } catch (e) { console.error('D1 sync failed (add inquiry):', e); }
        await db.saveInquiry(inquiry);
        setInquiries((prev: Inquiry[]) => [inquiry, ...prev]);
    };

    const handleUpdateInquiry = async (updatedInq: Inquiry) => {
        try { await inquiryService.updateInquiry(updatedInq); } catch (e) { console.error('D1 sync failed (update inquiry):', e); }
        await db.saveInquiry(updatedInq);
        setInquiries((prev: Inquiry[]) => prev.map((i: Inquiry) => i.id === updatedInq.id ? updatedInq : i));
    };

    const handleDeleteInquiry = async (id: string) => {
        try { await inquiryService.deleteInquiry(id); } catch (e) { console.error('D1 sync failed (delete inquiry):', e); }
        await db.deleteInquiry(id);
        setInquiries((prev: Inquiry[]) => prev.filter((i: Inquiry) => i.id !== id));
    };

    const handleSendInquiryMessage = async (inquiryId: string, text: string, tags: MessageTag[], replyTo?: MessageReplyTo, attachment?: MessageAttachment) => {
        const msg: InquiryMessage = {
            id: `inqmsg_${Date.now()}`,
            inquiryId,
            senderId: userProfile?.id || authUser?.id || '',
            senderName: userProfile?.name || authUser?.name || 'You',
            text,
            tags,
            timestamp: Date.now(),
            status: 'sent',
            replyTo,
            attachment,
        };
        // Save to D1 (cloud) and cache locally
        try { await inquiryService.saveInquiryMessage(msg); } catch (e) { console.error('D1 sync failed (inquiry message):', e); }
        await db.saveInquiryMessage(msg);
        setInquiryMessages((prev: InquiryMessage[]) => [...prev, msg]);

        // Simulate delivery + read receipts
        setTimeout(() => {
            setInquiryMessages((prev: InquiryMessage[]) => prev.map(m => m.id === msg.id ? { ...m, status: 'delivered' } : m));
        }, 700);
        setTimeout(() => {
            setInquiryMessages((prev: InquiryMessage[]) => prev.map(m => m.id === msg.id ? { ...m, status: 'read' } : m));
        }, 2200);
    };

    const handleLogout = async () => {
        await authService.logout();
        authUserRef.current = null;
        setAuthUser(null);
        setUserProfile(null);
        navigateTo('login');
    };

    const handleArtworkClick = (artwork: Artwork) => {
        setSelectedArtwork(artwork);
        window.history.pushState({ view: currentView, modal: 'artwork' }, '');
    };

    const handleCloseArtwork = () => {
        setSelectedArtwork(null);
    };

    const handleSendMessage = async (conversationId: string, text: string, tags: MessageTag[], replyTo?: MessageReplyTo, attachment?: MessageAttachment) => {
        const msg: Message = {
            id: `msg_${Date.now()}`,
            conversationId,
            senderId: userProfile?.id || authUser?.id || '',
            senderName: userProfile?.name || authUser?.name || 'You',
            text,
            tags,
            timestamp: Date.now(),
            status: 'sent',
            replyTo,
            attachment,
        };
        // Save to D1 (cloud) — the worker also updates conversation's last message
        try {
            await messagingService.sendMessage(msg);
        } catch (err) {
            console.error('Failed to send message to D1:', err);
        }
        // Also cache locally for offline/fallback
        await db.saveMessage(msg);
        setAllMessages((prev: Message[]) => [...prev, msg]);

        // Simulate delivery + read receipts
        setTimeout(() => {
            setAllMessages((prev: Message[]) => prev.map(m => m.id === msg.id ? { ...m, status: 'delivered' } : m));
        }, 700);
        setTimeout(() => {
            setAllMessages((prev: Message[]) => prev.map(m => m.id === msg.id ? { ...m, status: 'read' } : m));
        }, 2200);

        // Update conversation's last message
        const conv = conversations.find(c => c.id === conversationId);
        if (conv) {
            const lastMessagePreview = attachment ? (attachment.type === 'image' ? '📷 Photo' : `📎 ${attachment.name}`) : text;
            const updatedConv = { ...conv, lastMessage: lastMessagePreview, lastMessageTime: Date.now(), unreadCount: 0 };
            await db.saveConversation(updatedConv);
            setConversations((prev: Conversation[]) => prev.map(c => c.id === conversationId ? updatedConv : c).sort((a, b) => b.lastMessageTime - a.lastMessageTime));
        }
    };

    const handleTogglePinConversation = async (conversationId: string) => {
        const conv = conversations.find(c => c.id === conversationId);
        if (!conv) return;
        const updatedConv = { ...conv, isPinned: !conv.isPinned };
        try { await messagingService.updateConversation(updatedConv); } catch (e) { console.error('D1 sync failed (pin):', e); }
        await db.saveConversation(updatedConv);
        setConversations((prev: Conversation[]) => prev.map(c => c.id === conversationId ? updatedConv : c));
    };

    const handleToggleArchiveConversation = async (conversationId: string) => {
        const conv = conversations.find(c => c.id === conversationId);
        if (!conv) return;
        const updatedConv = { ...conv, isArchived: !conv.isArchived };
        try { await messagingService.updateConversation(updatedConv); } catch (e) { console.error('D1 sync failed (archive):', e); }
        await db.saveConversation(updatedConv);
        setConversations((prev: Conversation[]) => prev.map(c => c.id === conversationId ? updatedConv : c));
    };

    const handleCreateConversation = async (participantId: string, details?: ConversationDetails): Promise<Conversation> => {
        // Check if conversation already exists
        const selfId = userProfile?.id || authUser?.id || '';
        const existing = conversations.find(c => c.participantIds.includes(participantId) && c.participantIds.includes(selfId));
        if (existing) return existing;

        const otherMember = teamMembers.find(m => m.id === participantId);
        const conv: Conversation = {
            id: `conv_${Date.now()}`,
            participantIds: [selfId, participantId],
            participantNames: [userProfile?.name || authUser?.name || 'You', otherMember?.name || 'Team Member'],
            lastMessage: '',
            lastMessageTime: Date.now(),
            unreadCount: 0,
            title: details?.title,
            reason: details?.reason,
            note: details?.note,
        };
        try { await messagingService.createConversation(conv); } catch (e) { console.error('D1 sync failed (create conversation):', e); }
        await db.saveConversation(conv);
        setConversations((prev: Conversation[]) => [conv, ...prev]);
        return conv;
    };

    const handleCreateGroup = async (participantIds: string[], groupName: string): Promise<Conversation> => {
        const selfId = userProfile?.id || authUser?.id || '';
        const allParticipantIds = Array.from(new Set([selfId, ...participantIds]));
        const allParticipantNames = allParticipantIds.map(id =>
            id === selfId ? (userProfile?.name || authUser?.name || 'You') : (teamMembers.find(m => m.id === id)?.name || 'Team Member')
        );
        const conv: Conversation = {
            id: `conv_${Date.now()}`,
            participantIds: allParticipantIds,
            participantNames: allParticipantNames,
            lastMessage: '',
            lastMessageTime: Date.now(),
            unreadCount: 0,
            isGroup: true,
            groupName,
        };
        try { await messagingService.createConversation(conv); } catch (e) { console.error('D1 sync failed (create group):', e); }
        await db.saveConversation(conv);
        setConversations((prev: Conversation[]) => [conv, ...prev]);
        return conv;
    };

    const handleUpdateConversationDetails = async (conversationId: string, details: ConversationDetails) => {
        const conv = conversations.find(c => c.id === conversationId);
        if (!conv) return;
        const updatedConv = { ...conv, ...details };
        try { await messagingService.updateConversation(updatedConv); } catch (e) { console.error('D1 sync failed (update details):', e); }
        await db.saveConversation(updatedConv);
        setConversations((prev: Conversation[]) => prev.map(c => c.id === conversationId ? updatedConv : c));
    };

    // Update a group conversation's name and participants (admin feature)
    const handleUpdateGroup = async (conversationId: string, groupName: string, participantIds: string[]) => {
        const conv = conversations.find(c => c.id === conversationId);
        if (!conv) return;
        const selfId = userProfile?.id || authUser?.id || '';
        const allIds = Array.from(new Set([selfId, ...participantIds]));
        const allNames = allIds.map(id =>
            id === selfId ? (userProfile?.name || authUser?.name || 'You') : (teamMembers.find(m => m.id === id)?.name || 'Team Member')
        );
        const updatedConv: Conversation = { ...conv, groupName, participantIds: allIds, participantNames: allNames, isGroup: true };
        try { await messagingService.updateConversation(updatedConv); } catch (e) { console.error('D1 sync failed (update group):', e); }
        await db.saveConversation(updatedConv);
        setConversations((prev: Conversation[]) => prev.map(c => c.id === conversationId ? updatedConv : c));
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
                return <ArtworksView artworks={artworks} onAddArtwork={handleAddArtwork} onArtworkClick={handleArtworkClick} />;
            case 'collections':
                return <CollectionsView collections={collections} artworks={artworks} onAddCollection={handleAddCollection} onUpdateCollection={handleUpdateCollection} onDeleteCollection={handleDeleteCollection} onArtworkClick={handleArtworkClick} />;
            case 'catalogs':
                return <CatalogsView catalogs={catalogs} artworks={artworks} onAddCatalog={handleAddCatalog} onUpdateCatalog={handleUpdateCatalog} onDeleteCatalog={handleDeleteCatalog} onArtworkClick={handleArtworkClick} />;
            case 'invoice':
                return <InvoiceView invoices={invoices} artworks={artworks} onAddInvoice={handleAddInvoice} onUpdateInvoice={handleUpdateInvoice} onDeleteInvoice={handleDeleteInvoice} onArtworkClick={handleArtworkClick} />;
            case 'inquiry':
                return (
                    <InquiryView
                        inquiries={inquiries}
                        artworks={artworks}
                        onAddInquiry={handleAddInquiry}
                        onUpdateInquiry={handleUpdateInquiry}
                        onDeleteInquiry={handleDeleteInquiry}
                        onArtworkClick={handleArtworkClick}
                        inquiryMessages={inquiryMessages}
                        currentUserId={userProfile?.id || authUser?.id || ''}
                        currentUserName={userProfile?.name || authUser?.name || 'You'}
                        onSendInquiryMessage={handleSendInquiryMessage}
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
                        onSendMessage={handleSendMessage}
                        onCreateConversation={handleCreateConversation}
                        onCreateGroup={handleCreateGroup}
                        onUpdateConversationDetails={handleUpdateConversationDetails}
                        onUpdateGroup={handleUpdateGroup}
                        onTogglePinConversation={handleTogglePinConversation}
                        onToggleArchiveConversation={handleToggleArchiveConversation}
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
                        onLogout={handleLogout}
                    />
                ) : null;
            default:
                return <LoginView onLogin={handleLogin} />;
        }
    };

    return (
        <Layout currentView={currentView} onNavigate={navigateTo} userProfile={authUser} onShowActivity={() => navigateTo('activity')}>
            {renderView()}
            {selectedArtwork && (
                <ArtworkDetailView artwork={selectedArtwork} onClose={handleCloseArtwork} onUpdateArtwork={handleUpdateArtwork} onDeleteArtwork={handleDeleteArtwork} />
            )}
        </Layout>
    );
};

export default App;