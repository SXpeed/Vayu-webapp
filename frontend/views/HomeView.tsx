import React, { useMemo, useState } from 'react';
import { Artwork, CalendarEvent, ViewState, UserProfile } from '../types';
import { eventColor, eventTimeLabel } from '../services/eventService';
import { Clock, Receipt, HandCoins, Eye, EyeOff, ChevronLeft, Palette, IndianRupee, CalendarDays, Users, Check, ChevronDown, ChevronRight, ShieldCheck, User, CalendarClock, UserRound, Megaphone, Mic, Sparkles, MapPin, Settings2, Plus } from 'lucide-react';
import { PageRoot, PageHeader, PageBody, GhostIconButton } from '../components/ui';
import { BellButton } from '../components/NotificationBell';
import { useAppChrome } from '../components/Layout';
import { useBranding } from '../useBranding';
import type { AccessLevel, SectionId } from '../permissions';
import { HIDDEN_AMOUNT, currentMonth, itemsText, rupees, useMonthSales, type MonthSales } from '../components/SalesSummary';
import { shiftMonth } from '../salesRules';
import { TaskBoard } from './tasks/TaskList';
import { CountUp } from '../components/CountUp';

/** One dashboard metric — raised tile, gold glyph, serif figure. */
const StatTile: React.FC<{ icon: React.ReactNode; label: string; children?: React.ReactNode }> = ({ icon, label, children }) => (
    <div className="neu-card p-3 lg:p-4">
        <div className="flex items-center gap-2 mb-1.5">
            {icon}
            <span className="text-[11px] font-medium uppercase tracking-widest text-gray-700 dark:text-gray-300 truncate">{label}</span>
        </div>
        <p className="text-xl lg:text-2xl font-serif text-gray-900 dark:text-white">{children}</p>
    </div>
);

/**
 * Sales for one month from the sales ledger, with the month switcher. The
 * amount stays hidden each time Home opens until the eye is tapped. A tap
 * anywhere else on the tile opens the Sales page.
 */
