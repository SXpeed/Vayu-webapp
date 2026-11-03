import { useEffect, useSyncExternalStore } from 'react';
import { cleanSettings, EMPTY_SETTINGS, type BillingDoc, type BillingSettings } from '../invoicing';
import { apiCall as call } from './apiClient';
import { db } from './db';

const path = (id: string) => `/invoices/${encodeURIComponent(id)}`;

/** Billing documents on the server, shared by every device. The server numbers, locks and totals them. */
export const invoiceService = {
    getInvoices(): Promise<BillingDoc[]> {
        return call<BillingDoc[]>('/invoices');
    },

    /** Create or update (ids are assigned by the app). Answers with the document as saved. */
    saveInvoice(doc: BillingDoc): Promise<BillingDoc> {
        return call<BillingDoc>(path(doc.id), { method: 'PUT', body: JSON.stringify(doc) });
    },

    /** Numbers and locks a draft; answers with every document that changed (a converted proforma, an invoiced challan). */
    issueInvoice(id: string): Promise<BillingDoc[]> {
        return call<BillingDoc[]>(`${path(id)}/issue`, { method: 'POST' });
    },

    cancelInvoice(id: string, reason: string): Promise<BillingDoc> {
        return call<BillingDoc>(`${path(id)}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
    },

    async deleteInvoice(id: string): Promise<void> {
        await call<{ success: boolean }>(path(id), { method: 'DELETE' });
    },
};

// ── Billing setup: one copy per device, shared by every screen ──────────────

// Kept per workspace (db.billingSettingsKey) and wiped at sign-out with the other saved copies.
let cache: { key: string; settings: BillingSettings; loaded: boolean } | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** This workspace's copy, read again whenever the workspace changes. */
function current(): { key: string; settings: BillingSettings; loaded: boolean } {
    const key = db.billingSettingsKey();
    if (cache?.key !== key) {
        let settings = EMPTY_SETTINGS;
        try { settings = cleanSettings(JSON.parse(localStorage.getItem(key) ?? '{}')); } catch { /* unavailable: defaults */ }
        cache = { key, settings, loaded: false };
    }
    return cache;
}

function publish(next: BillingSettings): void {
    const c = current();
    cache = { key: c.key, settings: next, loaded: true };
    try { localStorage.setItem(c.key, JSON.stringify(next)); } catch { /* private mode or full: kept for this visit */ }
    listeners.forEach(l => l());
}

/** Fetches the setup from the server (once per visit unless forced). The device copy stays when offline. */
export function refreshBillingSettings(force = false): Promise<void> {
    if (current().loaded && !force) return Promise.resolve();
    inflight ??= call<unknown>('/invoices/settings')
        .then(raw => publish(cleanSettings(raw)))
        .catch((e: unknown) => console.warn('Billing setup not refreshed:', e))
        .finally(() => { inflight = null; });
    return inflight;
}

export async function saveBillingSettings(next: BillingSettings): Promise<BillingSettings> {
    try {
        const saved = cleanSettings(await call<unknown>('/invoices/settings', { method: 'PUT', body: JSON.stringify(next) }));
        publish(saved);
        return saved;
    } catch (e) {
        // Someone else saved first: bring their version in, so reopening the setup shows it.
        void refreshBillingSettings(true);
        throw e;
    }
}

const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => { listeners.delete(l); };
};

/** The billing setup, refreshed from the server the first time a screen asks for it. */
export function useBillingSettings(): BillingSettings {
    useEffect(() => { void refreshBillingSettings(); }, []);
    return useSyncExternalStore(subscribe, () => current().settings);
}
