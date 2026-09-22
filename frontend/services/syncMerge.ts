/**
 * Pure helpers that fold /api/sync change pages into the app's entity lists.
 * No React, no storage — unit-tested directly.
 */

export interface SyncChange {
    seq: number;
    entity: string;
    id: string;
    op: 'put' | 'delete';
    record?: unknown;
}

type Comparator<T> = (a: T, b: T) => number;

/**
 * Apply changes (already in seq order) to a list keyed by id: put replaces or
 * adds, delete removes. Items the server never knew about — e.g. a chat
 * message that failed to send — are untouched, so they survive a merge.
 * Returns the SAME array when nothing changed, so React can skip a render.
 */
export function mergeChanges<T extends { id: string }>(
    list: readonly T[], changes: readonly SyncChange[], compare?: Comparator<T>,
): T[] {
    if (changes.length === 0) return list as T[];
    const byId = new Map<string, T>();
    for (const item of list) byId.set(item.id, item);
    let changed = false;
    for (const change of changes) {
        if (change.op === 'delete') {
            if (byId.delete(change.id)) changed = true;
        } else if (change.record !== undefined && change.record !== null) {
            const next = change.record as T;
            const prev = byId.get(change.id);
            if (prev === undefined || JSON.stringify(prev) !== JSON.stringify(next)) {
                byId.set(change.id, next);
                changed = true;
            }
        }
    }
    if (!changed) return list as T[];
    const merged = [...byId.values()];
    return compare ? merged.sort(compare) : merged;
}

/** Changes grouped by entity, each group keeping seq order. */
export function groupByEntity(changes: readonly SyncChange[]): Map<string, SyncChange[]> {
    const groups = new Map<string, SyncChange[]>();
    for (const change of changes) {
        const group = groups.get(change.entity);
        if (group) group.push(change);
        else groups.set(change.entity, [change]);
    }
    return groups;
}

/** Newest first by a numeric field (missing values sort last). */
export const byDesc = <T,>(field: keyof T): Comparator<T> =>
    (a, b) => (Number(b[field]) || 0) - (Number(a[field]) || 0);

/** Oldest first by a numeric field. */
export const byAsc = <T,>(field: keyof T): Comparator<T> =>
    (a, b) => (Number(a[field]) || 0) - (Number(b[field]) || 0);

/** Pinned conversations first, then most recent activity — the server's order. */
export const conversationOrder: Comparator<{ isPinned?: boolean; lastMessageTime: number }> =
    (a, b) => Number(!!b.isPinned) - Number(!!a.isPinned) || (b.lastMessageTime || 0) - (a.lastMessageTime || 0);
