// Attendance by store (views/attendance/attendanceUtils.ts inStore): all
// stores shows everyone; one store shows its check-ins, the people assigned
// to it (so absences count) and anyone who checked in there from elsewhere.
//
//   node --test frontend/tests/attendanceScope.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers/load.mjs';

const { inStore, ALL_STORES } = await load('views/attendance/attendanceUtils.ts');

const team = [
    { id: 'a', name: 'Asha', storeId: 'flagship' },
    { id: 'b', name: 'Bilal', storeId: 'studio' },
    { id: 'c', name: 'Chitra' },
];
const records = [
    { id: 'r1', employeeId: 'a', storeId: 'flagship' },
    { id: 'r2', employeeId: 'a', storeId: 'studio' },
    { id: 'r3', employeeId: 'c', storeId: 'studio' },
];

test('all stores: everyone and every check-in', () => {
    const r = inStore(team, records, ALL_STORES);
    assert.equal(r.team.length, 3);
    assert.equal(r.records.length, 3);
});

test('one store: its check-ins, its people (absent too) and visitors', () => {
    const studio = inStore(team, records, 'studio');
    assert.deepEqual(studio.records.map(x => x.id), ['r2', 'r3']);
    assert.deepEqual(studio.team.map(u => u.id).sort(), ['a', 'b', 'c'], 'Bilal is assigned (absent); Asha and Chitra checked in there');
    const flagship = inStore(team, records, 'flagship');
    assert.deepEqual(flagship.records.map(x => x.id), ['r1']);
    assert.deepEqual(flagship.team.map(u => u.id), ['a'], 'people of other stores are left out');
});

test('a store nobody uses: nothing', () => {
    const r = inStore(team, records, 'warehouse');
    assert.deepEqual([r.team.length, r.records.length], [0, 0]);
});
