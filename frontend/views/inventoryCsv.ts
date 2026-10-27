// Inventory as a spreadsheet: export the artworks to CSV, edit in Excel, import
// it back. A row whose Inventory ID matches an artwork updates it (photos kept);
// any other row adds a new artwork. Photos are not part of the file.

import type { Artwork, ArtworkStatus } from '../types';
import { parseCsv } from './staffRoster/planRules';

export const INVENTORY_COLUMNS = [
    'Inventory ID', 'Title', 'Artist', 'Year', 'Medium', 'Dimensions', 'Price', 'Plus GST', 'Status', 'Location',
    'Edition size', 'Artist proofs', 'Edition number', 'Description title', 'Description',
] as const;

const STATUSES: ArtworkStatus[] = ['Available', 'Sold', 'Reserved'];

/** Header row, then one row per artwork. */
export function inventoryRows(artworks: Artwork[]): (string | number)[][] {
    return [[...INVENTORY_COLUMNS], ...artworks.map(a => [
        a.customId, a.title, a.artist ?? '', a.artworkYear ?? '', a.medium, a.dimensions, a.price, a.plusGst ? 'Yes' : '', a.status, a.location,
        a.edition?.size ?? '', a.edition?.proofs ?? '', a.edition?.number ?? '', a.descriptionTitle ?? '', a.description,
    ])];
}

export type ImportedArtwork = Omit<Artwork, 'id' | 'createdAt' | 'imageUrls'>;

/**
 * What an import would do: rows whose Inventory ID matches an artwork update
 * it (only when something changed; photos kept), the others are added.
 */
export function planImport(artworks: Artwork[], rows: ImportedArtwork[]): { adds: ImportedArtwork[]; updates: Artwork[] } {
    const byInventoryId = new Map(artworks.filter(a => a.customId.trim()).map(a => [a.customId.trim().toLowerCase(), a]));
    const adds: ImportedArtwork[] = [];
    const updates: Artwork[] = [];
    const sameRow = (a: Artwork, b: Artwork) => JSON.stringify(inventoryRows([a])[1]) === JSON.stringify(inventoryRows([b])[1]);
    for (const row of rows) {
        const existing = row.customId ? byInventoryId.get(row.customId.toLowerCase()) : undefined;
        if (!existing) adds.push(row);
        else if (!sameRow({ ...existing, ...row }, existing)) updates.push({ ...existing, ...row });
    }
    return { adds, updates };
}

/** " 2 rows can't be read …: row 4, 9." for the confirmation, or ''. */
export function skippedNote(skipped: number[]): string {
    if (skipped.length === 0) return '';
    const rows = skipped.length === 1 ? 'row' : 'rows';
    const more = skipped.length > 10 ? '…' : '';
    return ` ${skipped.length} ${rows} can't be read (no title, or a price or status that doesn't make sense) and will be left out: row ${skipped.slice(0, 10).join(', ')}${more}.`;
}

/** The file's artworks, and the row numbers (as Excel shows them) that couldn't be read. */
export function readInventoryCsv(text: string): { artworks: ImportedArtwork[]; skipped: number[] } {
    const [header = [], ...rows] = parseCsv(text);
    const col = new Map(header.map((h, i) => [h.trim().toLowerCase(), i]));
    if (!col.has('title')) throw new Error(`The first row must name the columns, including "Title" (${INVENTORY_COLUMNS.join(', ')}).`);
    const artworks: ImportedArtwork[] = [];
    const skipped: number[] = [];
    rows.forEach((row, i) => {
        const cell = (name: (typeof INVENTORY_COLUMNS)[number]) => (row[col.get(name.toLowerCase()) ?? -1] ?? '').trim();
        // "₹1,20,000" and "120000.00" both read as a number; anything else is a mistake, not zero.
        const priceText = cell('Price').replace(/[₹,\s]/g, '');
        const price = priceText === '' ? 0 : Number(priceText);
        const status = STATUSES.find(s => s.toLowerCase() === cell('Status').toLowerCase()) ?? (cell('Status') ? null : 'Available');
        const size = cell('Edition size');
        if (!cell('Title') || !Number.isFinite(price) || price < 0 || !status || (size && !/^\d+$/.test(size))) {
            skipped.push(i + 2);
            return;
        }
        artworks.push({
            customId: cell('Inventory ID'), title: cell('Title'), artist: cell('Artist'), artworkYear: cell('Year'),
            medium: cell('Medium'), dimensions: cell('Dimensions'), price, plusGst: /^(yes|y|true|1)$/i.test(cell('Plus GST')),
            status, location: cell('Location'), descriptionTitle: cell('Description title'), description: cell('Description'),
            edition: size ? { size, ...(cell('Artist proofs') && { proofs: cell('Artist proofs') }), ...(cell('Edition number') && { number: cell('Edition number') }) } : undefined,
        });
    });
    return { artworks, skipped };
}
