import { CalendarEvent } from '../types';

import { apiCall } from './apiClient';

/** Palette used for calendar event colors — one hue per event so overlaps
 *  between events, festivals and public holidays stay readable. */
export const EVENT_COLORS = [
    '#d97706', // amber
    '#2563eb', // blue
    '#059669', // emerald
    '#dc2626', // red
    '#7c3aed', // violet
    '#db2777', // pink
    '#0891b2', // cyan
    '#65a30d', // lime
] as const;

/** Color used for events that predate the color field. */
export const DEFAULT_EVENT_COLOR: string = EVENT_COLORS[0];

export const eventColor = (ev: Pick<CalendarEvent, 'color'> | undefined): string =>
    (ev?.color as string | undefined) || DEFAULT_EVENT_COLOR;

export const eventService = {
    async getEvents(): Promise<CalendarEvent[]> {
        return apiCall<CalendarEvent[]>('/events');
    },

    async saveEvent(event: CalendarEvent): Promise<CalendarEvent> {
        return apiCall<CalendarEvent>('/events', {
            method: 'POST',
            body: JSON.stringify(event),
        });
    },

    async updateEvent(event: CalendarEvent): Promise<CalendarEvent> {
        return apiCall<CalendarEvent>(`/events/${event.id}`, {
            method: 'PUT',
            body: JSON.stringify(event),
        });
    },

    async deleteEvent(id: string): Promise<void> {
        await apiCall<{ success: boolean }>(`/events/${id}`, {
            method: 'DELETE',
        });
    },
};

/** An event's start as shown in lists: "All day" when it starts at midnight, else the time. */
export function eventTimeLabel(date: number): string {
    const d = new Date(date);
    return d.getHours() === 0 && d.getMinutes() === 0 ? 'All day' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
