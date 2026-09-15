import { useCallback, useMemo } from 'react';
import { UserProfile } from '../types';

// Placeholders written when the author's profile or the team list hadn't
// loaded yet. They're never a real name, so never show them to others.
const PLACEHOLDER_NAMES = new Set(['You', 'Team Member', 'Unknown']);

/**
 * Names on conversations, messages and inquiries are snapshots taken when
 * they were saved, so they can be placeholders or stale after a rename.
 * Returns a resolver that prefers the live team roster, keyed by user id.
 */
export function useMemberNames(teamMembers: UserProfile[]) {
    const nameById = useMemo(
        () => new Map(teamMembers.map(m => [m.id, m.name])),
        [teamMembers],
    );

    return useCallback((id: string | undefined, storedName?: string): string => {
        const liveName = id ? nameById.get(id) : undefined;
        if (liveName) return liveName;
        if (storedName && !PLACEHOLDER_NAMES.has(storedName)) return storedName;
        return 'Team member';
    }, [nameById]);
}