const SalesTile: React.FC<{
    month: string; onMonth: (month: string) => void; sales: MonthSales; hidden: boolean; onToggleHidden: () => void; onOpen: () => void;
}> = ({ month, onMonth, sales, hidden, onToggleHidden, onOpen }) => {
    const atCurrent = month >= currentMonth();
    const summary = sales.data?.summary;
    let figure: React.ReactNode = <span className="text-gray-500 dark:text-gray-400">…</span>;
    if (sales.failed && !summary) figure = <span className="text-sm font-sans text-gray-500 dark:text-gray-400">Couldn’t load</span>;
    else if (summary && hidden) figure = <span className="tracking-wider" aria-label="Amount hidden">{HIDDEN_AMOUNT}</span>;
    else if (summary) figure = <span title={itemsText(summary.count)}><CountUp value={summary.totalAmount} format={rupees} /></span>;
    // The tile's own controls sit above the tap target that opens Sales.
    const arrow = 'relative z-[2] w-6 h-6 shrink-0 rounded-full flex items-center justify-center text-gold-700 dark:text-gold-300 hover:neu-raised-sm active-scale disabled:opacity-30 disabled:pointer-events-none';

    return (
        <div className="neu-card relative p-3 lg:p-4 flex flex-col">
            <button type="button" onClick={onOpen} aria-label="Open Sales" className="absolute inset-0 z-[1] w-full h-full rounded-[inherit] cursor-pointer active-scale" />
            <div className="flex items-center gap-2 mb-1.5">
                <HandCoins size={14} className="text-gold-500" />
                <span className="text-[11px] font-medium uppercase tracking-widest text-gray-700 dark:text-gray-300 truncate">Sales</span>
                <button type="button" onClick={onToggleHidden} aria-pressed={!hidden}
                    aria-label={hidden ? 'Show sales amounts' : 'Hide sales amounts'} title={hidden ? 'Show amounts' : 'Hide amounts'}
                    className="relative z-[2] ml-auto -my-1 -mr-1 w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-gray-600 dark:text-gray-300 hover:text-gold-700 dark:hover:text-gold-300 active-scale">
                    {hidden ? <Eye size={15} /> : <EyeOff size={15} />}
                </button>
            </div>
            <p className="text-xl lg:text-2xl font-serif tabular-nums text-gray-900 dark:text-white truncate">{figure}</p>
            <div className="mt-auto pt-1.5 flex items-center gap-1 -ml-1">
                <button type="button" onClick={() => onMonth(shiftMonth(month, -1))} aria-label="Previous month" className={arrow}>
                    <ChevronLeft size={14} />
                </button>
                <span className="min-w-0 flex-1 text-center text-[11px] text-gray-600 dark:text-gray-400 truncate" aria-live="polite">
                    {new Date(`${month}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' })}
                </span>
                <button type="button" onClick={() => onMonth(shiftMonth(month, 1))} disabled={atCurrent} aria-label="Next month" className={arrow}>
                    <ChevronRight size={14} />
                </button>
            </div>
        </div>
    );
};

interface HomeViewProps {
    artworks: Artwork[];
    events: CalendarEvent[];
    teamMembers: UserProfile[];
    userProfile: UserProfile;
    onNavigate: (view: ViewState) => void;
    onUpdateEvent: (event: CalendarEvent) => Promise<void>;
}

/** No section: open to everyone (My Space is the person's own). */
const QUICK_ACTIONS: { section?: SectionId; level?: AccessLevel; view: ViewState; label: string; Icon: React.ElementType }[] = [
    { section: 'payments', view: 'payments', label: 'Payments', Icon: IndianRupee },
    { section: 'contacts', view: 'contacts', label: 'Contacts', Icon: Users },
    { section: 'invoices', view: 'invoice', label: 'Billing', Icon: Receipt },
    { section: 'attendance', view: 'attendance', label: 'Attendance', Icon: Clock },
    { section: 'calendar', view: 'calendar', label: 'Calendar', Icon: CalendarDays },
    { section: 'schedule', view: 'schedule', label: 'Staff roster', Icon: CalendarClock },
    { view: 'myspace', label: 'My Space', Icon: UserRound },
    { section: 'social', view: 'social', label: 'Social', Icon: Megaphone },
    { section: 'meetings', view: 'meetings', label: 'Meetings', Icon: Mic },
    { section: 'meetings', view: 'assistant', label: 'Ask AI', Icon: Sparkles },
];

const MONTHS_SHORT = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const sameCalendarDay = (a: number, b: number): boolean => {
    const d1 = new Date(a), d2 = new Date(b);
    return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
};

const fmtShortDate = (d: number): string => new Date(d).toLocaleDateString([], { day: 'numeric', month: 'short' });
const fmtFull = (d: number): string => new Date(d).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/** " · First venue +2" for the row's second line; empty without locations. */
const placeLine = (locations: string[] = []): string => {
    if (locations.length === 0) return '';
    const more = locations.length > 1 ? ` +${locations.length - 1}` : '';
    return ` · ${locations[0]}${more}`;
};

/** Everything about one event, shown when its row on Home is opened. */
const EventDetails: React.FC<{ ev: CalendarEvent }> = ({ ev }) => {
    const todos = ev.todos || [];
    const head = 'text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--neu-text-dim)] mb-1';
    return (
        <div id={`event-${ev.id}`} className="pl-[4.25rem] pr-3 pb-3 space-y-3 text-[12.5px] text-[var(--neu-text)] animate-fade-in">
            <div>
                <p className={head}>When</p>
                <p>{fmtFull(ev.date)}{ev.endDate ? <> – {fmtFull(ev.endDate)}</> : null}</p>
            </div>
            {!!ev.locations?.length && (
                <div>
                    <p className={head}>{ev.locations.length > 1 ? 'Locations' : 'Location'}</p>
                    <ul className="space-y-1">
                        {ev.locations.map(loc => (
                            <li key={loc}>
                                <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(loc)}`} target="_blank" rel="noopener noreferrer"
                                    className="inline-flex items-start gap-1.5 hover:text-gold-700 dark:hover:text-gold-300 underline-offset-2 hover:underline">
                                    <MapPin size={13} className="mt-0.5 shrink-0 text-gold-600 dark:text-gold-400" aria-hidden /> {loc}
                                </a>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            {ev.notes && (
                <div>
                    <p className={head}>Notes</p>
                    <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{ev.notes}</p>
                </div>
            )}
            {todos.length > 0 && (
                <div>
                    <p className={head}>Tasks · {todos.filter(t => t.done).length}/{todos.length} done</p>
                    <ul className="space-y-1">
                        {todos.map(t => (
                            <li key={t.id} className="flex items-center gap-2">
                                <span role="img" aria-label={t.done ? 'Done' : 'Not done'} className={`w-[14px] h-[14px] rounded-[3px] flex items-center justify-center shrink-0 ${t.done ? 'neu-check-on' : 'neu-check'}`}>
                                    {t.done && <Check size={9} strokeWidth={3} />}
                                </span>
                                <span className={`flex-1 min-w-0 ${t.done ? 'line-through text-[var(--neu-text-dim)]' : ''}`}>{t.text}</span>
                                {t.assigneeName && <span className="text-[10px] font-bold text-gold-700 dark:text-gold-300 uppercase tracking-wider shrink-0">{t.assigneeName}</span>}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            {ev.createdByName && <p className="text-[11px] text-[var(--neu-text-dim)]">Added by {ev.createdByName}</p>}
        </div>
    );
};

export const HomeView: React.FC<HomeViewProps> = ({ artworks, events, teamMembers, userProfile, onNavigate, onUpdateEvent }) => {
    // Admin entry + role come from the shell; on desktop the sidebar shows them
    // instead, so the header only renders these buttons on phones.
    const { isAdmin, openAdmin, can } = useAppChrome();
    const branding = useBranding();
    // Everything on Home follows the person's role: tiles, shortcuts and sections
    // for sections they can't see are left out, and editing needs edit access.
    const canEditEvents = can('calendar', 'edit');
    const availableArtworks = useMemo(() => artworks.filter(a => a.status === 'Available').length, [artworks]);

    // Sales from the ledger, one month at a time. Amounts start hidden every
    // time Home opens; the tile's eye shows them.
    const [salesMonth, setSalesMonth] = useState(currentMonth);
    const [amountsHidden, setAmountsHidden] = useState(true);
    const monthSales = useMonthSales(salesMonth);

    // ── Upcoming events (calendar) ────────────────────────────────────────
    const startOfToday = useMemo(() => {
        const t = new Date();
        t.setHours(0, 0, 0, 0);
        return t.getTime();
    }, []);
    const allUpcomingEvents = useMemo(
        () => events
            .filter(e => (e.endDate ?? e.date) >= startOfToday)
            .sort((a, b) => a.date - b.date),
        [events, startOfToday]
    );
    const [showAllEvents, setShowAllEvents] = useState(false);
    const upcomingEvents = showAllEvents ? allUpcomingEvents : allUpcomingEvents.slice(0, 5);
    const [openEventId, setOpenEventId] = useState<string | null>(null);


    return (
        <PageRoot width="wide">
            {/* The sidebar carries the brand on desktop, so the admin and profile
                buttons here are phone-only — on lg+ they'd repeat the rail. */}
            <PageHeader
                title={branding.appName}
                actions={
                    <div className="flex items-center gap-2 lg:hidden">
                        <BellButton />
                        {(isAdmin || can('schedule', 'edit') || canEditEvents) && (
                            <GhostIconButton
                                onClick={() => openAdmin()}
                                label="Admin"
                                icon={<ShieldCheck size={16} className="text-brand-900 dark:text-gold-400" />}
                            />
                        )}
                        <GhostIconButton
                            onClick={() => onNavigate('profile')}
                            label="Profile"
                            icon={<User size={17} className="text-brand-900 dark:text-gold-400" />}
                        />
                    </div>
                }
            />

            <PageBody space="none">
                {/* Top Stats */}
                <div className="grid grid-cols-2 gap-3 lg:gap-5 animate-fade-in-up">
                    {can('sales') && (
                        <SalesTile month={salesMonth} onMonth={setSalesMonth} sales={monthSales}
                            hidden={amountsHidden} onToggleHidden={() => setAmountsHidden(h => !h)} onOpen={() => onNavigate('sales')} />
                    )}
                    {can('inventory') && (
                        <StatTile icon={<Palette size={14} className="text-gold-500" />} label="Available">
                            <CountUp value={availableArtworks} /> <span className="text-xs font-sans text-gray-500 dark:text-gray-400">/ {artworks.length}</span>
                        </StatTile>
                    )}
                </div>

            <div className="mt-6 lg:mt-8 space-y-8 w-full lg:grid lg:grid-cols-2 2xl:grid-cols-3 lg:gap-x-6 lg:gap-y-8 lg:space-y-0 lg:items-start">
                {/* Quick Actions */}
                <section className="animate-fade-in-up space-y-3" style={{ animationDelay: '150ms' }}>
                    <h2 className="text-xs font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest px-3">Quick Actions</h2>
                    {/* Compact tiles, icon over the label: three a row (an even 3×3 for
                        nine; more wouldn't fit their labels on phones), all nine across when there is room. */}
                    <div className="@container">
                    <div className="grid grid-cols-3 @[56rem]:grid-cols-9 gap-2.5">
                        {QUICK_ACTIONS.filter(a => !a.section || can(a.section, a.level)).map(({ view, label, Icon }) => (
                        <button
                            key={view}
                            onClick={() => onNavigate(view)}
                            className="neu-card min-w-0 px-1 py-2.5 flex flex-col items-center justify-center gap-1.5 hover:border-gold-500 dark:hover:border-gold-500 transition-colors active-scale"
                        >
                            <div className="shrink-0 text-brand-900 dark:text-gold-400">
                                <Icon size={18} strokeWidth={1.5} />
                            </div>
                            <span className="min-w-0 max-w-full text-[10px] @[40rem]:text-[11px] font-medium text-gray-600 dark:text-gray-300 uppercase tracking-normal @[40rem]:tracking-wider text-center leading-tight [overflow-wrap:anywhere]">{label}</span>
                        </button>
                        ))}
                    </div>
                    </div>
                </section>

                {/* Upcoming Events (calendar) — read here; added and edited in Admin → Events */}
                {can('calendar') && (
                <section className="animate-fade-in-up" style={{ animationDelay: '250ms' }}>
                    <div className="flex justify-between items-end mb-3 px-3">
                        <h2 className="text-xs font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest">Events</h2>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => onNavigate('calendar')}
                                aria-label="Open full calendar"
                                title="Open full calendar"
                                className="p-1 text-gray-700 dark:text-gray-300 hover:text-gold-600 dark:hover:text-gold-400 transition-colors active-scale"
                            >
                                <CalendarDays size={14} />
                            </button>
                            {canEditEvents && (
                                <button onClick={() => openAdmin('events')} className="text-[11px] font-medium text-gold-700 dark:text-gold-300 uppercase tracking-wider flex items-center gap-1 active-scale">
                                    <Settings2 size={11} /> Manage
                                </button>
                            )}
                        </div>
                    </div>
                    {/* One surface, hairlines between events: easier to scan
                        than a card each. Tap an event to open its details. */}
                    {upcomingEvents.length > 0 ? (
                        <ul className="neu-card px-2 py-1">
                            {upcomingEvents.map(ev => {
                                const isRange = !!ev.endDate && !sameCalendarDay(ev.date, ev.endDate);
                                const todos = ev.todos || [];
                                const doneCount = todos.filter(t => t.done).length;
                                const start = new Date(ev.date);
                                const open = openEventId === ev.id;
                                return (
                                    <li key={ev.id} className="task-row">
                                        <button type="button" onClick={() => setOpenEventId(open ? null : ev.id)} aria-expanded={open} aria-controls={`event-${ev.id}`}
                                            className="w-full flex items-center gap-3 px-2 py-2.5 text-left rounded-xl active-scale">
                                            <span className="w-11 shrink-0 text-center">
                                                <span className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--neu-text-dim)] leading-none">
                                                    {MONTHS_SHORT[start.getMonth()]}
                                                </span>
                                                <span className="block font-serif text-[22px] leading-tight text-[var(--neu-text)] tabular-nums">{start.getDate()}</span>
                                            </span>
                                            <span className="w-[3px] self-stretch rounded-full shrink-0 my-1" style={{ backgroundColor: eventColor(ev) }} aria-hidden />
                                            <span className="flex-1 min-w-0">
                                                <span className={`block font-serif text-[15.5px] leading-snug text-[var(--neu-text)] ${open ? '' : 'truncate'}`}>{ev.title}</span>
                                                <span className="block mt-0.5 text-[11.5px] text-[var(--neu-text-dim)] truncate">
                                                    {isRange ? `${fmtShortDate(ev.date)} – ${fmtShortDate(ev.endDate!)}` : eventTimeLabel(ev.date)}
                                                    {placeLine(ev.locations)}
                                                    {todos.length > 0 ? ` · ${doneCount}/${todos.length} tasks` : ''}
                                                </span>
                                            </span>
                                            <ChevronDown size={16} className={`shrink-0 text-[var(--neu-text-dim)] transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
                                        </button>
                                        {open && <EventDetails ev={ev} />}
                                    </li>
                                );
                            })}
                            {allUpcomingEvents.length > 5 && (
                                <li className="task-row">
                                    <button type="button" onClick={() => setShowAllEvents(v => !v)}
                                        className="w-full px-2 py-2.5 text-center text-[12px] font-medium text-gold-700 dark:text-gold-300 active-scale">
                                        {showAllEvents ? 'Show fewer' : `Show ${allUpcomingEvents.length - 5} more`}
                                    </button>
                                </li>
                            )}
                        </ul>
                    ) : (
                        <div className="neu-card px-5 py-6 text-center">
                            <p className="text-[13px] text-[var(--neu-text)]">No upcoming events</p>
                            <p className="mt-1 text-[12px] text-[var(--neu-text-dim)]">An exhibition, a client visit, a delivery — add it in Admin → Events to plan its tasks.</p>
                            {canEditEvents && (
                                <button type="button" onClick={() => openAdmin('events')} className="quiet-btn mt-2 !text-[var(--neu-text)] font-medium"><Plus size={14} /> Add event</button>
                            )}
                        </div>
                    )}
                </section>
                )}

                {/* Tasks: across every event, by when they are due */}
                {can('calendar') && (
                <section className="animate-fade-in-up lg:col-span-1" style={{ animationDelay: '280ms' }} aria-labelledby="home-tasks">
                    <h2 id="home-tasks" className="text-xs font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest mb-3 px-3">Tasks</h2>
                    <TaskBoard
                        events={events}
                        teamMembers={teamMembers}
                        currentUserId={userProfile.id}
                        canEdit={canEditEvents}
                        onUpdateEvent={onUpdateEvent}
                    />
                </section>
                )}
            </div>
            </PageBody>

        </PageRoot>
    );
};
