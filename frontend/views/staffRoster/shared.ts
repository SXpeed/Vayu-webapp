// Formatting and lookups the staff roster screens share.
import {
    addDays, endsNextDay, findConflicts, minToTime, toTs, weekDates, weekdayIdx,
    type Conflict, type StaffLeave, type StaffShift,
} from '../../staffRosterRules';
import type { StaffRosterData } from '../../services/staffRosterService';

export const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Today on this device, as 'YYYY-MM-DD'. */
export function todayIso(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const dayOfMonth = (iso: string) => new Date(toTs(iso)).getUTCDate();
export const dm = (iso: string) => { const d = new Date(toTs(iso)); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
export const dayLabel = (iso: string) => `${DOW[weekdayIdx(iso)]} ${dm(iso)}`;
export function rangeLabel(weekStart: string): string {
    const a = new Date(toTs(weekStart)), b = new Date(toTs(addDays(weekStart, 6)));
    const left = a.getUTCMonth() === b.getUTCMonth() ? `${a.getUTCDate()}` : `${a.getUTCDate()} ${MON[a.getUTCMonth()]}`;
    return `${left} – ${b.getUTCDate()} ${MON[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
}
export const timeRange = (s: StaffShift) => `${minToTime(s.startMin)}–${minToTime(s.endMin)}`;
/** "09–17" for the phone grid; minutes only when they aren't :00. */
export const shortRange = (s: StaffShift) => {
    const t = (m: number) => (m % 60 ? minToTime(m) : String(Math.floor(m / 60)).padStart(2, '0'));
    return `${t(s.startMin)}–${t(s.endMin)}`;
};
export const hoursText = (min: number) => { const h = min / 60; return Number.isInteger(h) ? `${h}` : h.toFixed(1); };
export const nextDay = endsNextDay;

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).map(p => p[0]).join('').slice(0, 2).toUpperCase();

/** Everything a screen derives from one load, in one place. */
export function derive(data: StaffRosterData) {
    const storeIdx = new Map(data.stores.map((s, i) => [s.id, i]));
    const storeName = (id: string | null) => data.stores.find(s => s.id === id)?.name ?? 'Store removed';
    const storeClass = (id: string | null) => `sr-store-${(storeIdx.get(id ?? '') ?? 0) % 6}`;
    const person = (id: string | null) => data.people.find(p => p.id === id);
    /** The name of someone no longer on the team, when the server still knows it. */
    const formerName = (id: string | null) => data.formerPeople?.find(p => p.id === id)?.name;
    const personName = (id: string | null) => {
        if (!id) return 'Open shift';
        const name = person(id)?.name;
        if (name) return name;
        const former = formerName(id);
        return former ? `${former} (left the team)` : 'Former team member';
    };
    const conflicts: Map<string, Conflict[]> = findConflicts(data.shifts, data.leaves);
    return { storeName, storeClass, person, formerName, personName, conflicts };
}
export type Derived = ReturnType<typeof derive>;

export const inWeek = (s: { date: string }, weekStart: string) => s.date >= weekStart && s.date <= addDays(weekStart, 6);
export const weekOf = weekDates;
export const approvedLeaves = (leaves: StaffLeave[]) => leaves.filter(l => l.status === 'approved');

/** Rows in the week for display: filters applied, open shifts kept apart. */
export interface Filters { storeId: string; title: string; q: string }
export const matchesPerson = (p: { name: string; title: string }, f: Filters) => {
    const q = f.q.trim().toLowerCase();
    return (f.title === 'all' || p.title === f.title) && (!q || p.name.toLowerCase().includes(q) || p.title.toLowerCase().includes(q));
};
export const matchesStore = (s: StaffShift, f: Filters) => s.kind === 'off' || f.storeId === 'all' || s.storeId === f.storeId;
