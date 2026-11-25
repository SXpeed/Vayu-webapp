// Meetings: the shape, the checks and the AI instructions, shared by the
// server (meetings.ts), the screen (views/MeetingsView.tsx) and the tests.

export const MEETING_TYPES = [
    { id: 'reporting', label: 'Reporting', hint: 'Updates, numbers, blockers' },
    { id: 'brainstorm', label: 'Brainstorm', hint: 'Ideas grouped by theme' },
    { id: 'brief', label: 'Brief', hint: 'Short: decisions and deadlines' },
    { id: 'notes', label: 'Notes', hint: 'Clean notes and action items' },
] as const;
export type MeetingType = typeof MEETING_TYPES[number]['id'];

/** Languages a summary or transcript can be translated into. */
export const LANGUAGES = [
    'English', 'Hindi', 'Marathi', 'Gujarati', 'Bengali', 'Punjabi', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Urdu',
    'French', 'German', 'Spanish', 'Italian', 'Arabic', 'Japanese', 'Chinese',
] as const;

export const MAX_TITLE = 200;
export const MAX_TRANSCRIPT = 200_000;
export const MAX_SUMMARY = 50_000;
export const MAX_MEETINGS = 500;
/** Most transcription services take one file of up to 25 MB; at 32 kbps that is ~100 minutes. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const MAX_RECORD_MINUTES = 90;

export interface Meeting {
    id: string;
    type: MeetingType;
    title: string;
    heldAt: number;
    transcript: string;
    summary: string;
    translation: string;
    translationLang: string;
    audioKey: string;
    audioUrl: string;
    audioType: string;
    durationSec: number;
    createdBy: string;
    createdByName: string;
    createdAt: number;
    updatedAt: number;
}

export type MeetingInput = Pick<Meeting, 'type' | 'title' | 'heldAt' | 'transcript' | 'summary'>;

const isType = (v: unknown): v is MeetingType => MEETING_TYPES.some(t => t.id === v);
export const typeLabel = (t: MeetingType) => MEETING_TYPES.find(m => m.id === t)?.label ?? 'Meeting';

/** A clean meeting from what a client sent, or why it can't be saved. */
export function parseMeeting(raw: unknown): MeetingInput | { problem: string } {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (!isType(r.type)) return { problem: 'Pick a meeting type.' };
    const title = typeof r.title === 'string' ? r.title.trim() : '';
    const transcript = typeof r.transcript === 'string' ? r.transcript.trimEnd() : '';
    const summary = typeof r.summary === 'string' ? r.summary.trimEnd() : '';
    const heldAt = typeof r.heldAt === 'number' && Number.isFinite(r.heldAt) && r.heldAt > 0 ? Math.floor(r.heldAt) : Date.now();
    if (title.length > MAX_TITLE) return { problem: `Keep the title under ${MAX_TITLE} characters.` };
    if (transcript.length > MAX_TRANSCRIPT) return { problem: `Keep the text under ${MAX_TRANSCRIPT.toLocaleString('en-IN')} characters.` };
    if (summary.length > MAX_SUMMARY) return { problem: `Keep the summary under ${MAX_SUMMARY.toLocaleString('en-IN')} characters.` };
    return { type: r.type, title: title || `${typeLabel(r.type)} meeting`, heldAt, transcript, summary };
}

// ── AI instructions ─────────────────────────────────────────────────────────

const BASE = [
    'You write meeting records for a small business team (an art gallery and design studio in India).',
    'Use only what is in the transcript. Never invent names, numbers, dates, amounts or decisions; if something is unclear, write "(unclear)".',
    'The transcript may mix Hindi and English, and may have transcription errors: read through them for the meaning.',
    'Write in clear, plain English.',
    'Output plain text, no Markdown symbols (#, *, **). Put each section heading on its own line ending with a colon, and use "- " for bullets.',
    'Leave out any section that has nothing in it.',
].join(' ');

const BY_TYPE: Record<MeetingType, string> = {
    reporting: 'This is a reporting meeting where people give updates. Sections: Overview (2–3 sentences); Updates by person (each person\'s name, then their points, with any figures); Numbers mentioned; Problems and blockers; Decisions; Action items (one per line as "- Who: what, by when" when said).',
    brainstorm: 'This is a brainstorming meeting. Sections: Topic (one sentence); Ideas (grouped under short theme headings, with who suggested each when said); Most promising (up to 3, with why); Concerns raised; Open questions; Next steps (as "- Who: what").',
    brief: 'Write a short brief, under 200 words. Sections: Purpose (one sentence); Key points (at most 6); Decisions; Dates and deadlines; Action items (as "- Who: what, by when").',
    notes: 'Write clean meeting notes. Sections: Summary (3–5 sentences); Notes (bullets in the order things were discussed); Action items (as "- Who: what, by when"); Follow-ups.',
};

/** The chat messages that turn a transcript into a summary. */
export function summaryMessages(type: MeetingType, title: string, transcript: string) {
    return [
        { role: 'system', content: `${BASE} ${BY_TYPE[type]}` },
        { role: 'user', content: `Meeting: ${title}\n\nTranscript:\n${transcript}` },
    ];
}

/** The chat messages that translate text, keeping its layout. */
export function translateMessages(lang: string, text: string) {
    return [
        {
            role: 'system',
            content: `Translate the user's text into ${lang}. Keep names, numbers, dates, amounts, headings, bullets and line breaks exactly as they are. Use natural everyday ${lang}, not stiff formal language. Output only the translation.`,
        },
        { role: 'user', content: text },
    ];
}

/** A hint that helps speech-to-text spell names and mixed Hindi/English. */
export const TRANSCRIBE_HINT = 'A business meeting at an Indian art gallery. Speakers may mix Hindi and English.';
