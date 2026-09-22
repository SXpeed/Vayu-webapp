// Which change-log entities a caller may read, derived from the same role
// permissions the REST routes enforce. Pure and dependency-light so the
// Worker, the SyncHub Durable Object and the unit tests can all use it.
import {
  ADMIN_PERMISSIONS, ADMIN_ROLE_ID, atLeast, normalizePermissions,
  type AccessLevel, type Permissions, type RoleDef, type SectionId,
} from './permissions';

/** Entity names as they appear in change_log.entity. */
export const SYNC_ENTITIES = [
  'artwork', 'collection', 'catalog', 'contact', 'inquiry', 'inquiry_message',
  'invoice', 'event', 'message', 'conversation', 'attendance', 'store',
] as const;
export type SyncEntity = (typeof SYNC_ENTITIES)[number];

/**
 * Signal-only entities carried on hub invalidate events but never written to
 * change_log (their records live in KV, which cannot share a D1 transaction).
 * Clients respond by refetching that dataset through its REST endpoint.
 */
export type SignalEntity = 'payments';

export function permissionsForRoles(roles: RoleDef[], roleId: string): Permissions {
  if (roleId === ADMIN_ROLE_ID) return ADMIN_PERMISSIONS;
  return roles.find(r => r.id === roleId)?.permissions ?? normalizePermissions({});
}

/**
 * The entity set a role may read. Mirrors accessRule() in worker.ts — the
 * same "this screen's data is also readable by these other screens" rules
 * (e.g. collections and invoices show artwork data).
 */
export function readableEntities(perms: Permissions): Set<SyncEntity> {
  const can = (section: SectionId, level: AccessLevel = 'view') => atLeast(perms[section], level);
  const set = new Set<SyncEntity>();
  if (can('inventory') || can('collections') || can('catalogs') || can('inquiries') || can('invoices')) {
    set.add('artwork');
  }
  if (can('collections')) set.add('collection');
  if (can('catalogs')) set.add('catalog');
  if (can('contacts') || can('inquiries') || can('invoices') || can('payments')) set.add('contact');
  if (can('inquiries')) { set.add('inquiry'); set.add('inquiry_message'); }
  if (can('invoices')) set.add('invoice');
  if (can('calendar')) set.add('event');
  if (can('messages')) { set.add('message'); set.add('conversation'); }
  if (can('attendance')) { set.add('attendance'); set.add('store'); }
  return set;
}

/** Payment links live in KV; their hub signal is gated by the payments section. */
export function canReadPayments(perms: Permissions): boolean {
  return atLeast(perms['payments'], 'view');
}

/** True when the row's scope allows this user (scope null = team-wide). */
export function scopeAllows(scope: string | null, userId: string, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  if (!scope) return true;
  try {
    const ids = JSON.parse(scope) as unknown;
    return Array.isArray(ids) && ids.includes(userId);
  } catch {
    return false; // malformed scope: fail closed
  }
}
