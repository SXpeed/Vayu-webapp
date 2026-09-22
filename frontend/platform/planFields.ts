// Everything a plan can control, in one list.
//
// The API validates against this, and the control panel renders its editor
// from it, so adding a new limit or feature later means adding one entry here
// — no new form code, no new validation.
//
// Keep keys stable: they are stored inside published plan versions and in
// per-organization overrides. `enforced: false` marks a setting that can be
// chosen today but that the app does not yet check; docs/PLANS.md lists them.

export interface LimitField {
  key: string;
  label: string;
  /** What it counts, shown under the input. */
  hint: string;
  /** Blank means unlimited. */
  nullable: boolean;
  max: number;
  /** A per-month allowance rather than a running total. */
  period?: 'month';
  default: number | null;
  enforced?: boolean;
}

export interface FlagField {
  key: string;
  label: string;
  hint: string;
  default: boolean;
  /** Part of every plan: shown ticked and locked, and always saved as on. */
  alwaysOn?: boolean;
  enforced?: boolean;
}

/** Countable limits. */
export const LIMIT_FIELDS: LimitField[] = [
  { key: 'maxMembers', label: 'Employee seats', hint: 'Enabled people, the owner included.', nullable: true, max: 100_000, default: 3, enforced: true },
  { key: 'maxGuests', label: 'Guest accounts', hint: 'Limited outside accounts. Reserved: guest access is not built yet.', nullable: true, max: 100_000, default: 0, enforced: false },
  { key: 'maxItems', label: 'Products / inventory items', hint: 'Artworks and other stock records held at once.', nullable: true, max: 10_000_000, default: 500, enforced: true },
  { key: 'maxCollections', label: 'Collections', hint: 'Groupings of inventory.', nullable: true, max: 1_000_000, default: 50, enforced: false },
  { key: 'maxCatalogs', label: 'Catalogs', hint: 'Saved catalogs kept at once.', nullable: true, max: 1_000_000, default: 50, enforced: false },
  { key: 'maxStores', label: 'Stores / locations', hint: 'Places attendance and stock can be tied to.', nullable: true, max: 10_000, default: 1, enforced: false },
  { key: 'maxContacts', label: 'Customer records', hint: 'People in the address book.', nullable: true, max: 1_000_000, default: 1000, enforced: false },
  { key: 'maxPrivateRooms', label: 'Private rooms', hint: 'Group conversations that can exist at once.', nullable: true, max: 100_000, default: 15, enforced: false },
  { key: 'storageMb', label: 'Storage (MB)', hint: 'Images, PDFs and attachments.', nullable: true, max: 10_000_000, default: 1024, enforced: false },
  { key: 'pdfGenerationsPerMonth', label: 'PDF generations / month', hint: 'Catalog and invoice PDFs built each month.', nullable: true, max: 100_000, period: 'month', default: 200, enforced: false },
  { key: 'invoicesPerMonth', label: 'Invoices / month', hint: 'Invoices and proformas issued each month.', nullable: true, max: 100_000, period: 'month', default: 50, enforced: false },
  { key: 'inquiriesPerMonth', label: 'Inquiries / month', hint: 'New customer inquiries logged each month.', nullable: true, max: 100_000, period: 'month', default: 200, enforced: false },
  { key: 'auditRetentionDays', label: 'Activity history (days)', hint: 'How long business activity is kept.', nullable: false, max: 3650, default: 90, enforced: false },
];

/** Parts of the app a plan includes. */
export const MODULE_FIELDS: FlagField[] = [
  { key: 'inventory', label: 'Inventory', hint: 'Artworks and stock records.', default: true, alwaysOn: true },
  { key: 'collections', label: 'Collections', hint: 'Group inventory into collections.', default: true },
  { key: 'catalogs', label: 'Catalogs', hint: 'Build and share catalogs.', default: true },
  { key: 'contacts', label: 'Customers', hint: 'Customer address book.', default: true },
  { key: 'inquiries', label: 'Inquiries', hint: 'Track interest through to a sale.', default: true },
  { key: 'invoices', label: 'Invoices', hint: 'Invoices and proformas.', default: true },
  { key: 'payments', label: 'Payments', hint: 'Collect customer payments through the organization’s own account.', default: false },
  { key: 'messaging', label: 'Direct & group messages', hint: 'Internal chat with photos and tags.', default: true },
  { key: 'privateRooms', label: 'Private rooms', hint: 'Closed group conversations.', default: true },
  { key: 'calendar', label: 'Calendar & follow-ups', hint: 'Events, reminders and follow-ups.', default: true },
  { key: 'attendance', label: 'Attendance', hint: 'Check-in and check-out with location.', default: false },
];

/** Capabilities that are not a whole module. */
export const FEATURE_FIELDS: FlagField[] = [
  { key: 'catalogPdf', label: 'Catalog PDF export', hint: 'Download catalogs as print-ready PDFs.', default: true },
  { key: 'backgroundRemoval', label: 'Background removal', hint: 'Cut out artwork photos automatically.', default: false },
  { key: 'bulkImport', label: 'Bulk CSV import', hint: 'Import inventory and contacts from a spreadsheet. Not built yet.', default: false, enforced: false },
  { key: 'exports', label: 'Data export & reports', hint: 'Download inventory, contacts and reports.', default: false, enforced: false },
  { key: 'customRoles', label: 'Custom roles', hint: 'Roles beyond owner, admin, manager and staff.', default: false, enforced: false },
  { key: 'branding', label: 'Own branding', hint: 'Organization logo and name on the app and documents.', default: false, enforced: false },
  { key: 'apiAccess', label: 'API access', hint: 'Programmatic access for integrations.', default: false, enforced: false },
  { key: 'prioritySupport', label: 'Priority support', hint: 'Faster response commitment.', default: false, enforced: false },
  { key: 'auditHistory', label: 'Admin activity history', hint: 'Who changed what, inside the organization.', default: true, alwaysOn: true },
];

/** Sent to the control panel so its editor is always in step with this list. */
export const PLAN_SCHEMA = {
  limits: LIMIT_FIELDS,
  modules: MODULE_FIELDS,
  features: FEATURE_FIELDS,
  billingTypes: ['free', 'trial', 'paid', 'custom'],
};
