import React, { useMemo, useState } from 'react';
import { Artwork, CalendarEvent, Catalog, EventTodo, ViewState, UserProfile } from '../types';
import { FullScreenPortal } from '../components/FullScreenPortal';
import { TypeDeleteDialog } from '../components/TypeDeleteDialog';
import { EVENT_COLORS, eventColor, eventTimeLabel } from '../services/eventService';
import { Clock, Receipt, HandCoins, Eye, EyeOff, ChevronLeft, Palette, IndianRupee, CalendarDays, Plus, Trash2, X, Loader2, Users, Check, ChevronRight, BookOpen, ShieldCheck, User, CalendarClock } from 'lucide-react';
import { PageRoot, PageHeader, PageBody, GhostIconButton } from '../components/ui';
import { BellButton } from '../components/NotificationBell';
import { useAppChrome } from '../components/Layout';
import { useBranding } from '../useBranding';
import type { SectionId } from '../permissions';
import { HIDDEN_AMOUNT, currentMonth, itemsText, rupees, useMonthSales, type MonthSales } from '../components/SalesSummary';
import { shiftMonth } from '../salesRules';
import { TaskBoard } from './tasks/TaskList';

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
    else if (summary) figure = <span title={itemsText(summary.count)}>{rupees(summary.totalAmount)}</span>;
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
    catalogs: Catalog[];
    events: CalendarEvent[];
    teamMembers: UserProfile[];
    userProfile: UserProfile;
    onNavigate: (view: ViewState) => void;
    onAddEvent: (event: Omit<CalendarEvent, 'id' | 'createdAt' | 'createdBy' | 'createdByName'>) => Promise<void>;
    onUpdateEvent: (event: CalendarEvent) => Promise<void>;
    onDeleteEvent: (id: string) => void;
}

const QUICK_ACTIONS: { section: SectionId; view: ViewState; label: string; Icon: React.ElementType }[] = [
    { section: 'payments', view: 'payments', label: 'Payments', Icon: IndianRupee },
    { section: 'contacts', view: 'contacts', label: 'Contacts', Icon: Users },
    { section: 'invoices', view: 'invoice', label: 'Proforma Invoice', Icon: Receipt },
    { section: 'attendance', view: 'attendance', label: 'Attendance', Icon: Clock },
];

const MONTHS_SHORT = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const sameCalendarDay = (a: number, b: number): boolean => {
    const d1 = new Date(a), d2 = new Date(b);
    return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
};

const fmtShortDate = (d: number): string => new Date(d).toLocaleDateString([], { day: 'numeric', month: 'short' });

