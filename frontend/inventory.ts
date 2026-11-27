// Worker side of stock locations and custom statuses (rules in inventoryRules.ts):
// the settings route, the one-time move of free-text locations into real ones,
// stock history, and the SQL that sales and tax invoices use to move stock.

import { err, json, runSetupOnce } from './rows';
import { cleanInventorySettings, cleanStock, locationIdFor, type InventorySettings, type Stock } from './inventoryRules';
import type { Ctx, SessionData } from './workerEnv';
import { getSession } from './workerRoles';

const SETTINGS_KEY = 'inventory_settings';

export async function readInventorySettings(kv: KVNamespace): Promise<InventorySettings> {
    try {
        const raw = await kv.get(SETTINGS_KEY);
        if (raw) return cleanInventorySettings(JSON.parse(raw));
    } catch { /* unreadable: start again from the defaults */ }
    return cleanInventorySettings({});
}

const pathOf = (locationId: string) => `$."${locationId}"`;
/** An artwork's units across locations; zero entries are left by json_set and count nothing. */
const TOTAL = "(SELECT COALESCE(SUM(value), 0) FROM json_each(COALESCE(stock, '{}')))";

/** Stock as stored: zero entries dropped. */
export const storedStock = (v: unknown): Stock => cleanStock(v) ?? {};

/**
 * Once per database: stock locations from the free-text Location of artworks,
 * and every artwork's stock put at its location. Run again after restoring
 * an archived artwork (it may predate stock). Same data, same ids (locationIdFor),
 * so two isolates doing this at once write the same thing.
 */
export async function seedStock(db: D1Database, kv: KVNamespace): Promise<void> {
    await db.prepare(`CREATE TABLE IF NOT EXISTS stock_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, artwork_id TEXT NOT NULL, at INTEGER NOT NULL,
        by_id TEXT NOT NULL DEFAULT '', by_name TEXT NOT NULL DEFAULT '', change TEXT NOT NULL, note TEXT NOT NULL DEFAULT '')`).run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_stock_history_artwork ON stock_history (artwork_id, at)').run();
    const { results } = await db.prepare(`SELECT TRIM(location) AS name, SUM(COALESCE(quantity, status <> 'Sold')) AS n FROM artworks
        WHERE stock IS NULL AND TRIM(COALESCE(location, '')) <> '' GROUP BY LOWER(TRIM(location)) ORDER BY n DESC, name`).all<{ name: string; n: number }>();
    const stored = await kv.get(SETTINGS_KEY);
    let settings = await readInventorySettings(kv);
    const norm = (name: string) => name.trim().replaceAll(/\s+/g, ' ').toLowerCase().slice(0, 60);
    const byName = (name: string) => settings.locations.find(l => l.id === locationIdFor(name)) ?? settings.locations.find(l => norm(l.name) === norm(name));
    const missing = results.filter(r => !byName(r.name));
    if (!stored || missing.length) {
        // A first setup: the location holding most units is the default; "Main" only if there are none.
        const fresh = missing.map(r => ({ id: locationIdFor(r.name), name: r.name }));
        const locations = stored ? [...settings.locations, ...fresh] : fresh.map((l, i) => ({ ...l, isDefault: i === 0 }));
        settings = cleanInventorySettings({ ...settings, locations }, stored ? settings : undefined);
        await kv.put(SETTINGS_KEY, JSON.stringify(settings));
    }
    const def = settings.locations.find(l => l.isDefault)!;
    const put = (where: string, id: string, ...binds: unknown[]) => db.prepare(
        `UPDATE artworks SET stock = CASE WHEN COALESCE(quantity, status <> 'Sold') > 0 THEN json_object(?1, COALESCE(quantity, status <> 'Sold')) ELSE '{}' END
         WHERE stock IS NULL${where}`).bind(id, ...binds);
    await db.batch([
        ...results.flatMap(r => { const l = byName(r.name); return l ? [put(' AND LOWER(TRIM(location)) = LOWER(?2)', l.id, r.name)] : []; }),
        put('', def.id),
    ]);
}

/** Runs seedStock once per database (after the artworks table has its columns). */
export const ensureStockSeeded = (db: D1Database, kv: KVNamespace) => runSetupOnce(db, 'stockSeed', () => seedStock(db, kv), 'v1');

/** A row of stock history: `change` is units by location, + in and - out. */
export function historyStmt(db: D1Database, session: SessionData, artworkId: string, change: Stock | Record<string, number>, note: string, guard = '', ...binds: unknown[]): D1PreparedStatement {
    return db.prepare(`INSERT INTO stock_history (artwork_id, at, by_id, by_name, change, note) SELECT ?1, ?2, ?3, ?4, ?5, ?6 ${guard}`)
        .bind(artworkId, Date.now(), session.userId, session.name, JSON.stringify(change), note.slice(0, 200), ...binds);
}

