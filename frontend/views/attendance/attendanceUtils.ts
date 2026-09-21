import { AttendanceRecord, StoreConfig } from '../../types';

/* Shared helpers for the attendance screens. Everything here works on real
 * server records only — no generated or sample data anywhere. */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** Shifts longer than this are flagged for review (usually a late check-out). */
export const LONG_SHIFT_MS = 14 * HOUR_MS;
/** Shifts shorter than this are flagged (usually an accidental double tap). */
export const SHORT_SHIFT_MS = 5 * 60_000;

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export const startOfDay = (ms: number): number => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
};

/** [from, to) epoch-ms bounds of a calendar month. */
export const monthRange = (year: number, month: number) => ({
    from: new Date(year, month, 1).getTime(),
    to: new Date(year, month + 1, 1).getTime(),
});

export const fmtTime = (ms: number | null | undefined): string =>
    ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';

export const fmtDay = (ms: number): string =>
    new Date(ms).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

/**
 * Time actually worked. Today's open check-in counts up to `now`; one left
 * open from an earlier day (a forgotten check-out) counts nothing until an
 * admin closes it. Otherwise one forgotten check-out showed as 80 hours.
 */
export const workedMs = (r: AttendanceRecord, now = Date.now()): number => {
    if (!r.checkInAt) return 0;
    if (r.checkOutAt) return Math.max(0, r.checkOutAt - r.checkInAt);
    return startOfDay(r.checkInAt) < startOfDay(now) ? 0 : Math.max(0, now - r.checkInAt);
};

/** Duration for display: "—" for a forgotten check-out, whose length is unknown. */
export const fmtWorked = (r: AttendanceRecord, now = Date.now()): string =>
    !r.checkOutAt && r.checkInAt && startOfDay(r.checkInAt) < startOfDay(now) ? '—' : fmtDuration(workedMs(r, now));

export const fmtDuration = (ms: number): string => {
    const mins = Math.round(ms / 60_000);
    return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
};

export type RecordFlag = 'open' | 'forgot' | 'long' | 'short';

/**
 * What needs a manager's eye on a record:
 * - open: checked in today, still at work
 * - forgot: still checked in from an earlier day (never checked out)
 * - long / short: a completed shift that is implausibly long or short
 */
export const recordFlags = (r: AttendanceRecord, now = Date.now()): RecordFlag[] => {
    if (r.status === 'checked-in') {
        return [r.checkInAt && startOfDay(r.checkInAt) < startOfDay(now) ? 'forgot' : 'open'];
    }
    const worked = workedMs(r, now);
    if (worked > LONG_SHIFT_MS) return ['long'];
    if (worked < SHORT_SHIFT_MS) return ['short'];
    return [];
};

export const FLAG_META: Record<RecordFlag, { label: string; cls: string }> = {
    open: { label: 'Checked in', cls: 'text-emerald-700 dark:text-emerald-400' },
    forgot: { label: 'Not checked out', cls: 'text-red-600 dark:text-red-400' },
    long: { label: 'Over 14h', cls: 'text-amber-700 dark:text-amber-400' },
    short: { label: 'Under 5 min', cls: 'text-[var(--neu-text-dim)]' },
};

export const isIssue = (f: RecordFlag) => f !== 'open';

export const storeName = (stores: StoreConfig[], id: string): string =>
    stores.find(s => s.id === id)?.name || 'Unknown store';

/** Great-circle distance between two points, in meters (same formula as the server). */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6_371_000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export const fmtDistance = (m: number): string => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

/** The server rejects GPS fixes less accurate than this (meters). */
export const MAX_GPS_ACCURACY = 100;

export interface GpsFix {
    lat: number;
    lng: number;
    accuracy: number;
}

export function getPosition(): Promise<GpsFix> {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            reject(new Error('GPS is not available on this device'));
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
            (err) => reject(new Error(
                err.code === err.PERMISSION_DENIED
                    ? 'Location permission denied — allow location access to check in'
                    : 'Could not get your location — try again near a window or open area'
            )),
            { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
        );
    });
}

/** True when location permission is already granted, so asking won't prompt. */
export async function locationAlreadyGranted(): Promise<boolean> {
    try {
        const status = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
        return status?.state === 'granted';
    } catch {
        return false;
    }
}

/**
 * Best effort: the Network Information API where available, else 'unknown'.
 * (iPhones don't expose it at all.)
 */
export function detectConnectionType(): 'wifi' | 'mobile' | 'unknown' {
    const conn = (navigator as unknown as { connection?: { type?: string } }).connection;
    if (conn?.type === 'wifi') return 'wifi';
    if (conn?.type === 'cellular') return 'mobile';
    return 'unknown';
}

export function downloadCsv(filename: string, rows: (string | number)[][]): void {
    const csv = rows.map(r => r.map(v => `"${String(v).replaceAll('"', '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Sunday-first grid of day numbers (null = padding) for a month. */
export function monthGrid(year: number, month: number): (number | null)[] {
    const lead = new Date(year, month, 1).getDay();
    const days = new Date(year, month + 1, 0).getDate();
    const cells: (number | null)[] = Array.from({ length: lead }, () => null);
    for (let d = 1; d <= days; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
}

/** [from, to) of the calendar day containing `ms`. */
export const dayRange = (ms: number) => {
    const from = startOfDay(ms);
    return { from, to: from + DAY_MS };
};

/** `yyyy-mm-dd` for a date input, in local time. */
export const toDateInput = (ms: number): string => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Hours as a short decimal for grids and CSV: 8.4 */
export const fmtHours = (ms: number): string => (ms / HOUR_MS).toFixed(1);

/** Everyone to list: the team, plus anyone with records who has since left. */
export function peopleFrom(team: { id: string; name: string }[], records: AttendanceRecord[]): { id: string; name: string }[] {
    const map = new Map(team.map(u => [u.id, u.name]));
    for (const r of records) if (!map.has(r.employeeId)) map.set(r.employeeId, r.employeeName || 'Former employee');
    return [...map.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}
