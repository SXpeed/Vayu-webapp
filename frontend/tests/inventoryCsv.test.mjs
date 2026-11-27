// Inventory export and import (views/inventoryCsv.ts): what goes into the
// file, and what a file a person edited in Excel reads back as.
//
//   node --test frontend/tests/inventoryCsv.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers/load.mjs';

const { inventoryRows, readInventoryCsv, planImport, INVENTORY_COLUMNS } = await load('views/inventoryCsv.ts');
const { cleanInventorySettings } = await load('inventoryRules.ts');

const settings = cleanInventorySettings({
    locations: [{ id: 'loc_storeb1', name: 'Store B', isDefault: true }, { id: 'loc_office1', name: 'Office' }, { id: 'loc_old0001', name: 'Old shed', archived: true }],
    statuses: [{ id: 'st_onloan1', name: 'On loan', behaves: 'Reserved' }],
});

const csv = (rows) => rows.map(r => r.map(v => `"${String(v).replaceAll('"', '""')}"`).join(',')).join('\r\n');

const art = {
    id: 'art_1', customId: 'VD-001', title: 'Monsoon, "I"', artist: 'R. Rao', artworkYear: '2024', medium: 'Oil', dimensions: '36 x 48 in',
    price: 250000, plusGst: true, status: 'Reserved', location: 'Store B', descriptionTitle: 'Provenance', description: 'Line one\nline two',
    edition: { size: '10', proofs: '2', number: '3' }, quantity: 4, imageUrls: ['/api/files/x.png'], createdAt: 1,
    stock: { loc_office1: 1, loc_storeb1: 3 }, statusLabel: 'st_onloan1', costPrice: 120000,
};

test('an export reads back as the same artwork, photos aside', () => {
    const { artworks, skipped } = readInventoryCsv('\ufeff' + csv(inventoryRows([art], settings, true)), settings);
    assert.deepEqual(skipped, []);
    const { id, createdAt, imageUrls, ...fields } = art;
    assert.deepEqual(artworks, [fields]);
});

test('one Qty column per location; cost price only for people who can see it', () => {
    const [header, row] = inventoryRows([art], settings);
    assert.deepEqual(header.slice(INVENTORY_COLUMNS.length), ['Qty: Store B', 'Qty: Office'], 'an archived location without stock gets no column');
    assert.ok(!header.includes('Cost price'));
    assert.equal(row[header.indexOf('Status')], 'On loan');
});

test('stock without Qty columns: Quantity at its Location, else the default; unknown Qty columns are named', () => {
    const file = csv([['Title', 'Quantity', 'Location', 'Qty: Garage'], ['A', '2', 'office', '5'], ['B', '3', 'Nowhere', '']]);
    const { artworks, unknownLocations } = readInventoryCsv(file, settings);
    assert.deepEqual(unknownLocations, ['Garage']);
    assert.deepEqual(artworks.map(a => a.stock), [{ loc_office1: 2 }, { loc_storeb1: 3 }]);
    const custom = readInventoryCsv(csv([['Title', 'Status'], ['C', 'on LOAN'], ['D', 'Lost']]), settings);
    assert.deepEqual(custom.artworks.map(a => [a.status, a.statusLabel]), [['Reserved', 'st_onloan1']]);
    assert.deepEqual(custom.skipped, [3]);
});

test('columns are found by name, in any order, and Excel-style values are understood', () => {
    const file = csv([['title', 'PRICE', 'Status', 'Plus GST'], ['Study', '₹1,20,000', 'sold', 'yes'], ['Sketch', '', '', '']]);
    const { artworks } = readInventoryCsv(file);
    assert.equal(artworks[0].price, 120000);
    assert.equal(artworks[0].status, 'Sold');
    assert.equal(artworks[0].plusGst, true);
    assert.deepEqual(artworks[0].stock, {}, 'sold holds none');
    assert.equal('stock' in artworks[1], false, 'no Quantity column: stock is left as it is');
    assert.deepEqual([artworks[1].price, artworks[1].status, artworks[1].edition], [0, 'Available', undefined]);
});

test('rows that make no sense are left out by their spreadsheet row number, never read as zero', () => {
    const file = csv([[...INVENTORY_COLUMNS],
        ['A-1', '', '', '', '', '', '100'],              // no title
        ['A-2', 'Ok', '', '', '', '', '200'],
        ['A-3', 'Bad price', '', '', '', '', 'ask me'],
        ['A-4', 'Bad status', '', '', '', '', '1', '', 'Lost'],
        ['A-5', 'Bad edition', '', '', '', '', '1', '', '', '', 'ten'],
    ]);
    const { artworks, skipped } = readInventoryCsv(file);
    assert.deepEqual(artworks.map(a => a.customId), ['A-2']);
    assert.deepEqual(skipped, [2, 4, 5, 6]);
});

test('a file without a header naming Title is refused', () => {
    assert.throws(() => readInventoryCsv(csv([['Monsoon', '100']])), /Title/);
});

test('an import updates by Inventory ID (only what changed, photos kept) and adds the rest', () => {
    const { id, createdAt, imageUrls, ...fields } = art;
    const rows = [
        { ...fields },                                     // same artwork, nothing changed
        { ...fields, title: 'Monsoon, renamed' },          // same ID, a change
        { ...fields, customId: 'VD-002', title: 'New' },   // no such ID
        { ...fields, customId: '', title: 'No ID' },       // no ID at all
    ];
    const { adds, updates } = planImport([art], rows);
    assert.deepEqual(adds.map(a => a.title), ['New', 'No ID']);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].id, 'art_1');
    assert.equal(updates[0].title, 'Monsoon, renamed');
    assert.deepEqual(updates[0].imageUrls, art.imageUrls);
});
