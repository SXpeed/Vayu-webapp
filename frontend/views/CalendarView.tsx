import React, { useEffect, useMemo, useState } from 'react';
import { CalendarEvent } from '../types';
import { apiCall } from '../services/apiClient';
import { eventColor } from '../services/eventService';
import { ArrowLeft, ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react';

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
        <div className="h-full flex flex-col bg-[#faf9f6] dark:bg-[#121212] transition-colors duration-500 animate-fade-in">
            {/* Header */}
            <div className="bg-white dark:bg-[#1a1a1a] px-[6px] pt-[calc(1.75rem+env(safe-area-inset-top,0px))] pb-[6px] shadow-sm z-10 border-b border-gray-100 dark:border-gray-800">
                <div className="flex items-center gap-[6px]">
                    <button
                        onClick={onBack}
                        className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale"
                        aria-label="Back to home"
                    >
                        <ArrowLeft size={20} />
                    </button>
                    <h1 className="flex-1 text-xl font-serif text-gray-900 dark:text-white truncate">
                        {MONTHS[viewMonth]} <span className="text-gray-400 dark:text-gray-500">{viewYear}</span>
                    </h1>
                    <button
                        onClick={goToday}
                        className="px-3 py-1.5 rounded-full text-[9px] font-bold uppercase tracking-widest bg-gray-100 dark:bg-[#2a2a2a] text-gray-600 dark:text-gray-300 transition-colors active-scale"
                    >
                        Today
                    </button>
                </div>
            </div>

            {/* Month navigation */}
            <div className="flex items-center justify-between px-[6px] py-2">
                <button
                    onClick={goPrevMonth}
                    aria-label="Previous month"
                    className="p-1.5 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale"
                >
                    <ChevronLeft size={18} />
                </button>
                <span className="text-[11px] font-medium text-gray-600 dark:text-gray-300 uppercase tracking-widest">
                    {MONTHS[viewMonth]} {viewYear}
                </span>
                <button
                    onClick={goNextMonth}
                    aria-label="Next month"
                    className="p-1.5 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale"
                >
                    <ChevronRight size={18} />
                </button>
            </div>

            {/* Legend — events use their own colour; holidays/festivals are always red */}
            <div className="flex items-center gap-3 px-[10px] pb-1.5 text-[8px] text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                <span className="flex items-center gap-1">
                    <span className="w-[6px] h-[6px] rounded-full bg-brand-900 dark:bg-gold-400 inline-block" />
                    Event (own colour)
                </span>
                <span className="flex items-center gap-1">
                    <span className="w-[6px] h-[6px] rounded-full bg-red-500 inline-block" />
                    Holiday / Festival
                </span>
            </div>

            {/* Weekday header */}
            <div className="grid grid-cols-7 gap-[2px] px-[6px] pb-1">
                {WEEKDAYS.map(day => (
                    <div key={day} className="text-center text-[8px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest py-1">
                        {day}
                    </div>
                ))}
            </div>

            {/* Month grid */}
            <div className="grid grid-cols-7 gap-[2px] px-[6px]">
                {gridCells.map((cell, i) => {
                    if (!cell) return <div key={`pad-${i}`} className="aspect-square" />;
                    const dayStart = startOfDayMs(cell.date);
                    const isSelected = dayStart === selectedDate;
                    const isTodayCell = isToday(cell.date);
                    const holiday = holidayOn(cell.date);
                    const dayEvents = eventsOnDay(cell.date);
                    const selectedCls = isSelected
                        ? 'bg-gold-500/20 border border-gold-500'
                        : isTodayCell
                            ? 'bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600'
                            : 'hover:bg-gray-100 dark:hover:bg-gray-800 border border-transparent';
                    return (
                        <button
                            key={dayKey(cell.date)}
                            type="button"
                            onClick={() => setSelectedDate(dayStart)}
                            aria-label={`${cell.date.getDate()} ${MONTHS[viewMonth]}${holiday ? `, ${holiday}` : ''}${dayEvents.length ? `, ${dayEvents.length} event(s)` : ''}`}
                            className={`aspect-square w-full flex flex-col items-center justify-start pt-[3px] rounded-[4px] transition-colors ${selectedCls}`}
                        >
                            <span className={`text-[10px] leading-none font-medium ${holiday ? 'text-red-600 dark:text-red-400' : isTodayCell ? 'text-brand-900 dark:text-gold-400 font-bold' : 'text-gray-900 dark:text-gray-100'}`}>
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
                                        <span className="text-[6px] font-bold leading-none text-gray-500 dark:text-gray-400">
                                            +{dayEvents.length - 3}
                                        </span>
                                    )}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>

            {/* Selected day panel */}
            <div className="flex-1 overflow-y-auto p-[6px] pt-3 no-scrollbar">
                <div className="flex items-center justify-between mb-2 px-1">
                    <h2 className="text-xs font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest">
                        {selectedDay.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}
                    </h2>
                    <span className="text-[9px] text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                        {selectedDay.toLocaleDateString([], { year: 'numeric' })}
                    </span>
                </div>

                {selectedHoliday && (
                    <div className="flex items-center gap-2 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-900/40 rounded-[6px] px-[6px] py-2 mb-2 animate-fade-in">
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
                            className="bg-white dark:bg-[#1e1e1e] rounded-[6px] shadow-sm border border-gray-100 dark:border-gray-800 p-[6px] mb-2 animate-fade-in-up"
                        >
                            <div className="flex items-center gap-[6px]">
                                <div className="w-1 self-stretch rounded-full shrink-0" style={{ backgroundColor: eventColor(ev) }}></div>
                                <div className="flex-1 min-w-0">
                                    <h3 className="font-serif text-gray-900 dark:text-gray-100 text-sm line-clamp-1">{ev.title}</h3>
                                    <p className="text-[9px] text-gray-500 dark:text-gray-400 uppercase tracking-wider mt-0.5">
                                        {isRange
                                            ? fmtRange(selectedDate, ev)
                                            : (new Date(ev.date).getHours() === 0 && new Date(ev.date).getMinutes() === 0
                                                ? 'All day'
                                                : new Date(ev.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}
                                        {ev.createdByName ? ` • by ${ev.createdByName}` : ''}
                                    </p>
                                </div>
                                {todos.length > 0 && (
                                    <span className="text-[8px] font-bold text-gold-600 dark:text-gold-400 uppercase tracking-wider shrink-0">
                                        {doneCount}/{todos.length} tasks
                                    </span>
                                )}
                            </div>
                            {ev.notes && <p className="text-[10px] text-gray-400 dark:text-gray-500 font-light line-clamp-1 mt-1 pl-[10px]">{ev.notes}</p>}
                        </div>
                    );
                })}
                {selectedEvents.length === 0 && !selectedHoliday && (
                    <div className="text-center py-10 text-gray-400 dark:text-gray-500 text-xs font-light">
                        Nothing scheduled for this day.
                    </div>
                )}
            </div>
        </div>
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