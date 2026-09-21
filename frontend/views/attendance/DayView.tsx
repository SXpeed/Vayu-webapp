import React, { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { ChevronLeft, ChevronRight, Download, Loader2, Search, TriangleAlert } from 'lucide-react';
import { AuthUser } from '../../services/authService';
import { AttendanceRecord, StoreConfig } from '../../types';
import { attendanceService } from '../../services/attendanceService';
import {
    DAY_MS, HOUR_MS, LONG_SHIFT_MS, dayRange, downloadCsv, fmtDay, fmtHours, fmtTime, peopleFrom, startOfDay,
    storeName, toDateInput, workedMs,
} from './attendanceUtils';

interface DayViewProps {
    team: AuthUser[];
    stores: StoreConfig[];
    refreshKey: number;
    /** Start of the day being shown (controlled, so the month grid can open a day). */
    day: number;
    onDayChange: (day: number) => void;
}

type DayStatus = 'in' | 'present' | 'forgot' | 'absent';

const STATUS: Record<DayStatus, { label: string; cls: string; order: number }> = {
    in: { label: 'In now', cls: 'text-emerald-700 dark:text-emerald-400', order: 0 },
    present: { label: 'Present', cls: 'text-sky-700 dark:text-sky-400', order: 1 },
    forgot: { label: 'Not checked out', cls: 'text-red-600 dark:text-red-400', order: 2 },
    absent: { label: 'Absent', cls: 'text-[var(--neu-text-dim)]', order: 3 },
};

interface Row {
    id: string;
    name: string;
    status: DayStatus;
    records: AttendanceRecord[];
    worked: number;
}

/** `datetime-local` value for an epoch-ms time, in local time. */
const toLocalInput = (ms: number) => `${toDateInput(ms)}T${new Date(ms).toTimeString().slice(0, 5)}`;

/** Admin: one day, everyone on it — who came, when, for how long. */
export const DayView: React.FC<DayViewProps> = ({ team, stores, refreshKey, day, onDayChange }) => {
    const [records, setRecords] = useState<AttendanceRecord[]>([]);
    const [openElsewhere, setOpenElsewhere] = useState<AttendanceRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState('');
    const [closing, setClosing] = useState<{ id: string; value: string } | null>(null);
    const [savingClose, setSavingClose] = useState(false);
    const now = Date.now();
    const today = startOfDay(now);
    const isToday = day === today;

    const load = useCallback(async () => {
        setLoading(true);
        const { from, to } = dayRange(day);
        try {
            const [dayRecs, latest] = await Promise.all([
                attendanceService.getRecords({ from, to }),
                // Forgotten check-outs from earlier days, for "needs attention".
                day === startOfDay(Date.now()) ? attendanceService.getRecords() : Promise.resolve([] as AttendanceRecord[]),
            ]);
            // Filter again: older servers ignore the range.
            setRecords(dayRecs.filter(r => r.checkInAt && r.checkInAt >= from && r.checkInAt < to));
            setOpenElsewhere(latest.filter(r => r.status === 'checked-in' && r.checkInAt && r.checkInAt < from));
        } catch (e) {
            toast.error((e as Error).message || 'Failed to load attendance');
        } finally {
            setLoading(false);
        }
    }, [day]);

    useEffect(() => { void load(); }, [load, refreshKey]);

    const rows = useMemo<Row[]>(() => peopleFrom(team, records).map(p => {
        const mine = records.filter(r => r.employeeId === p.id);
        let status: DayStatus = 'absent';
        if (mine.some(r => r.status === 'checked-in')) status = isToday ? 'in' : 'forgot';
        else if (mine.length) status = 'present';
        return { ...p, status, records: mine, worked: mine.reduce((s, r) => s + workedMs(r, now), 0) };
    }).sort((a, b) => STATUS[a.status].order - STATUS[b.status].order || a.name.localeCompare(b.name)),
    [team, records, isToday, now]);

    const counts = useMemo(() => {
        const c = { in: 0, present: 0, forgot: 0, absent: 0 };
        for (const r of rows) c[r.status] += 1;
        return c;
    }, [rows]);

    /** Forgotten check-outs have no known length, so no hours. */
    const hoursCell = (r: Row) => {
        if (r.status === 'forgot') return '—';
        return r.records.length ? `${fmtHours(r.worked)}h` : '';
    };

    /** Check-out time, with its day when it wasn't the same day (a late check-out). */
    const outText = (last?: AttendanceRecord) => {
        if (!last?.checkOutAt) return null;
        const t = fmtTime(last.checkOutAt);
        return startOfDay(last.checkOutAt) === day ? t : `${t} (${fmtDay(last.checkOutAt)})`;
    };
    /** Hours over 14 are almost always a missed check-out — flag them. */
    const hoursCls = (r: Row) => (r.worked > LONG_SHIFT_MS ? 'text-amber-700 dark:text-amber-400' : 'text-[var(--neu-text)]');

    const q = query.trim().toLowerCase();
    const shown = q ? rows.filter(r => r.name.toLowerCase().includes(q)) : rows;

    const go = (delta: number) => onDayChange(startOfDay(day + delta * DAY_MS + HOUR_MS * 12));

    const exportDay = () => {
        const head = ['Date', 'Name', 'Status', 'Check in', 'Check out', 'Hours', 'Store'];
        const lines = rows.map(r => {
            const first = r.records.at(-1);
            const last = r.records[0];
            return [
                toDateInput(day), r.name, STATUS[r.status].label,
                first ? fmtTime(first.checkInAt) : '', outText(last) ?? '',
                r.records.length && r.status !== 'forgot' ? fmtHours(r.worked) : '', last ? storeName(stores, last.storeId) : '',
            ];
        });
        downloadCsv(`attendance-${toDateInput(day)}.csv`, [head, ...lines]);
        toast.success('Exported');
    };

    // ── Close a forgotten check-out ──
    const startClose = (r: AttendanceRecord) =>
        setClosing({ id: r.id, value: toLocalInput(Math.min((r.checkInAt as number) + 8 * HOUR_MS, Date.now())) });
    const saveClose = async (r: AttendanceRecord) => {
        if (!closing) return;
        const checkOutAt = new Date(closing.value).getTime();
        if (!Number.isFinite(checkOutAt) || checkOutAt <= (r.checkInAt as number)) { toast.error('Check-out must be after the check-in'); return; }
        if (checkOutAt > Date.now()) { toast.error('Check-out can’t be in the future'); return; }
        setSavingClose(true);
        try {
            await attendanceService.closeRecord(r.id, checkOutAt);
            toast.success(`Closed ${r.employeeName || 'the'} check-in`);
            setClosing(null);
            await load();
        } catch (e) {
            const msg = (e as Error).message || '';
            toast.error(msg === 'Not found' ? 'The server needs the latest update before check-ins can be closed' : msg || 'Could not close the check-in');
        } finally {
            setSavingClose(false);
        }
    };

    const attention = [...openElsewhere, ...(isToday ? [] : records.filter(r => r.status === 'checked-in'))];

    return (
        <div className="space-y-4">
            {/* Day picker + export */}
            <section className="neu-card p-3 flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => go(-1)} aria-label="Previous day" className="neu-icon-btn neu-btn active-scale"><ChevronLeft size={16} /></button>
                <div className="flex-1 min-w-[150px] text-center">
                    <p className="font-serif text-lg text-[var(--neu-text)] leading-tight">
                        {new Date(day).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}
                    </p>
                    <p className="text-[11px] text-[var(--neu-text-dim)]">{isToday ? 'Today' : new Date(day).getFullYear()}</p>
                </div>
                <button type="button" onClick={() => go(1)} disabled={isToday} aria-label="Next day" className="neu-icon-btn neu-btn active-scale disabled:opacity-30"><ChevronRight size={16} /></button>
                <div className="w-full sm:w-auto flex items-center gap-2 sm:ml-2">
                    <input
                        type="date"
                        value={toDateInput(day)}
                        max={toDateInput(now)}
                        onChange={e => { if (e.target.value) onDayChange(startOfDay(new Date(`${e.target.value}T12:00:00`).getTime())); }}
                        aria-label="Pick a day"
                        className="neu-field flex-1 sm:w-auto py-2 text-sm"
                    />
                    {!isToday && (
                        <button type="button" onClick={() => onDayChange(today)} className="neu-raised-sm neu-btn rounded-full px-3.5 py-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--neu-gold)] active-scale">Today</button>
                    )}
                    <button type="button" onClick={exportDay} disabled={loading} className="neu-raised-sm neu-btn rounded-full px-3.5 py-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--neu-gold)] active-scale disabled:opacity-40">
                        <Download size={13} /> Export
                    </button>
                </div>
            </section>

            {/* One-line summary */}
            <p className="px-1 text-xs text-[var(--neu-text-dim)] flex flex-wrap gap-x-4 gap-y-1">
                {isToday && <span><b className={STATUS.in.cls}>{counts.in}</b> in now</span>}
                <span><b className={STATUS.present.cls}>{counts.present}</b> {isToday ? 'checked out' : 'present'}</span>
                {!isToday && counts.forgot > 0 && <span><b className={STATUS.forgot.cls}>{counts.forgot}</b> not checked out</span>}
                <span><b className="text-[var(--neu-text)]">{counts.absent}</b> absent</span>
            </p>

            {/* Forgotten check-outs */}
            {!loading && attention.length > 0 && (
                <section className="neu-card px-1.5 py-1">
                    <p className="px-2.5 pt-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-red-600 dark:text-red-400 flex items-center gap-1.5">
                        <TriangleAlert size={12} /> Never checked out — set their check-out time
                    </p>
                    {attention.map((r, i) => (
                        <React.Fragment key={r.id}>
                            {i > 0 && <div className="neu-divider mx-2.5" />}
                            <div className="px-2.5 py-2.5">
                                <div className="flex items-center gap-3">
                                    <p className="flex-1 min-w-0 text-[13px] text-[var(--neu-text)] truncate">
                                        <b className="font-medium">{r.employeeName || 'Employee'}</b>
                                        <span className="text-[var(--neu-text-dim)]"> · in {fmtDay(r.checkInAt as number)}, {fmtTime(r.checkInAt)} · {storeName(stores, r.storeId)}</span>
                                    </p>
                                    {closing?.id !== r.id && (
                                        <button type="button" onClick={() => startClose(r)} className="neu-raised-sm neu-btn rounded-full px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--neu-gold)] active-scale shrink-0">Close</button>
                                    )}
                                </div>
                                {closing?.id === r.id && (
                                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                                        <input
                                            type="datetime-local"
                                            value={closing.value}
                                            min={toLocalInput(r.checkInAt as number)}
                                            max={toLocalInput(Date.now())}
                                            onChange={e => setClosing({ id: r.id, value: e.target.value })}
                                            aria-label="Check-out time"
                                            className="neu-field flex-1 min-w-[190px] py-2 text-sm"
                                        />
                                        <button type="button" onClick={() => { void saveClose(r); }} disabled={savingClose} className="neu-button neu-button-primary">
                                            {savingClose && <Loader2 size={13} className="animate-spin" />} Save
                                        </button>
                                        <button type="button" onClick={() => setClosing(null)} disabled={savingClose} className="neu-button">Cancel</button>
                                    </div>
                                )}
                            </div>
                        </React.Fragment>
                    ))}
                </section>
            )}

            {/* Everyone */}
            <section className="neu-card p-2 sm:p-3">
                <div className="relative mb-2">
                    <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--neu-text-dim)] pointer-events-none" />
                    <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Find a person…" aria-label="Find a person" className="neu-field pl-9 py-2 text-sm" />
                </div>
                {loading ? (
                    <div className="py-10 flex justify-center"><Loader2 size={20} className="animate-spin text-gold-500" /></div>
                ) : (
                    <>
                        {/* Phone: a simple list */}
                        <div className="md:hidden">
                            {shown.map((r, i) => {
                                const first = r.records.at(-1);
                                const last = r.records[0];
                                return (
                                    <React.Fragment key={r.id}>
                                        {i > 0 && <div className="neu-divider mx-2.5" />}
                                        <div className="flex items-center gap-3 px-2.5 py-2.5">
                                            <div className="flex-1 min-w-0">
                                                <p className="text-[13px] font-medium text-[var(--neu-text)] truncate">{r.name}</p>
                                                <p className="text-[11px] text-[var(--neu-text-dim)] truncate tabular-nums">
                                                    {first
                                                        ? `${fmtTime(first.checkInAt)} – ${outText(last) ?? '…'} · ${storeName(stores, last.storeId)}`
                                                        : 'No check-in'}
                                                </p>
                                            </div>
                                            <div className="text-right shrink-0">
                                                <p className={`text-[11px] font-semibold ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</p>
                                                {hoursCell(r) && <p className={`text-[12px] font-semibold tabular-nums ${hoursCls(r)}`}>{hoursCell(r)}</p>}
                                            </div>
                                        </div>
                                    </React.Fragment>
                                );
                            })}
                            {shown.length === 0 && <p className="text-center text-xs text-[var(--neu-text-dim)] py-8">No one matches “{query}”.</p>}
                        </div>

                        {/* Desktop: a table */}
                        <table className="hidden md:table w-full text-[13px]">
                            <thead>
                                <tr className="text-left text-[10px] uppercase tracking-wider text-[var(--neu-text-dim)]">
                                    <th className="font-semibold px-2.5 py-2">Name</th>
                                    <th className="font-semibold px-2.5 py-2">Status</th>
                                    <th className="font-semibold px-2.5 py-2">In</th>
                                    <th className="font-semibold px-2.5 py-2">Out</th>
                                    <th className="font-semibold px-2.5 py-2 text-right">Hours</th>
                                    <th className="font-semibold px-2.5 py-2">Store</th>
                                </tr>
                            </thead>
                            <tbody>
                                {shown.map(r => {
                                    const first = r.records.at(-1);
                                    const last = r.records[0];
                                    return (
                                        <tr key={r.id} className="border-t border-[var(--neu-line)]">
                                            <td className="px-2.5 py-2.5 font-medium text-[var(--neu-text)]">{r.name}</td>
                                            <td className={`px-2.5 py-2.5 text-[12px] font-semibold ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</td>
                                            <td className="px-2.5 py-2.5 text-[var(--neu-text-dim)] tabular-nums">{first ? fmtTime(first.checkInAt) : '—'}</td>
                                            <td className="px-2.5 py-2.5 text-[var(--neu-text-dim)] tabular-nums">{outText(last) ?? '—'}</td>
                                            <td className={`px-2.5 py-2.5 text-right tabular-nums font-semibold ${hoursCls(r)}`}>{hoursCell(r) || '—'}</td>
                                            <td className="px-2.5 py-2.5 text-[var(--neu-text-dim)]">{last ? storeName(stores, last.storeId) : '—'}</td>
                                        </tr>
                                    );
                                })}
                                {shown.length === 0 && (
                                    <tr><td colSpan={6} className="text-center text-xs text-[var(--neu-text-dim)] py-8">No one matches “{query}”.</td></tr>
                                )}
                            </tbody>
                        </table>
                    </>
                )}
            </section>
        </div>
    );
};
