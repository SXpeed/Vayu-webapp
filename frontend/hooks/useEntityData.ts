import { useState, useCallback, useEffect, useRef } from 'react';
import { Artwork, CalendarEvent, Catalog, Collection, Contact, Invoice, Inquiry, Conversation, Message, InquiryMessage, UserProfile, ViewState } from '../types';
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
import { createRefreshScheduler } from '../services/refreshScheduler';
import { authHeaders, parseApiResponse } from '../services/apiClient';
import { apiBase } from '../services/workspace';
import { createDeltaSync, memoryCursor, type SyncPage } from '../services/deltaSyncClient';
import { byAsc, byDesc, conversationOrder, groupByEntity, mergeChanges, type SyncChange } from '../services/syncMerge';
import { realtimeService } from '../services/realtimeService';
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

/** Every list loadData knows, by the name its `selected` filter uses. */
const ALL_DATASETS = [
    'artworks', 'conversations', 'messages', 'collections', 'catalogs',
    'inquiries', 'inquiryMessages', 'events', 'contacts', 'invoices',
] as const;

/** Sync entities this hook keeps in state (attendance and stores load on their own screens). */
const HELD_ENTITIES: ReadonlySet<string> = new Set([
    'artwork', 'collection', 'catalog', 'contact', 'inquiry', 'inquiry_message',
    'invoice', 'event', 'message', 'conversation',
]);

/** While a realtime socket delivers change signals, polling is only a
 *  safety net against a lost signal. */
const SAFETY_SYNC_MS = 10 * 60_000;

/** GET /sync; null when the server has delta sync switched off (404). */
async function fetchSyncPage(cursor: number | null): Promise<SyncPage | null> {
    const query = cursor === null ? '' : `?cursor=${cursor}`;
    let res: Response;
    try {
        res = await fetch(`${apiBase()}/sync${query}`, { headers: authHeaders(), signal: AbortSignal.timeout(20_000) });
    } catch {
        throw new Error('Cannot reach the server. Check your connection and try again.');
    }
    if (res.status === 404) return null;
    return parseApiResponse<SyncPage>(res);
}

/** Set once this device's local-only invoices have been uploaded. */
const INVOICES_MIGRATED_KEY = 'vayu_invoices_synced';

/** Run `load` only when allowed; otherwise an empty list. */
const whenAllowed = <T,>(allowed: boolean, load: () => Promise<T[]>): Promise<T[]> =>
    allowed ? load() : Promise.resolve([]);

/**
 * Manages all entity state (artworks, catalogs, collections, invoices,
 * inquiries, conversations, messages, inquiryMessages, teamMembers),
 * loadData, D1 migration, BroadcastChannel sync, and polling effects.
 */
