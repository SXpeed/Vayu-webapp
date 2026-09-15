import { CalendarEvent } from '../types';

import { apiCall as call } from './apiClient';

export const eventService = {
    async getEvents(): Promise<CalendarEvent[]> {
        return call<CalendarEvent[]>('/events');
    },

    async saveEvent(event: CalendarEvent): Promise<CalendarEvent> {
        return call<CalendarEvent>('/events', {
            method: 'POST',
            body: JSON.stringify(event),
        });
    },

    async updateEvent(event: CalendarEvent): Promise<CalendarEvent> {
        return call<CalendarEvent>(`/events/${event.id}`, {
            method: 'PUT',
            body: JSON.stringify(event),
        });
    },

    async deleteEvent(id: string): Promise<void> {
        await call<{ success: boolean }>(`/events/${id}`, {
            method: 'DELETE',
        });
    },
};