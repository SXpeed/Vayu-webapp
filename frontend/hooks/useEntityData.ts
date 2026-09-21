import { useState, useCallback, useEffect, useRef } from 'react';
import { Artwork, CalendarEvent, Catalog, Collection, Contact, Invoice, Inquiry, Conversation, Message, InquiryMessage, UserProfile } from '../types';
import { db } from '../services/db';
import { messagingService } from '../services/messagingService';
import { artworkService } from '../services/artworkService';
import { collectionService } from '../services/collectionService';
import { catalogService } from '../services/catalogService';
import { inquiryService } from '../services/inquiryService';
import { eventService } from '../services/eventService';
import { contactService } from '../services/contactService';
import { authService, AuthUser } from '../services/authService';
import { makeCan, permissionsOf } from '../access';
import type { SectionId } from '../permissions';

type Dataset = 'artworks' | 'messages' | 'collections' | 'catalogs' | 'inquiries' | 'events' | 'contacts';

/**
 * Sections whose screens read each dataset. Mirrors accessRule's
 * `readableBy` in worker.ts, so the app never asks for data the server
 * would refuse.
 */
const DATASET_READERS: Record<Dataset, SectionId[]> = {
    artworks: ['inventory', 'collections', 'catalogs', 'inquiries', 'invoices'],
    messages: ['messages'],
    collections: ['collections'],
    catalogs: ['catalogs'],
    inquiries: ['inquiries'],
    events: ['calendar'],
    contacts: ['contacts', 'inquiries', 'invoices', 'payments'],
};

/** Run `load` only when allowed; otherwise an empty list. */
const whenAllowed = <T,>(allowed: boolean, load: () => Promise<T[]>): Promise<T[]> =>
    allowed ? load() : Promise.resolve([]);

/**
 * Manages all entity state (artworks, catalogs, collections, invoices,
 * inquiries, conversations, messages, inquiryMessages, teamMembers),
 * loadData, D1 migration, BroadcastChannel sync, and polling effects.
 */
