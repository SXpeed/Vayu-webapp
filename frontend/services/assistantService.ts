import { apiCall as call, authHeaders, parseApiResponse } from './apiClient';
import { apiBase } from './workspace';
import type { Asked } from './meetingService';

/** One step of an answer being made: a lookup, some words, or a problem. */
export type AskEvent = { step: string } | { text: string } | { error: string };
export interface ChatSummary { id: string; title: string; updatedAt: number }
export interface Chat extends ChatSummary { turns: Asked[] }

export const assistantService = {
    /** Asks, and reports the answer as it is written. Abort the signal to stop it. */
    async ask(question: string, history: Asked[], on: (e: AskEvent) => void, signal?: AbortSignal): Promise<void> {
        let res: Response;
        try {
            res = await fetch(`${apiBase()}/assistant/ask`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ question, history }), signal });
        } catch (e) {
            if ((e as Error).name === 'AbortError') return;
            throw new Error('Cannot reach the server. Check your connection and try again.');
        }
        if (!res.ok || !res.body) return void await parseApiResponse(res); // throws the server's message
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                const lines = (buf + value).split('\n');
                buf = lines.pop() ?? '';
                for (const l of lines) if (l.trim()) on(JSON.parse(l) as AskEvent);
            }
        } catch (e) {
            if ((e as Error).name !== 'AbortError') throw new Error('The answer was cut off. Try again.');
        }
    },
    /** A spoken question as text. */
    async transcribe(audio: Blob): Promise<string> {
        const type = audio.type.split(';')[0] || 'audio/webm';
        return (await call<{ text: string }>('/assistant/transcribe', { method: 'POST', headers: { 'Content-Type': type }, body: audio })).text;
    },
    async chats(): Promise<ChatSummary[]> {
        return (await call<{ chats: ChatSummary[] }>('/assistant/chats')).chats;
    },
    chat: (id: string) => call<Chat>(`/assistant/chats/${encodeURIComponent(id)}`),
    save: (id: string, turns: Asked[]) => call<ChatSummary>(`/assistant/chats/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ turns }) }),
    remove: (id: string) => call<{ ok: true }>(`/assistant/chats/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    clear: () => call<{ ok: true }>('/assistant/chats', { method: 'DELETE' }),
};
