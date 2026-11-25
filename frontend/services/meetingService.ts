import type { Meeting, MeetingInput } from '../meetingRules';
import { apiCall as call, tokenHeader } from './apiClient';
import storageService from './storageService';

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const EXT: Record<string, string> = { mp4: 'm4a', ogg: 'ogg' };

export interface MeetingList { meetings: Meeting[]; ai: { text: boolean; transcribe: boolean } }

export const meetingService = {
    list(): Promise<MeetingList> {
        return call<MeetingList>('/meetings');
    },
    /** Uploads the recording first (when there is one), then saves the meeting. */
    async create(m: MeetingInput, audio?: { blob: Blob; durationSec: number }): Promise<Meeting> {
        let audioKey = '';
        if (audio) {
            const ext = Object.entries(EXT).find(([k]) => audio.blob.type.includes(k))?.[1] ?? 'webm';
            audioKey = (await storageService.upload(new File([audio.blob], `meeting.${ext}`, { type: audio.blob.type.split(';')[0] }))).key;
        }
        return call<Meeting>('/meetings', json('POST', { ...m, audioKey, durationSec: audio?.durationSec ?? 0 }));
    },
    update(id: string, m: MeetingInput): Promise<Meeting> {
        return call<Meeting>(`/meetings/${id}`, json('PUT', m));
    },
    async remove(id: string): Promise<void> {
        await call(`/meetings/${id}`, { method: 'DELETE' });
    },
    ai(id: string, action: 'transcribe' | 'summarize' | 'translate', body: Record<string, unknown> = {}): Promise<Meeting> {
        return call<Meeting>(`/meetings/${id}/${action}`, json('POST', body));
    },
    /** The recording as a playable local URL: files are served as downloads, and Safari won't play those. */
    async audioUrl(m: Meeting): Promise<string> {
        const res = await fetch(m.audioUrl, { headers: tokenHeader(), credentials: 'include' });
        if (!res.ok) throw new Error('The recording did not load.');
        return URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: m.audioType || 'audio/webm' }));
    },
};
