// Inventory export and import (views/inventoryCsv.ts): what goes into the
// file, and what a file a person edited in Excel reads back as.
//
//   node --test frontend/tests/inventoryCsv.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers/load.mjs';

const { inventoryRows, readInventoryCsv, planImport, INVENTORY_COLUMNS } = await load('views/inventoryCsv.ts');

const csv = (rows) => rows.map(r => r.map(v => `"${String(v).replaceAll('"', '""')}"`).join(',')).join('\r\n');

const art = {
    id: 'art_1', customId: 'VD-001', title: 'Monsoon, "I"', artist: 'R. Rao', artworkYear: '2024', medium: 'Oil', dimensions: '36 x 48 in',
    price: 250000, plusGst: true, status: 'Reserved', location: 'Store B', descriptionTitle: 'Provenance', description: 'Line one\nline two',
    edition: { size: '10', proofs: '2', number: '3' }, imageUrls: ['/api/files/x.png'], createdAt: 1,
};

test('an export reads back as the same artwork, photos aside', () => {
    const { artworks, skipped } = readInventoryCsv('﻿' + csv(inventoryRows([art])));
    assert.deepEqual(skipped, []);
    const { id, createdAt, imageUrls, ...fields } = art;
    assert.deepEqual(artworks, [fields]);
});

test('columns are found by name, in any order, and Excel-style values are understood', () => {
    const file = csv([['title', 'PRICE', 'Status', 'Plus GST'], ['Study', '₹1,20,000', 'sold', 'yes'], ['Sketch', '', '', '']]);
    const { artworks } = readInventoryCsv(file);
    assert.equal(artworks[0].price, 120000);
    assert.equal(artworks[0].status, 'Sold');
    assert.equal(artworks[0].plusGst, true);
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