/** Units in (+) or out (-) at one location, never below zero. `where` narrows which pieces it applies to. */
export function addStockStmt(db: D1Database, artworkId: string, locationId: string, delta: number, where = '', ...binds: unknown[]): D1PreparedStatement {
    return db.prepare(`UPDATE artworks SET stock = json_set(COALESCE(stock, '{}'), ?1, MAX(COALESCE(json_extract(stock, ?1), 0) + ?2, 0)) WHERE id = ?3${where}`)
        .bind(pathOf(locationId), delta, artworkId, ...binds);
}

/** After stock moved: quantity is its total, and none left makes the piece Sold; otherwise `statusWhenStocked` (SQL). */
export function recountStmt(db: D1Database, artworkId: string, statusWhenStocked = 'status', where = ''): D1PreparedStatement {
    return db.prepare(`UPDATE artworks SET quantity = ${TOTAL}, status = CASE WHEN ${TOTAL} <= 0 THEN 'Sold' ELSE ${statusWhenStocked} END WHERE id = ?1${where}`).bind(artworkId);
}

export { pathOf };

/** Some artworks' stock exactly as stored (so a later write can check it is unchanged) and status. */
export async function stockOfArtworks(db: D1Database, ids: string[]): Promise<Map<string, { raw: string | null; status: string }>> {
    const unique = [...new Set(ids)].filter(Boolean);
    const chunks = Array.from({ length: Math.ceil(unique.length / 90) }, (_, i) => unique.slice(i * 90, i * 90 + 90));
    const reads = await Promise.all(chunks.map(chunk => db.prepare(`SELECT id, stock, status FROM artworks WHERE id IN (${chunk.map(() => '?').join(',')})`)
        .bind(...chunk).all<{ id: string; stock: string | null; status: string }>()));
    return new Map(reads.flatMap(r => r.results).map(r => [r.id, { raw: r.stock, status: r.status }]));
}

// ── Routes ──────────────────────────────────────────────────────────────────

type Handler = (ctx: Ctx) => Promise<Response>;
const HISTORY_PATH = /^\/artworks\/([\w-]{1,128})\/stock-history$/;

export function inventoryRoutes(deps: { ensureArtworks: (ctx: Ctx) => Promise<void> }): { method: string; match: (path: string) => boolean; handler: Handler }[] {
    /** GET /inventory-settings */
    const get: Handler = async (ctx) => {
        if (!(await getSession(ctx.request, ctx.env.VAYU_KV))) return err('Unauthorized', 401);
        await deps.ensureArtworks(ctx);
        return json(await readInventorySettings(ctx.env.VAYU_KV));
    };

    /** PUT /inventory-settings — the whole lists; a location that still holds stock can't be archived. */
    const put: Handler = async (ctx) => {
        if (!(await getSession(ctx.request, ctx.env.VAYU_KV))) return err('Unauthorized', 401);
        await deps.ensureArtworks(ctx);
        const before = await readInventorySettings(ctx.env.VAYU_KV);
        const next = cleanInventorySettings(await ctx.request.json().catch(() => null), before);
        const archiving = next.locations.filter(l => l.archived && !before.locations.find(b => b.id === l.id)?.archived);
        for (const l of archiving) {
            const holding = await ctx.env.VAYU_DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(json_extract(stock, ?1)), 0) AS units FROM artworks WHERE COALESCE(json_extract(stock, ?1), 0) > 0`)
                .bind(pathOf(l.id)).first<{ n: number; units: number }>();
            if (holding && holding.n > 0) return err(`${l.name} still holds ${holding.units} ${holding.units === 1 ? 'unit' : 'units'} (${holding.n} ${holding.n === 1 ? 'artwork' : 'artworks'}). Move them first.`, 409);
        }
        await ctx.env.VAYU_KV.put(SETTINGS_KEY, JSON.stringify(next));
        return json(next);
    };

    /** GET /artworks/:id/stock-history — newest first. */
    const history: Handler = async (ctx) => {
        if (!(await getSession(ctx.request, ctx.env.VAYU_KV))) return err('Unauthorized', 401);
        await deps.ensureArtworks(ctx);
        const id = HISTORY_PATH.exec(ctx.path)![1];
        const { results } = await ctx.env.VAYU_DB.prepare('SELECT at, by_name, change, note FROM stock_history WHERE artwork_id = ? ORDER BY at DESC, id DESC LIMIT 100')
            .bind(id).all<{ at: number; by_name: string; change: string; note: string }>();
        return json(results.map(r => {
            let change: Record<string, number> = {};
            try { change = JSON.parse(r.change); } catch { /* unreadable row: shown without units */ }
            return { at: r.at, byName: r.by_name, change, note: r.note };
        }));
    };

    return [
        { method: 'GET', match: p => p === '/inventory-settings', handler: get },
        { method: 'PUT', match: p => p === '/inventory-settings', handler: put },
        { method: 'GET', match: p => HISTORY_PATH.test(p), handler: history },
    ];
}
