/*
 * Inventory settings (stock locations, custom statuses) and per-location stock,
 * shared by the Worker and the app. Dependency-free so both bundles import it.
 *
 * An artwork's `status` stays one of the three base statuses that sales and
 * billing rely on; a custom status is a label (`statusLabel`) that behaves
 * like one of them. `stock` is units by location id; `quantity` is its total.
 */

export type BaseStatus = 'Available' | 'Reserved' | 'Sold';
export const BASE_STATUSES: BaseStatus[] = ['Available', 'Reserved', 'Sold'];

export const STATUS_COLORS = ['green', 'amber', 'red', 'blue', 'violet', 'gray'] as const;
export type StatusColor = typeof STATUS_COLORS[number];
const BASE_COLOR: Record<BaseStatus, StatusColor> = { Available: 'green', Reserved: 'amber', Sold: 'red' };

export interface StockLocation { id: string; name: string; isDefault?: boolean; archived?: boolean }
/** A built-in status has its base status as id and can be renamed, not removed. */
export interface StatusDef { id: string; name: string; behaves: BaseStatus; color: StatusColor; archived?: boolean }
export interface InventorySettings { locations: StockLocation[]; statuses: StatusDef[] }
/** Units by location id; only locations that hold some. */
export type Stock = Record<string, number>;

const MAX_LOCATIONS = 100;
const MAX_STATUSES = 50;
const MAX_UNITS = 1_000_000;
const LOCATION_ID = /^loc_[a-z0-9]{4,40}$/;
const STATUS_ID = /^st_[a-z0-9]{4,40}$/;

/** Same name, same id: two isolates setting up the same workspace at once agree. */
export function locationIdFor(name: string): string {
    let h = 0x811c9dc5;
    for (const ch of name.trim().toLowerCase()) h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193) >>> 0;
    return `loc_${h.toString(36).padStart(7, '0')}`;
}

export const newLocationId = () => `loc_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
export const newStatusId = () => `st_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;

const MAIN: StockLocation = { id: locationIdFor('Main'), name: 'Main', isDefault: true };
const builtIn = (s: BaseStatus): StatusDef => ({ id: s, name: s, behaves: s, color: BASE_COLOR[s] });

/** Before the server's copy arrives (first visit offline). */
export const DEFAULT_INVENTORY_SETTINGS: InventorySettings = { locations: [MAIN], statuses: BASE_STATUSES.map(builtIn) };

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().replaceAll(/\s+/g, ' ').slice(0, max) : '');
const asList = (v: unknown, max: number): Record<string, unknown>[] =>
    (Array.isArray(v) ? v : []).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object').slice(0, max);

/** `name`, or "name (2)", "name (3)"… if taken (case aside); the name is then taken. */
function uniqueName(name: string, taken: Set<string>): string {
    let out = name;
    let n = 2;
    while (taken.has(out.toLowerCase())) {
        out = `${name} (${n})`;
        n++;
    }
    taken.add(out.toLowerCase());
    return out;
}

const flags = (x: Record<string, unknown>) => ({ ...(x.isDefault === true && { isDefault: true }), ...(x.archived === true && { archived: true }) });
const colorOf = (v: unknown, fallback: StatusColor): StatusColor => ((STATUS_COLORS as readonly string[]).includes(v as string) ? v as StatusColor : fallback);

/** Locations sent, then any from before that weren't, always with one active default. */
function cleanLocations(sent: unknown, previous: StockLocation[]): StockLocation[] {
    const locations: StockLocation[] = [];
    const names = new Set<string>();
    for (const l of asList(sent, MAX_LOCATIONS)) {
        const id = typeof l.id === 'string' && LOCATION_ID.test(l.id) ? l.id : '';
        const name = text(l.name, 60);
        // A repeated id or name is dropped, never merged.
        if (!id || !name || locations.some(x => x.id === id) || names.has(name.toLowerCase())) continue;
        names.add(name.toLowerCase());
        locations.push({ id, name, ...flags(l) });
    }
    for (const l of previous) {
        if (!locations.some(x => x.id === l.id)) locations.push({ ...l, name: uniqueName(l.name, names) });
    }
    if (!locations.some(l => !l.archived)) {
        const name = uniqueName('Main', names);
        locations.unshift({ id: name === 'Main' ? MAIN.id : locationIdFor(name), name });
    }
    return withOneDefault(locations);
}

/** Exactly one default: the one marked, if active, else the first active. */
function withOneDefault(locations: StockLocation[]): StockLocation[] {
    const def = locations.find(l => l.isDefault && !l.archived) ?? locations.find(l => !l.archived)!;
    for (const l of locations) {
        if (l === def) l.isDefault = true;
        else delete l.isDefault;
    }
    return locations;
}

