// Staff roster import and copy rules (views/staffRoster/planRules.ts): reading
// a CSV the way the export writes it, checking each row as the server will,
// and skipping what is already planned so importing twice adds nothing.
//
//   node --test frontend/tests/rosterPlan.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers/load.mjs';

const rules = await load('views/staffRoster/planRules.ts');

const data = {
    canManage: true, me: 'u1',
    people: [{ id: 'u1', name: 'Rohan Das', title: 'Store associate' }, { id: 'u2', name: 'Neha Patel', title: 'Cashier' }],
    stores: [{ id: 's1', name: 'Flagship' }, { id: 's2', name: 'Studio' }],
    jobTitles: ['Cashier', 'Store associate'], shifts: [], leaves: [], weeks: {},
};

const HEADER = 'Date,Employee,Job title,Store,Start,End,Break (min),Status,Note';

test('CSV: quotes, doubled quotes, CRLF, a BOM and blank lines', () => {
    const rows = rules.parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\nlast,row');
    assert.deepEqual(rows, [['a', 'b'], ['x, y', 'say "hi"'], ['last', 'row']]);
});

test('the export\'s own format reads back, with names and stores matched and defaults filled in', () => {
    const csv = [
        HEADER,
        '2026-10-06,Rohan Das,Store associate,Flagship,09:00,17:00,60,Scheduled,Opening',
        '06/10/2026,neha patel,,studio,9 am,5:30 pm,,,',
        '2026-10-07,Rohan Das,,,,,,Day off,Swapped',
        '2026-10-08,,Cashier,Studio,12:00,20:00,30,Open,',
    ].join('\n');
    const { rows, problem } = rules.readImport(csv, data);
    assert.equal(problem, null);
    assert.deepEqual(rows.map(r => r.problem), [null, null, null, null]);
    const [a, b, off, open] = rows.map(r => r.shift);
    assert.deepEqual({ ...a }, { kind: 'shift', employeeId: 'u1', storeId: 's1', date: '2026-10-06', startMin: 540, endMin: 1020, breakMin: 60, role: 'Store associate', note: 'Opening' });
    assert.equal(b.employeeId, 'u2', 'names match without case');
    assert.equal(b.storeId, 's2');
    assert.equal(b.date, '2026-10-06', 'day-first dates, as in India');
    assert.equal(b.endMin, 17 * 60 + 30);
    assert.equal(b.breakMin, 60, 'the usual break when none is given (8.5 h shift)');
    assert.equal(b.role, 'Cashier', 'their job title when the row has none');
    assert.equal(off.kind, 'off');
    assert.equal(open.employeeId, null, 'no name: an open shift');
});

test('rows the server would refuse are reported with their line numbers, and nothing else stops', () => {
    const csv = [
        HEADER,
        '2026-10-06,Someone New,,Flagship,09:00,17:00,,,',
        'next tuesday,Rohan Das,,Flagship,09:00,17:00,,,',
        '2026-10-06,Rohan Das,,Nowhere,09:00,17:00,,,',
        '2026-10-06,Rohan Das,,Flagship,09:00,09:00,,,',
        '2026-10-06,Rohan Das,,Flagship,soon,17:00,,,',
        '2026-10-06,,,,,,,Day off,',
        '2026-10-09,Rohan Das,,Flagship,10:00,18:00,,,',
    ].join('\n');
    const { rows } = rules.readImport(csv, data);
    assert.deepEqual(rows.map(r => r.line), [2, 3, 4, 5, 6, 7, 8]);
    assert.match(rows[0].problem, /isn't on the team/);
    assert.match(rows[1].problem, /isn't a date/);
    assert.match(rows[2].problem, /doesn't exist/);
    assert.match(rows[3].problem, /same time/);
    assert.match(rows[4].problem, /times such as/);
    assert.match(rows[5].problem, /needs an employee/);
    assert.equal(rows[6].problem, null);
});

test('a file without Date and Employee columns is refused up front', () => {
    assert.match(rules.readImport('Name,When\nRohan,Monday', data).problem, /"Date" and an "Employee"/);
    assert.match(rules.readImport(HEADER, data).problem, /at least one row/);
});

test('importing or copying twice adds nothing; a day off on a working day is skipped', () => {
    const shift = { kind: 'shift', employeeId: 'u1', storeId: 's1', date: '2026-10-06', startMin: 540, endMin: 1020, breakMin: 60, role: 'Store associate', note: '' };
    const off = { kind: 'off', employeeId: 'u1', storeId: null, date: '2026-10-06', startMin: 0, endMin: 0, breakMin: 0, role: '', note: '' };
    const other = { ...shift, date: '2026-10-07' };
    const first = rules.addable([shift, other], []);
    assert.equal(first.add.length, 2);
    const again = rules.addable([shift, other], [shift, other]);
    assert.deepEqual([again.add.length, again.repeats], [0, 2]);
    const clash = rules.addable([off], [shift]);
    assert.deepEqual([clash.add.length, clash.offClashes], [0, 1]);
    // Within one file too: a shift and a day off for the same person and day.
    const inFile = rules.addable([shift, off], []);
    assert.deepEqual(inFile.add.map(s => s.kind), ['shift']);
    // Days off go first, so a shift later that day replaces one (as the server does).
    const ordered = rules.addable([other, { ...off, date: '2026-10-08' }], []);
    assert.deepEqual(ordered.add.map(s => s.kind), ['off', 'shift']);
});
