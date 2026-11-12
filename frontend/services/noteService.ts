import type { Note, NoteInput } from '../noteRules';
import { apiCall as call } from './apiClient';

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const noteService = {
    async list(): Promise<Note[]> {
        return (await call<{ notes: Note[] }>('/notes')).notes;
    },
    create(n: NoteInput): Promise<Note> {
        return call<Note>('/notes', json('POST', n));
    },
    update(id: string, n: NoteInput): Promise<Note> {
        return call<Note>(`/notes/${id}`, json('PUT', n));
    },
    async remove(id: string): Promise<void> {
        await call(`/notes/${id}`, { method: 'DELETE' });
    },
};
