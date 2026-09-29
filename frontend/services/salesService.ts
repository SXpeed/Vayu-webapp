import { summarize, type Sale, type SaleInput, type SalesSummary } from '../salesRules';
import { apiCall as call } from './apiClient';
import { db, type PendingSale } from './db';

export type { PendingSale } from './db';

export interface SalesPage {
    from: string;
    to: string;
    sales: Sale[];
    summary: SalesSummary;
    /** Every tag in use, most recent first (suggestions and filters). */
    allTags: string[];
}

/** A range of the ledger as a screen shows it. */
export interface SalesData extends SalesPage {
    /** Recorded on this device and not uploaded yet (dated within the range). */
    pending: PendingSale[];
    /** The server couldn't be reached: this is the copy saved on the device. */
    offline: boolean;
    /** When that copy was loaded (offline only). */
    savedAt: number | null;
}

/** No answer at all (as opposed to the server refusing): apiCall's errors carry no status then. */
const unreachable = (e: unknown): boolean => typeof (e as { status?: unknown }).status !== 'number';

/** The app names each new sale, so an upload retried after a dropped connection can't record it twice. */
export const newSaleId = (): string => `sale_${crypto.randomUUID().replaceAll('-', '')}`;

let flushing: Promise<void> | null = null;

/**
 * Uploads the sales recorded offline, oldest first. The server gives each its
 * number. A sale it refuses (the piece was sold meanwhile, say) stays on the
 * device with the reason, for someone to look at; one it has already
 * deleted is dropped. Stops at the first sign of being offline.
 */
export function flushPendingSales(): Promise<void> {
    flushing ??= (async () => {
        for (const item of db.getPendingSales()) {
            if (item.error) continue;
            try {
                await call<Sale>('/sales', { method: 'POST', body: JSON.stringify({ ...item.input, id: item.id }) });
                db.setPendingSales(db.getPendingSales().filter(p => p.id !== item.id));
            } catch (e) {
                if (unreachable(e)) return;
                const status = (e as { status: number }).status;
                // Down, signed out, plan lapsed or busy: try again later, as it is.
                if (status >= 500 || status === 401 || status === 402 || status === 429) return;
                const rest = db.getPendingSales();
                db.setPendingSales(status === 410
                    ? rest.filter(p => p.id !== item.id)
                    : rest.map(p => (p.id === item.id ? { ...p, error: (e as Error).message } : p)));
            }
        }
    })().finally(() => { flushing = null; });
    return flushing;
}

export const salesService = {
    /** The sales between two days (inclusive): from the server, or the device's copy when offline. */
    async load(from: string, to: string): Promise<SalesData> {
        await flushPendingSales().catch(() => undefined);
        const pending = db.getPendingSales().filter(p => p.input.saleDate >= from && p.input.saleDate <= to);
        try {
            const page = await call<SalesPage>(`/sales?from=${from}&to=${to}`);
            db.saveSalesPage({ ...page, savedAt: Date.now() });
            return { ...page, pending, offline: false, savedAt: null };
        } catch (e) {
            if (!unreachable(e)) throw e;
            const saved = db.getSavedSalesPage(from, to);
            if (saved) return { from, to, sales: saved.sales, summary: saved.summary, allTags: saved.allTags ?? [], pending, offline: true, savedAt: saved.savedAt };
            return { from, to, sales: [], summary: summarize([]), allTags: [], pending, offline: true, savedAt: null };
        }
    },

    /**
     * Records a sale. Offline, it is kept on this device and uploaded later
     * (`pending`); refusals (already sold, bad fields) are thrown as usual.
     */
    async record(input: SaleInput): Promise<{ sale: Sale } | { pending: PendingSale }> {
        const id = newSaleId();
        try {
            return { sale: await call<Sale>('/sales', { method: 'POST', body: JSON.stringify({ ...input, id }) }) };
        } catch (e) {
            if (!unreachable(e)) throw e;
            const pending: PendingSale = { id, input, savedAt: Date.now() };
            db.setPendingSales([...db.getPendingSales(), pending]);
            return { pending };
        }
    },

    /** Changing and deleting need the server: the sale's number and the piece's status live there. */
    update(id: string, input: SaleInput): Promise<Sale> {
        return call<Sale>(`/sales/${id}`, { method: 'PUT', body: JSON.stringify(input) });
    },

    async remove(id: string): Promise<void> {
        await call(`/sales/${id}`, { method: 'DELETE' });
    },

    /** Drops a sale that was recorded offline and never uploaded. */
    discardPending(id: string): void {
        db.setPendingSales(db.getPendingSales().filter(p => p.id !== id));
    },

    /** Tries a refused offline sale again (after, say, the piece was put back on sale). */
    retryPending(id: string): Promise<void> {
        db.setPendingSales(db.getPendingSales().map(p => (p.id === id ? { id: p.id, input: p.input, savedAt: p.savedAt } : p)));
        return flushPendingSales();
    },
};