export function useEntityData(
    authUser: AuthUser | null,
    authUserRef: React.RefObject<AuthUser | null>,
    currentView: ViewState,
) {
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
    const inflight = useRef<Promise<void> | null>(null);
    const loadAll = useCallback(async (isAuthenticated: boolean, selected?: readonly string[]) => {
        const identity = authUserRef.current;
        const loadedInvoices = await db.getInvoices();
        if (!selected) setInvoices(loadedInvoices);

        if (isAuthenticated) {
            // Sections settle independently. Bootstrap falls back to saved
            // data; later refresh failures retain current state and back off.
            const section = async <T,>(
                name: string, allowed: boolean, load: () => Promise<T[]>,
                saved: () => Promise<T[]>, apply: (data: T[]) => void, savedList?: SavedList,
            ) => {
                if (selected && !selected.includes(savedList ?? name)) return;
                if (!allowed) { apply([]); return; }
                try {
                    // apiClient aborts timed-out reads. Do not race another
                    // timeout against it and launch duplicate requests.
                    const data = await load();
                    if (authUserRef.current !== identity) return;
                    apply(data);
                    if (savedList) await db.replaceSaved(savedList, data);
                } catch (err) {
                    if (authUserRef.current !== identity) return;
                    if (selected) throw err; // scheduler backs off
                    console.warn(`Loading ${name} failed; using the saved copy.`, err);
                    const copy = await saved();
                    if (authUserRef.current === identity && copy.length) apply(copy);
                }
            };
            const results = await Promise.allSettled([
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
            if (results.some(result => result.status === 'rejected')) throw new Error('Some sections could not refresh');
        } else {
            setArtworks(await db.getArtworks());
            setConversations(await db.getConversations());
            setAllMessages(await db.getMessages());
            setCollections(await db.getCollections());
            setCatalogs(await db.getCatalogs());
            setInquiries(await db.getInquiries());
            setInquiryMessages(await db.getInquiryMessages());
        }
    }, [applyIfChanged, canReadData, keepFailed, syncInvoices, authUserRef]);

    /** Single-flight: a call while a load is running is a no-op. */
    const loadData = useCallback((isAuthenticated: boolean, selected?: readonly string[]): Promise<void> => {
        if (inflight.current) return Promise.resolve();
        const run = loadAll(isAuthenticated, selected).finally(() => { inflight.current = null; });
        inflight.current = run;
        return run;
    }, [loadAll]);

    /** A complete, failure-reporting reload. Waits out any load in flight so
     *  the copy it takes is newer than the sync boundary fetched before it. */
    const fullLoad = useCallback(async () => {
        while (inflight.current) await inflight.current.catch(() => undefined);
        await loadData(true, ALL_DATASETS);
    }, [loadData]);

    /**
     * Fold a /api/sync page into state and the offline copies. Datasets this
     * hook doesn't hold (attendance, stores) are skipped; their screens load
     * their own data.
     */
    const applyChanges = useCallback(async (changes: SyncChange[]) => {
        const groups = groupByEntity(changes);
        const merge = <T extends { id: string },>(
            entity: string, key: string, setter: React.Dispatch<React.SetStateAction<T[]>>,
            compare?: (a: T, b: T) => number, savedList?: SavedList,
        ) => {
            const group = groups.get(entity);
            if (!group) return;
            // The last full-load payload no longer describes state; without
            // this, a later identical full load would be skipped as "unchanged".
            delete lastPayloads.current[key];
            setter(prev => {
                const next = mergeChanges(prev, group, compare);
                if (next !== prev && savedList) queueMicrotask(() => { void db.replaceSaved(savedList, next); });
                return next;
            });
        };
        merge<Artwork>('artwork', 'artworks', setArtworks, byDesc<Artwork>('createdAt'), 'artworks');
        merge<Collection>('collection', 'collections', setCollections, byDesc<Collection>('createdAt'), 'collections');
        merge<Catalog>('catalog', 'catalogs', setCatalogs, byDesc<Catalog>('createdAt'), 'catalogs');
        merge<Contact>('contact', 'contacts', setContacts, byDesc<Contact>('createdAt'), 'contacts');
        merge<Inquiry>('inquiry', 'inquiries', setInquiries, byDesc<Inquiry>('date'), 'inquiries');
        merge<InquiryMessage>('inquiry_message', 'inquiryMessages', setInquiryMessages, byAsc<InquiryMessage>('timestamp'), 'inquiryMessages');
        merge<CalendarEvent>('event', 'events', setEvents, byAsc<CalendarEvent>('date'), 'events');
        merge<Conversation>('conversation', 'conversations', setConversations, conversationOrder, 'conversations');
        merge<Message>('message', 'messages', setAllMessages, byAsc<Message>('timestamp'), 'messages');
        merge<Invoice>('invoice', 'invoices', setInvoices, byDesc<Invoice>('date'));
        // Invoices keep their own device store (see syncInvoices).
        for (const change of groups.get('invoice') ?? []) {
            if (change.op === 'delete') await db.deleteInvoice(change.id);
            else if (change.record) await db.saveInvoice(change.record as Invoice);
        }
    }, []);

    // One delta-sync engine per signed-in user (per tab: see memoryCursor).
    const engineRef = useRef<{ userId: string; engine: ReturnType<typeof createDeltaSync> } | null>(null);
    const getEngine = useCallback(() => {
        const userId = authUserRef.current?.id;
        if (!userId) return null;
        if (engineRef.current?.userId !== userId) {
            engineRef.current = {
                userId,
                engine: createDeltaSync({
                    fetchPage: fetchSyncPage,
                    ...memoryCursor(),
                    fullLoad,
                    applyChanges,
                    isCurrent: () => authUserRef.current?.id === userId,
                }),
            };
        }
        return engineRef.current.engine;
    }, [authUserRef, fullLoad, applyChanges]);

    /**
     * Bring everything up to date: a delta pass when the server supports it,
     * otherwise (or if the pass fails) the classic full reload, which falls
     * back to the device's saved copies.
     */
    const syncAll = useCallback(async () => {
        const engine = getEngine();
        if (engine) {
            try {
                if (await engine.run() !== 'unavailable') return;
            } catch (err) {
                console.warn('Delta sync failed; reloading everything.', err);
            }
        }
        await loadData(true);
    }, [getEngine, loadData]);

    const loadTeamMembers = useCallback(async () => {
        try {
            // /auth/team already includes presence; avoid a duplicate KV scan.
            const team = await authService.getTeamMembers();
            const mapped: UserProfile[] = team.map(u => ({
                id: u.id,
                name: u.name,
                email: u.email,
                phone: '',
                address: '',
                isOnline: u.isOnline ?? false,
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

    // Refresh each screen's dependencies, including artworks used by catalogs,
    // inquiries and invoices. A bounded interval keeps stationary screens fresh.
    useEffect(() => {
        if (!authUser) return;
        const datasets: Partial<Record<ViewState, readonly string[]>> = {
            home: ['artworks', 'catalogs', 'invoices', 'events'],
            artworks: ['artworks'],
            collections: ['collections', 'artworks'],
            catalogs: ['catalogs', 'artworks'],
            contacts: ['contacts', 'inquiries'],
            calendar: ['events'],
            invoice: ['invoices', 'artworks'],
            inquiry: ['inquiries', 'inquiryMessages', 'artworks', 'invoices'],
            messaging: ['conversations', 'messages'],
        };
        const selected = datasets[currentView];
        if (!selected) return;
        const pollMs = currentView === 'messaging' || currentView === 'inquiry' ? 60_000 : 120_000;
        const scheduler = createRefreshScheduler({
            // One /api/sync request covers every dataset; without it, reload
            // just this screen's lists.
            run: async () => {
                const engine = getEngine();
                if (engine?.available && await engine.run() !== 'unavailable') return;
                await loadData(true, selected);
            },
            intervalMs: () => (realtimeService.connected ? SAFETY_SYNC_MS : pollMs),
            // The initial bootstrap already loads Home's data.
            initialDelayMs: currentView === 'home' ? 120_000 : 0,
            enabled: () => document.visibilityState === 'visible' && navigator.onLine,
        });
        const refresh = () => { void scheduler.request(); };
        document.addEventListener('visibilitychange', refresh);
        window.addEventListener('online', refresh);
        window.addEventListener('focus', refresh);
        const channel = typeof BroadcastChannel !== 'undefined'
            ? new BroadcastChannel('vayu_cloud_sync') : null;
        if (channel) channel.onmessage = event => {
            if (event.data?.type === 'SYNC_REQUIRED') refresh();
        };
        return () => {
            scheduler.stop();
            channel?.close();
            document.removeEventListener('visibilitychange', refresh);
            window.removeEventListener('online', refresh);
            window.removeEventListener('focus', refresh);
        };
    }, [authUser, currentView, loadData, getEngine]);

    // Realtime socket for the signed-in user: change signals trigger a delta
    // pass, presence updates the team list. Hidden tabs defer their pass
    // until they are looked at again.
    const userId = authUser?.id;
    useEffect(() => {
        if (!userId) return;
        realtimeService.start(userId);
        let pending = false;
        const catchUp = () => {
            if (!pending || document.visibilityState !== 'visible') return;
            pending = false;
            const engine = getEngine();
            if (engine?.available) void engine.run().catch(err => console.warn('Delta sync failed', err));
        };
        const unsubscribe = realtimeService.subscribe(event => {
            if (event.type === 'invalidate') {
                // An empty list means "reconnected: catch up on everything".
                if (event.events.length === 0 || event.events.some(e => HELD_ENTITIES.has(e.entity))) {
                    pending = true;
                    catchUp();
                }
            } else if (event.type === 'status' && event.connected) {
                // The team list may have loaded before any socket (ours or a
                // colleague's) was up; refresh it once now that presence events
                // keep it current.
                void loadTeamMembers();
            } else if (event.type === 'presence') {
                const online = new Map(event.changes.map(c => [c.userId, c.online]));
                setTeamMembers(prev => {
                    if (!prev.some(m => online.has(m.id) && m.isOnline !== online.get(m.id))) return prev;
                    return prev.map(m => (online.has(m.id) ? { ...m, isOnline: online.get(m.id)! } : m));
                });
            }
        });
        document.addEventListener('visibilitychange', catchUp);
        return () => {
            unsubscribe();
            document.removeEventListener('visibilitychange', catchUp);
            realtimeService.stop();
        };
    }, [userId, getEngine, loadTeamMembers]);

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
        syncAll,
        loadTeamMembers,
        migrateLocalToD1,
    };
}
