import React, { useMemo, useState } from 'react';
import { useBackClose } from '../hooks/useBackClose';
import { CalendarEvent, EventTodo, UserProfile } from '../types';
import { FullScreenPortal } from '../components/FullScreenPortal';
import { TypeDeleteDialog } from '../components/TypeDeleteDialog';
import { EVENT_COLORS, eventColor, eventTimeLabel } from '../services/eventService';
import { Check, ChevronRight, Copy, Loader2, MapPin, Plus, Search, Trash2, X } from 'lucide-react';

export interface EventsAdminProps {
    events: CalendarEvent[];
    teamMembers: UserProfile[];
    onAddEvent: (event: Omit<CalendarEvent, 'id' | 'createdAt' | 'createdBy' | 'createdByName'>) => Promise<void>;
    onUpdateEvent: (event: CalendarEvent) => Promise<void>;
    onDeleteEvent: (id: string) => void;
}

/** Epoch ms -> 'YYYY-MM-DDTHH:mm' in local time, for datetime-local inputs. */
const toInputValue = (ms?: number): string => {
    if (!ms) return '';
    const d = new Date(ms);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const fmtDate = (ms: number): string => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

/** One location input; the id keeps each input's state when another is removed. */
interface LocationRow { id: string; text: string }
const locationRow = (text = ''): LocationRow => ({ id: crypto.randomUUID(), text });

const EMPTY_FORM = { title: '', dateTime: '', endDateTime: '', locations: [] as LocationRow[], notes: '', color: '', todos: [] as EventTodo[] };
type Form = typeof EMPTY_FORM;

const formOf = (ev: CalendarEvent): Form => ({
    title: ev.title,
    dateTime: toInputValue(ev.date),
    endDateTime: toInputValue(ev.endDate),
    locations: ev.locations?.length ? ev.locations.map(l => locationRow(l)) : [locationRow()],
    notes: ev.notes || '',
    color: ev.color || EVENT_COLORS[0],
    todos: [...(ev.todos || [])],
});

const label = 'block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1.5 uppercase tracking-wider';

/** Admin → Events: every event, upcoming or past, to add, edit, copy or delete. */
export const EventsAdmin: React.FC<EventsAdminProps> = ({ events, teamMembers, onAddEvent, onUpdateEvent, onDeleteEvent }) => {
    const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
    const [query, setQuery] = useState('');
    const [showForm, setShowForm] = useState(false);
    useBackClose(showForm, () => setShowForm(false));
    const [editing, setEditing] = useState<CalendarEvent | null>(null);
    const [form, setForm] = useState<Form>({ ...EMPTY_FORM });
    const [isSaving, setIsSaving] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [todoDraft, setTodoDraft] = useState('');
    const [todoAssignee, setTodoAssignee] = useState('');

    const startOfToday = useMemo(() => new Date().setHours(0, 0, 0, 0), []);
    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        return events
            .filter(e => ((e.endDate ?? e.date) >= startOfToday) === (tab === 'upcoming'))
            .filter(e => !q || [e.title, e.notes, ...(e.locations || [])].some(s => s?.toLowerCase().includes(q)))
            .sort((a, b) => (tab === 'upcoming' ? a.date - b.date : b.date - a.date));
    }, [events, startOfToday, tab, query]);

    const isEndAfterStart = !form.endDateTime || new Date(form.endDateTime).getTime() >= new Date(form.dateTime).getTime();
    const canSave = form.title.trim().length > 0 && form.dateTime.length > 0 && isEndAfterStart;

    const openAdd = () => {
        setEditing(null);
        // Rotate through the palette so consecutive events get distinct colors.
        setForm({ ...EMPTY_FORM, locations: [locationRow()], color: EVENT_COLORS[events.length % EVENT_COLORS.length] });
        setShowForm(true);
    };
    const openEdit = (ev: CalendarEvent) => { setEditing(ev); setForm(formOf(ev)); setShowForm(true); };
    /** A copy to adjust: same details, tasks reopened, saved as a new event. */
    const duplicate = () => {
        setEditing(null);
        setForm(prev => ({
            ...prev,
            title: `${prev.title} (copy)`,
            todos: prev.todos.map(t => ({ ...t, id: `todo_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`, done: false, createdAt: Date.now() })),
        }));
    };

    const save = async () => {
        if (!canSave || isSaving) return;
        setIsSaving(true);
        try {
            const fields = {
                title: form.title.trim(),
                date: new Date(form.dateTime).getTime(),
                endDate: form.endDateTime ? new Date(form.endDateTime).getTime() : undefined,
                locations: form.locations.map(l => l.text.trim()).filter(Boolean),
                notes: form.notes.trim() || undefined,
                color: form.color || undefined,
                todos: form.todos,
            };
            if (editing) await onUpdateEvent({ ...editing, ...fields });
            else await onAddEvent(fields);
            setEditing(null);
            setShowForm(false);
        } finally {
            setIsSaving(false);
        }
    };

    const remove = () => {
        if (!editing) return;
        onDeleteEvent(editing.id);
        setConfirmDelete(false);
        setEditing(null);
        setShowForm(false);
    };

    const setLocation = (id: string, text: string) =>
        setForm(prev => ({ ...prev, locations: prev.locations.map(l => (l.id === id ? { ...l, text } : l)) }));
    const removeLocation = (id: string) =>
        setForm(prev => ({ ...prev, locations: prev.locations.length > 1 ? prev.locations.filter(l => l.id !== id) : [locationRow()] }));

    const addTodo = () => {
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
        setForm(prev => ({ ...prev, todos: [...prev.todos, todo] }));
        setTodoDraft('');
        setTodoAssignee('');
    };

    return (
        <div className="space-y-3 animate-fade-in">
            <div className="flex items-center gap-2">
                <div className="neu-inset rounded-full p-1 flex shrink-0" role="tablist" aria-label="Which events">
                    {(['upcoming', 'past'] as const).map(t => (
                        <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                            className={`px-3.5 py-1.5 rounded-full text-[11px] font-semibold uppercase tracking-wider active-scale ${tab === t ? 'neu-raised-sm text-gold-700 dark:text-gold-300' : 'text-[var(--neu-text-dim)]'}`}>
                            {t}
                        </button>
                    ))}
                </div>
                <label className="relative flex-1 min-w-0">
                    <span className="sr-only">Search events</span>
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--neu-text-dim)]" aria-hidden />
                    <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search" className="neu-field !pl-8 py-1.5 text-[12px]" />
                </label>
                <button type="button" onClick={openAdd}
                    className="neu-raised-sm neu-btn rounded-full px-3.5 py-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gold-700 dark:text-gold-300 active-scale shrink-0">
                    <Plus size={12} /> Add
                </button>
            </div>

            {shown.length > 0 ? (
                <ul className="neu-card px-2 py-1">
                    {shown.map(ev => (
                        <li key={ev.id} className="task-row">
                            <button type="button" onClick={() => openEdit(ev)} aria-label={`Edit event ${ev.title}`}
                                className="w-full flex items-center gap-3 px-2 py-2.5 text-left rounded-xl active-scale">
                                <span className="w-[3px] self-stretch rounded-full shrink-0 my-1" style={{ backgroundColor: eventColor(ev) }} aria-hidden />
                                <span className="flex-1 min-w-0">
                                    <span className="block font-serif text-[15px] leading-snug text-[var(--neu-text)] truncate">{ev.title}</span>
                                    <span className="block mt-0.5 text-[11.5px] text-[var(--neu-text-dim)] truncate">
                                        {fmtDate(ev.date)}{ev.endDate ? ` – ${fmtDate(ev.endDate)}` : ` · ${eventTimeLabel(ev.date)}`}
                                        {ev.locations?.length ? ` · ${ev.locations.join(', ')}` : ''}
                                    </span>
                                </span>
                                <ChevronRight size={16} className="shrink-0 text-[var(--neu-text-dim)]" aria-hidden />
                            </button>
                        </li>
                    ))}
                </ul>
            ) : (
                <div className="neu-card px-5 py-8 text-center text-[13px] text-[var(--neu-text-dim)]">
                    {query ? 'No events match.' : `No ${tab} events.`}
                </div>
            )}

            {showForm && (
                <FullScreenPortal>
                    <div className="neu-sheet z-50 animate-fade-in-up">
                        <div className="flex justify-between items-center p-3 pt-[calc(1.75rem+var(--safe-top))] z-10">
                            <button onClick={() => setShowForm(false)} className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale" aria-label="Close">
                                <X size={20} />
                            </button>
                            <h2 className="text-base font-serif text-gray-900 dark:text-white">{editing ? 'Edit Event' : 'Add Event'}</h2>
                            {editing ? (
                                <button onClick={duplicate} className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale" aria-label="Duplicate event" title="Duplicate">
                                    <Copy size={17} />
                                </button>
                            ) : <div className="w-9" />}
                        </div>
                        <div className="flex-1 overflow-y-auto p-3 space-y-5 no-scrollbar">
                            <div>
                                <label htmlFor="event-title" className={label}>Event Title *</label>
                                <input id="event-title" value={form.title} onChange={e => setForm(prev => ({ ...prev, title: e.target.value }))}
                                    placeholder="e.g. Gallery visit with client" autoComplete="off" autoCorrect="off" spellCheck={false} className="neu-field" />
                            </div>
                            <div>
                                <p className={label}>Locations</p>
                                <div className="space-y-1.5">
                                    {form.locations.map(({ id, text: loc }, i) => (
                                        <div key={id} className="flex items-center gap-1.5">
                                            <MapPin size={14} className="shrink-0 text-[var(--neu-text-dim)]" aria-hidden />
                                            <input value={loc} onChange={e => setLocation(id, e.target.value)} aria-label={`Location ${i + 1}`}
                                                placeholder={i === 0 ? 'e.g. Bikaner House, New Delhi' : 'Another venue'} autoComplete="off" className="neu-field flex-1 min-w-0" />
                                            {(form.locations.length > 1 || loc) && (
                                                <button type="button" onClick={() => removeLocation(id)} aria-label={`Remove location ${i + 1}`}
                                                    className="p-1.5 text-gray-600 dark:text-gray-300 hover:text-red-500 shrink-0"><X size={13} /></button>
                                            )}
                                        </div>
                                    ))}
                                    {form.locations.length < 20 && (
                                        <button type="button" onClick={() => setForm(prev => ({ ...prev, locations: [...prev.locations, locationRow()] }))}
                                            className="quiet-btn !text-[var(--neu-text)] text-[12px]"><Plus size={13} /> Add location</button>
                                    )}
                                </div>
                            </div>
                            <div>
                                <label htmlFor="event-date" className={label}>Date &amp; Time *</label>
                                <input id="event-date" type="datetime-local" value={form.dateTime} onChange={e => setForm(prev => ({ ...prev, dateTime: e.target.value }))} className="neu-field" />
                            </div>
                            <div>
                                <label htmlFor="event-end-date" className={label}>End Date <span className="normal-case">(optional — multi-day events)</span></label>
                                <input id="event-end-date" type="datetime-local" value={form.endDateTime} min={form.dateTime || undefined}
                                    onChange={e => setForm(prev => ({ ...prev, endDateTime: e.target.value }))} className="neu-field" aria-invalid={!isEndAfterStart} />
                                {!isEndAfterStart && <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">The end is before the start.</p>}
                            </div>
                            <div>
                                <label htmlFor="event-notes" className={label}>Notes</label>
                                <textarea id="event-notes" value={form.notes} onChange={e => setForm(prev => ({ ...prev, notes: e.target.value }))}
                                    rows={3} placeholder="Any details (optional)" className="neu-field" />
                            </div>
                            <div>
                                <label htmlFor="event-task" className={label}>Tasks &amp; Assignment</label>
                                <div className="space-y-1.5">
                                    {form.todos.map(todo => (
                                        <div key={todo.id} className="flex items-center gap-2 neu-raised rounded-2xl px-2 py-1.5">
                                            <button type="button" onClick={() => setForm(prev => ({ ...prev, todos: prev.todos.map(t => (t.id === todo.id ? { ...t, done: !t.done } : t)) }))}
                                                aria-label={todo.done ? `Mark "${todo.text}" as not done` : `Mark "${todo.text}" as done`}
                                                className={`w-[18px] h-[18px] rounded-[4px] flex items-center justify-center shrink-0 transition-colors active-scale ${todo.done ? 'neu-check-on' : 'neu-check'}`}>
                                                {todo.done && <Check size={11} strokeWidth={3} />}
                                            </button>
                                            <span className={`flex-1 min-w-0 text-xs truncate ${todo.done ? 'text-gray-400 line-through' : 'text-gray-700 dark:text-gray-200'}`}>{todo.text}</span>
                                            {todo.assigneeName && <span className="text-[10px] font-bold text-gold-700 dark:text-gold-300 uppercase tracking-wider shrink-0">{todo.assigneeName}</span>}
                                            <button type="button" onClick={() => setForm(prev => ({ ...prev, todos: prev.todos.filter(t => t.id !== todo.id) }))}
                                                aria-label={`Remove task "${todo.text}"`} className="p-1 text-gray-600 dark:text-gray-300 hover:text-red-500 transition-colors shrink-0">
                                                <X size={11} />
                                            </button>
                                        </div>
                                    ))}
                                    {form.todos.length === 0 && <p className="text-[11px] text-gray-600 dark:text-gray-300 font-light">No tasks yet — add one below.</p>}
                                    <div className="flex items-center gap-1.5">
                                        <input id="event-task" value={todoDraft} onChange={e => setTodoDraft(e.target.value)}
                                            onKeyDown={e => { if (e.key === 'Enter') addTodo(); }} placeholder="Add a task..." autoComplete="off"
                                            className="neu-field flex-1 min-w-0 text-[11px] py-1.5" />
                                        <select value={todoAssignee} onChange={e => setTodoAssignee(e.target.value)} aria-label="Assign task to"
                                            className="neu-field text-[11px] py-1.5 px-2 max-w-[110px] shrink-0">
                                            <option value="">Assign</option>
                                            {teamMembers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                                        </select>
                                        <button type="button" onClick={addTodo} disabled={!todoDraft.trim()} aria-label="Add task"
                                            className={`p-1.5 rounded-lg shrink-0 transition-colors active-scale ${todoDraft.trim() ? 'neu-raised-sm neu-btn text-gold-700 dark:text-gold-300' : 'bg-gray-200 dark:bg-gray-800 text-gray-600 dark:text-gray-300'}`}>
                                            <Plus size={13} />
                                        </button>
                                    </div>
                                </div>
                            </div>
                            <div>
                                <p className={label}>Colour</p>
                                <div className="flex items-center gap-2 flex-wrap">
                                    {EVENT_COLORS.map(c => (
                                        <button key={c} type="button" onClick={() => setForm(prev => ({ ...prev, color: c }))} aria-label={`Use colour ${c}`} aria-pressed={form.color === c}
                                            className={`w-7 h-7 rounded-full transition-transform active-scale ${form.color === c ? 'ring-2 ring-offset-2 ring-gold-500 dark:ring-offset-[#121212] scale-110' : ''}`}
                                            style={{ backgroundColor: c }} />
                                    ))}
                                </div>
                            </div>
                            <button type="button" onClick={save} disabled={!canSave || isSaving}
                                className={`w-full rounded-lg py-3 text-sm font-medium tracking-wide transition-colors shadow-md active-scale flex items-center justify-center gap-2 ${canSave ? 'neu-raised-sm neu-btn text-gold-700 dark:text-gold-300' : 'bg-gray-200 dark:bg-gray-800 text-gray-600 dark:text-gray-300'}`}>
                                {isSaving && <Loader2 size={14} className="animate-spin" />}
                                {editing ? 'Save Changes' : 'Add Event'}
                            </button>
                            {editing && (
                                <button type="button" onClick={() => setConfirmDelete(true)} className="neu-button neu-button-danger w-full">
                                    <Trash2 size={14} /> Delete Event
                                </button>
                            )}
                        </div>
                    </div>
                </FullScreenPortal>
            )}

            {/* Delete confirmation — must type "Delete" */}
            <TypeDeleteDialog
                isOpen={confirmDelete}
                title="Delete event"
                itemName={editing?.title || ''}
                message="it will be archived for admin review"
                onClose={() => setConfirmDelete(false)}
                onConfirm={remove}
            />
        </div>
    );
};
