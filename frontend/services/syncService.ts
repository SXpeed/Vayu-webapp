/**
 * Background Sync & Periodic Background Sync registration.
 *
 * - Periodic sync (installed PWA, Chromium): the browser wakes the service
 *   worker on its own schedule to refresh the app shell and, if a window is
 *   open, trigger a data reload.
 * - One-off background sync: queued when the app goes offline; the browser
 *   fires it the moment connectivity returns — even with the tab backgrounded
 *   — so data refreshes immediately instead of waiting for the next poll.
 * - As a plain fallback (all browsers), the `online` event broadcasts
 *   SYNC_REQUIRED so open tabs reload data right away.
 */

const ONEOFF_TAG = 'vayu-sync';
const PERIODIC_TAG = 'vayu-periodic-sync';
const PERIODIC_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // browser decides the real cadence

// The Sync APIs aren't in the standard TS lib yet.
interface SyncCapableRegistration extends ServiceWorkerRegistration {
    sync?: { register(tag: string): Promise<void> };
    periodicSync?: { register(tag: string, options?: { minInterval: number }): Promise<void> };
}

function broadcastSyncRequired(): void {
    try {
        const channel = new BroadcastChannel('vayu_cloud_sync');
        channel.postMessage({ type: 'SYNC_REQUIRED' });
        channel.close();
    } catch { /* BroadcastChannel unavailable */ }
}

async function getReadyRegistration(): Promise<SyncCapableRegistration | null> {
    if (!('serviceWorker' in navigator)) return null;
    try {
        return await navigator.serviceWorker.ready as SyncCapableRegistration;
    } catch {
        return null;
    }
}

let initialized = false;

export const syncService = {
    /** Queue a one-off background sync that fires when connectivity returns. */
    async registerBackgroundSync(): Promise<void> {
        const reg = await getReadyRegistration();
        if (!reg?.sync) return;
        try {
            await reg.sync.register(ONEOFF_TAG);
        } catch { /* unsupported or blocked — polling still covers us */ }
    },

    /** Register browser-scheduled periodic refresh (requires installed PWA). */
    async registerPeriodicSync(): Promise<void> {
        const reg = await getReadyRegistration();
        if (!reg?.periodicSync) return;
        try {
            // Permission is only granted for installed PWAs with engagement.
            const status = await navigator.permissions.query({
                name: 'periodic-background-sync' as PermissionName,
            });
            if (status.state !== 'granted') return;
            await reg.periodicSync.register(PERIODIC_TAG, { minInterval: PERIODIC_MIN_INTERVAL_MS });
        } catch { /* unsupported or permission query not recognized */ }
    },

    /** Idempotent app-start hook: registers syncs and connectivity listeners. */
    init(): void {
        if (initialized || !('serviceWorker' in navigator)) return;
        initialized = true;

        this.registerPeriodicSync();

        // Started offline? Queue the sync now so recovery is instant.
        if (!navigator.onLine) this.registerBackgroundSync();

        globalThis.addEventListener('offline', () => {
            this.registerBackgroundSync();
        });

        globalThis.addEventListener('online', () => {
            broadcastSyncRequired();
        });
    },
};
