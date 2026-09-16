import React, { useMemo, useState } from 'react';
import { Artwork, CalendarEvent, Catalog, EventTodo, Invoice, ViewState, UserProfile } from '../types';
import { FullScreenPortal } from '../components/FullScreenPortal';
import { TypeDeleteDialog } from '../components/TypeDeleteDialog';
import { getThumbUrl } from '../services/storageService';
import { EVENT_COLORS, eventColor } from '../services/eventService';
import { MessageCircle, Receipt, TrendingUp, Palette, ArrowRight, IndianRupee, CalendarDays, Plus, Trash2, X, Loader2, Users, Check, ChevronDown, Edit2 } from 'lucide-react';

interface HomeViewProps {
    artworks: Artwork[];
    catalogs: Catalog[];
    invoices: Invoice[];
    events: CalendarEvent[];
    teamMembers: UserProfile[];
    userProfile: UserProfile;
    onNavigate: (view: ViewState) => void;
    onCatalogClick: (catalog: Catalog) => void;
    onAddEvent: (event: Omit<CalendarEvent, 'id' | 'createdAt' | 'createdBy' | 'createdByName'>) => Promise<void>;
    onUpdateEvent: (event: CalendarEvent) => void;
    onDeleteEvent: (id: string) => void;
}

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

const EMPTY_EVENT_FORM = { title: '', dateTime: '', endDateTime: '', notes: '', color: '' };

