// Tasks, as Home and the Calendar show them. A task belongs to an event
// (CalendarEvent.todos); every change here is saved as that event's update.
//
//  - TaskRow: a circle to tick, the title, and one quiet line of detail.
//    Tapping the title opens the editor.
//  - QuickAdd: "+ Add task", then type and press Enter. Options (which
//    event, who, priority) appear once there is something typed.
//  - TaskEditor: a bottom sheet on phones, a side panel on computers.
//  - TaskBoard (Home) and DayTasks (Calendar) put them together.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, NotebookText, Plus, Trash2, X } from 'lucide-react';
import type { CalendarEvent, EventTodo, TaskPriority, UserProfile } from '../../types';
import { eventColor } from '../../services/eventService';
import {
    buildBoard, dayHeading, dayKeyOf, eventsOnDay, newTask, shortDay, tasksOf, timeLabel, type TaskItem,
} from './taskModel';

/** Saves one task's change (or removal, with null) as its event's update. */
function saveTask(onUpdateEvent: (ev: CalendarEvent) => void, event: CalendarEvent, todoId: string, next: EventTodo | null) {
    const todos = (event.todos || []).flatMap(t => (t.id !== todoId ? [t] : next ? [next] : []));
    onUpdateEvent({ ...event, todos });
}

// ── Row ────────────────────────────────────────────────────────────────────

const TaskRow: React.FC<{
    item: TaskItem; today: string; canEdit: boolean; showEvent?: boolean;
    onToggle: (item: TaskItem) => void; onOpen: (item: TaskItem) => void;
}> = ({ item, today, canEdit, showEvent = true, onToggle, onOpen }) => {
    const { todo, event } = item;
    const overdue = !todo.done && item.dueDay < today;
    const meta: React.ReactNode[] = [];
    if (overdue) meta.push(<span key="o" className="task-overdue shrink-0 whitespace-nowrap">Overdue · {shortDay(item.dueDay, today)}</span>);
    // Priority as a quiet word, not another coloured dot beside the event's.
    // Low is not worth the space in a row (the editor shows it).
    if (todo.priority === 'high') meta.push(<span key="p" className="task-overdue font-medium shrink-0">High</span>);
    if (todo.priority === 'medium') meta.push(<span key="p" className="font-medium shrink-0">Medium</span>);
    if (todo.dueTime) meta.push(<span key="t" className="tabular-nums shrink-0 whitespace-nowrap">{timeLabel(todo.dueTime)}</span>);
    if (showEvent) {
        meta.push(
            <span key="e" className="inline-flex items-center gap-1 min-w-0">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: eventColor(event) }} aria-hidden />
                <span className="truncate">{event.title}</span>
            </span>,
        );
    }
    if (todo.assigneeName) meta.push(<span key="a" className="truncate min-w-[3rem]">{todo.assigneeName}</span>);

    return (
        <li className="task-row group flex items-start gap-3 py-2.5" data-done={todo.done || undefined}>
            <button
                type="button"
                role="checkbox"
                aria-checked={todo.done}
                aria-label={todo.done ? `Mark "${todo.text}" as not done` : `Mark "${todo.text}" as done`}
                disabled={!canEdit}
                onClick={() => onToggle(item)}
                className="task-check mt-[1px]"
            >
                <Check size={11} strokeWidth={3} />
            </button>
            <button type="button" onClick={() => onOpen(item)} className="flex-1 min-w-0 text-left -my-1 py-1 rounded-md">
                <span className="task-title block text-[13.5px] leading-snug text-[var(--neu-text)] break-words line-clamp-2">{todo.text}</span>
                {(meta.length > 0 || todo.notes) && (
                    <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] leading-snug text-[var(--neu-text-dim)] min-w-0">
                        {meta.map((m, i) => (
                            <React.Fragment key={i}>
                                {i > 0 && <span aria-hidden className="opacity-60 shrink-0">·</span>}
                                {m}
                            </React.Fragment>
                        ))}
                        {todo.notes && <NotebookText size={12} className="shrink-0 opacity-70" aria-label="Has notes" />}
                    </span>
                )}
            </button>
        </li>
    );
};

// ── Quick add ──────────────────────────────────────────────────────────────

