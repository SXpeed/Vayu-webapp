import React, { useEffect, useMemo, useState } from 'react';
import { CalendarEvent } from '../types';
import { apiCall } from '../services/apiClient';
import { eventColor } from '../services/eventService';
import { ChevronLeft, ChevronRight, ChevronDown, X, CalendarDays } from 'lucide-react';
import { PageRoot, PageHeader, Button } from '../components/ui';

interface CalendarViewProps {
    events: CalendarEvent[];
    onBack: () => void;
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

interface CalendarCell {
    date: Date;
    inMonth: boolean;
}

/** Build the 6-week grid (Sun-start) for the given month, padded with nulls. */
function buildMonthGrid(year: number, month: number): Array<CalendarCell | null> {
    const cells: Array<CalendarCell | null> = [];
    const firstWeekday = new Date(year, month, 1).getDay();
    for (let i = 0; i < firstWeekday; i++) cells.push(null);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
        cells.push({ date: new Date(year, month, d), inMonth: true });
    }
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
}

export const CalendarView: React.FC<CalendarViewProps> = ({ events, onBack }) => {
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

    const gridCells = useMemo(() => buildMonthGrid(viewYear, viewMonth), [viewYear, viewMonth]);

    const goPrevMonth = () => {
        if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
        else setViewMonth(m => m - 1);
    };
    const goNextMonth = () => {
        if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
        else setViewMonth(m => m + 1);
    };
    const goToday = () => {
        const now = new Date();
        setViewYear(now.getFullYear());
        setViewMonth(now.getMonth());
        setSelectedDate(startOfTodayMs());
    };

    /** Events that visually cover the given day (start..endDate inclusive). */
    const eventsOnDay = (day: Date): CalendarEvent[] => {
        const from = startOfDayMs(day);
        const to = from + 86_399_999;
        return events.filter(ev => ev.date <= to && (ev.endDate ?? ev.date) >= from);
    };

    const holidayOn = (day: Date): string | undefined => holidayMap[dayKey(day)];
    const isToday = (day: Date): boolean => dayKey(day) === dayKey(today);

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

            {/* Legend — events use their own colour; holidays/festivals are always red */}
            <div className="flex items-center gap-3 px-[10px] pb-1.5 text-[10px] text-gray-600 dark:text-gray-300 uppercase tracking-wider">
                <span className="flex items-center gap-1">
                    <span className="w-[6px] h-[6px] rounded-full bg-brand-900 dark:bg-gold-400 inline-block" />
                    Event (own colour)
                </span>
                <span className="flex items-center gap-1">
                    <span className="w-[6px] h-[6px] rounded-full bg-red-500 inline-block" />
                    Holiday / Festival
                </span>
            </div>

            {/* Month card (phone) */}
            <div className="px-3 pb-1 lg:hidden">
                <div className="neu-raised rounded-2xl p-2">
                    <div className="grid grid-cols-7 gap-[2px] pb-1.5">
                        {WEEKDAYS.map(day => (
                            <div key={day} className="text-center text-[10px] font-bold text-gray-600 dark:text-gray-300 uppercase tracking-widest py-1">
                                {day}
                            </div>
                        ))}
                    </div>
                    <div className="grid grid-cols-7 gap-[2px]">
                {gridCells.map((cell, i) => {
                    if (!cell) return <div key={`pad-${i}`} className="aspect-square" />;
                    const dayStart = startOfDayMs(cell.date);
                    const isSelected = dayStart === selectedDate;
                    const isTodayCell = isToday(cell.date);
                    const holiday = holidayOn(cell.date);
                    const dayEvents = eventsOnDay(cell.date);
                    const selectedCls = isSelected
                        ? 'bg-gold-500/15 ring-1 ring-gold-500/70'
                        : isTodayCell
                            ? 'neu-inset ring-1 ring-gray-300/70 dark:ring-gray-600/70'
                            : 'neu-hoverable';
                    return (
                        <button
                            key={dayKey(cell.date)}
                            type="button"
                            onClick={() => setSelectedDate(dayStart)}
                            aria-label={`${cell.date.getDate()} ${MONTHS[viewMonth]}${holiday ? `, ${holiday}` : ''}${dayEvents.length ? `, ${dayEvents.length} event(s)` : ''}`}
                            className={`aspect-square w-full flex flex-col items-center justify-start pt-[3px] rounded-lg transition-colors ${selectedCls}`}
                        >
                            <span className={`text-[11px] leading-none font-medium ${holiday ? 'text-red-600 dark:text-red-400' : isTodayCell ? 'text-brand-900 dark:text-gold-400 font-bold' : 'text-gray-900 dark:text-gray-100'}`}>
                                {cell.date.getDate()}
                            </span>
                            {holiday && (
                                <span className="text-[5px] leading-[1.1] text-red-500 truncate w-full px-[1px] mt-[1px]">
                                    {holiday}
                                </span>
                            )}
                            {dayEvents.length > 0 && (
                                <span className="mt-auto mb-[2px] flex items-center gap-[2px]">
                                    {dayEvents.slice(0, 3).map(ev => (
                                        <span
                                            key={ev.id}
                                            className="w-[5px] h-[5px] rounded-full shrink-0"
                                            style={{ backgroundColor: eventColor(ev) }}
                                        />
                                    ))}
                                    {dayEvents.length > 3 && (
                                        <span className="text-[6px] font-bold leading-none text-gray-700 dark:text-gray-300">
                                            +{dayEvents.length - 3}
                                        </span>
                                    )}
                                </span>
                            )}
                        </button>
                    );
                })}
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
                                        <p className="gold-text text-[10px] font-bold uppercase tracking-widest">{MONTHS[m]}</p>
                                        <span className="flex items-center gap-1">
                                            {isCurrentMonth && <span className="w-1.5 h-1.5 rounded-full bg-gold-500" title="This month" />}
                                            <ChevronDown
                                                size={11}
                                                className="text-gray-400 dark:text-gray-500"
                                            />
                                        </span>
                                    </button>
                                    <div className="grid grid-cols-7 gap-[2px]">
                                        {WEEKDAYS.map((d, i) => (
                                            <div key={i} className="text-center text-[7px] font-bold text-gray-400 dark:text-gray-500 py-0.5">{d.charAt(0)}</div>
                                        ))}
                                        {miniCells.map((cell, i) => {
                                            if (!cell) return <div key={`pad-${i}`} className="h-6" />;
                                            const dayStart = startOfDayMs(cell.date);
                                            const isSel = dayStart === selectedDate;
                                            const isTodayCell = isToday(cell.date);
                                            const holiday = holidayOn(cell.date);
                                            const dayEvents = eventsOnDay(cell.date);
                                            return (
                                                <button
                                                    key={dayKey(cell.date)}
                                                    type="button"
                                                    onClick={() => setSelectedDate(dayStart)}
                                                    aria-label={`${cell.date.getDate()} ${MONTHS[m]}${holiday ? `, ${holiday}` : ''}${dayEvents.length ? `, ${dayEvents.length} event(s)` : ''}`}
                                                    className={`h-6 rounded-[3px] flex flex-col items-center justify-center transition-colors ${isSel
                                                        ? 'bg-gold-500/15 ring-1 ring-gold-500/70'
                                                        : isTodayCell
                                                            ? 'neu-inset'
                                                            : 'neu-hoverable'
                                                        }`}
                                                >
                                                    <span className={`text-[9px] leading-none font-medium ${holiday ? 'text-red-600 dark:text-red-400' : isTodayCell ? 'text-brand-900 dark:text-gold-400 font-bold' : 'text-gray-800 dark:text-gray-200'}`}>
                                                        {cell.date.getDate()}
                                                    </span>
                                                    {dayEvents.length > 0 ? (
                                                        <span className="flex items-center gap-[1px] mt-[1px]">
                                                            {dayEvents.slice(0, 3).map(ev => (
                                                                <span key={ev.id} className="w-[3px] h-[3px] rounded-full" style={{ backgroundColor: eventColor(ev) }} />
                                                            ))}
                                                        </span>
                                                    ) : holiday ? (
                                                        <span className="w-[3px] h-[3px] rounded-full bg-red-500 mt-[1px]" />
                                                    ) : null}
                                                </button>
                                            );
                                        })}
                                    </div>
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
                    <div className="flex items-center gap-2 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-900/40 rounded-lg px-3 py-2 mb-2 animate-fade-in">
                        <CalendarDays size={14} className="text-red-600 dark:text-red-400 shrink-0" />
                        <p className="text-xs font-medium text-red-600 dark:text-red-400 truncate">
                            Public Holiday — {selectedHoliday}
                        </p>
                    </div>
                )}

                {selectedEvents.map(ev => {
                    const todos = ev.todos || [];
                    const doneCount = todos.filter(t => t.done).length;
                    const isRange = !!ev.endDate && dayKey(new Date(ev.endDate)) !== dayKey(new Date(ev.date));
                    return (
                        <div
                            key={ev.id}
                            className="neu-raised rounded-2xl p-3 mb-2 animate-fade-in-up"
                        >
                            <div className="flex items-center gap-3">
                                <div className="w-1 self-stretch rounded-full shrink-0" style={{ backgroundColor: eventColor(ev) }}></div>
                                <div className="flex-1 min-w-0">
                                    <h3 className="font-serif text-gray-900 dark:text-gray-100 text-sm line-clamp-1">{ev.title}</h3>
                                    <p className="text-[11px] text-gray-700 dark:text-gray-300 uppercase tracking-wider mt-0.5">
                                        {isRange
                                            ? fmtRange(selectedDate, ev)
                                            : (new Date(ev.date).getHours() === 0 && new Date(ev.date).getMinutes() === 0
                                                ? 'All day'
                                                : new Date(ev.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}
                                        {ev.createdByName ? ` • by ${ev.createdByName}` : ''}
                                    </p>
                                </div>
                                {todos.length > 0 && (
                                    <span className="text-[10px] font-bold text-gold-700 dark:text-gold-300 uppercase tracking-wider shrink-0">
                                        {doneCount}/{todos.length} tasks
                                    </span>
                                )}
                            </div>
                            {ev.notes && <p className="text-[11px] text-gray-600 dark:text-gray-300 font-light line-clamp-1 mt-1 pl-[10px]">{ev.notes}</p>}
                        </div>
                    );
                })}
                {selectedEvents.length === 0 && !selectedHoliday && (
                    <div className="text-center py-10 text-gray-600 dark:text-gray-300 text-xs font-light">
                        Nothing scheduled for this day.
                    </div>
                )}
            </div>
            </div>

            {/* Floating month calendar (desktop year view) — zooms in big and
                smooth; Esc, backdrop click or ✕ zoom it back out. Day clicks
                select the date (the right-hand day panel updates behind it). */}
            {openMonth !== null && (
                <div
                    className={`fixed inset-0 z-[70] flex items-center justify-center p-4 lg:p-8 ${floatClosing ? 'cal-scrim-out' : 'cal-scrim-in'}`}
                    style={{ backgroundColor: 'rgba(15, 17, 22, 0.45)', backdropFilter: 'blur(5px)', WebkitBackdropFilter: 'blur(5px)' }}
                    onClick={closeFloat}
                    role="dialog"
                    aria-modal="true"
                    aria-label={`${MONTHS[openMonth]} ${viewYear}`}
                >
                    <div
                        onClick={(e) => e.stopPropagation()}
                        className={`neu-raised rounded-3xl w-[min(92vw,700px)] max-h-[86dvh] overflow-y-auto no-scrollbar p-5 ${floatClosing ? 'cal-float-out' : 'cal-float-in'}`}
                    >
                        <div className="flex items-center justify-between mb-3 px-1">
                            <p className="gold-text text-sm font-bold uppercase tracking-widest">
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
                            {WEEKDAYS.map((d, i) => (
                                <div key={i} className="text-center text-[10px] font-bold text-gray-400 dark:text-gray-500 py-1">{d}</div>
                            ))}
                            {buildMonthGrid(viewYear, openMonth).map((cell, i) => {
                                if (!cell) return <div key={`pad-${i}`} className="aspect-square" />;
                                const dayStart = startOfDayMs(cell.date);
                                const isSel = dayStart === selectedDate;
                                const isTodayCell = isToday(cell.date);
                                const holiday = holidayOn(cell.date);
                                const dayEvents = eventsOnDay(cell.date);
                                return (
                                    <button
                                        key={dayKey(cell.date)}
                                        type="button"
                                        onClick={() => setSelectedDate(dayStart)}
                                        aria-label={`${cell.date.getDate()} ${MONTHS[openMonth]}${holiday ? `, ${holiday}` : ''}${dayEvents.length ? `, ${dayEvents.length} event(s)` : ''}`}
                                        className={`aspect-square w-full flex flex-col items-center justify-start pt-1.5 rounded-xl transition-colors ${isSel
                                            ? 'bg-gold-500/15 ring-1 ring-gold-500/70'
                                            : isTodayCell
                                                ? 'neu-inset ring-1 ring-gray-300/70 dark:ring-gray-600/70'
                                                : 'neu-hoverable'
                                            }`}
                                    >
                                        <span className={`text-sm leading-none font-medium ${holiday ? 'text-red-600 dark:text-red-400' : isTodayCell ? 'text-brand-900 dark:text-gold-400 font-bold' : 'text-gray-900 dark:text-gray-100'}`}>
                                            {cell.date.getDate()}
                                        </span>
                                        {holiday && (
                                            <span className="text-[7px] leading-[1.2] text-red-500 truncate w-full px-1 mt-0.5">
                                                {holiday}
                                            </span>
                                        )}
                                        {dayEvents.length > 0 && (
                                            <span className="mt-auto mb-1.5 flex items-center gap-1">
                                                {dayEvents.slice(0, 3).map(ev => (
                                                    <span
                                                        key={ev.id}
                                                        className="w-1.5 h-1.5 rounded-full shrink-0"
                                                        style={{ backgroundColor: eventColor(ev) }}
                                                    />
                                                ))}
                                                {dayEvents.length > 3 && (
                                                    <span className="text-[8px] font-bold text-gray-700 dark:text-gray-300">
                                                        +{dayEvents.length - 3}
                                                    </span>
                                                )}
                                            </span>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </div>
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