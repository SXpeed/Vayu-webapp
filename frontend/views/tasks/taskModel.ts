// Tasks, gathered from the events they belong to, and sorted the way a
// person plans a day: overdue first, then today, then each coming day, with
// finished work set aside. Plain functions (tests/taskModel.test.mjs).
//
// A task belongs to an event (CalendarEvent.todos). It is due on its own
// date when one is set, otherwise on the day its event starts.

import type { CalendarEvent, EventTodo, TaskPriority } from '../../types';

export interface TaskItem {
    todo: EventTodo;
    event: CalendarEvent;
    /** The day it is due, as YYYY-MM-DD (local time). */
    dueDay: string;
}

/** YYYY-MM-DD for a local date. */
export function dayKeyOf(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The local Date at the start of a YYYY-MM-DD day. */
export function dateOfKey(key: string): Date {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
}

export function addDays(key: string, days: number): string {
    const d = dateOfKey(key);
    d.setDate(d.getDate() + days);
    return dayKeyOf(d);
}

export function taskDueDay(todo: EventTodo, event: CalendarEvent): string {
    return todo.due ?? dayKeyOf(new Date(event.date));
}

/** Every task of these events. */
export function tasksOf(events: CalendarEvent[]): TaskItem[] {
    const out: TaskItem[] = [];
    for (const event of events) {
        for (const todo of event.todos || []) out.push({ todo, event, dueDay: taskDueDay(todo, event) });
    }
    return out;
}

const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 };
const rank = (p?: TaskPriority) => (p ? PRIORITY_RANK[p] : 3);

/** Within a day: important first, then by time, then in the order they were added. */
export function compareTasks(a: TaskItem, b: TaskItem): number {
    return rank(a.todo.priority) - rank(b.todo.priority)
        || (a.todo.dueTime ?? '99:99').localeCompare(b.todo.dueTime ?? '99:99')
        || a.todo.createdAt - b.todo.createdAt;
}

export interface DayGroup { day: string; tasks: TaskItem[] }

export interface TaskBoard {
    overdue: TaskItem[];
    today: TaskItem[];
    /** Each coming day that has open tasks, soonest first. */
    upcoming: DayGroup[];
    /** Finished tasks, most recently due first. */
    completed: TaskItem[];
}

/** Open tasks by when they are due, relative to `today` (YYYY-MM-DD). */
export function buildBoard(items: TaskItem[], today: string): TaskBoard {
    const board: TaskBoard = { overdue: [], today: [], upcoming: [], completed: [] };
    const ahead = new Map<string, TaskItem[]>();
    for (const item of items) {
        if (item.todo.done) board.completed.push(item);
        else if (item.dueDay < today) board.overdue.push(item);
        else if (item.dueDay === today) board.today.push(item);
        else ahead.set(item.dueDay, [...(ahead.get(item.dueDay) ?? []), item]);
    }
    // Most recently overdue first: last week's slip matters more than last year's.
    board.overdue.sort((a, b) => b.dueDay.localeCompare(a.dueDay) || compareTasks(a, b));
    board.today.sort(compareTasks);
    board.upcoming = [...ahead.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, tasks]) => ({ day, tasks: tasks.sort(compareTasks) }));
    board.completed.sort((a, b) => b.dueDay.localeCompare(a.dueDay) || b.todo.createdAt - a.todo.createdAt);
    return board;
}

/** "Today", "Tomorrow", "Friday" (this week), else "Friday 10 Oct". */
export function dayHeading(day: string, today: string): { title: string; detail: string } {
    const date = dateOfKey(day);
    const detail = date.toLocaleDateString('en-IN', { day: 'numeric', month: 'long' });
    if (day === today) return { title: 'Today', detail };
    if (day === addDays(today, 1)) return { title: 'Tomorrow', detail };
    if (day === addDays(today, -1)) return { title: 'Yesterday', detail };
    const weekday = date.toLocaleDateString('en-IN', { weekday: 'long' });
    if (day > today && day <= addDays(today, 6)) return { title: weekday, detail };
    return { title: weekday, detail: date.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: day.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric' }) };
}

/** "30 Sep" (with the year when it isn't this year). */
export function shortDay(day: string, today: string): string {
    return dateOfKey(day).toLocaleDateString('en-IN', {
        day: 'numeric', month: 'short', year: day.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric',
    });
}

/** "14:30" → "2:30 pm". */
export function timeLabel(hhmm: string): string {
    const [h, m] = hhmm.split(':').map(Number);
    return new Date(2000, 0, 1, h, m).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
}

/** The events a new task for this day can belong to: those running on it. */
export function eventsOnDay(events: CalendarEvent[], day: string): CalendarEvent[] {
    const from = dateOfKey(day).getTime();
    const to = from + 86_399_999;
    return events.filter(ev => ev.date <= to && (ev.endDate ?? ev.date) >= from).sort((a, b) => a.date - b.date);
}

/** A new task, ready to add to an event. */
export function newTask(text: string, fields: Partial<EventTodo> = {}): EventTodo {
    return {
        id: `todo_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
        text: text.trim(),
        done: false,
        createdAt: Date.now(),
        ...fields,
    };
}