/** Epoch ms -> 'YYYY-MM-DDTHH:mm' in local time, for datetime-local inputs. */
const toInputValue = (ms?: number): string => {
    if (!ms) return '';
    const d = new Date(ms);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const EMPTY_EVENT_FORM = { title: '', dateTime: '', endDateTime: '', notes: '', color: '', todos: [] as EventTodo[] };

export const HomeView: React.FC<HomeViewProps> = ({ artworks, catalogs, events, teamMembers, userProfile, onNavigate, onAddEvent, onUpdateEvent, onDeleteEvent }) => {
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
    const [showEventModal, setShowEventModal] = useState(false);
    const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
    const [eventForm, setEventForm] = useState({ ...EMPTY_EVENT_FORM });
    const [isSavingEvent, setIsSavingEvent] = useState(false);
    const [confirmDeleteEvent, setConfirmDeleteEvent] = useState(false);
    const [todoDraft, setTodoDraft] = useState('');
    const [todoAssignee, setTodoAssignee] = useState('');

    const startOfToday = useMemo(() => {
        const t = new Date();
        t.setHours(0, 0, 0, 0);
        return t.getTime();
    }, []);
    const upcomingEvents = useMemo(
        () => events
            .filter(e => (e.endDate ?? e.date) >= startOfToday)
            .sort((a, b) => a.date - b.date)
            .slice(0, 5),
        [events, startOfToday]
    );

    const isEndAfterStart = !eventForm.endDateTime
        || new Date(eventForm.endDateTime).getTime() >= new Date(eventForm.dateTime).getTime();
    const canSaveEvent = eventForm.title.trim().length > 0
        && eventForm.dateTime.length > 0
        && isEndAfterStart;

    const handleSaveEvent = async () => {
        if (!canSaveEvent || isSavingEvent) return;
        setIsSavingEvent(true);
        try {
            const fields = {
                title: eventForm.title.trim(),
                date: new Date(eventForm.dateTime).getTime(),
                endDate: eventForm.endDateTime ? new Date(eventForm.endDateTime).getTime() : undefined,
                notes: eventForm.notes.trim() || undefined,
                color: eventForm.color || undefined,
                todos: eventForm.todos,
            };
            if (editingEvent) {
                await onUpdateEvent({ ...editingEvent, ...fields });
            } else {
                await onAddEvent({ ...fields });
            }
            setEventForm({ ...EMPTY_EVENT_FORM });
            setEditingEvent(null);
            setShowEventModal(false);
        } finally {
            setIsSavingEvent(false);
        }
    };

    const openAddEvent = () => {
        setEditingEvent(null);
        // Rotate through the palette so consecutive events get distinct colors.
        setEventForm({ ...EMPTY_EVENT_FORM, color: EVENT_COLORS[events.length % EVENT_COLORS.length] });
        setShowEventModal(true);
    };

    const openEditEvent = (ev: CalendarEvent) => {
        setEditingEvent(ev);
        setEventForm({
            title: ev.title,
            dateTime: toInputValue(ev.date),
            endDateTime: toInputValue(ev.endDate),
            notes: ev.notes || '',
            color: ev.color || EVENT_COLORS[0],
            todos: [...(ev.todos || [])],
        });
        setShowEventModal(true);
    };

    const handleDeleteEventFromModal = () => {
        if (!editingEvent) return;
        onDeleteEvent(editingEvent.id);
        setConfirmDeleteEvent(false);
        setEditingEvent(null);
        setEventForm({ ...EMPTY_EVENT_FORM });
        setShowEventModal(false);
    };

    const toggleFormTodo = (todoId: string) => {
        setEventForm(prev => ({ ...prev, todos: prev.todos.map(t => (t.id === todoId ? { ...t, done: !t.done } : t)) }));
    };

    const removeFormTodo = (todoId: string) => {
        setEventForm(prev => ({ ...prev, todos: prev.todos.filter(t => t.id !== todoId) }));
    };

    const addTodoToForm = () => {
        if (!todoDraft.trim()) return;
        const assignee = teamMembers.find(m => m.id === todoAssignee);
        const todo: EventTodo = {
            id: `todo_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
            text: todoDraft.trim(),
            assigneeId: assignee?.id,
            assigneeName: assignee?.name,
            done: false,
            createdAt: Date.now(),
        };
        setEventForm(prev => ({ ...prev, todos: [...prev.todos, todo] }));
        setTodoDraft('');
        setTodoAssignee('');
    };



    return (
        <PageRoot width="wide">
            {/* The sidebar carries the brand on desktop, so the admin and profile
                buttons here are phone-only — on lg+ they'd repeat the rail. */}
            <PageHeader
                title={branding.appName}
                actions={
                    <div className="flex items-center gap-2 lg:hidden">
                        <BellButton />
                        {isAdmin && (
                            <GhostIconButton
                                onClick={openAdmin}
                                label="Admin — deleted items, users & activity"
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
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-5 animate-fade-in-up">
                    {can('sales') && (
                        <SalesTile month={salesMonth} onMonth={setSalesMonth} sales={monthSales}
                            hidden={amountsHidden} onToggleHidden={() => setAmountsHidden(h => !h)} onOpen={() => onNavigate('sales')} />
                    )}
                    {can('inventory') && (
                        <StatTile icon={<Palette size={14} className="text-gold-500" />} label="Available">
                            {availableArtworks} <span className="text-xs font-sans text-gray-500 dark:text-gray-400">/ {artworks.length}</span>
                        </StatTile>
                    )}
                    {can('catalogs') && (
                        <StatTile icon={<BookOpen size={14} className="text-gold-500" />} label="Catalogs">
                            {catalogs.length}
                        </StatTile>
                    )}
                    {can('calendar') && (
                        <StatTile icon={<CalendarDays size={14} className="text-gold-500" />} label="Upcoming">
                            {upcomingEvents.length}
                        </StatTile>
                    )}
                </div>

            <div className="mt-6 lg:mt-8 space-y-8 w-full lg:grid lg:grid-cols-2 2xl:grid-cols-3 lg:gap-x-6 lg:gap-y-8 lg:space-y-0 lg:items-start">
                {/* Quick Actions */}
                {(['payments', 'contacts', 'invoices', 'attendance'] as const).some(sec => can(sec)) && (
                <section className="animate-fade-in-up" style={{ animationDelay: '150ms' }}>
                    <h2 className="text-xs font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest mb-3 px-3">Quick Actions</h2>
                    {/* Four across when there is room; two by two, icon beside
                        the label, in narrow columns so no label spills out. */}
                    <div className="@container">
                    <div className="grid grid-cols-2 @[22rem]:grid-cols-4 gap-3">
                        {QUICK_ACTIONS.filter(a => can(a.section)).map(({ section, view, label, Icon }) => (
                        <button
                            key={section}
                            onClick={() => onNavigate(view)}
                            className="neu-card min-w-0 px-2.5 py-3 @[22rem]:px-1 flex @[22rem]:flex-col items-center justify-start @[22rem]:justify-center gap-2 hover:border-gold-500 dark:hover:border-gold-500 transition-colors active-scale"
                        >
                            <div className="shrink-0 text-brand-900 dark:text-gold-400">
                                <Icon size={22} strokeWidth={1.5} />
                            </div>
                            <span className="min-w-0 max-w-full text-[11px] @[22rem]:text-[10px] @[26rem]:text-[11px] font-medium text-gray-600 dark:text-gray-300 uppercase tracking-normal @[26rem]:tracking-wider text-left @[22rem]:text-center leading-tight [overflow-wrap:anywhere]">{label}</span>
                        </button>
                        ))}
                    </div>
                    </div>
                </section>
                )}

                {/* Staff roster: this week's shifts, for everyone who can see it */}
                {can('schedule') && (
                <section className="animate-fade-in-up" style={{ animationDelay: '175ms' }}>
                    <h2 className="text-xs font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest mb-3 px-3">Team</h2>
                    <button
                        type="button"
                        onClick={() => onNavigate('schedule')}
                        className="neu-card-interactive w-full p-3 flex items-center gap-3.5 text-left active-scale"
                    >
                        <span className="neu-inset shrink-0 w-14 h-14 rounded-2xl flex items-center justify-center">
                            <CalendarClock size={24} strokeWidth={1.5} className="text-brand-900 dark:text-gold-400" />
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className="block font-serif text-[17px] leading-tight text-gray-900 dark:text-white">Staff roster</span>
                            <span className="block mt-0.5 text-[11.5px] text-gray-600 dark:text-gray-400 leading-snug">
                                {can('schedule', 'edit') ? 'Plan shifts, approve leave and publish the week' : 'Your shifts this week, and leave requests'}
                            </span>
                        </span>
                        <ChevronRight size={18} className="shrink-0 text-gold-700 dark:text-gold-300" />
                    </button>
                </section>
                )}

                {/* Upcoming Events (calendar) */}
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
                                <button onClick={openAddEvent} className="text-[11px] font-medium text-gold-700 dark:text-gold-300 uppercase tracking-wider flex items-center gap-1 active-scale">
                                    <Plus size={10} /> Add
                                </button>
                            )}
                        </div>
                    </div>
                    {/* One surface, hairlines between events: easier to scan
                        than a card each. Tap an event to edit it; its tasks
                        live in Tasks below. */}
                    {upcomingEvents.length > 0 ? (
                        <ul className="neu-card px-2 py-1">
                            {upcomingEvents.map(ev => {
                                const isRange = !!ev.endDate && !sameCalendarDay(ev.date, ev.endDate);
                                const todos = ev.todos || [];
                                const doneCount = todos.filter(t => t.done).length;
                                const start = new Date(ev.date);
                                const body = (
                                    <>
                                        <span className="w-11 shrink-0 text-center">
                                            <span className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--neu-text-dim)] leading-none">
                                                {MONTHS_SHORT[start.getMonth()]}
                                            </span>
                                            <span className="block font-serif text-[22px] leading-tight text-[var(--neu-text)] tabular-nums">{start.getDate()}</span>
                                        </span>
                                        <span className="w-[3px] self-stretch rounded-full shrink-0 my-1" style={{ backgroundColor: eventColor(ev) }} aria-hidden />
                                        <span className="flex-1 min-w-0">
                                            <span className="block font-serif text-[15.5px] leading-snug text-[var(--neu-text)] truncate">{ev.title}</span>
                                            <span className="block mt-0.5 text-[11.5px] text-[var(--neu-text-dim)] truncate">
                                                {isRange ? `${fmtShortDate(ev.date)} – ${fmtShortDate(ev.endDate!)}` : eventTimeLabel(ev.date)}
                                                {todos.length > 0 ? ` · ${doneCount}/${todos.length} tasks` : ''}
                                            </span>
                                        </span>
                                        {canEditEvents && <ChevronRight size={16} className="shrink-0 text-[var(--neu-text-dim)]" aria-hidden />}
                                    </>
                                );
                                return (
                                    <li key={ev.id} className="task-row">
                                        {canEditEvents ? (
                                            <button type="button" onClick={() => openEditEvent(ev)} aria-label={`Edit event ${ev.title}`}
                                                className="w-full flex items-center gap-3 px-2 py-2.5 text-left rounded-xl active-scale">
                                                {body}
                                            </button>
                                        ) : (
                                            <div className="flex items-center gap-3 px-2 py-2.5">{body}</div>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    ) : (
                        <div className="neu-card px-5 py-6 text-center">
                            <p className="text-[13px] text-[var(--neu-text)]">No upcoming events</p>
                            <p className="mt-1 text-[12px] text-[var(--neu-text-dim)]">An exhibition, a client visit, a delivery — add it to plan its tasks.</p>
                            {canEditEvents && (
                                <button type="button" onClick={openAddEvent} className="quiet-btn mt-2 !text-[var(--neu-text)] font-medium"><Plus size={14} /> Add event</button>
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

            {/* Add / Edit Event Modal */}
            {showEventModal && (
                <FullScreenPortal>
                    <div className="neu-sheet z-50 animate-fade-in-up">
                        <div className="flex justify-between items-center p-3 pt-[calc(1.75rem+var(--safe-top))] z-10">
                            <button
                                onClick={() => setShowEventModal(false)}
                                className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale"
                                aria-label="Close"
                            >
                                <X size={20} />
                            </button>
                            <h2 className="text-base font-serif text-gray-900 dark:text-white">{editingEvent ? 'Edit Event' : 'Add Event'}</h2>
                            <div className="w-9"></div>
                        </div>
                        <div className="flex-1 overflow-y-auto p-3 space-y-5 no-scrollbar">
                            <div>
                                <label htmlFor="event-title" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1.5 uppercase tracking-wider">Event Title *</label>
                                <input
                                    id="event-title"
                                    value={eventForm.title}
                                    onChange={(e) => setEventForm(prev => ({ ...prev, title: e.target.value }))}
                                    placeholder="e.g. Gallery visit with client"
                                    autoComplete="off"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    className="neu-field"
                                />
                            </div>
                            <div>
                                <label htmlFor="event-date" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1.5 uppercase tracking-wider">Date &amp; Time *</label>
                                <input
                                    id="event-date"
                                    type="datetime-local"
                                    value={eventForm.dateTime}
                                    onChange={(e) => setEventForm(prev => ({ ...prev, dateTime: e.target.value }))}
                                    className="neu-field"
                                />
                            </div>
                            <div>
                                <label htmlFor="event-end-date" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1.5 uppercase tracking-wider">End Date <span className="normal-case">(optional — multi-day events)</span></label>
                                <input
                                    id="event-end-date"
                                    type="datetime-local"
                                    value={eventForm.endDateTime}
                                    onChange={(e) => setEventForm(prev => ({ ...prev, endDateTime: e.target.value }))}
                                    className="neu-field"
                                />
                            </div>
                            <div>
                                <label htmlFor="event-notes" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1.5 uppercase tracking-wider">Notes</label>
                                <textarea
                                    id="event-notes"
                                    value={eventForm.notes}
                                    onChange={(e) => setEventForm(prev => ({ ...prev, notes: e.target.value }))}
                                    rows={3}
                                    placeholder="Any details (optional)"
                                    className="neu-field"
                                />
                            </div>
                            <div>
                                <label htmlFor="event-task" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1.5 uppercase tracking-wider">Tasks &amp; Assignment</label>
                                <div className="space-y-1.5">
                                    {eventForm.todos.map(todo => (
                                        <div key={todo.id} className="flex items-center gap-2 neu-raised rounded-2xl px-2 py-1.5">
                                            <button
                                                type="button"
                                                onClick={() => toggleFormTodo(todo.id)}
                                                aria-label={todo.done ? `Mark "${todo.text}" as not done` : `Mark "${todo.text}" as done`}
                                                className={`w-[18px] h-[18px] rounded-[4px] flex items-center justify-center shrink-0 transition-colors active-scale ${todo.done ? 'neu-check-on' : 'neu-check'}`}
                                            >
                                                {todo.done && <Check size={11} strokeWidth={3} />}
                                            </button>
                                            <span className={`flex-1 min-w-0 text-xs truncate ${todo.done ? 'text-gray-400 line-through' : 'text-gray-700 dark:text-gray-200'}`}>
                                                {todo.text}
                                            </span>
                                            {todo.assigneeName && (
                                                <span className="text-[10px] font-bold text-gold-700 dark:text-gold-300 uppercase tracking-wider shrink-0">
                                                    {todo.assigneeName}
                                                </span>
                                            )}
                                            <button
                                                type="button"
                                                onClick={() => removeFormTodo(todo.id)}
                                                aria-label={`Remove task "${todo.text}"`}
                                                className="p-1 text-gray-600 dark:text-gray-300 hover:text-red-500 transition-colors shrink-0"
                                            >
                                                <X size={11} />
                                            </button>
                                        </div>
                                    ))}
                                    {eventForm.todos.length === 0 && (
                                        <p className="text-[11px] text-gray-600 dark:text-gray-300 font-light">No tasks yet — add one below.</p>
                                    )}
                                    <div className="flex items-center gap-1.5">
                                        <input
                                            id="event-task"
                                            value={todoDraft}
                                            onChange={(e) => setTodoDraft(e.target.value)}
                                            onKeyDown={(e) => { if (e.key === 'Enter') addTodoToForm(); }}
                                            placeholder="Add a task..."
                                            autoComplete="off"
                                            className="neu-field flex-1 min-w-0 text-[11px] py-1.5"
                                        />
                                        <select
                                            value={todoAssignee}
                                            onChange={(e) => setTodoAssignee(e.target.value)}
                                            aria-label="Assign task to"
                                            className="neu-field text-[11px] py-1.5 px-2 max-w-[110px] shrink-0"
                                        >
                                            <option value="">Assign</option>
                                            {teamMembers.map(m => (
                                                <option key={m.id} value={m.id}>{m.name}</option>
                                            ))}
                                        </select>
                                        <button
                                            type="button"
                                            onClick={addTodoToForm}
                                            disabled={!todoDraft.trim()}
                                            aria-label="Add task"
                                            className={`p-1.5 rounded-lg shrink-0 transition-colors active-scale ${todoDraft.trim()
                                                ? 'neu-raised-sm neu-btn text-gold-700 dark:text-gold-300'
                                                : 'bg-gray-200 dark:bg-gray-800 text-gray-600 dark:text-gray-300'}`}
                                        >
                                            <Plus size={13} />
                                        </button>
                                    </div>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={handleSaveEvent}
                                disabled={!canSaveEvent || isSavingEvent}
                                className={`w-full rounded-lg py-3 text-sm font-medium tracking-wide transition-colors shadow-md active-scale flex items-center justify-center gap-2 ${canSaveEvent
                                    ? 'neu-raised-sm neu-btn text-gold-700 dark:text-gold-300'
                                    : 'bg-gray-200 dark:bg-gray-800 text-gray-600 dark:text-gray-300'
                                    }`}
                            >
                                {isSavingEvent && <Loader2 size={14} className="animate-spin" />}
                                {editingEvent ? 'Save Changes' : 'Add Event'}
                            </button>
                            {editingEvent && (
                                <button
                                    type="button"
                                    onClick={() => setConfirmDeleteEvent(true)}
                                    className="neu-button neu-button-danger w-full"
                                >
                                    <Trash2 size={14} /> Delete Event
                                </button>
                            )}
                            <div>
                                <p className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1.5 uppercase tracking-wider">Colour</p>
                                <div className="flex items-center gap-2 flex-wrap">
                                    {EVENT_COLORS.map(c => (
                                        <button
                                            key={c}
                                            type="button"
                                            onClick={() => setEventForm(prev => ({ ...prev, color: c }))}
                                            aria-label={`Use colour ${c}`}
                                            aria-pressed={eventForm.color === c}
                                            className={`w-7 h-7 rounded-full transition-transform active-scale ${eventForm.color === c ? 'ring-2 ring-offset-2 ring-gold-500 dark:ring-offset-[#121212] scale-110' : ''}`}
                                            style={{ backgroundColor: c }}
                                        />
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>
                </FullScreenPortal>
            )}

            {/* Delete confirmation — must type "Delete" */}
            <TypeDeleteDialog
                isOpen={confirmDeleteEvent}
                title="Delete event"
                itemName={editingEvent?.title || ''}
                message="it will be archived for admin review"
                onClose={() => setConfirmDeleteEvent(false)}
                onConfirm={handleDeleteEventFromModal}
            />
        </PageRoot>
    );
};
