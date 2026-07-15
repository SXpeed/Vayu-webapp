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
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const output = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) {
        output[i] = rawData.charCodeAt(i);
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

export const pushService = {
    isSupported(): boolean {
        return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
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
        const reg = await navigator.serviceWorker.ready;
        const { publicKey } = await apiCall<{ publicKey: string }>('/push/public-key');
        const sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
        });
        await registerOnServer(sub);
    },

    /** Unsubscribe this browser and remove it from the server. */
    async disable(): Promise<void> {
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
     * Re-register an existing browser subscription under the current session.
     * Called after login so a shared device notifies the right user.
     */
    async syncSubscription(): Promise<void> {
        try {
            if (!this.isSupported() || Notification.permission !== 'granted') return;
            const reg = await getRegistration();
            const sub = await reg?.pushManager.getSubscription();
            if (sub) await registerOnServer(sub);
        } catch { /* non-fatal */ }
    },
};
