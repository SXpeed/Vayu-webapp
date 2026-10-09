import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarEvent, UserProfile } from '../types';
import { apiCall } from '../services/apiClient';
import { eventColor, eventTimeLabel } from '../services/eventService';
import { ChevronLeft, ChevronRight, ChevronDown, X } from 'lucide-react';
import { PageRoot, PageHeader, Button } from '../components/ui';
import { DayTasks } from './tasks/TaskList';
import { dayKeyOf } from './tasks/taskModel';

interface CalendarViewProps {
    events: CalendarEvent[];
    onBack: () => void;
    /** Tasks are ticked, added and edited here too (they are saved with their event). */
    onUpdateEvent?: (ev: CalendarEvent) => void;
    teamMembers?: UserProfile[];
    canEdit?: boolean;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const dayKey = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const startOfDayMs = (d: Date): number => {
    const t = new Date(d);
    t.setHours(0, 0, 0, 0);
    return t.getTime();
};

const startOfTodayMs = (): number => startOfDayMs(new Date());
const eventCount = (n: number): string => {
    if (n === 0) return '';
    return n === 1 ? '1 event' : `${n} events`;
};

interface CalendarCell {
    date: Date;
    inMonth: boolean;
}

/**
 * The month as six weeks (Sunday first), always: every month is the same
 * height, so moving between months never makes the page jump. Days of the
 * neighbouring months fill the edges.
 */
function buildMonthGrid(year: number, month: number): CalendarCell[][] {
    const first = new Date(year, month, 1 - new Date(year, month, 1).getDay());
    return Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, d) => {
        const date = new Date(first.getFullYear(), first.getMonth(), first.getDate() + w * 7 + d);
        return { date, inMonth: date.getMonth() === month };
    }));
}

type CellSize = 'phone' | 'mini' | 'large';
const CELL: Record<CellSize, { cls: string; num: string; top: string; size: string; dots: string }> = {
    phone: { cls: 'aspect-square w-full pt-[7px]', num: 'text-[13px]', top: '7px', size: '13px', dots: 'mt-auto mb-[6px]' },
    mini: { cls: 'h-7 w-full pt-[5px] !rounded-[0.45rem]', num: 'text-[10px]', top: '5px', size: '10px', dots: 'mt-auto mb-[3px] scale-75' },
    large: { cls: 'aspect-square w-full pt-2.5', num: 'text-[15px]', top: '10px', size: '15px', dots: 'mt-auto mb-2' },
};

/**
 * One day. Today: its number in full ink with a short accent bar under it.
 * Selected: a soft ink surface. Past days and the neighbouring months recede.
 * Up to three event dots in a fixed slot, then "+n".
 */
const DayCell: React.FC<{
    cell: CalendarCell; size: CellSize; selected: boolean; today: boolean; past: boolean;
    holiday?: string; dayEvents: CalendarEvent[]; hideOutside?: boolean; onSelect: () => void;
}> = ({ cell, size, selected, today, past, holiday, dayEvents, hideOutside = false, onSelect }) => {
    const v = CELL[size];
    if (!cell.inMonth && hideOutside) return <div className={v.cls} aria-hidden />;
    const label = [
        cell.date.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }),
        today ? 'today' : '',
        holiday ?? '',
        eventCount(dayEvents.length),
    ].filter(Boolean).join(', ');
    return (
        <button
            type="button"
            onClick={onSelect}
            aria-pressed={selected}
            aria-label={label}
            data-today={today || undefined}
            data-past={past || undefined}
            data-outside={!cell.inMonth || undefined}
            data-holiday={holiday ? '' : undefined}
            title={holiday}
            className={`cal-day ${v.cls}`}
            style={{ '--cal-num-top': v.top, '--cal-num-size': v.size } as React.CSSProperties}
        >
            <span className={`cal-day-num ${v.num}`}>{cell.date.getDate()}</span>
            <span className={`cal-dots ${v.dots}`} aria-hidden>
                {dayEvents.slice(0, 3).map(ev => (
                    <span key={ev.id} className="cal-dot" style={{ backgroundColor: eventColor(ev) }} />
                ))}
                {dayEvents.length > 3 && <span className="cal-more">+{dayEvents.length - 3}</span>}
                {dayEvents.length === 0 && holiday && <span className="cal-dot bg-[#b0544a] dark:bg-[#e3958b] opacity-70" />}
            </span>
        </button>
    );
};

