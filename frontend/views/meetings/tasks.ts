// A meeting's open action items as Tasks: one calendar event on the meeting
// day, one to-do each, given to the team member the owner's name matches.

import type { CalendarEvent } from '../../types';
import { typeLabel, type Meeting } from '../../meetingRules';

export function tasksEventFor(m: Meeting, team: { id: string; name: string }[], now: number): Omit<CalendarEvent, 'id' | 'createdAt' | 'createdBy' | 'createdByName'> {
    const byName = new Map(team.map(t => [t.name.trim().toLowerCase(), t]));
    return {
        title: `Follow-ups: ${m.title}`,
        date: m.heldAt,
        notes: `Action items from the ${typeLabel(m.type).toLowerCase()} meeting.`,
        todos: m.actionItems.filter(a => !a.done).map((a, i) => {
            const who = byName.get(a.owner.trim().toLowerCase());
            return {
                id: `todo_${now}_${i}`, text: a.text, done: false, createdAt: now,
                ...(a.due ? { due: a.due } : {}),
                ...(who ? { assigneeId: who.id, assigneeName: who.name } : {}),
            };
        }),
    };
}