/** The built-ins first (so they keep their names), then custom ones in the order sent, then any from before that weren't. */
function cleanStatuses(sent: unknown, previous: StatusDef[]): StatusDef[] {
    const list = asList(sent, MAX_STATUSES);
    const statuses: StatusDef[] = [];
    const names = new Set<string>();
    const push = (st: StatusDef) => statuses.push({ ...st, name: uniqueName(st.name, names) });
    for (const b of BASE_STATUSES) {
        const given = list.find(x => x.id === b);
        push(given
            ? { id: b, name: text(given.name, 40) || b, behaves: b, color: colorOf(given.color, BASE_COLOR[b]) }
            : previous.find(x => x.id === b) ?? builtIn(b));
    }
    for (const x of list) {
        const id = typeof x.id === 'string' ? x.id : '';
        const behaves = BASE_STATUSES.find(b => b === x.behaves);
        const name = text(x.name, 40);
        if (STATUS_ID.test(id) && behaves && name && !statuses.some(st => st.id === id)) {
            push({ id, name, behaves, color: colorOf(x.color, BASE_COLOR[behaves]), ...(x.archived === true && { archived: true }) });
        }
    }
    for (const st of previous) if (!statuses.some(x => x.id === st.id)) push({ ...st });
    return statuses;
}

/**
 * Settings as sent or stored, cleaned. Nothing in `previous` is ever lost: a
 * location or custom status missing from `raw` (a device that opened the
 * settings before someone added it) comes back as it was, so stock and labels
 * never point at an id that no longer exists. Removing is archiving, sent explicitly.
 */
export function cleanInventorySettings(raw: unknown, previous?: InventorySettings): InventorySettings {
    const src = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    return { locations: cleanLocations(src.locations, previous?.locations ?? []), statuses: cleanStatuses(src.statuses, previous?.statuses ?? []) };
}

export const defaultLocation = (s: InventorySettings): StockLocation => s.locations.find(l => l.isDefault) ?? s.locations[0] ?? MAIN;

/** Stock as sent or stored: whole units at known locations, none at zero, in a stable order. null when not sent. */
export function cleanStock(raw: unknown, knownIds?: ReadonlySet<string>): Stock | null {
    let v = raw;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const out: Stock = {};
    for (const id of Object.keys(v).sort((a, b) => a.localeCompare(b))) {
        const n = (v as Record<string, unknown>)[id];
        if (!LOCATION_ID.test(id) || (knownIds && !knownIds.has(id))) continue;
        if (Number.isInteger(n) && (n as number) > 0 && (n as number) <= MAX_UNITS) out[id] = n as number;
    }
    return out;
}

export const totalOf = (stock: Stock): number => Object.values(stock).reduce((n, q) => n + q, 0);

/** An artwork's stock; a record from before locations has all of it at the default location. */
export function stockByLocation(a: { stock?: Stock; quantity?: number; status: string }, settings: InventorySettings): Stock {
    if (a.stock) return a.stock;
    const q = a.quantity ?? Number(a.status !== 'Sold');
    return q > 0 ? { [defaultLocation(settings).id]: q } : {};
}

/** Where a sale of `qty` comes from: the one asked for, else the default, else the location with most. null when no one location has enough. */
export function pickLocation(stock: Stock, qty: number, defaultId: string, wanted?: string | null): string | null {
    if (wanted) return (stock[wanted] ?? 0) >= qty ? wanted : null;
    if ((stock[defaultId] ?? 0) >= qty) return defaultId;
    const most = Object.entries(stock).sort((a, b) => b[1] - a[1])[0];
    if (!most || most[1] < qty) return null;
    return most[0];
}

/** Where an invoice's units come from: the default first, then the fullest; only what is there. */
export function takePlan(stock: Stock, qty: number, defaultId: string): { locationId: string; qty: number }[] {
    const order = Object.entries(stock).sort((a, b) => Number(b[0] === defaultId) - Number(a[0] === defaultId) || b[1] - a[1]);
    const plan: { locationId: string; qty: number }[] = [];
    let left = qty;
    for (const [locationId, have] of order) {
        if (left <= 0) break;
        const take = Math.min(have, left);
        plan.push({ locationId, qty: take });
        left -= take;
    }
    return plan;
}

/** The status a piece shows: its custom label while that still matches how it behaves, else its base status. */
export function statusOf(a: { status: string; statusLabel?: string }, settings: InventorySettings): StatusDef {
    const base = BASE_STATUSES.find(b => b === a.status) ?? 'Available';
    const custom = a.statusLabel ? settings.statuses.find(s => s.id === a.statusLabel) : undefined;
    if (custom?.behaves === base) return custom;
    return settings.statuses.find(s => s.id === base) ?? builtIn(base);
}

/** "Store 3 · Office 2", in settings order; a location missing from settings still shows. */
export function stockLabel(stock: Stock, settings: InventorySettings, withUnits = true): string {
    const known = settings.locations.filter(l => stock[l.id]).map(l => [l.name, stock[l.id]] as const);
    const unknown = Object.keys(stock).filter(id => !settings.locations.some(l => l.id === id)).map(id => ['Removed location', stock[id]] as const);
    return [...known, ...unknown].map(([name, n]) => (withUnits ? `${name} ${n}` : name)).join(' · ');
}

/** Margin on a sale at `price`: rupees and percent of price; null without both prices. */
export function marginOf(price: number, cost: number | undefined): { amount: number; percent: number } | null {
    if (!cost || cost <= 0 || !price || price <= 0) return null;
    return { amount: price - cost, percent: Math.round(((price - cost) / price) * 1000) / 10 };
}