export function useEntityData(authUser: AuthUser | null, authUserRef: React.RefObject<AuthUser | null>) {
    const [artworks, setArtworks] = useState<Artwork[]>([]);
    const [catalogs, setCatalogs] = useState<Catalog[]>([]);
    const [collections, setCollections] = useState<Collection[]>([]);
    const [invoices, setInvoices] = useState<Invoice[]>([]);
    const [inquiries, setInquiries] = useState<Inquiry[]>([]);
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [allMessages, setAllMessages] = useState<Message[]>([]);
    const [inquiryMessages, setInquiryMessages] = useState<InquiryMessage[]>([]);
    const [teamMembers, setTeamMembers] = useState<UserProfile[]>([]);
    const [events, setEvents] = useState<CalendarEvent[]>([]);
    const [contacts, setContacts] = useState<Contact[]>([]);

    // Serialized snapshot of the last payload applied per entity key. Polling
    // compares against this and skips setState when nothing changed, so the
    // app doesn't re-render every poll tick.
    const lastPayloads = useRef<Record<string, string>>({});
    const applyIfChanged = useCallback(<T,>(key: string, data: T, setter: (value: T) => void) => {
        const serialized = JSON.stringify(data);
        if (lastPayloads.current[key] === serialized) return;
        lastPayloads.current[key] = serialized;
        setter(data);
    }, []);

    /** Server messages, plus any of ours it never accepted, so a failed
     *  message stays on screen (marked "Not sent") instead of vanishing. */
    const keepFailed = useCallback((remote: Message[]) => {
        setAllMessages(prev => {
            const ids = new Set(remote.map(m => m.id));
            const failed = prev.filter(m => m.status === 'failed' && !ids.has(m.id));
            return failed.length ? [...remote, ...failed] : remote;
        });
    }, []);

    /** Can the signed-in person's role read this dataset? Read at call time from the ref. */
    const canReadData = useCallback((dataset: Dataset): boolean => {
        const can = makeCan(permissionsOf(authUserRef.current));
        return DATASET_READERS[dataset].some(section => can(section, 'view'));
    }, [authUserRef]);

    // loadData takes isAuthenticated as a parameter instead of reading from
    // state/closure, so it has NO state dependencies and a stable reference.
    const loadData = useCallback(async (isAuthenticated: boolean) => {
        const loadedInvoices = await db.getInvoices();
        setInvoices(loadedInvoices);

        if (isAuthenticated) {
            try {
                const [
                    loadedArtworks, loadedConversations, loadedMessages,
                    loadedCollections, loadedCatalogs, loadedInquiries, loadedInquiryMessages,
                    loadedEvents, loadedContacts
                ] = await Promise.all([
                    // Only what this role may read (same rules as the server);
                    // the rest resolve empty instead of failing the whole load.
                    whenAllowed(canReadData('artworks'), () => artworkService.getArtworks()),
                    whenAllowed(canReadData('messages'), () => messagingService.getConversations()),
                    whenAllowed(canReadData('messages'), () => messagingService.getMessages()),
                    whenAllowed(canReadData('collections'), () => collectionService.getCollections()),
                    whenAllowed(canReadData('catalogs'), () => catalogService.getCatalogs()),
                    whenAllowed(canReadData('inquiries'), () => inquiryService.getInquiries()),
                    whenAllowed(canReadData('inquiries'), () => inquiryService.getInquiryMessages()),
                    whenAllowed(canReadData('events'), () => eventService.getEvents()),
                    whenAllowed(canReadData('contacts'), () => contactService.getContacts()),
                ]);
                applyIfChanged('artworks', loadedArtworks, setArtworks);
                applyIfChanged('conversations', loadedConversations, setConversations);
                applyIfChanged('messages', loadedMessages, keepFailed);
                applyIfChanged('collections', loadedCollections, setCollections);
                applyIfChanged('catalogs', loadedCatalogs, setCatalogs);
                applyIfChanged('events', loadedEvents, setEvents);
                applyIfChanged('contacts', loadedContacts, setContacts);
                applyIfChanged('inquiries', loadedInquiries, setInquiries);
                applyIfChanged('inquiryMessages', loadedInquiryMessages, setInquiryMessages);
                for (const art of loadedArtworks) await db.saveArtwork(art);
            } catch (err) {
                console.error('Failed to load cloud data from D1:', err);
                setArtworks(await db.getArtworks());
                setConversations(await db.getConversations());
                setAllMessages(await db.getMessages());
                setCollections(await db.getCollections());
                setCatalogs(await db.getCatalogs());
                setInquiries(await db.getInquiries());
                setInquiryMessages(await db.getInquiryMessages());
            }
        } else {
            setArtworks(await db.getArtworks());
            setConversations(await db.getConversations());
            setAllMessages(await db.getMessages());
            setCollections(await db.getCollections());
            setCatalogs(await db.getCatalogs());
            setInquiries(await db.getInquiries());
            setInquiryMessages(await db.getInquiryMessages());
        }
    }, [applyIfChanged, canReadData, keepFailed]);

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

    // Helper: collect local-only items and schedule their push to D1
    const collectMigrations = <T extends { id: string }>(
        localItems: T[],
        d1Ids: Set<string>,
        saveFn: (item: T) => Promise<unknown>,
        label: string,
        migrations: Promise<unknown>[],
    ) => {
        for (const item of localItems) {
            if (!d1Ids.has(item.id)) {
                migrations.push(
                    saveFn(item).catch(e => console.error(`Migration failed (${label}):`, e))
                );
            }
        }
    };

    // One-time migration: push any local-only data to D1
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

            // Only sections this role can edit: migrating writes to them.
            const can = makeCan(permissionsOf(authUserRef.current));
            const [
                d1Artworks, d1Catalogs, d1Collections, d1Inquiries,
                d1Conversations, d1Messages, d1InquiryMessages
            ] = await Promise.all([
                whenAllowed(can('inventory', 'edit'), () => artworkService.getArtworks()),
                whenAllowed(can('catalogs', 'edit'), () => catalogService.getCatalogs()),
                whenAllowed(can('collections', 'edit'), () => collectionService.getCollections()),
                whenAllowed(can('inquiries', 'edit'), () => inquiryService.getInquiries()),
                whenAllowed(can('messages', 'edit'), () => messagingService.getConversations()),
                whenAllowed(can('messages', 'edit'), () => messagingService.getMessages()),
                whenAllowed(can('inquiries', 'edit'), () => inquiryService.getInquiryMessages()),
            ]);

            const idSet = (arr: { id: string }[]) => new Set(arr.map(x => x.id));
            const migrations: Promise<unknown>[] = [];

            const only = <T,>(allowed: boolean, items: T[]) => (allowed ? items : []);
            collectMigrations(only(can('inventory', 'edit'), localArtworks), idSet(d1Artworks), artworkService.saveArtwork, 'artwork', migrations);
            collectMigrations(only(can('catalogs', 'edit'), localCatalogs), idSet(d1Catalogs), catalogService.saveCatalog, 'catalog', migrations);
            collectMigrations(only(can('collections', 'edit'), localCollections), idSet(d1Collections), collectionService.saveCollection, 'collection', migrations);
            collectMigrations(only(can('inquiries', 'edit'), localInquiries), idSet(d1Inquiries), inquiryService.saveInquiry, 'inquiry', migrations);
            collectMigrations(only(can('messages', 'edit'), localConversations), idSet(d1Conversations), messagingService.createConversation, 'conversation', migrations);
            collectMigrations(only(can('messages', 'edit'), localMessages), idSet(d1Messages), messagingService.sendMessage, 'message', migrations);
            collectMigrations(only(can('inquiries', 'edit'), localInquiryMessages), idSet(d1InquiryMessages), inquiryService.saveInquiryMessage, 'inquiry message', migrations);

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
    }, [loadData, loadTeamMembers, authUserRef]);

    // Polling: conversations & messages every 15 seconds.
    // Skips work while the tab is hidden and re-polls immediately when it
    // becomes visible again; setState only fires when the payload changed.
    useEffect(() => {
        if (!authUser) return;
        let cancelled = false;

        const poll = async () => {
            if (cancelled || document.visibilityState === 'hidden') return;
            if (!canReadData('messages')) return;
            try {
                const [remoteConversations, remoteMessages] = await Promise.all([
                    messagingService.getConversations(),
                    messagingService.getMessages(),
                ]);
                if (!cancelled) {
                    applyIfChanged('conversations', remoteConversations, setConversations);
                    applyIfChanged('messages', remoteMessages, keepFailed);
                }
            } catch (err) {
                console.warn('Failed to poll messages:', err);
            }
        };

        poll();
        const interval = setInterval(poll, 15000);
        const onVisibilityChange = () => {
            if (document.visibilityState === 'visible') poll();
        };
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => {
            cancelled = true;
            clearInterval(interval);
            document.removeEventListener('visibilitychange', onVisibilityChange);
        };
    }, [authUser, applyIfChanged, canReadData, keepFailed]);

    // Polling: inquiry messages every 15 seconds
    useEffect(() => {
        if (!authUser) return;
        let cancelled = false;

        const pollInquiry = async () => {
            if (cancelled || document.visibilityState === 'hidden') return;
            try {
                const remoteInquiryMessages = await inquiryService.getInquiryMessages();
                if (!cancelled) {
                    applyIfChanged('inquiryMessages', remoteInquiryMessages, setInquiryMessages);
                }
            } catch (err) {
                console.warn('Failed to poll inquiry messages:', err);
            }
        };

        pollInquiry();
        const interval = setInterval(pollInquiry, 15000);
        const onVisibilityChange = () => {
            if (document.visibilityState === 'visible') pollInquiry();
        };
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => {
            cancelled = true;
            clearInterval(interval);
            document.removeEventListener('visibilitychange', onVisibilityChange);
        };
    }, [authUser, applyIfChanged]);

    // Polling: artworks, collections, catalogs & inquiries every 15 seconds
    useEffect(() => {
        if (!authUser) return;
        let cancelled = false;

        const pollEntities = async () => {
            if (cancelled || document.visibilityState === 'hidden') return;
            try {
                // Only what this role may read — one refused section used to
                // fail the whole poll, so nothing refreshed at all.
                const [remoteArtworks, remoteCollections, remoteCatalogs, remoteInquiries, remoteEvents, remoteContacts] = await Promise.all([
                    whenAllowed(canReadData('artworks'), () => artworkService.getArtworks()),
                    whenAllowed(canReadData('collections'), () => collectionService.getCollections()),
                    whenAllowed(canReadData('catalogs'), () => catalogService.getCatalogs()),
                    whenAllowed(canReadData('inquiries'), () => inquiryService.getInquiries()),
                    whenAllowed(canReadData('events'), () => eventService.getEvents()),
                    whenAllowed(canReadData('contacts'), () => contactService.getContacts()),
                ]);
                if (!cancelled) {
                    applyIfChanged('artworks', remoteArtworks, setArtworks);
                    applyIfChanged('collections', remoteCollections, setCollections);
                    applyIfChanged('catalogs', remoteCatalogs, setCatalogs);
                    applyIfChanged('inquiries', remoteInquiries, setInquiries);
                    applyIfChanged('events', remoteEvents, setEvents);
                    applyIfChanged('contacts', remoteContacts, setContacts);
                }
            } catch (err) {
                console.warn('Failed to poll entities:', err);
            }
        };

        pollEntities();
        const interval = setInterval(pollEntities, 15000);
        const onVisibilityChange = () => {
            if (document.visibilityState === 'visible') pollEntities();
        };
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => {
            cancelled = true;
            clearInterval(interval);
            document.removeEventListener('visibilitychange', onVisibilityChange);
        };
    }, [authUser, applyIfChanged, canReadData]);

    return {
        artworks, setArtworks,
        catalogs, setCatalogs,
        collections, setCollections,
        invoices, setInvoices,
        inquiries, setInquiries,
        conversations, setConversations,
        allMessages, setAllMessages,
        inquiryMessages, setInquiryMessages,
        teamMembers, setTeamMembers,
        events, setEvents,
        contacts, setContacts,
        loadData,
        loadTeamMembers,
        migrateLocalToD1,
    };
}