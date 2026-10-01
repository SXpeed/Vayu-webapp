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

/**
 * Takes a full copy: the boundary cursor first, so changes made meanwhile
 * are picked up by the next incremental pass. Gives that cursor (saved), or
 * why the run ends (offline, or the account changed meanwhile).
 */
async function takeFullCopy(options: DeltaSyncOptions): Promise<{ cursor: number } | 'unavailable' | 'stale'> {
    const boundary = await options.fetchPage(null);
    if (boundary === null) return 'unavailable';
    if (!options.isCurrent()) return 'stale';
    await options.fullLoad();
    if (!options.isCurrent()) return 'stale';
    options.saveCursor(boundary.cursor);
    return { cursor: boundary.cursor };
}

/** Applies one page of changes and saves its cursor: the outcome when the run is over, null to fetch the next page. */
async function applyPage(options: DeltaSyncOptions, page: SyncPage): Promise<SyncOutcome | null> {
    const changes = page.changes ?? [];
    if (changes.length) await options.applyChanges(changes);
    if (!options.isCurrent()) return 'stale';
    options.saveCursor(page.cursor);
    return page.hasMore ? null : 'synced';
}

/**
 * One fetched page: the outcome when the run ends, else the cursor to go on
 * from. A rejected cursor takes a full copy, once per run.
 */
async function handlePage(options: DeltaSyncOptions, page: SyncPage | null, resynced: boolean): Promise<{ outcome: SyncOutcome } | { cursor: number; resynced: boolean }> {
    if (page === null) return { outcome: 'unavailable' };
    if (!options.isCurrent()) return { outcome: 'stale' };
    if (!page.resyncRequired) {
        const outcome = await applyPage(options, page);
        return outcome ? { outcome } : { cursor: page.cursor, resynced };
    }
    options.clearCursor();
    if (resynced) throw new Error('Sync cursor rejected twice in one run');
    const copy = await takeFullCopy(options);
    return typeof copy === 'string' ? { outcome: copy } : { cursor: copy.cursor, resynced: true };
}

export function createDeltaSync(options: DeltaSyncOptions, now: () => number = Date.now) {
    let inFlight: Promise<SyncOutcome> | null = null;
    let again = false;
    let unavailableAt: number | null = null;
    const unavailable = () => unavailableAt !== null && now() - unavailableAt < UNAVAILABLE_RETRY_MS;

    const pass = async (): Promise<SyncOutcome> => {
        let cursor = options.loadCursor();
        let resynced = false;

        if (cursor === null) {
            const copy = await takeFullCopy(options);
            if (typeof copy === 'string') return copy;
            cursor = copy.cursor;
        }

        for (let pages = 0; pages < MAX_PAGES_PER_RUN; pages++) {
            const step = await handlePage(options, await options.fetchPage(cursor), resynced);
            if ('outcome' in step) return step.outcome;
            ({ cursor, resynced } = step);
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

/** Where a saved copy is up to, as kept on the device (db.ts SyncMark). */
export interface SavedSyncMark { identity: string; cursor: number; fullCopyAt: number }

export interface SavedCursorOptions {
    /** Who the copy is for, with which access: a different identity starts afresh. */
    identity: string;
    read(): SavedSyncMark | null;
    write(mark: SavedSyncMark | null): void;
    /** A copy taken whole longer ago than this is taken whole again. */
    maxAgeMs: number;
    /** False once a write to the saved copy has failed: its position is then not kept. */
    copyIntact(): boolean;
    now?: () => number;
}

/**
 * A cursor kept with the device's saved copy, so a start-up asks only for
 * what changed since instead of reloading every list. Read once, at the first
 * pass: from then on it lives in memory, per tab (see memoryCursor). Saved
 * only after the copy itself is up to date (the caller saves its lists before
 * the engine saves the cursor), so the saved position is never ahead of the
 * saved data; behind is harmless, as replayed changes carry the current state.
 * The whole copy is retaken every `maxAgeMs`: catching up never brings back
 * what was there before the person could see it (added to an existing chat).
 */
export function savedCursor(options: SavedCursorOptions) {
    const now = options.now ?? Date.now;
    let cursor: number | null | undefined;
    let fullCopyTaken = false;
    return {
        loadCursor: (): number | null => {
            if (cursor === undefined) {
                const mark = options.read();
                const usable = mark !== null && mark.identity === options.identity && now() - mark.fullCopyAt < options.maxAgeMs;
                cursor = usable ? mark.cursor : null;
            }
            return cursor;
        },
        saveCursor: (value: number): void => {
            cursor = value;
            if (!options.copyIntact()) {
                options.write(null);
                fullCopyTaken = false;
                return;
            }
            const mark = options.read();
            const fullCopyAt = fullCopyTaken ? now() : (mark?.identity === options.identity ? mark.fullCopyAt : 0);
            fullCopyTaken = false;
            options.write({ identity: options.identity, cursor: value, fullCopyAt });
        },
        clearCursor: (): void => {
            cursor = null;
            options.write(null);
        },
        /** Call when a full copy has loaded: the cursor saved next starts a new age. */
        tookFullCopy: (): void => { fullCopyTaken = true; },
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
