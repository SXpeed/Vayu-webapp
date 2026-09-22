/**
 * Client side of /api/sync. One engine per signed-in identity.
 *
 * First run (no cursor yet): fetch the boundary cursor S, THEN take a full
 * copy through the ordinary list endpoints, then replay changes after S.
 * Anything written while the full copy loaded has seq > S, and replayed puts
 * carry the row's current state, so the replay is idempotent and nothing is
 * missed. Later runs only fetch pages after the stored cursor.
 *
 * The cursor advances only after its page has been applied, so a failure
 * mid-sync re-reads that page instead of skipping it. Runs are single-flight:
 * a request that arrives mid-run schedules exactly one more pass afterwards.
 */
import type { SyncChange } from './syncMerge';

export interface SyncPage {
    mode?: 'boundary' | 'incremental';
    cursor: number;
    hasMore?: boolean;
    changes?: SyncChange[];
    resyncRequired?: boolean;
}

export type SyncOutcome = 'synced' | 'unavailable' | 'stale';

export interface DeltaSyncOptions {
    /** GET /sync — `cursor` null asks for the boundary. Resolves null when the
     *  endpoint is switched off (404), so callers fall back to polling. */
    fetchPage(cursor: number | null): Promise<SyncPage | null>;
    loadCursor(): number | null;
    saveCursor(cursor: number): void;
    clearCursor(): void;
    /** Reload every dataset from the list endpoints; must throw on failure. */
    fullLoad(): Promise<void>;
    applyChanges(changes: SyncChange[]): Promise<void> | void;
    /** False once the identity this engine was built for has signed out. */
    isCurrent(): boolean;
}

/** Guards against a server that keeps answering hasMore forever. */
const MAX_PAGES_PER_RUN = 50;
/** After a 404 the flag may be switched on later; look again after this. */
const UNAVAILABLE_RETRY_MS = 30 * 60_000;

export function createDeltaSync(options: DeltaSyncOptions, now: () => number = Date.now) {
    let inFlight: Promise<SyncOutcome> | null = null;
    let again = false;
    let unavailableAt: number | null = null;
    const unavailable = () => unavailableAt !== null && now() - unavailableAt < UNAVAILABLE_RETRY_MS;

    const pass = async (): Promise<SyncOutcome> => {
        let cursor = options.loadCursor();
        let resynced = false;

        const takeFullCopy = async (): Promise<SyncOutcome | null> => {
            const boundary = await options.fetchPage(null);
            if (boundary === null) return 'unavailable';
            if (!options.isCurrent()) return 'stale';
            await options.fullLoad();
            if (!options.isCurrent()) return 'stale';
            cursor = boundary.cursor;
            options.saveCursor(cursor);
            return null;
        };

        if (cursor === null) {
            const outcome = await takeFullCopy();
            if (outcome) return outcome;
        }

        for (let pages = 0; pages < MAX_PAGES_PER_RUN; pages++) {
            const page = await options.fetchPage(cursor);
            if (page === null) return 'unavailable';
            if (!options.isCurrent()) return 'stale';
            if (page.resyncRequired) {
                options.clearCursor();
                if (resynced) throw new Error('Sync cursor rejected twice in one run');
                resynced = true;
                const outcome = await takeFullCopy();
                if (outcome) return outcome;
                continue;
            }
            const changes = page.changes ?? [];
            if (changes.length) await options.applyChanges(changes);
            if (!options.isCurrent()) return 'stale';
            cursor = page.cursor;
            options.saveCursor(cursor);
            if (!page.hasMore) return 'synced';
        }
        return 'synced'; // the next run continues from the saved cursor
    };

    const run = (): Promise<SyncOutcome> => {
        if (unavailable()) return Promise.resolve('unavailable');
        if (inFlight) {
            again = true;
            return inFlight;
        }
        inFlight = (async () => {
            try {
                let outcome: SyncOutcome;
                do {
                    again = false;
                    outcome = await pass();
                } while (again && outcome === 'synced' && options.isCurrent());
                unavailableAt = outcome === 'unavailable' ? now() : null;
                return outcome;
            } finally {
                inFlight = null;
            }
        })();
        return inFlight;
    };

    return {
        run,
        /** False while the server says /api/sync is switched off. */
        get available() { return !unavailable(); },
    };
}

/**
 * The cursor lives in memory, one per tab. It describes what THIS tab's
 * in-memory state has applied: a cursor shared through localStorage would let
 * one tab advance past changes another tab never saw. Each tab takes its own
 * full copy at start-up anyway, so persisting it would save nothing.
 */
export function memoryCursor() {
    let cursor: number | null = null;
    return {
        loadCursor: () => cursor,
        saveCursor: (value: number) => { cursor = value; },
        clearCursor: () => { cursor = null; },
    };
}
