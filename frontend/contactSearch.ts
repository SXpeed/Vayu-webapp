// Saved contacts matching what is typed into a customer's name, phone or
// email field (ContactSuggest). Runs on the device over the contacts already
// loaded, so it needs no server and works offline.

import type { Contact } from './types';

const digitsOf = (s: string | undefined): string => (s ?? '').replaceAll(/\D/g, '');
const recency = (c: Contact): number => c.lastInteractionAt ?? c.updatedAt ?? c.createdAt ?? 0;

/**
 * Best first: the name starts with what was typed, then a word in it does,
 * then the phone has those digits (3 or more), then the name or email
 * contains it. Nothing typed: the most recently active contacts.
 */
export function searchContacts(contacts: readonly Contact[], query: string, limit = 50): Contact[] {
    const q = query.trim().toLowerCase();
    if (!q) return [...contacts].sort((a, b) => recency(b) - recency(a)).slice(0, limit);
    const digits = digitsOf(q);
    const scored: { score: number; c: Contact }[] = [];
    for (const c of contacts) {
        const name = (c.name ?? '').toLowerCase();
        let score = -1;
        if (name.startsWith(q)) score = 0;
        else if (name.split(/\s+/).some(w => w.startsWith(q))) score = 1;
        else if (digits.length >= 3 && [c.phone, ...(c.phones ?? [])].some(p => digitsOf(p).includes(digits))) score = 2;
        else if (name.includes(q) || [c.email, ...(c.emails ?? [])].some(e => (e ?? '').toLowerCase().includes(q))) score = 3;
        if (score >= 0) scored.push({ score, c });
    }
    return scored
        .sort((a, b) => a.score - b.score || (a.c.name ?? '').localeCompare(b.c.name ?? ''))
        .slice(0, limit)
        .map(x => x.c);
}
