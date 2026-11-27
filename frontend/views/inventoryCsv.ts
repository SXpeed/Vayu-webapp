// Inventory as a spreadsheet: export the artworks to CSV, edit in Excel, import
// it back. A row whose Inventory ID matches an artwork updates it (photos kept);
// any other row adds a new artwork. Photos come only with an .xlsx (inventoryXlsx.ts).
// Stock is one "Qty: <location>" column per location; a file without those
// (older, or typed by hand) reads Quantity at its Location, else the default.

import { stockOf, type Artwork } from '../types';
import { DEFAULT_INVENTORY_SETTINGS, defaultLocation, stockByLocation, statusOf, type InventorySettings, type Stock } from '../inventoryRules';
import { parseCsv } from './staffRoster/planRules';

export const INVENTORY_COLUMNS = [
    'Inventory ID', 'Title', 'Artist', 'Year', 'Medium', 'Dimensions', 'Price', 'Plus GST', 'Status', 'Location',
    'Edition size', 'Artist proofs', 'Edition number', 'Description title', 'Description', 'Quantity',
] as const;
const COST = 'Cost price';
const QTY = 'Qty: ';

const norm = (s: string) => s.trim().replaceAll(/\s+/g, ' ').toLowerCase();

/** Locations that get a column: the active ones, and any archived one these artworks still hold stock at. */
const columnLocations = (artworks: Artwork[], s: InventorySettings) =>
    s.locations.filter(l => !l.archived || artworks.some(a => stockByLocation(a, s)[l.id]));

/** Header row, then one row per artwork. Cost price only when `withCost` (the person can see it). */
export function inventoryRows(artworks: Artwork[], settings: InventorySettings = DEFAULT_INVENTORY_SETTINGS, withCost = false): (string | number)[][] {
    const locations = columnLocations(artworks, settings);
    return [[...INVENTORY_COLUMNS, ...locations.map(l => `${QTY}${l.name}`), ...(withCost ? [COST] : [])], ...artworks.map(a => {
        const stock = stockByLocation(a, settings);
        return [
            a.customId, a.title, a.artist ?? '', a.artworkYear ?? '', a.medium, a.dimensions, a.price, a.plusGst ? 'Yes' : '', statusOf(a, settings).name, a.location,
            a.edition?.size ?? '', a.edition?.proofs ?? '', a.edition?.number ?? '', a.descriptionTitle ?? '', a.description, stockOf(a),
            ...locations.map(l => stock[l.id] ?? 0), ...(withCost ? [a.costPrice ?? ''] : []),
        ];
    })];
}

export type ImportedArtwork = Omit<Artwork, 'id' | 'createdAt' | 'imageUrls'>;

/**
 * What an import would do: rows whose Inventory ID matches an artwork update
 * it (only when something changed; photos kept), the others are added.
 * `photoCounts[i]` > 0 means row i brings photos: they go on a new artwork, or
 * on an existing one that has none (so importing the same file twice doesn't
 * double them). `addFrom` / `updateFrom` give each one's row index in `rows`.
 */
export function planImport(artworks: Artwork[], rows: ImportedArtwork[], photoCounts: number[] = [], settings: InventorySettings = DEFAULT_INVENTORY_SETTINGS) {
    const byInventoryId = new Map(artworks.filter(a => a.customId.trim()).map(a => [a.customId.trim().toLowerCase(), a]));
    const adds: ImportedArtwork[] = [], addFrom: number[] = [];
    const updates: Artwork[] = [], updateFrom: number[] = [], takesPhotos: boolean[] = [];
    const sameRow = (a: Artwork, b: Artwork) => JSON.stringify(inventoryRows([a], settings, true)[1]) === JSON.stringify(inventoryRows([b], settings, true)[1]);
    rows.forEach((row, i) => {
        const existing = row.customId ? byInventoryId.get(row.customId.toLowerCase()) : undefined;
        const photos = (photoCounts[i] ?? 0) > 0 && !existing?.imageUrls.length;
        if (!existing) { adds.push(row); addFrom.push(i); }
        // stockSeen: a sale since this device's copy keeps its stock and status (the server checks).
        else if (photos || !sameRow({ ...existing, ...row }, existing)) { updates.push({ ...existing, ...row, stockSeen: { status: existing.status, quantity: stockOf(existing) } }); updateFrom.push(i); takesPhotos.push(photos); }
    });
    return { adds, updates, addFrom, updateFrom, takesPhotos };
}

/** " 2 rows can't be read …: row 4, 9." for the confirmation, or ''. */
export function skippedNote(skipped: number[]): string {
    if (skipped.length === 0) return '';
    const rows = skipped.length === 1 ? 'row' : 'rows';
    const more = skipped.length > 10 ? '…' : '';
    return ` ${skipped.length} ${rows} can't be read (no title, or a price, cost, quantity or status that doesn't make sense) and will be left out: row ${skipped.slice(0, 10).join(', ')}${more}.`;
}

