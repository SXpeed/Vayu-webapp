// The rules behind copying a week and importing a spreadsheet, without the
// screens (PlanTools.tsx), so they can be tested on their own.

import { defaultBreakMin, shiftFieldErrors, timeToMin } from '../../staffRosterRules';
import type { ShiftInput, StaffRosterData } from '../../services/staffRosterService';

const sameShift = (a: ShiftInput, b: ShiftInput) =>
    a.kind === b.kind && a.employeeId === b.employeeId && a.date === b.date
    && (a.kind === 'off' || (a.storeId === b.storeId && a.startMin === b.startMin && a.endMin === b.endMin));

/**
 * What can be added next to `existing`: drops exact repeats, and days off for
 * someone who works that day (the server refuses those).
 */
export function addable(inputs: ShiftInput[], existing: ShiftInput[]): { add: ShiftInput[]; repeats: number; offClashes: number } {
    const add: ShiftInput[] = [];
    let repeats = 0, offClashes = 0;
    const all = [...existing];
    for (const s of inputs) {
        if (all.some(x => sameShift(x, s))) { repeats++; continue; }
        if (s.kind === 'off' && all.some(x => x.kind === 'shift' && x.employeeId === s.employeeId && x.date === s.date)) { offClashes++; continue; }
        add.push(s);
        all.push(s);
    }
    // A shift replaces a day off on the same day (the server does the same), so days off go first.
    add.sort((a, b) => Number(a.kind === 'shift') - Number(b.kind === 'shift'));
    return { add, repeats, offClashes };
}

/** Rows of a CSV: quoted fields, doubled quotes, CRLF, a leading BOM. */
export function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [], field = '', quoted = false;
    const src = text.replace(/^﻿/, '');
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (quoted) {
            if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
            else if (ch === '"') quoted = false;
            else field += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') { row.push(field); field = ''; }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && src[i + 1] === '\n') i++;
            row.push(field); rows.push(row); row = []; field = '';
        } else field += ch;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(c => c.trim()));
}

/** 2026-10-05, 05/10/2026 or 05-10-2026 (day first, as in India). */
function readDate(v: string): string | null {
    const t = v.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
    return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

/** 09:00, 9:00, 9 am, 5:30 PM. */
function readTime(v: string): number | null {
    const t = v.trim().toLowerCase();
    const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(t);
    if (!m) return null;
    let h = Number(m[1]);
    const min = Number(m[2] ?? 0);
    if (m[3] === 'pm' && h < 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    return timeToMin(`${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`);
}

export interface ImportRow { line: number; shift: ShiftInput | null; problem: string | null }

const COLUMNS: Record<string, string[]> = {
    date: ['date'], employee: ['employee', 'name', 'staff', 'person'], role: ['job title', 'role', 'role needed'], store: ['store', 'location'],
    start: ['start'], end: ['end'], break: ['break (min)', 'break', 'unpaid break'], status: ['status', 'type'], note: ['note', 'notes'],
};

/** The rows of an import, each a shift or day off ready to save, or the reason it can't be. */
export function readImport(text: string, data: StaffRosterData): { rows: ImportRow[]; problem: string | null } {
    const table = parseCsv(text);
    if (table.length < 2) return { rows: [], problem: 'The file needs a header row and at least one row below it.' };
    const header = table[0].map(h => h.trim().toLowerCase());
    const col = (key: string) => header.findIndex(h => COLUMNS[key].includes(h));
    const at = Object.fromEntries(Object.keys(COLUMNS).map(k => [k, col(k)])) as Record<string, number>;
    if (at.date < 0 || at.employee < 0) return { rows: [], problem: 'The file needs at least a "Date" and an "Employee" column (as the export has).' };
    const byName = new Map(data.people.map(p => [p.name.trim().toLowerCase(), p]));
    const storeByName = new Map(data.stores.map(s => [s.name.trim().toLowerCase(), s]));
    const onlyStore = data.stores.length === 1 ? data.stores[0] : null;

    const rows = table.slice(1).map((cells, i): ImportRow => {
        const line = i + 2;
        const get = (key: string) => (at[key] >= 0 ? (cells[at[key]] ?? '').trim() : '');
        const fail = (problem: string): ImportRow => ({ line, shift: null, problem });
        const date = readDate(get('date'));
        if (!date) return fail(`Date "${get('date')}" isn't a date (use 2026-10-05 or 05/10/2026).`);
        const name = get('employee');
        const person = name ? byName.get(name.toLowerCase()) : undefined;
        if (name && !person) return fail(`"${name}" isn't on the team (names must match the roster).`);
        const dayOff = /day off|^off$/i.test(get('status')) || (!!person && !get('start') && !get('end'));
        if (dayOff) {
            if (!person) return fail('A day off needs an employee.');
            return { line, shift: { kind: 'off', employeeId: person.id, storeId: null, date, startMin: 0, endMin: 0, breakMin: 0, role: '', note: get('note').slice(0, 200) }, problem: null };
        }
        const startMin = readTime(get('start')), endMin = readTime(get('end'));
        if (startMin === null || endMin === null) return fail('Start and End need times such as 09:00 and 17:00.');
        const storeName = get('store');
        const store = storeName ? storeByName.get(storeName.toLowerCase()) : onlyStore;
        if (!store) return fail(storeName ? `Store "${storeName}" doesn't exist (names must match Attendance → Stores).` : 'Say which store.');
        const breakText = get('break');
        const breakMin = breakText ? Number(breakText) : defaultBreakMin(startMin, endMin);
        if (!Number.isFinite(breakMin)) return fail(`Break "${breakText}" should be minutes, e.g. 30.`);
        const role = (get('role') || person?.title || data.jobTitles[0] || '').slice(0, 60);
        const shift: ShiftInput = { kind: 'shift', employeeId: person?.id ?? null, storeId: store.id, date, startMin, endMin, breakMin, role, note: get('note').slice(0, 200) };
        const errors = shiftFieldErrors(shift);
        return errors.length ? fail(errors[0]) : { line, shift, problem: null };
    });
    return { rows, problem: null };
}

