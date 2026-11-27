import { useEffect, useSyncExternalStore } from 'react';
import { cleanInventorySettings, DEFAULT_INVENTORY_SETTINGS, type InventorySettings } from '../inventoryRules';
import { apiCall as call } from './apiClient';
import { db } from './db';

// Stock locations and statuses: one copy per device, shared by every screen, the
// same way as the billing setup (invoiceService.ts). Wiped at sign-out with the other saved copies.
let cache: { key: string; settings: InventorySettings; loaded: boolean } | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function current(): { key: string; settings: InventorySettings; loaded: boolean } {
    const key = db.inventorySettingsKey();
    if (cache?.key !== key) {
        let settings = DEFAULT_INVENTORY_SETTINGS;
        try {
            const saved = localStorage.getItem(key);
            if (saved) settings = cleanInventorySettings(JSON.parse(saved));
        } catch { /* unavailable: defaults */ }
        cache = { key, settings, loaded: false };
    }
    return cache;
}

function publish(next: InventorySettings): void {
    const c = current();
    cache = { key: c.key, settings: next, loaded: true };
    try { localStorage.setItem(c.key, JSON.stringify(next)); } catch { /* private mode or full: kept for this visit */ }
    listeners.forEach(l => l());
}

export function refreshInventorySettings(force = false): Promise<void> {
    if (current().loaded && !force) return Promise.resolve();
    inflight ??= call<unknown>('/inventory-settings')
        .then(raw => publish(cleanInventorySettings(raw)))
        .catch((e: unknown) => console.warn('Inventory settings not refreshed:', e))
        .finally(() => { inflight = null; });
    return inflight;
}

export async function saveInventorySettings(next: InventorySettings): Promise<InventorySettings> {
    try {
        const saved = cleanInventorySettings(await call<unknown>('/inventory-settings', { method: 'PUT', body: JSON.stringify(next) }));
        publish(saved);
        return saved;
    } catch (e) {
        void refreshInventorySettings(true);
        throw e;
    }
}

const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => { listeners.delete(l); };
};

/** Stock locations and statuses, refreshed from the server the first time a screen asks. */
export function useInventorySettings(): InventorySettings {
    useEffect(() => { void refreshInventorySettings(); }, []);
    return useSyncExternalStore(subscribe, () => current().settings);
}

export interface StockHistoryEntry { at: number; byName: string; change: Record<string, number>; note: string }

export const getStockHistory = (artworkId: string) => call<StockHistoryEntry[]>(`/artworks/${encodeURIComponent(artworkId)}/stock-history`);