export interface InventoryFile { artworks: ImportedArtwork[]; skipped: number[]; rows: number[]; unknownLocations: string[] }

/** The file's artworks, and the row numbers (as Excel shows them) that couldn't be read. */
export function readInventoryCsv(text: string, settings: InventorySettings = DEFAULT_INVENTORY_SETTINGS): InventoryFile {
    return readInventoryTable(parseCsv(text), undefined, settings);
}

/** "₹1,20,000" and "120000.00" both read as a number; blank is null; anything else NaN (a mistake, not zero). */
const amount = (t: string): number | null => {
    const clean = t.replace(/[₹,\s]/g, '');
    return clean === '' ? null : Number(clean);
};

/**
 * A row's stock: its Qty columns when the file has them; else Quantity at its
 * Location; neither (undefined) keeps the stock as it is.
 */
function rowStock(qty: [string, string][], quantity: string, location: { id: string }): Stock | undefined {
    if (qty.length) return Object.fromEntries(qty.map(([id, t]) => [id, Number(t || 0)]).filter(([, n]) => (n as number) > 0));
    if (!quantity) return undefined;
    return Number(quantity) > 0 ? { [location.id]: Number(quantity) } : {};
}

/**
 * Header row then data rows; `rowNumbers` are their spreadsheet row numbers
 * (default: one after another). `rows[i]` is artwork i's row number.
 * `unknownLocations`: "Qty:" columns naming no location (left out).
 */
export function readInventoryTable(table: string[][], rowNumbers = table.map((_, i) => i + 1), settings: InventorySettings = DEFAULT_INVENTORY_SETTINGS): InventoryFile {
    const [header = [], ...rows] = table;
    const col = new Map(header.map((h, i) => [h.trim().toLowerCase(), i]));
    if (!col.has('title')) throw new Error(`The first row must name the columns, including "Title" (${INVENTORY_COLUMNS.join(', ')}).`);
    const locationNamed = (name: string) => settings.locations.find(l => norm(l.name) === norm(name));
    const qtyColumns: { index: number; locationId: string }[] = [];
    const unknownLocations: string[] = [];
    header.forEach((h, index) => {
        const named = h.trim().toLowerCase().startsWith('qty:') ? h.trim().slice(4).trim() : '';
        if (!named) return;
        const l = locationNamed(named);
        if (l) qtyColumns.push({ index, locationId: l.id });
        else unknownLocations.push(named.trim());
    });
    const statusNamed = (t: string) => settings.statuses.find(s => norm(s.name) === norm(t) || s.id.toLowerCase() === norm(t));

    const artworks: ImportedArtwork[] = [];
    const skipped: number[] = [];
    const artworkRows: number[] = [];
    rows.forEach((row, i) => {
        const at = (index: number | undefined) => (row[index ?? -1] ?? '').trim();
        const cell = (name: (typeof INVENTORY_COLUMNS)[number] | typeof COST) => at(col.get(name.toLowerCase()));
        const price = amount(cell('Price')) ?? 0;
        const cost = col.has(COST.toLowerCase()) ? amount(cell(COST)) : null;
        const status = cell('Status') ? statusNamed(cell('Status')) : statusOf({ status: 'Available' }, settings);
        const size = cell('Edition size');
        const quantity = cell('Quantity');
        const units = qtyColumns.map(q => at(q.index));
        const whole = (t: string) => t === '' || /^\d+$/.test(t);
        if (!cell('Title') || !Number.isFinite(price) || price < 0 || (cost !== null && (Number.isNaN(cost) || cost < 0)) || !status
            || (size && !/^\d+$/.test(size)) || !whole(quantity) || !units.every(whole)) {
            skipped.push(rowNumbers[i + 1]);
            return;
        }
        const stock = status.behaves === 'Sold' ? {} : rowStock(qtyColumns.map((q, k) => [q.locationId, units[k]]), quantity, locationNamed(cell('Location')) ?? defaultLocation(settings));
        artworkRows.push(rowNumbers[i + 1]);
        artworks.push({
            customId: cell('Inventory ID'), title: cell('Title'), artist: cell('Artist'), artworkYear: cell('Year'),
            medium: cell('Medium'), dimensions: cell('Dimensions'), price, plusGst: /^(yes|y|true|1)$/i.test(cell('Plus GST')),
            status: status.behaves, statusLabel: status.id === status.behaves ? '' : status.id,
            location: cell('Location'), descriptionTitle: cell('Description title'), description: cell('Description'),
            ...(stock && { stock, quantity: Object.values(stock).reduce((n, q) => n + q, 0) }),
            ...(cost !== null && { costPrice: cost }),
            edition: size ? { size, ...(cell('Artist proofs') && { proofs: cell('Artist proofs') }), ...(cell('Edition number') && { number: cell('Edition number') }) } : undefined,
        });
    });
    return { artworks, skipped, rows: artworkRows, unknownLocations };
}
