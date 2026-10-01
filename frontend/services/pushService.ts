import { apiCall } from './apiClient';

/**
 * Client-side Web Push subscription management.
 *
 * "Enabled" means this browser holds an active push subscription that has
 * been registered with the server for the logged-in user. The Profile-page
 * toggle drives enable()/disable(); syncSubscription() keeps the server
 * mapping pointed at the current user after login.
 */

function urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replaceAll('-', '+').replaceAll('_', '/');
    const rawData = atob(base64);
    const output = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) {
        output[i] = rawData.codePointAt(i) ?? 0;
    }
    return output;
}

async function getRegistration(): Promise<ServiceWorkerRegistration | undefined> {
    if (!('serviceWorker' in navigator)) return undefined;
    return await navigator.serviceWorker.getRegistration() ?? undefined;
}

async function registerOnServer(sub: PushSubscription): Promise<void> {
    await apiCall('/push/subscribe', {
        method: 'POST',
        body: JSON.stringify(sub.toJSON()),
    });
}

/** Set when the person turns notifications off, so signing in doesn't turn them back on. */
const TURNED_OFF_KEY = 'vayu.push.off';

/**
 * Who is signed in on this device, kept where the service worker can read
 * it (sw.js). Each notification names its person; the worker shows only
 * those for whoever is signed in now, and none while signed out.
 */
const IDENTITY_CACHE = 'push-identity';
const IDENTITY_URL = '/__push-identity';

async function subscribeBrowser(): Promise<PushSubscription> {
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await apiCall<{ publicKey: string }>('/push/public-key');
    return reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    });
}

export const pushService = {
    isSupported(): boolean {
        return 'serviceWorker' in navigator && 'PushManager' in globalThis && 'Notification' in globalThis;
    },

    /** True when this browser has an active subscription and permission is granted. */
    async isEnabled(): Promise<boolean> {
        if (!this.isSupported() || Notification.permission !== 'granted') return false;
        const reg = await getRegistration();
        const sub = await reg?.pushManager.getSubscription();
        return !!sub;
    },

    /** Ask for permission, subscribe this browser, and register it with the server. */
    async enable(): Promise<void> {
        if (!this.isSupported()) {
            throw new Error('Push notifications are not supported in this browser');
        }
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            throw new Error('Notification permission was not granted. You can enable it in your browser settings.');
        }
        // The SW registers on page load; ready resolves once it is active.
        const sub = await subscribeBrowser();
        await registerOnServer(sub);
        try { localStorage.removeItem(TURNED_OFF_KEY); } catch { /* private mode */ }
    },

    /** Unsubscribe this browser and remove it from the server. */
    async disable(): Promise<void> {
        try { localStorage.setItem(TURNED_OFF_KEY, '1'); } catch { /* private mode */ }
        const reg = await getRegistration();
        const sub = await reg?.pushManager.getSubscription();
        if (!sub) return;
        try {
            await apiCall('/push/unsubscribe', {
                method: 'POST',
                body: JSON.stringify({ endpoint: sub.endpoint }),
            });
        } catch { /* still unsubscribe locally */ }
        await sub.unsubscribe();
    },

    /**
     * Re-register this browser's subscription under the current session.
     * Called after login so a shared device notifies the right user. A
     * device whose subscription was dropped (the browser does that after
     * notifications it was told not to show) is subscribed again, unless
     * the person turned notifications off.
     */
    async syncSubscription(): Promise<void> {
        try {
            if (!this.isSupported() || Notification.permission !== 'granted') return;
            const reg = await getRegistration();
            let sub = await reg?.pushManager.getSubscription();
            if (!sub && localStorage.getItem(TURNED_OFF_KEY) !== '1') sub = await subscribeBrowser();
            if (sub) await registerOnServer(sub);
        } catch { /* non-fatal */ }
    },

    /**
     * Signing out: this device stops receiving the person's notifications.
     * The browser keeps its subscription, so whoever signs in next takes
     * the device over without being asked for permission again.
     */
    async releaseDevice(): Promise<void> {
        await this.setIdentity(null);
        try {
            const reg = await getRegistration();
            const sub = await reg?.pushManager.getSubscription();
            if (sub) {
                await apiCall('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) });
            }
        } catch { /* signed out already (session gone): the worker's check still hides them */ }
    },

    /** Records who is signed in here (null: nobody), for the service worker's check. */
    async setIdentity(userId: string | null): Promise<void> {
        try {
            if (!('caches' in globalThis)) return;
            const cache = await caches.open(IDENTITY_CACHE);
            await cache.put(IDENTITY_URL, new Response(JSON.stringify({ userId, at: Date.now() }), { headers: { 'Content-Type': 'application/json' } }));
        } catch { /* storage blocked: notifications show as before */ }
    },
};