export const CalendarView: React.FC<CalendarViewProps> = ({ events, onBack, onUpdateEvent, teamMembers = [], canEdit = false }) => {
    const today = useMemo(() => new Date(), []);
    const [viewYear, setViewYear] = useState(today.getFullYear());
    const [viewMonth, setViewMonth] = useState(today.getMonth());
    const [selectedDate, setSelectedDate] = useState<number>(() => startOfTodayMs());
    const [holidayMap, setHolidayMap] = useState<Record<string, string>>({});
    /** Year-at-a-glance (desktop): the month currently open in the big
     *  floating calendar, plus a flag so closing plays a zoom-out first. */
    const [openMonth, setOpenMonth] = useState<number | null>(null);
    const [floatClosing, setFloatClosing] = useState(false);
    const closeFloat = () => {
        setFloatClosing(true);
        window.setTimeout(() => { setOpenMonth(null); setFloatClosing(false); }, 220);
    };

    // Esc closes the floating month.
    useEffect(() => {
        if (openMonth === null) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeFloat(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [openMonth]);

    // ── Public holidays (India: national + festivals) via the Worker's
    // /api/holidays route (Calendarific, cached in KV per year). Session cache
    // avoids refetching while flipping months. Failures (offline / not
    // configured) simply leave the calendar without holiday labels.
    useEffect(() => {
        const cacheKey = `vayu_holidays_${viewYear}`;
        const cached = sessionStorage.getItem(cacheKey);
        if (cached) {
            try { setHolidayMap(prev => ({ ...prev, ...JSON.parse(cached) })); } catch { /* corrupt cache — refetch */ }
            return;
        }
        let cancelled = false;
        apiCall<Array<{ date: string; name: string }>>(`/holidays?year=${viewYear}`)
            .then(list => {
                if (cancelled || !Array.isArray(list)) return;
                const map: Record<string, string> = {};
                for (const h of list) {
                    if (h?.date && h?.name) map[h.date] = h.name;
                }
                try { sessionStorage.setItem(cacheKey, JSON.stringify(map)); } catch { /* quota — ignore */ }
                setHolidayMap(prev => ({ ...prev, ...map }));
            })
            .catch(() => { /* offline or not configured — not critical */ });
        return () => { cancelled = true; };
    }, [viewYear]);

    const weeks = useMemo(() => buildMonthGrid(viewYear, viewMonth), [viewYear, viewMonth]);
    /** Which way the month grid slides in: 1 from the right (later), -1 from the left. */
    const [direction, setDirection] = useState<1 | -1>(1);

    /** Shows this month, sliding in from the side it lies on. */
    const showMonth = (year: number, month: number) => {
        const target = year * 12 + month;
        const current = viewYear * 12 + viewMonth;
        if (target === current) return;
        setDirection(target > current ? 1 : -1);
        setViewYear(year);
        setViewMonth(month);
    };
    const goPrevMonth = () => showMonth(viewMonth === 0 ? viewYear - 1 : viewYear, (viewMonth + 11) % 12);
    const goNextMonth = () => showMonth(viewMonth === 11 ? viewYear + 1 : viewYear, (viewMonth + 1) % 12);
    const goToday = () => {
        const now = new Date();
        showMonth(now.getFullYear(), now.getMonth());
        setSelectedDate(startOfTodayMs());
    };
    /** A day was picked; one from a neighbouring month brings that month in. */
    const pickDay = (cell: CalendarCell) => {
        setSelectedDate(startOfDayMs(cell.date));
        if (!cell.inMonth) showMonth(cell.date.getFullYear(), cell.date.getMonth());
    };

    // Phones: swipe the month sideways to move between months.
    const swipe = useRef<{ x: number; y: number } | null>(null);
    const swipeHandlers = {
        onPointerDown: (e: React.PointerEvent) => { if (e.pointerType !== 'mouse') swipe.current = { x: e.clientX, y: e.clientY }; },
        onPointerUp: (e: React.PointerEvent) => {
            const start = swipe.current;
            swipe.current = null;
            if (!start) return;
            const dx = e.clientX - start.x;
            if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(e.clientY - start.y) * 1.5) (dx < 0 ? goNextMonth : goPrevMonth)();
        },
        onPointerCancel: () => { swipe.current = null; },
    };

    /** Events that visually cover the given day (start..endDate inclusive). */
    const eventsOnDay = (day: Date): CalendarEvent[] => {
        const from = startOfDayMs(day);
        const to = from + 86_399_999;
        return events.filter(ev => ev.date <= to && (ev.endDate ?? ev.date) >= from);
    };

    const holidayOn = (day: Date): string | undefined => holidayMap[dayKey(day)];
    const isToday = (day: Date): boolean => dayKey(day) === dayKey(today);
    const todayStart = startOfDayMs(today);
    /** Everything a day cell needs, the same in every view. */
    const cellProps = (cell: CalendarCell) => {
        const dayStart = startOfDayMs(cell.date);
        return {
            cell,
            selected: dayStart === selectedDate,
            today: isToday(cell.date),
            past: dayStart < todayStart,
            holiday: holidayOn(cell.date),
            dayEvents: eventsOnDay(cell.date),
            onSelect: () => pickDay(cell),
        };
    };

    const selectedDay = new Date(selectedDate);
    const selectedHoliday = holidayOn(selectedDay);
    const selectedEvents = useMemo(
        () => eventsOnDay(selectedDay).sort((a, b) => a.date - b.date),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [events, selectedDate, holidayMap]
    );

    return (
        <PageRoot width="wide">
            <PageHeader
                title="Calendar"
                subtitle={`${MONTHS[viewMonth]} ${viewYear}`}
                onBack={onBack}
                // The legend and month grid sit between this header and the
                // scroller, where a floating stepper would cover them.
                floatTools={false}
                actions={
                    <Button onClick={goToday} className="text-[11px] uppercase tracking-widest px-3 py-1.5">
                        Today
                    </Button>
                }
            >
                {/* Month stepper (phone only — desktop shows the whole year).
                    The month itself is the header subtitle, so it isn't
                    repeated here. */}
                <div className="flex items-center justify-between lg:hidden">
                    <button
                        onClick={goPrevMonth}
                        aria-label="Previous month"
                        className="neu-icon-btn-sm text-gray-700 dark:text-gray-300 active-scale"
                    >
                        <ChevronLeft size={18} />
                    </button>
                    <span className="text-[11px] font-medium text-gray-600 dark:text-gray-300 uppercase tracking-widest">
                        Browse months
                    </span>
                    <button
                        onClick={goNextMonth}
                        aria-label="Next month"
                        className="neu-icon-btn-sm text-gray-700 dark:text-gray-300 active-scale"
                    >
                        <ChevronRight size={18} />
                    </button>
                </div>
            </PageHeader>

            {/* Legend: events in their own colour, holidays a muted red, today's bar */}
            <div className="flex items-center gap-4 px-4 pb-2 text-[11px] text-[var(--neu-text-dim)]">
                <span className="flex items-center gap-1.5"><span className="cal-dot bg-[var(--neu-text-dim)]" />Event</span>
                <span className="flex items-center gap-1.5"><span className="cal-dot bg-[#b0544a] dark:bg-[#e3958b]" />Holiday</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-[2px] rounded-full bg-[var(--neu-gold)]" />Today</span>
            </div>

            {/* Month (phone): six weeks, a hairline between them; swipe for the next month */}
            <div className="px-3 pb-1 lg:hidden">
                <div className="neu-card px-2 pt-2 pb-1 overflow-hidden touch-pan-y" {...swipeHandlers}>
                    <div className="grid grid-cols-7 pb-1">
                        {WEEKDAYS.map(day => (
                            <div key={day} className="text-center text-[10px] font-semibold text-[var(--neu-text-dim)] uppercase tracking-[0.12em] py-1">
                                {day.charAt(0)}
                            </div>
                        ))}
                    </div>
                    <div key={`${viewYear}-${viewMonth}`} className="cal-swap" style={{ '--cal-dir': direction } as React.CSSProperties}>
                        {weeks.map(week => (
                            <div key={dayKey(week[0].date)} className="cal-week grid grid-cols-7 gap-1 py-1">
                                {week.map(cell => <DayCell key={dayKey(cell.date)} size="phone" {...cellProps(cell)} />)}
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* Calendar + day details */}
            <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
                {/* Year at a glance (desktop) */}
                <div className="hidden lg:flex flex-col flex-1 min-w-0 min-h-0">
                    {/* Year navigation */}
                    <div className="flex items-center justify-between px-5 pt-3 pb-1">
                        <button onClick={() => setViewYear(y => y - 1)} aria-label="Previous year" className="neu-icon-btn-sm text-gray-700 dark:text-gray-300 active-scale">
                            <ChevronLeft size={18} />
                        </button>
                        <span className="text-sm font-serif text-gray-900 dark:text-white tracking-wide">{viewYear}</span>
                        <button onClick={() => setViewYear(y => y + 1)} aria-label="Next year" className="neu-icon-btn-sm text-gray-700 dark:text-gray-300 active-scale">
                            <ChevronRight size={18} />
                        </button>
                    </div>
                    {/* 12 mini months */}
                    <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar grid grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3 px-5 py-6 content-start">
                        {Array.from({ length: 12 }, (_, m) => {
                            const miniCells = buildMonthGrid(viewYear, m);
                            const isCurrentMonth = m === today.getMonth() && viewYear === today.getFullYear();
                            return (
                                <div
                                    key={m}
                                    className="neu-raised rounded-2xl p-3 animate-fade-in-up"
                                    style={{ animationDelay: `${m * 25}ms` }}
                                >
                                    <button
                                        type="button"
                                        onClick={() => setOpenMonth(m)}
                                        aria-haspopup="dialog"
                                        aria-label={`Enlarge ${MONTHS[m]} ${viewYear}`}
                                        className="w-full flex items-center justify-between mb-1 px-0.5 cursor-pointer select-none"
                                    >
                                        <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--neu-text)]">{MONTHS[m]}</p>
                                        <span className="flex items-center gap-1">
                                            {isCurrentMonth && <span className="w-1.5 h-1.5 rounded-full bg-gold-500" title="This month" />}
                                            <ChevronDown
                                                size={11}
                                                className="text-gray-400 dark:text-gray-500"
                                            />
                                        </span>
                                    </button>
                                    <div className="grid grid-cols-7 gap-x-[2px]">
                                        {WEEKDAYS.map((d, i) => (
                                            <div key={i} className="text-center text-[8px] font-semibold text-[var(--neu-text-dim)] py-0.5">{d.charAt(0)}</div>
                                        ))}
                                    </div>
                                    {miniCells.map(week => (
                                        <div key={dayKey(week[0].date)} className="cal-week grid grid-cols-7 gap-x-[2px] py-[2px]">
                                            {week.map(cell => <DayCell key={dayKey(cell.date)} size="mini" hideOutside {...cellProps(cell)} />)}
                                        </div>
                                    ))}
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Selected day panel */}
                <div className="flex-1 min-h-0 overflow-y-auto p-3 pt-3 no-scrollbar lg:flex-none lg:w-[340px] lg:shrink-0 lg:border-l lg:border-gray-200/60 dark:lg:border-white/5 lg:p-4">
                <div className="flex items-center justify-between mb-2 px-1">
                    <h2 className="text-xs font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest">
                        {selectedDay.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}
                    </h2>
                    <span className="text-[11px] text-gray-600 dark:text-gray-300 uppercase tracking-wider">
                        {selectedDay.toLocaleDateString([], { year: 'numeric' })}
                    </span>
                </div>

                {selectedHoliday && (
                    <p className="px-1 pb-2 text-[12px] text-[#b0544a] dark:text-[#e3958b]">Public holiday · {selectedHoliday}</p>
                )}

                {/* The day's events: quiet rows on one surface */}
                {selectedEvents.length > 0 && (
                    <ul className="neu-card px-3 py-1 mb-4">
                        {selectedEvents.map(ev => {
                            const todos = ev.todos || [];
                            const doneCount = todos.filter(t => t.done).length;
                            const isRange = !!ev.endDate && dayKey(new Date(ev.endDate)) !== dayKey(new Date(ev.date));
                            return (
                                <li key={ev.id} className="task-row flex items-stretch gap-3 py-2.5">
                                    <span className="w-[3px] rounded-full shrink-0" style={{ backgroundColor: eventColor(ev) }} aria-hidden />
                                    <span className="flex-1 min-w-0">
                                        <span className="block font-serif text-[15px] leading-snug text-[var(--neu-text)] truncate">{ev.title}</span>
                                        <span className="block mt-0.5 text-[11.5px] text-[var(--neu-text-dim)] truncate">
                                            {isRange ? fmtRange(selectedDate, ev) : eventTimeLabel(ev.date)}
                                            {todos.length > 0 ? ` · ${doneCount}/${todos.length} tasks` : ''}
                                            {ev.createdByName ? ` · ${ev.createdByName}` : ''}
                                        </span>
                                        {ev.notes && <span className="block mt-0.5 text-[11.5px] text-[var(--neu-text-dim)] line-clamp-2">{ev.notes}</span>}
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                )}
                {selectedEvents.length === 0 && !selectedHoliday && (
                    <p className="px-1 py-3 text-[12.5px] text-[var(--neu-text-dim)]">Nothing scheduled for this day.</p>
                )}

                {onUpdateEvent && (
                    <div className="px-1">
                        <DayTasks events={events} day={dayKeyOf(selectedDay)} teamMembers={teamMembers} canEdit={canEdit} onUpdateEvent={onUpdateEvent} />
                    </div>
                )}
            </div>
            </div>

            {/* Floating month calendar (desktop year view) — zooms in big and
                smooth; Esc, backdrop click or ✕ zoom it back out. Day clicks
                select the date (the right-hand day panel updates behind it). */}
            {openMonth !== null && (
                <dialog open
                    className={`fixed inset-0 z-[70] flex items-center justify-center p-4 lg:p-8 ${floatClosing ? 'cal-scrim-out' : 'cal-scrim-in'}`}
                    style={{ backgroundColor: 'rgba(15, 17, 22, 0.45)', backdropFilter: 'blur(5px)', WebkitBackdropFilter: 'blur(5px)' }}
                    aria-modal="true"
                    aria-label={`${MONTHS[openMonth]} ${viewYear}`}
                >
                    <button type="button" tabIndex={-1} aria-label="Close calendar" onClick={closeFloat} className="absolute inset-0 w-full h-full cursor-default" />
                    <div
                        className={`relative neu-raised rounded-3xl w-[min(92vw,700px)] max-h-[86dvh] overflow-y-auto no-scrollbar p-5 ${floatClosing ? 'cal-float-out' : 'cal-float-in'}`}
                    >
                        <div className="flex items-center justify-between mb-3 px-1">
                            <p className="font-serif text-lg text-[var(--neu-text)]">
                                {MONTHS[openMonth]} {viewYear}
                            </p>
                            <button
                                type="button"
                                onClick={closeFloat}
                                aria-label="Close calendar"
                                className="neu-icon-btn-sm text-gray-700 dark:text-gray-300 active-scale"
                            >
                                <X size={16} />
                            </button>
                        </div>

                        <div className="grid grid-cols-7 gap-1">
                            {WEEKDAYS.map(d => (
                                <div key={d} className="text-center text-[10px] font-semibold text-[var(--neu-text-dim)] uppercase tracking-[0.12em] py-1">{d}</div>
                            ))}
                        </div>
                        {buildMonthGrid(viewYear, openMonth).map(week => (
                            <div key={dayKey(week[0].date)} className="cal-week grid grid-cols-7 gap-1 py-1">
                                {week.map(cell => <DayCell key={dayKey(cell.date)} size="large" hideOutside {...cellProps(cell)} />)}
                            </div>
                        ))}
                    </div>
                </dialog>
            )}
        </PageRoot>
    );
};

/** How the event reads on a given day inside a multi-day range. */
function fmtRange(dayMs: number, ev: CalendarEvent): string {
    const day = new Date(dayMs);
    const start = new Date(ev.date);
    if (day.getTime() === startOfDayMs(start)) {
        return new Date(ev.date).getHours() === 0 ? 'Starts today' : `Starts ${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
    const end = new Date(ev.endDate ?? ev.date);
    if (day.getTime() === startOfDayMs(end)) return 'Ends today';
    return 'Ongoing';
}