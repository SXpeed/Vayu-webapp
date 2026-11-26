import { apiCall as call } from './apiClient';
import type { Asked } from './meetingService';

export const assistantService = {
    async ask(question: string, history: Asked[]): Promise<string> {
        return (await call<{ answer: string }>('/assistant/ask', { method: 'POST', body: JSON.stringify({ question, history }) })).answer;
    },
    /** A spoken question as text. */
    async transcribe(audio: Blob): Promise<string> {
        const type = audio.type.split(';')[0] || 'audio/webm';
        return (await call<{ text: string }>('/assistant/transcribe', { method: 'POST', headers: { 'Content-Type': type }, body: audio })).text;
    },
};
