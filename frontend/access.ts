import type { AuthUser } from './services/authService';
import type { ViewState } from './types';
import {
    ADMIN_PERMISSIONS, ADMIN_ROLE_ID, STAFF_DEFAULT_PERMISSIONS, atLeast, normalizePermissions, withoutSections,
    type AccessLevel, type Permissions, type SectionId,
} from './permissions';

/** Which section each screen belongs to. Unlisted screens (home, profile) are always open. */
export const VIEW_SECTION: Partial<Record<ViewState, SectionId>> = {
    artworks: 'inventory',
    collections: 'collections',
    catalogs: 'catalogs',
    contacts: 'contacts',
    inquiry: 'inquiries',
    invoice: 'invoices',
    payments: 'payments',
    sales: 'sales',
    calendar: 'calendar',
    messaging: 'messages',
    attendance: 'attendance',
    schedule: 'schedule',
    activity: 'activity',
};

/**
 * A signed-in person's permissions. The server sends them with the user;
 * a server from before roles existed doesn't, so fall back to how it
 * behaved then (admins everything, everyone else the Staff defaults).
 */
export function permissionsOf(user: AuthUser | null | undefined): Permissions {
    if (!user) return normalizePermissions({});
    // What the plan leaves out is closed to admins too (the server says which).
    if (user.role === ADMIN_ROLE_ID) return withoutSections(ADMIN_PERMISSIONS, user.sectionsOff);
    return user.permissions ? normalizePermissions(user.permissions) : STAFF_DEFAULT_PERMISSIONS;
}

export type CanFn = (section: SectionId, level?: AccessLevel) => boolean;

export const makeCan = (perms: Permissions): CanFn =>
    (section, level = 'view') => atLeast(perms[section], level);

/** Can this person open a screen at all? */
export const canOpenView = (can: CanFn, view: ViewState): boolean => {
    const section = VIEW_SECTION[view];
    return !section || can(section, 'view');
};