/**
 * "+ Add task" → a field. Enter adds the task and keeps the field open for
 * the next one; Escape (or leaving it empty) closes it. Which event it goes
 * to, who does it and how important it is show once something is typed.
 */
const QuickAdd: React.FC<{
    events: CalendarEvent[]; teamMembers: UserProfile[]; label?: string;
    onAdd: (event: CalendarEvent, todo: EventTodo) => void;
}> = ({ events, teamMembers, label = 'Add task', onAdd }) => {
    const [open, setOpen] = useState(false);
    const [text, setText] = useState('');
    const [eventId, setEventId] = useState(events[0]?.id ?? '');
    const [assignee, setAssignee] = useState('');
    const [priority, setPriority] = useState<TaskPriority | ''>('');
    const input = useRef<HTMLInputElement>(null);
    const wrap = useRef<HTMLDivElement>(null);

    // The chosen event may have gone (deleted, or the day changed).
    useEffect(() => {
        if (!events.some(e => e.id === eventId)) setEventId(events[0]?.id ?? '');
    }, [events, eventId]);

    if (events.length === 0) return null;
    const close = () => { setOpen(false); setText(''); setAssignee(''); setPriority(''); };
    const submit = () => {
        const event = events.find(e => e.id === eventId);
        if (!event || !text.trim()) return;
        const member = teamMembers.find(m => m.id === assignee);
        onAdd(event, newTask(text, {
            ...(member ? { assigneeId: member.id, assigneeName: member.name } : {}),
            ...(priority ? { priority } : {}),
        }));
        setText('');
        setPriority('');
        input.current?.focus();
    };

    if (!open) {
        return (
            <button type="button" onClick={() => setOpen(true)} className="quiet-btn px-1">
                <Plus size={14} /> {label}
            </button>
        );
    }
    const select = 'neu-field !w-auto !py-1.5 !px-2.5 text-[12px] max-w-[46%]';
    return (
        <div
            ref={wrap}
            className="py-2 sheet-in"
            onBlur={e => { if (!text.trim() && !wrap.current?.contains(e.relatedTarget as Node)) close(); }}
        >
            <div className="flex items-center gap-3">
                <span className="task-check opacity-50" aria-hidden />
                <input
                    ref={input}
                    autoFocus
                    value={text}
                    onChange={e => setText(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
                        if (e.key === 'Escape') close();
                    }}
                    enterKeyHint="done"
                    placeholder="What needs doing?"
                    aria-label="New task"
                    maxLength={300}
                    autoComplete="off"
                    className="neu-field flex-1 min-w-0 !py-2 text-[13.5px]"
                />
            </div>
            <div className="reveal-rows" data-open={text.trim() ? '' : undefined}>
                <div>
                    <div className="flex flex-wrap items-center gap-2 pt-2 pl-[1.9rem]">
                        {events.length > 1 && (
                            <select value={eventId} onChange={e => setEventId(e.target.value)} aria-label="Event" className={select}>
                                {events.map(ev => <option key={ev.id} value={ev.id}>{ev.title}</option>)}
                            </select>
                        )}
                        <select value={assignee} onChange={e => setAssignee(e.target.value)} aria-label="Assign to" className={select}>
                            <option value="">Anyone</option>
                            {teamMembers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                        </select>
                        <PriorityPicker value={priority} onChange={setPriority} compact />
                        <button type="button" onClick={submit} className="quiet-btn ml-auto !text-[var(--neu-text)] font-medium">Add</button>
                    </div>
                </div>
            </div>
        </div>
    );
};

/** None · Low · Medium · High, as a quiet radio group. */
const PriorityPicker: React.FC<{ value: TaskPriority | ''; onChange: (p: TaskPriority | '') => void; compact?: boolean; disabled?: boolean }> = ({ value, onChange, compact = false, disabled = false }) => {
    const options: [TaskPriority | '', string][] = [['', 'None'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];
    return (
        <div role="radiogroup" aria-label="Priority" className="inline-flex items-center rounded-full neu-inset p-0.5">
            {options.map(([p, name]) => (
                <button
                    key={name}
                    type="button"
                    role="radio"
                    aria-checked={value === p}
                    disabled={disabled}
                    onClick={() => onChange(p)}
                    className={`inline-flex items-center gap-1.5 rounded-full ${compact ? 'px-2 py-1 text-[11px]' : 'px-3 py-1.5 text-[12px]'} transition-colors ${value === p ? 'bg-[var(--neu-bg)] text-[var(--neu-text)] font-medium shadow-sm' : 'text-[var(--neu-text-dim)]'}`}
                >
                    {p && <span className="task-priority" data-p={p} aria-hidden />}
                    {name}
                </button>
            ))}
        </div>
    );
};

// ── Editor ─────────────────────────────────────────────────────────────────

/**
 * One task, edited in place: a sheet from the bottom on phones, a panel on
 * the right on computers. Changes are kept when it closes (Done, Escape or
 * a tap outside), so there is no separate save step to forget.
 */
const TaskEditor: React.FC<{
    item: TaskItem; teamMembers: UserProfile[]; canEdit: boolean;
    onSave: (next: EventTodo) => void; onDelete: () => void; onClose: () => void;
}> = ({ item, teamMembers, canEdit, onSave, onDelete, onClose }) => {
    const [draft, setDraft] = useState<EventTodo>(item.todo);
    const pressedScrim = useRef(false);
    const set = (patch: Partial<EventTodo>) => setDraft(d => ({ ...d, ...patch }));

    const finish = () => {
        const changed = JSON.stringify(draft) !== JSON.stringify(item.todo);
        if (canEdit && changed && draft.text.trim()) onSave({ ...draft, text: draft.text.trim(), notes: draft.notes?.trim() || undefined });
        onClose();
    };
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    });

    const eventDay = dayKeyOf(new Date(item.event.date));
    const label = 'block text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--neu-text-dim)] mb-1.5';
    return createPortal(
        <div className="fixed inset-0 z-[90]" role="dialog" aria-modal="true" aria-label="Task">
            <button
                type="button" aria-label="Close" tabIndex={-1}
                onPointerDown={() => { pressedScrim.current = true; }}
                onClick={() => { if (pressedScrim.current) finish(); }}
                className="absolute inset-0 w-full h-full neu-scrim border-none p-0 cursor-default"
            />
            <div className="absolute inset-x-0 bottom-0 max-h-[88%] lg:inset-y-3 lg:right-3 lg:left-auto lg:w-[24rem] lg:max-h-none
                            neu-modal rounded-t-[1.5rem] lg:rounded-[1.5rem] flex flex-col sheet-in pb-[var(--safe-bottom-ui,0px)]">
                <div className="flex items-center gap-3 px-5 pt-4 pb-2">
                    <span className="flex-1 min-w-0 flex items-center gap-1.5 text-[12px] text-[var(--neu-text-dim)]">
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: eventColor(item.event) }} aria-hidden />
                        <span className="truncate">{item.event.title}</span>
                    </span>
                    <button type="button" onClick={finish} className="quiet-btn !text-[var(--neu-text)] font-medium px-1">Done</button>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 pb-5 space-y-5">
                    <div className="flex items-start gap-3 pt-1">
                        <button
                            type="button" role="checkbox" aria-checked={draft.done} disabled={!canEdit}
                            aria-label={draft.done ? 'Mark as not done' : 'Mark as done'}
                            onClick={() => set({ done: !draft.done })}
                            className="task-check mt-1.5"
                        >
                            <Check size={11} strokeWidth={3} />
                        </button>
                        <textarea
                            value={draft.text}
                            onChange={e => set({ text: e.target.value })}
                            readOnly={!canEdit}
                            rows={2}
                            maxLength={300}
                            aria-label="Task"
                            className="neu-field flex-1 font-serif !text-[17px] leading-snug [field-sizing:content] min-h-[2.75rem] max-h-40"
                        />
                    </div>

                    <div>
                        <span className={label}>Due</span>
                        <div className="flex items-center gap-2">
                            <input
                                type="date" aria-label="Due date" disabled={!canEdit}
                                value={draft.due ?? eventDay}
                                onChange={e => set({ due: e.target.value && e.target.value !== eventDay ? e.target.value : undefined })}
                                className="neu-field flex-1 min-w-0"
                            />
                            <input
                                type="time" aria-label="Due time" disabled={!canEdit}
                                value={draft.dueTime ?? ''}
                                onChange={e => set({ dueTime: e.target.value || undefined })}
                                className="neu-field !w-[8.5rem]"
                            />
                            {draft.dueTime && canEdit && (
                                <button type="button" onClick={() => set({ dueTime: undefined })} aria-label="Remove the time" className="quiet-btn px-1"><X size={14} /></button>
                            )}
                        </div>
                    </div>

                    <div>
                        <span className={label}>Priority</span>
                        <PriorityPicker value={draft.priority ?? ''} onChange={p => set({ priority: p || undefined })} disabled={!canEdit} />
                    </div>

                    <div>
                        <label htmlFor="task-assignee" className={label}>Assigned to</label>
                        <select
                            id="task-assignee" disabled={!canEdit}
                            value={draft.assigneeId ?? ''}
                            onChange={e => {
                                const m = teamMembers.find(x => x.id === e.target.value);
                                set({ assigneeId: m?.id, assigneeName: m?.name });
                            }}
                            className="neu-field"
                        >
                            <option value="">Anyone</option>
                            {/* Keep a former member's name selectable rather than silently dropping it. */}
                            {draft.assigneeId && !teamMembers.some(m => m.id === draft.assigneeId) && (
                                <option value={draft.assigneeId}>{draft.assigneeName ?? 'Former member'}</option>
                            )}
                            {teamMembers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                        </select>
                    </div>

                    <div>
                        <label htmlFor="task-notes" className={label}>Notes</label>
                        <textarea
                            id="task-notes" readOnly={!canEdit}
                            value={draft.notes ?? ''}
                            onChange={e => set({ notes: e.target.value })}
                            rows={3}
                            maxLength={2000}
                            placeholder="Details, links, who to call…"
                            className="neu-field [field-sizing:content] min-h-[5rem] max-h-64"
                        />
                    </div>

                    {canEdit && (
                        <button type="button" onClick={() => { onDelete(); onClose(); }} className="quiet-btn !text-[#a3562c] dark:!text-[#e2a47c]">
                            <Trash2 size={14} /> Delete task
                        </button>
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
};

// ── Shared wiring ──────────────────────────────────────────────────────────

/** Toggle, open, edit and delete for a list of task rows. */
function useTaskActions(onUpdateEvent: (ev: CalendarEvent) => void, events: CalendarEvent[]) {
    const [editing, setEditing] = useState<{ eventId: string; todoId: string } | null>(null);
    // The live copy, so a change synced from someone else shows in the editor's base.
    const editingItem = useMemo(() => {
        if (!editing) return null;
        const event = events.find(e => e.id === editing.eventId);
        const todo = event?.todos?.find(t => t.id === editing.todoId);
        return event && todo ? tasksOf([{ ...event, todos: [todo] }])[0] : null;
    }, [editing, events]);
    return {
        editingItem,
        toggle: (item: TaskItem) => saveTask(onUpdateEvent, item.event, item.todo.id, { ...item.todo, done: !item.todo.done }),
        open: (item: TaskItem) => setEditing({ eventId: item.event.id, todoId: item.todo.id }),
        close: () => setEditing(null),
        add: (event: CalendarEvent, todo: EventTodo) => onUpdateEvent({ ...event, todos: [...(event.todos || []), todo] }),
    };
}

const SectionHeading: React.FC<{ title: string; detail?: string; count?: number; tone?: 'overdue' }> = ({ title, detail, count, tone }) => (
    <div className="flex items-baseline gap-2 pt-5 first:pt-1 pb-1">
        <h3 className={`text-[11px] font-semibold uppercase tracking-[0.14em] ${tone === 'overdue' ? 'task-overdue' : 'text-[var(--neu-text)]'}`}>{title}</h3>
        {detail && <span className="text-[11.5px] text-[var(--neu-text-dim)]">{detail}</span>}
        {count !== undefined && <span className="ml-auto text-[11px] tabular-nums text-[var(--neu-text-dim)]">{count}</span>}
    </div>
);

/** The finished tasks, folded away under "Completed 4". */
const CompletedGroup: React.FC<{ items: TaskItem[]; render: (items: TaskItem[]) => React.ReactNode }> = ({ items, render }) => {
    const [open, setOpen] = useState(false);
    if (items.length === 0) return null;
    return (
        <div className="pt-3">
            <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} className="quiet-btn px-1">
                Completed <span className="tabular-nums">{items.length}</span>
                <ChevronDown size={14} className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
            </button>
            <div className="reveal-rows" data-open={open ? '' : undefined}>
                <div>{open && render(items)}</div>
            </div>
        </div>
    );
};

// ── Home: the board ────────────────────────────────────────────────────────

type Filter = 'all' | 'mine' | 'priority';
const DAY_GROUPS_SHOWN = 5;
const OVERDUE_SHOWN = 5;
/** Completed tasks from the last fortnight onwards; older ones are history. */
const COMPLETED_WINDOW_DAYS = 14;

export const TaskBoard: React.FC<{
    events: CalendarEvent[]; teamMembers: UserProfile[]; currentUserId: string; canEdit: boolean;
    onUpdateEvent: (ev: CalendarEvent) => void;
}> = ({ events, teamMembers, currentUserId, canEdit, onUpdateEvent }) => {
    const [filter, setFilter] = useState<Filter>('all');
    const [allDays, setAllDays] = useState(false);
    const [allOverdue, setAllOverdue] = useState(false);
    const today = dayKeyOf(new Date());
    const actions = useTaskActions(onUpdateEvent, events);

    const board = useMemo(() => {
        let items = tasksOf(events);
        if (filter === 'mine') items = items.filter(i => i.todo.assigneeId === currentUserId);
        if (filter === 'priority') items = items.filter(i => i.todo.priority === 'high' || i.todo.priority === 'medium');
        const since = dayKeyOf(new Date(Date.now() - COMPLETED_WINDOW_DAYS * 86_400_000));
        const b = buildBoard(items, today);
        return { ...b, completed: b.completed.filter(i => i.dueDay >= since) };
    }, [events, filter, currentUserId, today]);

    // Where a new task can go: events running today or later, soonest first.
    const addable = useMemo(
        () => events.filter(ev => (ev.endDate ?? ev.date) >= new Date().setHours(0, 0, 0, 0)).sort((a, b) => a.date - b.date).slice(0, 30),
        [events],
    );

    const rows = (items: TaskItem[]) => (
        <ul>
            {items.map(item => (
                <TaskRow key={`${item.event.id}:${item.todo.id}`} item={item} today={today} canEdit={canEdit} onToggle={actions.toggle} onOpen={actions.open} />
            ))}
        </ul>
    );
    const open = board.overdue.length + board.today.length + board.upcoming.reduce((n, g) => n + g.tasks.length, 0);
    const days = allDays ? board.upcoming : board.upcoming.slice(0, DAY_GROUPS_SHOWN);
    const overdue = allOverdue ? board.overdue : board.overdue.slice(0, OVERDUE_SHOWN);
    const tab = (f: Filter, name: string) => (
        <button key={f} type="button" role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}
            className={`px-2.5 py-1 rounded-full text-[11.5px] transition-colors ${filter === f ? 'neu-inset text-[var(--neu-text)] font-medium' : 'text-[var(--neu-text-dim)]'}`}>
            {name}
        </button>
    );

    return (
        <div className="neu-card px-4 py-3 lg:px-5">
            <div className="flex items-center gap-2 -mx-1">
                <div role="tablist" aria-label="Show" className="flex items-center gap-0.5">
                    {tab('all', 'All')}{tab('mine', 'Mine')}{tab('priority', 'Priority')}
                </div>
            </div>

            {/* Adding is the quickest thing here: first, not under the list. */}
            {canEdit && (
                <div className="pt-1">
                    {addable.length > 0
                        ? <QuickAdd events={addable} teamMembers={teamMembers} onAdd={actions.add} />
                        : <p className="py-1 text-[12px] text-[var(--neu-text-dim)]">Tasks belong to events. Add an event to start a list.</p>}
                </div>
            )}

            {board.overdue.length > 0 && (
                <section aria-label="Overdue">
                    <SectionHeading title="Overdue" count={board.overdue.length} tone="overdue" />
                    {rows(overdue)}
                    {board.overdue.length > OVERDUE_SHOWN && (
                        <button type="button" onClick={() => setAllOverdue(v => !v)} className="quiet-btn px-1">
                            {allOverdue ? 'Show fewer' : `Show ${board.overdue.length - OVERDUE_SHOWN} more`}
                        </button>
                    )}
                </section>
            )}

            <section aria-label="Today">
                <SectionHeading {...dayHeading(today, today)} count={board.today.length || undefined} />
                {board.today.length > 0
                    ? rows(board.today)
                    : <p className="py-2 text-[12.5px] text-[var(--neu-text-dim)]">{open === 0 && filter === 'all' ? 'No tasks today. Add one when something comes up.' : 'Nothing due today.'}</p>}
            </section>

            {days.map(group => (
                <section key={group.day} aria-label={dayHeading(group.day, today).title}>
                    <SectionHeading {...dayHeading(group.day, today)} count={group.tasks.length} />
                    {rows(group.tasks)}
                </section>
            ))}
            {board.upcoming.length > DAY_GROUPS_SHOWN && (
                <button type="button" onClick={() => setAllDays(v => !v)} className="quiet-btn px-1 mt-1">
                    {allDays ? 'Show fewer days' : `${board.upcoming.length - DAY_GROUPS_SHOWN} more days`}
                    <ChevronDown size={14} className={`transition-transform duration-200 ${allDays ? 'rotate-180' : ''}`} />
                </button>
            )}

            <CompletedGroup items={board.completed} render={rows} />

            {actions.editingItem && (
                <TaskEditor
                    key={actions.editingItem.todo.id}
                    item={actions.editingItem}
                    teamMembers={teamMembers}
                    canEdit={canEdit}
                    onSave={next => saveTask(onUpdateEvent, actions.editingItem!.event, next.id, next)}
                    onDelete={() => saveTask(onUpdateEvent, actions.editingItem!.event, actions.editingItem!.todo.id, null)}
                    onClose={actions.close}
                />
            )}
        </div>
    );
};

