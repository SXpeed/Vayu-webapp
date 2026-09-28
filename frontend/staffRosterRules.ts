// Staff roster rules shared by the Worker (which enforces them when a week is
// published) and the app (which shows them while planning). Pure and
// dependency-free so both bundles can import it.
//
// Dates are calendar days as 'YYYY-MM-DD' strings; times are minutes after
// midnight. A shift whose end is at or before its start ends the next day.

export type ShiftKind = 'shift' | 'off';
export type LeaveStatus = 'pending' | 'approved' | 'declined';

export interface StaffShift {
    id: string;
    kind: ShiftKind;
    /** null: an open shift that still needs someone. Days off always have one. */
    employeeId: string | null;
    storeId: string | null;
    date: string;
    startMin: number;
    endMin: number;
    breakMin: number;
    /** The job this shift needs, e.g. "Sales associate". */
    role: string;
    note: string;
}

export interface StaffLeave {
    id: string;
    employeeId: string;
    from: string;
    to: string;
    type: string;
    /** Private to the person and managers. */
    reason: string;
    status: LeaveStatus;
    requestedAt: number;
    decidedAt: number | null;
    decidedByName: string;
}

export const LEAVE_TYPES = ['Annual leave', 'Sick leave', 'Personal leave', 'Unpaid leave', 'Other'] as const;
export const DEFAULT_JOB_TITLES = ['Store manager', 'Sales associate', 'Store associate', 'Cashier', 'Stock associate'];

/** A shift may run at most this long; longer is almost always a typo. */
export const MAX_SHIFT_MIN = 16 * 60;
/** Weekly paid hours above this are flagged. */
export const WEEKLY_LIMIT_MIN = 48 * 60;

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const isIsoDate = (v: unknown): v is string => typeof v === 'string' && ISO_DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
export const toTs = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);
export const toIso = (ts: number): string => new Date(ts).toISOString().slice(0, 10);
export const addDays = (iso: string, n: number): string => toIso(toTs(iso) + n * DAY_MS);
/** 0 = Monday … 6 = Sunday. */
export const weekdayIdx = (iso: string): number => (new Date(toTs(iso)).getUTCDay() + 6) % 7;
export const mondayOf = (iso: string): string => addDays(iso, -weekdayIdx(iso));
export const weekDates = (weekStart: string): string[] => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
const dayNumber = (iso: string): number => Math.round(toTs(iso) / DAY_MS);

export const timeToMin = (hhmm: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
    if (!m) return null;
    const h = Number(m[1]), min = Number(m[2]);
    return h < 24 && min < 60 ? h * 60 + min : null;
};
export const minToTime = (m: number): string => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export const endsNextDay = (s: Pick<StaffShift, 'startMin' | 'endMin'>): boolean => s.endMin <= s.startMin;
export const shiftLengthMin = (s: Pick<StaffShift, 'startMin' | 'endMin'>): number =>
    s.endMin > s.startMin ? s.endMin - s.startMin : s.endMin + 1440 - s.startMin;
export const paidMin = (s: Pick<StaffShift, 'startMin' | 'endMin' | 'breakMin'>): number => Math.max(0, shiftLengthMin(s) - s.breakMin);
/** The unpaid break a new shift starts with: an hour from six hours up. */
export const defaultBreakMin = (startMin: number, endMin: number): number => (shiftLengthMin({ startMin, endMin }) >= 360 ? 60 : 30);

/** Problems with one shift's own fields, before it is compared with others. */
export function shiftFieldErrors(s: Pick<StaffShift, 'kind' | 'storeId' | 'date' | 'startMin' | 'endMin' | 'breakMin' | 'role'>): string[] {
    const errors: string[] = [];
    if (!isIsoDate(s.date)) errors.push('Choose a date.');
    if (s.kind === 'off') return errors;
    if (!s.storeId) errors.push('Choose a store.');
    if (!s.role.trim()) errors.push('Choose the role this shift needs.');
    if (s.startMin === s.endMin) errors.push('The shift starts and ends at the same time. Change the end time.');
    else {
        const len = shiftLengthMin(s);
        if (len > MAX_SHIFT_MIN) errors.push(`That is ${len / 60} hours. A shift can be at most 16 hours.`);
        if (s.breakMin >= len) errors.push('The break is as long as the shift. Shorten the break.');
    }
    if (s.breakMin < 0 || s.breakMin > 180) errors.push('A break can be 0 to 180 minutes.');
    return errors;
}

export type Conflict = { type: 'overlap'; otherId: string } | { type: 'leave'; leaveId: string };

/** Every problem that blocks publishing, by shift id. Days off and open shifts never conflict. */
export function findConflicts(shifts: StaffShift[], leaves: StaffLeave[]): Map<string, Conflict[]> {
    const out = new Map<string, Conflict[]>();
    const add = (id: string, c: Conflict) => { const list = out.get(id) ?? []; list.push(c); out.set(id, list); };
    const byEmployee = new Map<string, StaffShift[]>();
    for (const s of shifts) {
        if (s.kind !== 'shift' || !s.employeeId) continue;
        const list = byEmployee.get(s.employeeId) ?? [];
        list.push(s);
        byEmployee.set(s.employeeId, list);
    }
    for (const list of byEmployee.values()) {
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                const a = list[i], b = list[j];
                const a0 = dayNumber(a.date) * 1440 + a.startMin, a1 = a0 + shiftLengthMin(a);
                const b0 = dayNumber(b.date) * 1440 + b.startMin, b1 = b0 + shiftLengthMin(b);
                if (a0 < b1 && b0 < a1) { add(a.id, { type: 'overlap', otherId: b.id }); add(b.id, { type: 'overlap', otherId: a.id }); }
            }
        }
        for (const s of list) {
            const leave = leaves.find(l => l.status === 'approved' && l.employeeId === s.employeeId && s.date >= l.from && s.date <= l.to);
            if (leave) add(s.id, { type: 'leave', leaveId: leave.id });
        }
    }
    return out;
}

/** The approved (or other status) leave covering this person's day, if any. */
export const leaveOn = (leaves: StaffLeave[], employeeId: string, date: string, status: LeaveStatus = 'approved'): StaffLeave | undefined =>
    leaves.find(l => l.employeeId === employeeId && l.status === status && date >= l.from && date <= l.to);
