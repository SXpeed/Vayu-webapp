import type { AudioPart, Meeting, MeetingInput } from '../meetingRules';
import { apiCall as call, tokenHeader } from './apiClient';
import storageService from './storageService';

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const EXT: Record<string, string> = { mp4: 'm4a', ogg: 'ogg', wav: 'wav', mpeg: 'mp3' };

export interface MeetingList { meetings: Meeting[]; ai: { text: boolean; transcribe: boolean } }
export interface Asked { q: string; a: string }
export interface AskAllAnswer { answer: string; sources: { id: string; title: string; heldAt: number }[] }

export const meetingService = {
    list(): Promise<MeetingList> {
        return call<MeetingList>('/meetings');
    },
    /** Typed text, or `recording` to start one whose audio follows in parts. */
    create(m: MeetingInput, recording = false): Promise<Meeting> {
        return call<Meeting>('/meetings', json('POST', { ...m, recording }));
    },
    /** Stores one part's audio; its key then goes to addPart. */
    async uploadPart(blob: Blob, index: number): Promise<string> {
        const type = blob.type.split(';')[0] || 'audio/webm';
        const ext = Object.entries(EXT).find(([k]) => type.includes(k))?.[1] ?? 'webm';
        return (await storageService.upload(new File([blob], `meeting-${index + 1}.${ext}`, { type }))).key;
    },
    /** Adds a stored part to the meeting; the reply has its text when AI is set up. */
    addPart(id: string, index: number, audioKey: string, durationSec: number): Promise<Meeting & { transcribeError?: string }> {
        return call(`/meetings/${id}/parts`, json('POST', { audioKey, durationSec, index }));
    },
    retranscribe(id: string, index: number): Promise<Meeting> {
        return call<Meeting>(`/meetings/${id}/parts/${index}/transcribe`, json('POST', {}));
    },
    finish(id: string): Promise<Meeting> {
        return call<Meeting>(`/meetings/${id}/finish`, json('POST', {}));
    },
    update(id: string, m: MeetingInput): Promise<Meeting> {
        return call<Meeting>(`/meetings/${id}`, json('PUT', m));
    },
    async remove(id: string): Promise<void> {
        await call(`/meetings/${id}`, { method: 'DELETE' });
    },
    ai(id: string, action: 'summarize' | 'translate', body: Record<string, unknown> = {}): Promise<Meeting> {
        return call<Meeting>(`/meetings/${id}/${action}`, json('POST', body));
    },
    speakers(id: string, chunk: number, known: string[]): Promise<{ text: string; index: number; total: number }> {
        return call(`/meetings/${id}/speakers`, json('POST', { chunk, known }));
    },
    async ask(id: string, question: string, history: Asked[]): Promise<string> {
        return (await call<{ answer: string }>(`/meetings/${id}/ask`, json('POST', { question, history }))).answer;
    },
    askAll(question: string, history: Asked[]): Promise<AskAllAnswer> {
        return call<AskAllAnswer>('/meetings/ask', json('POST', { question, history }));
    },
    /** A part as a playable local URL: files are served as downloads, and Safari won't play those. */
    async audioUrl(part: AudioPart): Promise<string> {
        const res = await fetch(part.url, { headers: tokenHeader(), credentials: 'include' });
        if (!res.ok) throw new Error('The recording did not load.');
        return URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: part.type || 'audio/webm' }));
    },
};
