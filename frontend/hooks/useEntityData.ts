import { useState, useCallback, useEffect, useRef } from 'react';
import { Artwork, CalendarEvent, Catalog, Collection, Contact, Invoice, Inquiry, Conversation, Message, InquiryMessage, UserProfile } from '../types';
import { db, SavedList } from '../services/db';
import { messagingService } from '../services/messagingService';
import { artworkService } from '../services/artworkService';
import { collectionService } from '../services/collectionService';
import { catalogService } from '../services/catalogService';
import { inquiryService } from '../services/inquiryService';
import { eventService } from '../services/eventService';
import { contactService } from '../services/contactService';
import { invoiceService } from '../services/invoiceService';
import { authService, AuthUser } from '../services/authService';
import { makeCan, permissionsOf } from '../access';
import type { SectionId } from '../permissions';

type Dataset = 'artworks' | 'messages' | 'collections' | 'catalogs' | 'inquiries' | 'events' | 'contacts' | 'invoices';

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
    invoices: ['invoices'],
};

/** Set once this device's local-only invoices have been uploaded. */
const INVOICES_MIGRATED_KEY = 'vayu_invoices_synced';

/** How long one section may take to load before its saved copy is shown. */
const LOAD_TIMEOUT_MS = 12_000;

/** Reject if `promise` hasn't settled within `ms`. */
const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T> =>
    new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
        promise.then(
            value => { clearTimeout(timer); resolve(value); },
            error => { clearTimeout(timer); reject(error); },
        );
    });

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

    /**
     * Server invoices, after (once per device) uploading any that were only
     * ever saved on this device — proformas used to live in localStorage
     * alone. After that first sync the server is the source of truth: an
     * invoice deleted on another phone must not come back from a stale copy
     * here, so later loads replace the device copy instead of merging it.
     */
    const syncInvoices = useCallback(async (): Promise<Invoice[]> => {
        const remote = await invoiceService.getInvoices();
        const canEdit = makeCan(permissionsOf(authUserRef.current))('invoices', 'edit');
        let firstSync = false;
        try { firstSync = !localStorage.getItem(INVOICES_MIGRATED_KEY); } catch { /* private mode */ }
        if (firstSync && canEdit) {
            const onServer = new Set(remote.map(i => i.id));
            for (const inv of await db.getInvoices()) {
                if (onServer.has(inv.id)) continue;
                try { remote.push(await invoiceService.saveInvoice(inv)); } catch (err) { console.warn('Could not upload invoice', inv.invoiceNumber, err); }
            }
            try { localStorage.setItem(INVOICES_MIGRATED_KEY, '1'); } catch { /* private mode */ }
        }
        // Mirror the server list on the device for offline use.
        const onServer = new Set(remote.map(i => i.id));
        for (const inv of await db.getInvoices()) if (!onServer.has(inv.id)) await db.deleteInvoice(inv.id);
        for (const inv of remote) await db.saveInvoice(inv);
        return remote.sort((a, b) => b.date - a.date);
    }, [authUserRef]);

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
            // Each section loads on its own, with a time limit. This used to be
            // one all-or-nothing batch: a single stuck endpoint (GET /catalogs
            // hung on the server) held the whole app on its loading screen and
            // left every other section empty.
            //
            // A slow section is retried once. Only if it still fails does the
            // device's saved copy show — and only when that copy has something
            // in it, so a failure never blanks a list. Successful loads refresh
            // the saved copy, so it's never far out of date.
            const section = async <T,>(
                name: string, allowed: boolean, load: () => Promise<T[]>,
                saved: () => Promise<T[]>, apply: (data: T[]) => void, savedList?: SavedList,
            ) => {
                if (!allowed) { apply([]); return; }
                for (let attempt = 1; attempt <= 2; attempt++) {
                    try {
                        const data = await withTimeout(load(), LOAD_TIMEOUT_MS);
                        apply(data);
                        if (savedList) void db.replaceSaved(savedList, data);
                        return;
                    } catch (err) {
                        if (attempt === 2) console.warn(`Loading ${name} failed twice; using the saved copy if there is one.`, err);
                    }
                }
                const copy = await saved();
                if (copy.length) apply(copy);
            };
            await Promise.all([
                section('artworks', canReadData('artworks'), () => artworkService.getArtworks(), () => db.getArtworks(), data => applyIfChanged('artworks', data, setArtworks), 'artworks'),
                section('conversations', canReadData('messages'), () => messagingService.getConversations(), () => db.getConversations(), data => applyIfChanged('conversations', data, setConversations), 'conversations'),
                section('messages', canReadData('messages'), () => messagingService.getMessages(), () => db.getMessages(), data => applyIfChanged('messages', data, keepFailed), 'messages'),
                section('collections', canReadData('collections'), () => collectionService.getCollections(), () => db.getCollections(), data => applyIfChanged('collections', data, setCollections), 'collections'),
                section('catalogs', canReadData('catalogs'), () => catalogService.getCatalogs(), () => db.getCatalogs(), data => applyIfChanged('catalogs', data, setCatalogs), 'catalogs'),
                section('inquiries', canReadData('inquiries'), () => inquiryService.getInquiries(), () => db.getInquiries(), data => applyIfChanged('inquiries', data, setInquiries), 'inquiries'),
                section('inquiry messages', canReadData('inquiries'), () => inquiryService.getInquiryMessages(), () => db.getInquiryMessages(), data => applyIfChanged('inquiryMessages', data, setInquiryMessages), 'inquiryMessages'),
                section('events', canReadData('events'), () => eventService.getEvents(), () => db.getEvents(), data => applyIfChanged('events', data, setEvents), 'events'),
                section('contacts', canReadData('contacts'), () => contactService.getContacts(), () => db.getContacts(), data => applyIfChanged('contacts', data, setContacts), 'contacts'),
                section('invoices', canReadData('invoices'), () => syncInvoices(), () => db.getInvoices(), data => applyIfChanged('invoices', data, setInvoices)),
            ]);
        } else {
            setArtworks(await db.getArtworks());
            setConversations(await db.getConversations());
            setAllMessages(await db.getMessages());
            setCollections(await db.getCollections());
            setCatalogs(await db.getCatalogs());
            setInquiries(await db.getInquiries());
            setInquiryMessages(await db.getInquiryMessages());
        }
    }, [applyIfChanged, canReadData, keepFailed, syncInvoices]);

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

        // No immediate run: the initial load already fetched this, and the
        // effect restarts as sign-in settles, so running here multiplied the
        // startup requests (4 copies of each were seen).
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
                // Only what this role may read, and each section on its own:
                // one failing endpoint used to stop every section refreshing.
                const [arts, cols, cats, inqs, evs, cons, invs] = await Promise.allSettled([
                    whenAllowed(canReadData('artworks'), () => artworkService.getArtworks()),
                    whenAllowed(canReadData('collections'), () => collectionService.getCollections()),
                    whenAllowed(canReadData('catalogs'), () => catalogService.getCatalogs()),
                    whenAllowed(canReadData('inquiries'), () => inquiryService.getInquiries()),
                    whenAllowed(canReadData('events'), () => eventService.getEvents()),
                    whenAllowed(canReadData('contacts'), () => contactService.getContacts()),
                    whenAllowed(canReadData('invoices'), () => invoiceService.getInvoices()),
                ]);
                if (!cancelled) {
                    if (arts.status === 'fulfilled') applyIfChanged('artworks', arts.value, setArtworks);
                    if (cols.status === 'fulfilled') applyIfChanged('collections', cols.value, setCollections);
                    if (cats.status === 'fulfilled') applyIfChanged('catalogs', cats.value, setCatalogs);
                    if (inqs.status === 'fulfilled') applyIfChanged('inquiries', inqs.value, setInquiries);
                    if (evs.status === 'fulfilled') applyIfChanged('events', evs.value, setEvents);
                    if (cons.status === 'fulfilled') applyIfChanged('contacts', cons.value, setContacts);
                    if (invs.status === 'fulfilled') applyIfChanged('invoices', [...invs.value].sort((a, b) => b.date - a.date), setInvoices);
                }
            } catch (err) {
                console.warn('Failed to poll entities:', err);
            }
        };

        // No immediate run: the initial load already fetched this, and the
        // effect restarts as sign-in settles, so running here multiplied the
        // startup requests (4 copies of each were seen).
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