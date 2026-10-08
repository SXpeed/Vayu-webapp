// The day a chat's messages were sent, as WhatsApp shows it: a small label
// above the first message of each day ("Today", "Yesterday", "Monday",
// "5 October", "5 October 2025").

import React from 'react';

const startOfDay = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d; };
const dayKey = (ms: number) => startOfDay(ms).toDateString();

/** "Today", "Yesterday", the weekday within the last week, then the date (the year only when it isn't this one). */
export function chatDayLabel(ms: number, now = Date.now()): string {
    const day = startOfDay(ms);
    const daysAgo = Math.round((startOfDay(now).getTime() - day.getTime()) / 86_400_000);
    if (daysAgo === 0) return 'Today';
    if (daysAgo === 1) return 'Yesterday';
    if (daysAgo > 1 && daysAgo < 7) return day.toLocaleDateString('en-IN', { weekday: 'long' });
    const sameYear = day.getFullYear() === new Date(now).getFullYear();
    return day.toLocaleDateString('en-IN', sameYear ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' });
}

export const DayDivider: React.FC<{ ms: number }> = ({ ms }) => (
    <div className="flex justify-center py-1">
        <span className="neu-inset rounded-full px-3 py-1 text-[11px] font-semibold text-[var(--neu-text-dim)]">{chatDayLabel(ms)}</span>
    </div>
);

/** A chat's rows with a day label above the first message of each day. */
export function withDayDividers<T extends { id: string; timestamp: number }>(messages: T[], row: (msg: T) => React.ReactNode): React.ReactNode[] {
    const out: React.ReactNode[] = [];
    let last = '';
    for (const msg of messages) {
        const key = dayKey(msg.timestamp);
        if (key !== last) {
            out.push(<DayDivider key={`day-${msg.id}`} ms={msg.timestamp} />);
            last = key;
        }
        out.push(row(msg));
    }
    return out;
}
