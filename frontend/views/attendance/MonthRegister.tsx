import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { ChevronLeft, ChevronRight, Download, Loader2 } from 'lucide-react';
import { AuthUser } from '../../services/authService';
import { AttendanceRecord } from '../../types';
import { attendanceService } from '../../services/attendanceService';
import { LONG_SHIFT_MS, MONTHS, downloadCsv, fmtHours, monthRange, peopleFrom, startOfDay, toDateInput, workedMs } from './attendanceUtils';

interface MonthRegisterProps {
    team: AuthUser[];
    refreshKey: number;
    /** Open the day view for a date (start of day). */
    onOpenDay: (day: number) => void;
}

type Cell = { worked: number; open: boolean; forgot: boolean };

const WEEKDAY_LETTER = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/**
 * Admin: the month as an attendance register — one row per person, one
 * column per day, hours in each cell. Tap a cell to open that day.
 */
export const MonthRegister: React.FC<MonthRegisterProps> = ({ team, refreshKey, onOpenDay }) => {
    const [year, setYear] = useState(() => new Date().getFullYear());
    const [month, setMonth] = useState(() => new Date().getMonth());
    const [records, setRecords] = useState<AttendanceRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const now = Date.now();
    const today = startOfDay(now);

    const load = useCallback(async () => {
        setLoading(true);
        const { from, to } = monthRange(year, month);
        try {
            const all = await attendanceService.getRecords({ from, to });
            setRecords(all.filter(r => r.checkInAt && r.checkInAt >= from && r.checkInAt < to));
        } catch (e) {
            toast.error((e as Error).message || 'Failed to load the month');
        } finally {
            setLoading(false);
        }
    }, [year, month]);

    useEffect(() => { void load(); }, [load, refreshKey]);

    // Open scrolled to today, so a phone doesn't start at the 1st with no
    // hint that the grid scrolls sideways.
    const scrollerRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const box = scrollerRef.current;
        const cell = box?.querySelector<HTMLElement>('[data-today]');
        if (box && cell && !loading) box.scrollLeft = Math.max(0, cell.offsetLeft - box.clientWidth / 2);
    }, [loading, year, month]);

    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);
    const isCurrentMonth = year === new Date().getFullYear() && month === new Date().getMonth();

    // person id -> day -> cell
    const grid = useMemo(() => {
        const map = new Map<string, Map<number, Cell>>();
        for (const r of records) {
            const day = new Date(r.checkInAt as number).getDate();
            const byDay = map.get(r.employeeId) ?? new Map<number, Cell>();
            const cell = byDay.get(day) ?? { worked: 0, open: false, forgot: false };
            cell.worked += workedMs(r, now);
            if (r.status === 'checked-in') {
                if (startOfDay(r.checkInAt as number) < today) cell.forgot = true;
                else cell.open = true;
            }
            byDay.set(day, cell);
            map.set(r.employeeId, byDay);
        }
        return map;
    }, [records, now, today]);

    const people = useMemo(() => peopleFrom(team, records), [team, records]);

    const totals = (id: string) => {
        const byDay = grid.get(id);
        if (!byDay) return { days: 0, worked: 0 };
        let worked = 0;
        for (const c of byDay.values()) worked += c.worked;
        return { days: byDay.size, worked };
    };

    const shift = (dir: number) => {
        const d = new Date(year, month + dir, 1);
        setYear(d.getFullYear());
        setMonth(d.getMonth());
    };

    const exportMonth = () => {
        const head = ['Name', ...days.map(d => toDateInput(new Date(year, month, d).getTime())), 'Days present', 'Total hours'];
        const lines = people.map(p => {
            const byDay = grid.get(p.id);
            const t = totals(p.id);
            return [
                p.name,
                ...days.map(d => {
                    const c = byDay?.get(d);
                    if (!c) return '';
                    if (c.forgot) return 'not checked out';
                    return fmtHours(c.worked);
                }),
                t.days, fmtHours(t.worked),
            ];
        });
        downloadCsv(`attendance-${year}-${String(month + 1).padStart(2, '0')}.csv`, [head, ...lines]);
        toast.success('Exported');
    };

    const dayStart = (d: number) => new Date(year, month, d).getTime();
    const isWeekend = (d: number) => [0, 6].includes(new Date(year, month, d).getDay());

    return (
        <div className="space-y-4">
            <section className="neu-card p-3 flex items-center gap-2">
                <button type="button" onClick={() => shift(-1)} aria-label="Previous month" className="neu-icon-btn neu-btn active-scale"><ChevronLeft size={16} /></button>
                <p className="flex-1 text-center font-serif text-lg text-[var(--neu-text)]">{MONTHS[month]} {year}</p>
                <button type="button" onClick={() => shift(1)} disabled={isCurrentMonth} aria-label="Next month" className="neu-icon-btn neu-btn active-scale disabled:opacity-30"><ChevronRight size={16} /></button>
                <button type="button" onClick={exportMonth} disabled={loading} className="neu-raised-sm neu-btn rounded-full px-3.5 py-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--neu-gold)] active-scale disabled:opacity-40 ml-1">
                    <Download size={13} /> Export
                </button>
            </section>

            <p className="px-1 text-[11px] text-[var(--neu-text-dim)] flex flex-wrap gap-x-4 gap-y-1">
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-gold-500/25" /> Hours worked</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-emerald-500/25" /> In now</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-amber-500/30" /> Over 14 h — check</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-red-500/20" /> Not checked out</span>
                <span>Tap a day to see its details</span>
            </p>

            <section className="neu-card p-2">
                {loading ? (
                    <div className="py-12 flex justify-center"><Loader2 size={20} className="animate-spin text-gold-500" /></div>
                ) : (
                    <div ref={scrollerRef} className="overflow-x-auto no-scrollbar">
                        <table className="border-separate border-spacing-0 text-[11px] tabular-nums">
                            <thead>
                                <tr>
                                    <th className="sticky left-0 z-10 bg-[var(--neu-bg)] text-left font-semibold text-[10px] uppercase tracking-wider text-[var(--neu-text-dim)] px-2 py-1.5 min-w-[112px]">Name</th>
                                    {days.map(d => (
                                        <th key={d} data-today={dayStart(d) === today || undefined} className={`font-medium px-0 py-1 w-9 min-w-[36px] text-center ${isWeekend(d) ? 'text-[var(--neu-text-dim)] opacity-60' : 'text-[var(--neu-text-dim)]'} ${dayStart(d) === today ? 'text-[var(--neu-gold)]' : ''}`}>
                                            <span className="block text-[9px]">{WEEKDAY_LETTER[new Date(year, month, d).getDay()]}</span>
                                            <button type="button" onClick={() => onOpenDay(dayStart(d))} disabled={dayStart(d) > today} className="font-semibold hover:text-[var(--neu-gold)] disabled:cursor-default" aria-label={`Open ${toDateInput(dayStart(d))}`}>{d}</button>
                                        </th>
                                    ))}
                                    <th className="font-semibold text-[10px] uppercase tracking-wider text-[var(--neu-text-dim)] px-2 text-right">Days</th>
                                    <th className="font-semibold text-[10px] uppercase tracking-wider text-[var(--neu-text-dim)] px-2 text-right">Hours</th>
                                </tr>
                            </thead>
                            <tbody>
                                {people.map(p => {
                                    const byDay = grid.get(p.id);
                                    const t = totals(p.id);
                                    return (
                                        <tr key={p.id}>
                                            <td className="sticky left-0 z-10 bg-[var(--neu-bg)] px-2 py-1 text-[12px] font-medium text-[var(--neu-text)] truncate max-w-[140px] border-t border-[var(--neu-line)]">{p.name}</td>
                                            {days.map(d => {
                                                const c = byDay?.get(d);
                                                const future = dayStart(d) > today;
                                                let cls = isWeekend(d) ? 'bg-gray-500/[0.06]' : '';
                                                let text = '';
                                                if (c?.forgot) { cls = 'bg-red-500/20 text-red-700 dark:text-red-300 font-semibold'; text = '!'; }
                                                else if (c?.open) { cls = 'bg-emerald-500/25 text-emerald-800 dark:text-emerald-300 font-semibold'; text = 'In'; }
                                                else if (c && c.worked > LONG_SHIFT_MS) { cls = 'bg-amber-500/30 text-amber-900 dark:text-amber-200 font-semibold'; text = fmtHours(c.worked); }
                                                else if (c) { cls = 'bg-gold-500/25 text-[var(--neu-text)] font-medium'; text = fmtHours(c.worked); }
                                                return (
                                                    <td key={d} className="p-0.5 border-t border-[var(--neu-line)]">
                                                        <button
                                                            type="button"
                                                            disabled={future}
                                                            onClick={() => onOpenDay(dayStart(d))}
                                                            title={c ? `${p.name}, ${toDateInput(dayStart(d))}: ${c.forgot ? 'not checked out' : `${fmtHours(c.worked)} h`}` : undefined}
                                                            className={`w-8 h-7 rounded-md text-[10.5px] ${cls} ${dayStart(d) === today ? 'ring-1 ring-gold-500/70' : ''} disabled:cursor-default hover:ring-1 hover:ring-[var(--neu-gold)]`}
                                                        >
                                                            {text}
                                                        </button>
                                                    </td>
                                                );
                                            })}
                                            <td className="px-2 text-right font-semibold text-[var(--neu-text)] border-t border-[var(--neu-line)]">{t.days}</td>
                                            <td className="px-2 text-right font-semibold text-[var(--neu-text)] border-t border-[var(--neu-line)]">{fmtHours(t.worked)}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>
        </div>
    );
};
