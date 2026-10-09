// Photos kept on the device. The service worker (public/sw.js) saves each
// photo and file as it is shown, and serves the saved copy first. This side:
//   - downloads every preview in the background, so lists and tiles work
//     without a connection (not on mobile data where the phone says so);
//   - saves a catalog or collection whole for offline use ("Save for
//     offline": full-size photos and the PDF), until taken off again;
//   - deletes everything when the person signs out.

import type { Artwork } from '../types';
import { db } from './db';
import { getThumbUrl } from './storageService';
import { fileKeyOf } from './workspace';

/** The same names as public/sw.js. */
const PREVIEW_CACHE = 'photos-previews';
const FULL_CACHE = 'photos-full';
const OFFLINE_CACHE = 'photos-offline';
const PHOTO_CACHES = [PREVIEW_CACHE, FULL_CACHE, OFFLINE_CACHE];

/** What "Save for offline" kept, by set (catalog or collection id). */
const OFFLINE_SETS_KEY = 'vayu_offline_sets';
const PERSIST_ASKED_KEY = 'vayu_storage_persist_asked';
const DOWNLOADS_AT_ONCE = 3;

type OfflineSets = Record<string, string[]>;

const hasCaches = () => typeof caches !== 'undefined';

type Connection = { saveData?: boolean; type?: string; effectiveType?: string };

/**
 * Not on mobile data the phone reports, nor with Data Saver on, nor on a very
 * slow connection. iPhones don't say which network they are on: previews are
 * small (about 50 KB), so they download there too.
 */
function goodForBackgroundDownloads(): boolean {
    const conn = (navigator as Navigator & { connection?: Connection }).connection;
    if (!conn) return true;
    if (conn.saveData) return false;
    if (conn.type) return conn.type !== 'cellular';
    return !/2g/.test(conn.effectiveType ?? '');
}

/** Asks the browser, once, not to clear the saved photos when space runs low. */
function askToKeepStorage(): void {
    try {
        if (localStorage.getItem(PERSIST_ASKED_KEY)) return;
        localStorage.setItem(PERSIST_ASKED_KEY, '1');
    } catch { return; }
    void navigator.storage?.persist?.().catch(() => false);
}

/** Every stored photo the device's saved copy refers to. */
async function photoAddresses(): Promise<string[]> {
    const [artworks, catalogs, collections, inquiries, messages, inquiryMessages] = await Promise.all([
        db.getArtworks(), db.getCatalogs(), db.getCollections(), db.getInquiries(), db.getMessages(), db.getInquiryMessages(),
    ]);
    const found = new Set<string>();
    const add = (url?: string) => { if (url && fileKeyOf(url) !== null) found.add(url); };
    for (const a of artworks) a.imageUrls?.forEach(add);
    for (const c of catalogs) add(c.coverImageUrl);
    for (const c of collections) add(c.coverImageUrl);
    for (const i of inquiries) i.imageUrls?.forEach(add);
    for (const m of [...messages, ...inquiryMessages]) if (m.attachment?.type === 'image') add(m.attachment.url);
    return [...found];
}

/** Fetches each address not already in `cache` and saves it there, a few at a time. */
async function download(cache: Cache, addresses: string[], onEach?: () => void): Promise<number> {
    let next = 0;
    let failed = 0;
    const worker = async () => {
        while (next < addresses.length) {
            const address = addresses[next++];
            // Each worker takes one address at a time; several workers run side by side.
            try {
                if (!(await cache.match(address))) { // NOSONAR
                    const res = await fetch(address, { credentials: 'same-origin' }); // NOSONAR
                    if (res.ok && res.headers.get('X-Preview-Stand-In') !== '1') await cache.put(address, res); // NOSONAR
                    else if (!res.ok) failed++;
                }
            } catch {
                failed++;
            }
            onEach?.();
        }
    };
    await Promise.all(Array.from({ length: DOWNLOADS_AT_ONCE }, worker));
    return failed;
}

function readSets(): OfflineSets {
    try { return JSON.parse(localStorage.getItem(OFFLINE_SETS_KEY) ?? '{}') as OfflineSets; } catch { return {}; }
}

function writeSets(sets: OfflineSets): void {
    try { localStorage.setItem(OFFLINE_SETS_KEY, JSON.stringify(sets)); } catch { /* storage full: the photos stay saved */ }
}

/** A set's offline files: each artwork's photos (full size and preview), plus extras such as a PDF. */
export function offlineAddresses(artworkIds: string[], artworks: Artwork[], extra: (string | undefined)[] = []): string[] {
    const ids = new Set(artworkIds);
    const found = new Set<string>();
    const add = (url?: string) => {
        if (!url || fileKeyOf(url) === null) return;
        found.add(url);
        found.add(getThumbUrl(url));
    };
    for (const art of artworks) if (ids.has(art.id)) art.imageUrls?.forEach(add);
    for (const url of extra) if (url && fileKeyOf(url) !== null) found.add(url);
    return [...found];
}

let previewRun: Promise<void> | null = null;

export const photoStore = {
    /** Downloads every preview not yet on the device (once per start; skipped on mobile data). */
    downloadPreviews(): Promise<void> {
        if (!hasCaches() || !navigator.onLine || !goodForBackgroundDownloads()) return Promise.resolve();
        if (previewRun !== null) return previewRun;
        previewRun = (async () => {
            askToKeepStorage();
            const cache = await caches.open(PREVIEW_CACHE);
            const previews = (await photoAddresses()).map(getThumbUrl);
            await download(cache, previews);
        })().catch(err => console.warn('Saving previews stopped:', err));
        return previewRun;
    },

    isSavedForOffline(setId: string): boolean {
        return setId in readSets();
    },

    /** Saves a set's files for offline use; says how many could not be saved. */
    async saveForOffline(setId: string, addresses: string[], onProgress?: (done: number, total: number) => void): Promise<{ failed: number }> {
        if (!hasCaches()) throw new Error('This browser cannot keep files for offline use.');
        askToKeepStorage();
        const cache = await caches.open(OFFLINE_CACHE);
        let done = 0;
        onProgress?.(0, addresses.length);
        const failed = await download(cache, addresses, () => onProgress?.(++done, addresses.length));
        writeSets({ ...readSets(), [setId]: addresses });
        return { failed };
    },

    /** Takes a set off the device, keeping files another saved set still needs. */
    async removeOffline(setId: string): Promise<void> {
        const sets = readSets();
        const mine = sets[setId] ?? [];
        delete sets[setId];
        writeSets(sets);
        if (!hasCaches()) return;
        const stillNeeded = new Set(Object.values(sets).flat());
        const cache = await caches.open(OFFLINE_CACHE);
        await Promise.all(mine.filter(a => !stillNeeded.has(a)).map(a => cache.delete(a)));
    },

    /** Deletes every saved photo and file (signing out). */
    async clear(): Promise<void> {
        try { localStorage.removeItem(OFFLINE_SETS_KEY); } catch { /* unavailable */ }
        if (!hasCaches()) return;
        await Promise.all(PHOTO_CACHES.map(name => caches.delete(name).catch(() => false)));
    },

    /** Whether a full-size file is on the device (else, offline, its preview shows in its place). */
    async hasFullSize(address: string): Promise<boolean> {
        if (!hasCaches()) return false;
        for (const name of [FULL_CACHE, OFFLINE_CACHE]) {
            if (await caches.open(name).then(cache => cache.match(address))) return true;
        }
        return false;
    },
};