export const HomeView: React.FC<HomeViewProps> = ({ artworks, catalogs, invoices, events, teamMembers, userProfile, onNavigate, onCatalogClick, onAddEvent, onUpdateEvent, onDeleteEvent }) => {
    const availableArtworks = useMemo(() => artworks.filter(a => a.status === 'Available').length, [artworks]);
    // Proforma invoices are quotations; only paid ones count as revenue.
    const totalRevenue = useMemo(() => invoices.filter(inv => inv.status === 'Paid').reduce((sum, inv) => sum + inv.total, 0), [invoices]);
    const recentCatalogs = useMemo(() => [...catalogs].sort((a, b) => b.createdAt - a.createdAt).slice(0, 2), [catalogs]);

    // ── Upcoming events (calendar) ────────────────────────────────────────
    const [showEventModal, setShowEventModal] = useState(false);
    const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
    const [eventForm, setEventForm] = useState({ ...EMPTY_EVENT_FORM });
    const [isSavingEvent, setIsSavingEvent] = useState(false);
    const [confirmDeleteEvent, setConfirmDeleteEvent] = useState(false);
    const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
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
            };
            if (editingEvent) {
                await onUpdateEvent({ ...editingEvent, ...fields });
            } else {
                await onAddEvent({ ...fields, todos: [] });
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

    const updateEventTodos = (eventId: string, todos: EventTodo[]) => {
        const ev = events.find(e => e.id === eventId);
        if (!ev) return;
        onUpdateEvent({ ...ev, todos });
    };

    const toggleTodo = (eventId: string, todoId: string) => {
        const ev = events.find(e => e.id === eventId);
        if (!ev) return;
        updateEventTodos(eventId, (ev.todos || []).map(t => (t.id === todoId ? { ...t, done: !t.done } : t)));
    };

    const removeTodo = (eventId: string, todoId: string) => {
        const ev = events.find(e => e.id === eventId);
        if (!ev) return;
        updateEventTodos(eventId, (ev.todos || []).filter(t => t.id !== todoId));
    };

    const addTodo = (eventId: string) => {
        if (!todoDraft.trim()) return;
        const ev = events.find(e => e.id === eventId);
        if (!ev) return;
        const assignee = teamMembers.find(m => m.id === todoAssignee);
        const todo: EventTodo = {
            id: `todo_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
            text: todoDraft.trim(),
            assigneeId: assignee?.id,
            assigneeName: assignee?.name,
            done: false,
            createdAt: Date.now(),
        };
        updateEventTodos(eventId, [...(ev.todos || []), todo]);
        setTodoDraft('');
        setTodoAssignee('');
    };



    return (
        <div className="h-full flex flex-col bg-[#faf9f6] dark:bg-[#121212] overflow-y-auto no-scrollbar pb-20 transition-colors duration-500 animate-fade-in">
            {/* Top Stats */}
            <div className="px-[6px] pt-4">
                <div className="flex gap-[6px] animate-fade-in-up" style={{ animationDelay: '100ms' }}>
                    <div className="flex-1 bg-white dark:bg-[#1e1e1e] rounded-[6px] p-[6px] shadow-sm border border-gray-100 dark:border-gray-800">
                        <div className="flex items-center gap-2 mb-1.5">
                            <TrendingUp size={14} className="text-gold-500" />
                            <span className="text-[9px] font-medium uppercase tracking-widest text-gray-500 dark:text-gray-400">Revenue</span>
                        </div>
                        <p className="text-xl font-serif text-gray-900 dark:text-white">₹{totalRevenue.toLocaleString('en-IN')}</p>
                    </div>
                    <div className="flex-1 bg-white dark:bg-[#1e1e1e] rounded-[6px] p-[6px] shadow-sm border border-gray-100 dark:border-gray-800">
                        <div className="flex items-center gap-2 mb-1.5">
                            <Palette size={14} className="text-gold-500" />
                            <span className="text-[9px] font-medium uppercase tracking-widest text-gray-500 dark:text-gray-400">Available</span>
                        </div>
                        <p className="text-xl font-serif text-gray-900 dark:text-white">{availableArtworks} <span className="text-xs font-sans text-gray-400">/ {artworks.length}</span></p>
                    </div>
                </div>
            </div>

            <div className="px-[6px] mt-6 space-y-8">
                {/* Quick Actions */}
                <section className="animate-fade-in-up" style={{ animationDelay: '200ms' }}>
                    <h2 className="text-xs font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest mb-[6px] px-[6px]">Quick Actions</h2>
                    <div className="grid grid-cols-4 gap-[6px]">
                        <button
                            onClick={() => onNavigate('payments')}
                            className="bg-white dark:bg-[#1e1e1e] p-[6px] rounded-[6px] shadow-sm border border-gray-100 dark:border-gray-800 flex flex-col items-center justify-center gap-2 hover:border-gold-500 dark:hover:border-gold-500 transition-colors active-scale"
                        >
                            <div className="text-brand-900 dark:text-gold-400">
                                <IndianRupee size={22} strokeWidth={1.5} />
                            </div>
                            <span className="text-[9px] font-medium text-gray-600 dark:text-gray-300 uppercase tracking-wider">Payments</span>
                        </button>
                        <button
                            onClick={() => onNavigate('contacts')}
                            className="bg-white dark:bg-[#1e1e1e] p-[6px] rounded-[6px] shadow-sm border border-gray-100 dark:border-gray-800 flex flex-col items-center justify-center gap-2 hover:border-gold-500 dark:hover:border-gold-500 transition-colors active-scale"
                        >
                            <div className="text-brand-900 dark:text-gold-400">
                                <Users size={22} strokeWidth={1.5} />
                            </div>
                            <span className="text-[9px] font-medium text-gray-600 dark:text-gray-300 uppercase tracking-wider">Contacts</span>
                        </button>
                        <button 
                            onClick={() => onNavigate('invoice')}
                            className="bg-white dark:bg-[#1e1e1e] p-[6px] rounded-[6px] shadow-sm border border-gray-100 dark:border-gray-800 flex flex-col items-center justify-center gap-2 hover:border-gold-500 dark:hover:border-gold-500 transition-colors active-scale"
                        >
                            <div className="text-brand-900 dark:text-gold-400">
                                <Receipt size={22} strokeWidth={1.5} />
                            </div>
                            <span className="text-[9px] font-medium text-gray-600 dark:text-gray-300 uppercase tracking-wider text-center leading-tight">Proforma<br />Invoice</span>
                        </button>
                        <button 
                            onClick={() => onNavigate('messaging')}
                            className="bg-white dark:bg-[#1e1e1e] p-[6px] rounded-[6px] shadow-sm border border-gray-100 dark:border-gray-800 flex flex-col items-center justify-center gap-2 hover:border-gold-500 dark:hover:border-gold-500 transition-colors active-scale"
                        >
                            <div className="text-brand-900 dark:text-gold-400">
                                <MessageCircle size={22} strokeWidth={1.5} />
                            </div>
                            <span className="text-[9px] font-medium text-gray-600 dark:text-gray-300 uppercase tracking-wider">Messages</span>
                        </button>
                    </div>
                </section>

                {/* Upcoming Events (calendar) */}
                <section className="animate-fade-in-up" style={{ animationDelay: '250ms' }}>
                    <div className="flex justify-between items-end mb-[6px] px-[6px]">
                        <h2 className="text-xs font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest">Upcoming Events</h2>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => onNavigate('calendar')}
                                aria-label="Open full calendar"
                                title="Open full calendar"
                                className="p-1 text-gray-500 dark:text-gray-400 hover:text-gold-600 dark:hover:text-gold-400 transition-colors active-scale"
                            >
                                <CalendarDays size={14} />
                            </button>
                            <button onClick={openAddEvent} className="text-[9px] font-medium text-gold-600 dark:text-gold-400 uppercase tracking-wider flex items-center gap-1 active-scale">
                                <Plus size={10} /> Add
                            </button>
                        </div>
                    </div>
                    <div className="space-y-[6px]">
                        {upcomingEvents.map((ev, index) => {
                            const isRange = !!ev.endDate && !sameCalendarDay(ev.date, ev.endDate);
                            const todos = ev.todos || [];
                            const doneCount = todos.filter(t => t.done).length;
                            const isExpanded = expandedEventId === ev.id;
                            return (
                                <div
                                    key={ev.id}
                                    className="bg-white dark:bg-[#1e1e1e] rounded-[6px] shadow-sm border border-gray-100 dark:border-gray-800 animate-fade-in-up overflow-hidden"
                                    style={{ animationDelay: `${300 + index * 40}ms` }}
                                >
                                    <div
                                        role="button"
                                        tabIndex={0}
                                        onClick={() => setExpandedEventId(isExpanded ? null : ev.id)}
                                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setExpandedEventId(isExpanded ? null : ev.id); }}
                                        className="flex items-center gap-3 p-[6px] cursor-pointer select-none"
                                        aria-expanded={isExpanded}
                                    >
                                        <div className="w-11 shrink-0 rounded-[6px] bg-gold-500/10 dark:bg-gold-900/20 border border-gold-500/30 text-center py-1">
                                            <p className="text-[8px] font-bold text-gold-600 dark:text-gold-400 uppercase tracking-widest leading-none">
                                                {isRange ? `${MONTHS_SHORT[new Date(ev.date).getMonth()]}-${MONTHS_SHORT[new Date(ev.endDate).getMonth()]}` : MONTHS_SHORT[new Date(ev.date).getMonth()]}
                                            </p>
                                            <p className="text-base font-serif text-gray-900 dark:text-white leading-tight">
                                                {isRange ? `${new Date(ev.date).getDate()}-${new Date(ev.endDate).getDate()}` : new Date(ev.date).getDate()}
                                            </p>
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <h3 className="font-serif text-gray-900 dark:text-gray-100 text-sm line-clamp-1 flex items-center gap-1.5">
                                                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: eventColor(ev) }} />
                                                {ev.title}
                                            </h3>
                                            <p className="text-[9px] text-gray-500 dark:text-gray-400 uppercase tracking-wider mt-0.5">
                                                {isRange
                                                    ? `${fmtShortDate(ev.date)} – ${fmtShortDate(ev.endDate)}`
                                                    : (new Date(ev.date).getHours() === 0 && new Date(ev.date).getMinutes() === 0
                                                        ? 'All day'
                                                        : new Date(ev.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}
                                                {todos.length > 0 ? ` • ${doneCount}/${todos.length} tasks` : ''}
                                                {ev.createdByName ? ` • by ${ev.createdByName}` : ''}
                                            </p>
                                            {ev.notes && <p className="text-[10px] text-gray-400 dark:text-gray-500 font-light line-clamp-1 mt-0.5">{ev.notes}</p>}
                                        </div>
                                        <button
                                            type="button"
                                            onClick={(e) => { e.stopPropagation(); openEditEvent(ev); }}
                                            aria-label={`Edit event ${ev.title}`}
                                            className="p-1.5 text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale shrink-0"
                                        >
                                            <Edit2 size={14} />
                                        </button>
                                        <ChevronDown size={14} className={`text-gray-400 dark:text-gray-500 shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                                    </div>

                                    {isExpanded && (
                                        <div className="border-t border-gray-100 dark:border-gray-800 bg-gray-50/60 dark:bg-[#191919] px-[6px] py-[6px] space-y-1.5">
                                            {todos.map(todo => (
                                                <div key={todo.id} className="flex items-center gap-2">
                                                    <button
                                                        type="button"
                                                        onClick={() => toggleTodo(ev.id, todo.id)}
                                                        aria-label={todo.done ? `Mark "${todo.text}" as not done` : `Mark "${todo.text}" as done`}
                                                        className={`w-[18px] h-[18px] rounded-[4px] border flex items-center justify-center shrink-0 transition-colors active-scale ${todo.done ? 'bg-gold-500 border-gold-500 text-white' : 'border-gray-300 dark:border-gray-600'}`}
                                                    >
                                                        {todo.done && <Check size={11} strokeWidth={3} />}
                                                    </button>
                                                    <span className={`flex-1 min-w-0 text-xs truncate ${todo.done ? 'text-gray-400 line-through' : 'text-gray-700 dark:text-gray-200'}`}>
                                                        {todo.text}
                                                    </span>
                                                    {todo.assigneeName && (
                                                        <span className="text-[8px] font-bold text-gold-600 dark:text-gold-400 uppercase tracking-wider shrink-0">
                                                            {todo.assigneeName}
                                                        </span>
                                                    )}
                                                    <button
                                                        type="button"
                                                        onClick={() => removeTodo(ev.id, todo.id)}
                                                        aria-label={`Delete task "${todo.text}"`}
                                                        className="p-1 text-gray-300 dark:text-gray-600 hover:text-red-500 transition-colors shrink-0"
                                                    >
                                                        <X size={11} />
                                                    </button>
                                                </div>
                                            ))}
                                            {todos.length === 0 && (
                                                <p className="text-[10px] text-gray-400 dark:text-gray-500 font-light">No tasks yet — add one below.</p>
                                            )}
                                            <div className="flex items-center gap-1.5 pt-1">
                                                <input
                                                    value={todoDraft}
                                                    onChange={(e) => setTodoDraft(e.target.value)}
                                                    onKeyDown={(e) => { if (e.key === 'Enter') addTodo(ev.id); }}
                                                    placeholder="Add a task..."
                                                    autoComplete="off"
                                                    aria-label="New task"
                                                    className="flex-1 min-w-0 bg-white dark:bg-[#2a2a2a] border border-gray-200 dark:border-gray-700 rounded-[6px] py-1.5 px-2.5 text-[11px] text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                                                />
                                                <select
                                                    value={todoAssignee}
                                                    onChange={(e) => setTodoAssignee(e.target.value)}
                                                    aria-label="Assign task to"
                                                    className="bg-white dark:bg-[#2a2a2a] border border-gray-200 dark:border-gray-700 rounded-[6px] py-1.5 px-1.5 text-[10px] text-gray-700 dark:text-gray-200 focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 max-w-[110px] shrink-0"
                                                >
                                                    <option value="">Assign</option>
                                                    {teamMembers.map(m => (
                                                        <option key={m.id} value={m.id}>{m.name}</option>
                                                    ))}
                                                </select>
                                                <button
                                                    type="button"
                                                    onClick={() => addTodo(ev.id)}
                                                    disabled={!todoDraft.trim()}
                                                    aria-label="Add task"
                                                    className={`p-1.5 rounded-[6px] shrink-0 transition-colors active-scale ${todoDraft.trim()
                                                        ? 'bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950'
                                                        : 'bg-gray-200 dark:bg-gray-800 text-gray-400 dark:text-gray-600'}`}
                                                >
                                                    <Plus size={13} />
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                        {upcomingEvents.length === 0 && (
                            <div className="w-full text-center py-8 bg-white dark:bg-[#1e1e1e] rounded-[6px] border border-gray-100 dark:border-gray-800">
                                <CalendarDays size={24} strokeWidth={1.25} className="mx-auto text-gray-300 dark:text-gray-600 mb-2" />
                                <p className="text-gray-400 dark:text-gray-500 text-xs font-light">No upcoming events. Tap "+ Add" to schedule one.</p>
                            </div>
                        )}
                    </div>
                </section>

                {/* Recent Catalogs */}
                {recentCatalogs.length > 0 && (
                    <section className="animate-fade-in-up" style={{ animationDelay: '350ms' }}>
                        <div className="flex justify-between items-end mb-[6px] px-[6px]">
                            <h2 className="text-xs font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest">Latest Catalogs</h2>
                            <button onClick={() => onNavigate('catalogs')} className="text-[9px] font-medium text-gold-600 dark:text-gold-400 uppercase tracking-wider flex items-center gap-1 active-scale">
                                View All <ArrowRight size={10} />
                            </button>
                        </div>
                        <div className="space-y-[6px] px-0">
                            {recentCatalogs.map((catalog, index) => (
                                <button 
                                    type="button"
                                    key={catalog.id} 
                                    onClick={() => onCatalogClick(catalog)}
                                    className="w-full text-left bg-white dark:bg-[#1e1e1e] rounded-[6px] shadow-sm overflow-hidden border border-gray-100 dark:border-gray-800 flex h-24 animate-scale-in cursor-pointer active-scale" 
                                    style={{ animationDelay: `${400 + index * 50}ms` }}
                                >
                                    <img loading="lazy" decoding="async" src={getThumbUrl(catalog.coverImageUrl)} alt={catalog.name} className="w-24 h-full object-cover" />
                                    <div className="p-[6px] flex flex-col justify-center flex-1">
                                        <h3 className="font-serif text-gray-900 dark:text-gray-100 text-sm line-clamp-1">{catalog.name}</h3>
                                        <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-1 line-clamp-1 font-light">{catalog.description}</p>
                                        <p className="text-[9px] font-medium text-gold-600 dark:text-gold-400 mt-2 uppercase tracking-widest">
                                            {catalog.artworkIds.length} Items
                                        </p>
                                    </div>
                                </button>
                            ))}
                        </div>
                    </section>
                )}
            </div>

            {/* Add / Edit Event Modal */}
            {showEventModal && (
                <FullScreenPortal>
                    <div className="absolute inset-0 bg-[#faf9f6] dark:bg-[#121212] z-50 flex flex-col animate-fade-in-up">
                        <div className="bg-white dark:bg-[#1a1a1a] flex justify-between items-center p-[6px] border-b border-gray-100 dark:border-gray-800 pt-[calc(1.75rem+env(safe-area-inset-top,0px))] shadow-sm z-10">
                            <button
                                onClick={() => setShowEventModal(false)}
                                className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale"
                                aria-label="Close"
                            >
                                <X size={20} />
                            </button>
                            <h2 className="text-base font-serif text-gray-900 dark:text-white">{editingEvent ? 'Edit Event' : 'Add Event'}</h2>
                            <div className="w-9"></div>
                        </div>
                        <div className="flex-1 overflow-y-auto p-[6px] space-y-5 no-scrollbar">
                            <div>
                                <label htmlFor="event-title" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wider">Event Title *</label>
                                <input
                                    id="event-title"
                                    value={eventForm.title}
                                    onChange={(e) => setEventForm(prev => ({ ...prev, title: e.target.value }))}
                                    placeholder="e.g. Gallery visit with client"
                                    autoComplete="off"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2.5 px-3.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                                />
                            </div>
                            <div>
                                <label htmlFor="event-date" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wider">Date &amp; Time *</label>
                                <input
                                    id="event-date"
                                    type="datetime-local"
                                    value={eventForm.dateTime}
                                    onChange={(e) => setEventForm(prev => ({ ...prev, dateTime: e.target.value }))}
                                    className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2.5 px-3.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                                />
                            </div>
                            <div>
                                <label htmlFor="event-end-date" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wider">End Date <span className="normal-case">(optional — multi-day events)</span></label>
                                <input
                                    id="event-end-date"
                                    type="datetime-local"
                                    value={eventForm.endDateTime}
                                    onChange={(e) => setEventForm(prev => ({ ...prev, endDateTime: e.target.value }))}
                                    className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2.5 px-3.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                                />
                            </div>
                            <div>
                                <label htmlFor="event-notes" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wider">Notes</label>
                                <textarea
                                    id="event-notes"
                                    value={eventForm.notes}
                                    onChange={(e) => setEventForm(prev => ({ ...prev, notes: e.target.value }))}
                                    rows={3}
                                    placeholder="Any details (optional)"
                                    className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2.5 px-3.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors resize-none"
                                />
                            </div>
                            <button
                                type="button"
                                onClick={handleSaveEvent}
                                disabled={!canSaveEvent || isSavingEvent}
                                className={`w-full rounded-[6px] py-3 text-sm font-medium tracking-wide transition-colors shadow-md active-scale flex items-center justify-center gap-2 ${canSaveEvent
                                    ? 'bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 hover:bg-brand-800 dark:hover:bg-gold-400'
                                    : 'bg-gray-200 dark:bg-gray-800 text-gray-400 dark:text-gray-600'
                                    }`}
                            >
                                {isSavingEvent && <Loader2 size={14} className="animate-spin" />}
                                {editingEvent ? 'Save Changes' : 'Add Event'}
                            </button>
                            {editingEvent && (
                                <button
                                    type="button"
                                    onClick={() => setConfirmDeleteEvent(true)}
                                    className="w-full rounded-[6px] py-2.5 text-sm font-medium tracking-wide transition-colors active-scale flex items-center justify-center gap-2 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900/40 hover:bg-red-50 dark:hover:bg-red-900/20"
                                >
                                    <Trash2 size={14} /> Delete Event
                                </button>
                            )}
                            <div>
                                <label className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wider">Colour</label>
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
        </div>
    );
};
