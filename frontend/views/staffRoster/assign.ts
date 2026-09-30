// Who can take a shift: for the one-tap Assign list, the editor's employee
// list and drag-and-drop. Free people first, then those with the fewest hours
// that week, so work spreads evenly.

import {
    WEEKLY_LIMIT_MIN, findConflicts, leaveOn, mondayOf, paidMin, weekDates, type StaffShift,
} from '../../staffRosterRules';
import type { StaffRosterData } from '../../services/staffRosterService';
import { dayLabel, timeRange, type Derived } from './shared';

export type Availability = 'free' | 'day-off' | 'pending-leave' | 'busy' | 'on-leave';

export interface Candidate {
    id: string;
    name: string;
    title: string;
    status: Availability;
    /** A short reason, e.g. "busy 09:00–17:00 at Studio". */
    note: string;
    /** Paid minutes that week, and with this shift added. */
    weekMin: number;
    weekMinWith: number;
}

/** Can be assigned without creating a conflict (a day off or requested leave only warns). */
export const assignable = (c: Candidate) => c.status === 'free' || c.status === 'day-off' || c.status === 'pending-leave';

const ORDER: Availability[] = ['free', 'day-off', 'pending-leave', 'busy', 'on-leave'];

/** Everyone on the team, as candidates for `shift` (its day, times and store). */
export function candidatesFor(data: StaffRosterData, d: Derived, shift: Pick<StaffShift, 'id' | 'date' | 'startMin' | 'endMin' | 'breakMin' | 'storeId' | 'kind' | 'role' | 'note'>): Candidate[] {
    const week = weekDates(mondayOf(shift.date));
    const others = data.shifts.filter(x => x.id !== shift.id);
    return data.people.map(p => {
        const trial: StaffShift = { ...shift, id: '__trial', employeeId: p.id, kind: 'shift' } as StaffShift;
        const conflicts = findConflicts([...others.filter(x => x.employeeId === p.id), trial], data.leaves).get('__trial') ?? [];
        const overlap = conflicts.find(c => c.type === 'overlap');
        const weekMin = others.filter(x => x.kind === 'shift' && x.employeeId === p.id && week.includes(x.date)).reduce((a, x) => a + paidMin(x), 0);
        let status: Availability = 'free';
        let note = '';
        if (conflicts.some(c => c.type === 'leave')) {
            status = 'on-leave';
            note = `on ${leaveOn(data.leaves, p.id, shift.date)?.type.toLowerCase() ?? 'leave'}`;
        } else if (overlap && overlap.type === 'overlap') {
            const o = others.find(x => x.id === overlap.otherId);
            status = 'busy';
            note = o ? `busy ${timeRange(o)} at ${d.storeName(o.storeId)}` : 'busy then';
        } else if (leaveOn(data.leaves, p.id, shift.date, 'pending')) {
            status = 'pending-leave';
            note = 'asked for leave';
        } else if (others.some(x => x.kind === 'off' && x.employeeId === p.id && x.date === shift.date)) {
            status = 'day-off';
            note = `day off ${dayLabel(shift.date)}`;
        }
        const weekMinWith = weekMin + paidMin(trial);
        if (status === 'free' && weekMinWith > WEEKLY_LIMIT_MIN) note = 'would go over 48 h';
        return { id: p.id, name: p.name, title: p.title, status, note, weekMin, weekMinWith };
    }).sort((a, b) =>
        ORDER.indexOf(a.status) - ORDER.indexOf(b.status)
        // Same job title as the role first, then the fewest hours.
        || Number(b.title === shift.role) - Number(a.title === shift.role)
        || a.weekMin - b.weekMin
        || a.name.localeCompare(b.name));
}

/** The label in a picker: "Priya Shah · free · 28 h this week". */
export function candidateLabel(c: Candidate): string {
    const status = { free: 'free', 'day-off': 'day off', 'pending-leave': 'asked for leave', busy: 'busy', 'on-leave': 'on leave' }[c.status];
    const hours = `${Math.round(c.weekMin / 6) / 10} h this week`;
    return `${c.name}${c.title ? ` · ${c.title}` : ''} — ${c.note || status} · ${hours}`;
}
