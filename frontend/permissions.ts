/*
 * Role-based access: shared by the Worker (enforcement) and the app (what to
 * show). Keep this file dependency-free so both bundles can import it.
 *
 * A role grants each section one level:
 *   none — hidden entirely; the server refuses its data
 *   view — can see, can't create/change/delete
 *   edit — full use
 * "admin" is built in, always has everything, and can't be edited. User and
 * role management and the deleted-items archive stay admin-only.
 */

export type AccessLevel = 'none' | 'view' | 'edit';

export type SectionId =
    | 'inventory' | 'collections' | 'catalogs' | 'contacts' | 'inquiries' | 'invoices'
    | 'payments' | 'calendar' | 'messages' | 'attendance' | 'activity';

export interface SectionDef {
    id: SectionId;
    label: string;
    description: string;
    /** Wording for view / edit where the generic words would mislead. */
    levelLabels?: Partial<Record<AccessLevel, string>>;
}

export const SECTIONS: SectionDef[] = [
    { id: 'inventory', label: 'Inventory', description: 'Artworks, prices and photos' },
    { id: 'collections', label: 'Collections', description: 'Grouped artworks' },
    { id: 'catalogs', label: 'Catalogs', description: 'Catalog PDFs and the catalog builder' },
    { id: 'contacts', label: 'Contacts', description: 'Client phone numbers and emails' },
    { id: 'inquiries', label: 'Inquiries', description: 'Customer inquiries and their chats' },
    { id: 'invoices', label: 'Proforma invoices', description: 'Proforma invoices (stored on each device)' },
    { id: 'payments', label: 'Payments', description: 'Payment links' },
    { id: 'calendar', label: 'Calendar', description: 'Events and holidays' },
    { id: 'messages', label: 'Messages', description: 'Team chat' },
    {
        id: 'attendance', label: 'Attendance', description: 'Check in/out and the team’s records',
        levelLabels: { view: 'Own', edit: 'Manage' },
    },
    { id: 'activity', label: 'Activity log', description: 'Who changed what (read-only)' },
];

export const SECTION_IDS: SectionId[] = SECTIONS.map(s => s.id);

export type Permissions = Record<SectionId, AccessLevel>;

export interface RoleDef {
    id: string;
    name: string;
    /** Built-in roles can't be deleted; "admin" can't be edited either. */
    builtIn?: boolean;
    permissions: Permissions;
}

export const ADMIN_ROLE_ID = 'admin';
export const STAFF_ROLE_ID = 'user';

const all = (level: AccessLevel): Permissions =>
    Object.fromEntries(SECTION_IDS.map(id => [id, level])) as Permissions;

/** Everything, always. */
export const ADMIN_PERMISSIONS: Permissions = all('edit');

/**
 * Staff starts exactly as regular users worked before roles existed: every
 * data section, their own attendance, no activity log.
 */
export const STAFF_DEFAULT_PERMISSIONS: Permissions = { ...all('edit'), attendance: 'view', activity: 'none' };

export const BUILT_IN_ROLES: RoleDef[] = [
    { id: ADMIN_ROLE_ID, name: 'Admin', builtIn: true, permissions: ADMIN_PERMISSIONS },
    { id: STAFF_ROLE_ID, name: 'Staff', builtIn: true, permissions: STAFF_DEFAULT_PERMISSIONS },
];

const LEVEL_RANK: Record<AccessLevel, number> = { none: 0, view: 1, edit: 2 };

export const atLeast = (have: AccessLevel | undefined, need: AccessLevel): boolean =>
    LEVEL_RANK[have ?? 'none'] >= LEVEL_RANK[need];

/** Fill gaps with 'none' and drop anything unknown (e.g. a section removed later). */
export function normalizePermissions(input: unknown): Permissions {
    const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const out = all('none');
    for (const id of SECTION_IDS) {
        const v = src[id];
        if (v === 'view' || v === 'edit' || v === 'none') out[id] = v;
    }
    return out;
}
