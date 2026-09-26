// The organization's plan, and how much of each limit it uses — for the
// app's Admin → Plan tab, so an organization can see where it stands and ask
// for a larger plan before it runs out.
//
// Counts come from the organization's own app data (the database, files and
// members the app actually uses). Limits and what is included come from the
// platform (resolveEntitlements), overrides applied.

import type { Env } from './workerEnv';
import { resolveEntitlements, seatUsage, limitOf } from './platform/plans';
import { FEATURE_FIELDS, LIMIT_FIELDS, MODULE_FIELDS } from './platform/planFields';

export interface UsageRow {
  key: string;
  label: string;
  hint: string;
  /** null: not counted (not recorded yet, or couldn't be read). */
  used: number | null;
  /** null: unlimited. */
  limit: number | null;
  unit?: 'MB';
  period?: 'month';
  /** The app stops new ones at the limit (otherwise it is a guide for now). */
  enforced: boolean;
}

/** Not usage: guest access isn't built, and history length is a setting. */
const NOT_USAGE = new Set(['maxGuests', 'auditRetentionDays']);
/** Limits the app itself stops at. The others are shown as a guide. */
const APP_ENFORCED = new Set(['maxMembers']);

const STORAGE_CACHE_KEY = 'plan:storage-bytes';
const STORAGE_CACHE_SECONDS = 6 * 3600;
/** Beyond this many listing pages (1,000 files each) the total isn't worth a request's time. */
const MAX_STORAGE_PAGES = 50;

/**
 * Bytes of files the organization stores, cached for a few hours: counting
 * means listing every file. For the organization that owns the original
 * app's storage, other organizations' folders ("orgs/…") are left out.
 */
async function storageBytes(env: Env): Promise<number | null> {
  const cached = await env.VAYU_KV.get<{ bytes: number }>(STORAGE_CACHE_KEY, 'json').catch(() => null);
  if (cached && Number.isFinite(cached.bytes)) return cached.bytes;
  const skipOthers = env.ORG_STORAGE !== 'own';
  let bytes = 0;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_STORAGE_PAGES; page++) {
    const listing = await env.VAYU_R2.list({ cursor, limit: 1000 });
    for (const object of listing.objects) {
      if (skipOthers && object.key.startsWith('orgs/')) continue;
      bytes += object.size;
    }
    if (!listing.truncated) {
      await env.VAYU_KV.put(STORAGE_CACHE_KEY, JSON.stringify({ bytes }), { expirationTtl: STORAGE_CACHE_SECONDS }).catch(() => undefined);
      return bytes;
    }
    cursor = listing.cursor;
  }
  return null;
}

/** First moment of this calendar month, India time (the app's customers are there). */
function monthStartIst(now = Date.now()): number {
  const ist = new Date(now + 5.5 * 3600_000);
  return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - 5.5 * 3600_000;
}

export async function planAndUsage(env: Env) {
  if (!env.ORG_ID || !env.PLATFORM_DB) return null;
  const db = env.VAYU_DB;
  const count = async (sql: string, ...binds: unknown[]): Promise<number | null> => {
    try {
      const row = await db.prepare(sql).bind(...binds).first<{ n: number }>();
      return row?.n ?? 0;
    } catch {
      return null; // the table doesn't exist yet: nothing counted
    }
  };
  const since = monthStartIst();
  const [entitlements, seats, items, collections, catalogs, contacts, stores, rooms, invoices, inquiries, bytes] = await Promise.all([
    resolveEntitlements(env.PLATFORM_DB, env.ORG_ID),
    seatUsage(env.PLATFORM_DB, env.ORG_ID).then(s => s.used).catch(() => null),
    count('SELECT COUNT(*) AS n FROM artworks'),
    count('SELECT COUNT(*) AS n FROM collections'),
    count('SELECT COUNT(*) AS n FROM catalogs'),
    count('SELECT COUNT(*) AS n FROM contacts'),
    count('SELECT COUNT(*) AS n FROM stores'),
    count('SELECT COUNT(*) AS n FROM conversations WHERE is_private = 1'),
    count('SELECT COUNT(*) AS n FROM invoices WHERE date >= ?', since),
    count('SELECT COUNT(*) AS n FROM inquiries WHERE date >= ?', since),
    storageBytes(env).catch(() => null),
  ]);

  const used: Record<string, number | null> = {
    maxMembers: seats,
    maxItems: items,
    maxCollections: collections,
    maxCatalogs: catalogs,
    maxContacts: contacts,
    maxStores: stores,
    maxPrivateRooms: rooms,
    storageMb: bytes === null ? null : Math.round((bytes / 1048576) * 10) / 10,
    // Not recorded by the app yet.
    pdfGenerationsPerMonth: null,
    invoicesPerMonth: invoices,
    inquiriesPerMonth: inquiries,
  };

  const usage: UsageRow[] = LIMIT_FIELDS.filter(f => !NOT_USAGE.has(f.key)).map(f => ({
    key: f.key,
    label: f.label.replace(' (MB)', ''),
    hint: f.hint,
    used: used[f.key] ?? null,
    limit: limitOf(entitlements, f.key),
    ...(f.key === 'storageMb' ? { unit: 'MB' as const } : {}),
    ...(f.period ? { period: f.period } : {}),
    enforced: APP_ENFORCED.has(f.key),
  }));

  const included = (fields: typeof MODULE_FIELDS, on: Record<string, boolean>) =>
    fields.filter(f => on[f.key]).map(f => f.label);

  return {
    plan: entitlements.plan,
    subscription: entitlements.subscription,
    active: entitlements.active,
    usage,
    modules: included(MODULE_FIELDS, entitlements.limits.modules),
    features: included(FEATURE_FIELDS, entitlements.limits.features),
    historyDays: limitOf(entitlements, 'auditRetentionDays'),
    monthStartedAt: since,
  };
}
