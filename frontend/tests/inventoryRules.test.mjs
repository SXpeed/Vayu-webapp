// Stock locations and custom statuses (inventoryRules.ts): settings cleaning,
// where a sale or invoice takes stock from, and the status a piece shows.
//
//   node --test frontend/tests/inventoryRules.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers/load.mjs';

const { cleanInventorySettings, cleanStock, pickLocation, takePlan, statusOf, stockLabel, locationIdFor, marginOf } = await load('inventoryRules.ts');

test('settings always keep one default, the built-in statuses, and everything a stale copy left out', () => {
    const empty = cleanInventorySettings({});
    assert.deepEqual(empty.locations, [{ id: locationIdFor('Main'), name: 'Main', isDefault: true }]);
    assert.deepEqual(empty.statuses.map(s => s.id), ['Available', 'Reserved', 'Sold']);

    const prev = cleanInventorySettings({
        locations: [{ id: 'loc_aaaa1', name: 'Store', isDefault: true }, { id: 'loc_bbbb1', name: 'Office' }],
        statuses: [{ id: 'Sold', name: 'Gone' }, { id: 'st_loan1', name: 'On loan', behaves: 'Reserved', color: 'blue' }],
    });
    assert.equal(prev.statuses.find(s => s.id === 'Sold').name, 'Gone', 'built-ins can be renamed');
    assert.deepEqual(prev.statuses.map(s => s.id), ['Available', 'Reserved', 'Sold', 'st_loan1']);

    const next = cleanInventorySettings({ locations: [{ id: 'loc_bbbb1', name: 'office', isDefault: true, archived: true }, { id: 'bad', name: 'X' }, { id: 'loc_cccc1', name: '  ' }] }, prev);
    assert.ok(!next.locations.some(l => l.name === 'X' || !l.name.trim()), 'bad ids and blank names are dropped');
    assert.deepEqual(next.locations.find(l => l.id === 'loc_aaaa1'), { id: 'loc_aaaa1', name: 'Store', isDefault: true }, 'left out: kept as it was (and the default, office being archived)');
    const def = next.locations.filter(l => l.isDefault);
    assert.equal(def.length, 1);
    assert.ok(!def[0].archived, 'the default is never archived');
    assert.equal(next.statuses.find(s => s.id === 'st_loan1').archived, undefined, 'a status left out stays as it was');
    assert.equal(next.statuses.find(s => s.id === 'Sold').name, 'Gone', 'a built-in left out keeps its name');
});

test('duplicate names are told apart, never merged', () => {
    const s = cleanInventorySettings({ statuses: [{ id: 'st_aaaa1', name: 'Sold', behaves: 'Sold' }] });
    assert.deepEqual(s.statuses.map(x => x.name), ['Available', 'Reserved', 'Sold', 'Sold (2)']);
});

test('stock: whole units at known locations, zeros dropped', () => {
    assert.deepEqual(cleanStock({ loc_bbbb1: 2, loc_aaaa1: 0, loc_cccc1: 1.5, nope: 3, loc_dddd1: -1 }), { loc_bbbb1: 2 });
    assert.deepEqual(cleanStock('{"loc_aaaa1":3}', new Set(['loc_bbbb1'])), {}, 'unknown location');
    assert.equal(cleanStock(null), null);
});

test('a sale takes from the location asked for, else the default, else the fullest', () => {
    const stock = { loc_a: 1, loc_b: 4 };
    assert.equal(pickLocation(stock, 1, 'loc_a'), 'loc_a');
    assert.equal(pickLocation(stock, 2, 'loc_a'), 'loc_b');
    assert.equal(pickLocation(stock, 2, 'loc_a', 'loc_a'), null, 'asked for, not enough there');
    assert.equal(pickLocation(stock, 5, 'loc_a'), null);
});

test('an invoice takes the default first, then the fullest, and only what is there', () => {
    assert.deepEqual(takePlan({ loc_a: 2, loc_b: 1, loc_c: 5 }, 4, 'loc_a'), [{ locationId: 'loc_a', qty: 2 }, { locationId: 'loc_c', qty: 2 }]);
    assert.deepEqual(takePlan({ loc_a: 1 }, 3, 'loc_a'), [{ locationId: 'loc_a', qty: 1 }]);
});

test('a custom status shows only while it matches how the piece behaves', () => {
    const s = cleanInventorySettings({ statuses: [{ id: 'st_loan1', name: 'On loan', behaves: 'Reserved' }] });
    assert.equal(statusOf({ status: 'Reserved', statusLabel: 'st_loan1' }, s).name, 'On loan');
    assert.equal(statusOf({ status: 'Sold', statusLabel: 'st_loan1' }, s).name, 'Sold', 'sold since: Sold');
    assert.equal(statusOf({ status: 'Available', statusLabel: 'st_gone1' }, s).name, 'Available');
});

test('labels and margins', () => {
    const s = cleanInventorySettings({ locations: [{ id: 'loc_aaaa1', name: 'Store', isDefault: true }, { id: 'loc_bbbb1', name: 'Office' }] });
    assert.equal(stockLabel({ loc_bbbb1: 2, loc_aaaa1: 3 }, s), 'Store 3 · Office 2');
    assert.deepEqual(marginOf(50000, 30000), { amount: 20000, percent: 40 });
    assert.equal(marginOf(50000, 0), null);
});
