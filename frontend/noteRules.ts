// My Notes: the shape and the checks, shared by the server (notes.ts) and the
// My Space screen (tests/notes.integration.test.mjs).

export const MAX_TITLE = 200;
export const MAX_BODY = 20_000;
export const MAX_NOTES = 500;

export interface Note {
    id: string;
    title: string;
    body: string;
    pinned: boolean;
    createdAt: number;
    updatedAt: number;
}

export type NoteInput = Pick<Note, 'title' | 'body' | 'pinned'>;

/** A clean note from what a client sent, or why it can't be saved. */
export function parseNote(raw: unknown): NoteInput | { problem: string } {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const title = typeof r.title === 'string' ? r.title.trim() : '';
    const body = typeof r.body === 'string' ? r.body.trimEnd() : '';
    if (!title && !body.trim()) return { problem: 'Write something first.' };
    if (title.length > MAX_TITLE) return { problem: `Keep the title under ${MAX_TITLE} characters.` };
    if (body.length > MAX_BODY) return { problem: `Keep the note under ${MAX_BODY.toLocaleString('en-IN')} characters.` };
    return { title, body, pinned: r.pinned === true };
}