// ── Calendar: one day's tasks ──────────────────────────────────────────────

export const DayTasks: React.FC<{
    events: CalendarEvent[]; day: string; teamMembers: UserProfile[]; canEdit: boolean;
    onUpdateEvent: (ev: CalendarEvent) => void;
}> = ({ events, day, teamMembers, canEdit, onUpdateEvent }) => {
    const today = dayKeyOf(new Date());
    const actions = useTaskActions(onUpdateEvent, events);
    const items = useMemo(() => tasksOf(events).filter(i => i.dueDay === day), [events, day]);
    const openTasks = items.filter(i => !i.todo.done).sort((a, b) => (a.todo.priority ? 0 : 1) - (b.todo.priority ? 0 : 1) || (a.todo.dueTime ?? '99').localeCompare(b.todo.dueTime ?? '99'));
    const done = items.filter(i => i.todo.done);
    const dayEvents = useMemo(() => eventsOnDay(events, day), [events, day]);
    const rows = (list: TaskItem[]) => (
        <ul>
            {list.map(item => (
                <TaskRow key={`${item.event.id}:${item.todo.id}`} item={item} today={today} canEdit={canEdit} showEvent={dayEvents.length > 1 || item.event.date < new Date(`${day}T00:00`).getTime()} onToggle={actions.toggle} onOpen={actions.open} />
            ))}
        </ul>
    );
    return (
        <div>
            <SectionHeading title="Tasks" count={openTasks.length || undefined} />
            {openTasks.length > 0 ? rows(openTasks) : (
                <p className="py-2 text-[12.5px] text-[var(--neu-text-dim)]">
                    {dayEvents.length > 0 ? 'No tasks for this day.' : 'No tasks. Tasks are added to an event on this day.'}
                </p>
            )}
            {canEdit && <QuickAdd events={dayEvents} teamMembers={teamMembers} onAdd={(ev, todo) => actions.add(ev, ev.date < new Date(`${day}T00:00`).getTime() ? { ...todo, due: day } : todo)} />}
            <CompletedGroup items={done} render={rows} />
            {actions.editingItem && (
                <TaskEditor
                    key={actions.editingItem.todo.id}
                    item={actions.editingItem}
                    teamMembers={teamMembers}
                    canEdit={canEdit}
                    onSave={next => saveTask(onUpdateEvent, actions.editingItem!.event, next.id, next)}
                    onDelete={() => saveTask(onUpdateEvent, actions.editingItem!.event, actions.editingItem!.todo.id, null)}
                    onClose={actions.close}
                />
            )}
        </div>
    );
};
