// Who a push notification goes to, and which person a device belongs to.
// Plain rules, so they can be tested on their own (tests/pushRules.test.mjs);
// worker.ts does the storage around them.

import { atLeast, type RoleDef, type SectionId } from './permissions';
import { permissionsForRoles } from './entityAccess';

/**
 * The devices to notify about something in `section` (an inquiry, a
 * payment): those of people who still have an account here and whose role
 * can see that section, except `exceptUserId` (who did it).
 * `roleOf` holds the role of each current member (absent: removed).
 */
export function sectionRecipients<T extends { userId: string }>(
  subs: T[], roleOf: Map<string, string>, roles: RoleDef[], section: SectionId, exceptUserId: string,
): T[] {
  return subs.filter(sub => {
    if (sub.userId === exceptUserId) return false;
    const role = roleOf.get(sub.userId);
    return role !== undefined && atLeast(permissionsForRoles(roles, role)[section], 'view');
  });
}

/** Which person, in which workspace (its KV prefix), a push device belongs to. */
export interface PushOwner { scope: string; userId: string }

/**
 * A device is claimed by whoever turns notifications on, or signs in, on it.
 * Returns the KV key (from the top of the shared namespace) of the previous
 * holder's registration, to remove, or null when it was theirs already.
 */
export function staleRegistration(previous: PushOwner | null, next: PushOwner, deviceId: string): string | null {
  if (!previous) return null;
  if (previous.scope === next.scope && previous.userId === next.userId) return null;
  return `${previous.scope}push:sub:${previous.userId}:${deviceId}`;
}
