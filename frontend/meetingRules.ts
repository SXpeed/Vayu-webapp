// Meetings: the shape, the checks and the AI instructions, shared by the
// server (meetings.ts), the screens (views/MeetingsView.tsx, views/meetings/)
// and the tests (tests/meetings.integration.test.mjs).

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
export const MAX_TRANSCRIPT = 400_000;
export const MAX_SUMMARY = 50_000;
export const MAX_MEETINGS = 500;
export const MAX_ATTENDEES = 50;
export const MAX_ACTION_ITEMS = 50;
/** Transcription services take one file of up to 25 MB, so audio is stored in parts below that. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
/** A recording is saved (and transcribed, for live text) every this many seconds. */
export const PART_SECONDS = 180;
export const MAX_RECORD_MINUTES = 240;
export const MAX_PARTS = Math.ceil((MAX_RECORD_MINUTES * 60) / PART_SECONDS) + 20; // + room for uploaded files split into parts
/** Transcript text the "who said what" step sends to the AI at once. */
export const SPEAKER_CHUNK = 6_000;

export interface Attendee { id: string; name: string }
export interface AudioPart { key: string; url: string; type: string; sec: number; text: string }
export interface ActionItem { id: string; text: string; owner: string; due: string; done: boolean }

export interface Meeting {
    id: string;
    type: MeetingType;
    title: string;
    heldAt: number;
    /** 'recording' while parts are still arriving. */
    status: 'recording' | 'ready';
    attendees: Attendee[];
    parts: AudioPart[];
    transcript: string;
    summary: string;
    actionItems: ActionItem[];
    /** Set once the action items were added to Tasks: the calendar event holding them. */
    tasksEventId: string;
    translation: string;
    translationLang: string;
    durationSec: number;
    createdBy: string;
    createdByName: string;
    createdAt: number;
    updatedAt: number;
}

export type MeetingInput = Pick<Meeting, 'type' | 'title' | 'heldAt' | 'transcript' | 'summary' | 'attendees' | 'actionItems' | 'tasksEventId'>;

const isType = (v: unknown): v is MeetingType => MEETING_TYPES.some(t => t.id === v);
export const typeLabel = (t: MeetingType) => MEETING_TYPES.find(m => m.id === t)?.label ?? 'Meeting';
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

export function parseAttendees(raw: unknown): Attendee[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: Attendee[] = [];
    for (const a of raw.slice(0, MAX_ATTENDEES)) {
        const id = str((a as Attendee)?.id, 64);
        const name = str((a as Attendee)?.name, 100);
        if (id && name && !seen.has(id)) { seen.add(id); out.push({ id, name }); }
    }
    return out;
}

export function parseActionItemList(raw: unknown): ActionItem[] {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, MAX_ACTION_ITEMS).flatMap((a, i): ActionItem[] => {
        const r = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
        const text = str(r.text, 500);
        if (!text) return [];
        const due = str(r.due, 10);
        return [{ id: str(r.id, 40) || `ai${i}`, text, owner: str(r.owner, 100), due: isDay(due) ? due : '', done: r.done === true }];
    });
}

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
    return {
        type: r.type, title: title || `${typeLabel(r.type)} meeting`, heldAt, transcript, summary,
        attendees: parseAttendees(r.attendees), actionItems: parseActionItemList(r.actionItems), tasksEventId: str(r.tasksEventId, 100),
    };
}

/** The first JSON array in a model's reply (models wrap it in prose or code fences). */
export function parseActionItems(reply: string): ActionItem[] {
    const start = reply.indexOf('[');
    const end = reply.lastIndexOf(']');
    if (start < 0 || end <= start) return [];
    try {
        return parseActionItemList(JSON.parse(reply.slice(start, end + 1))).map((a, i) => ({ ...a, id: `a${i + 1}`, done: false }));
    } catch {
        return [];
    }
}

/** Text in pieces of about `size` characters, cut at line or sentence ends so no one's words are split. */
export function chunkText(text: string, size: number): string[] {
    const out: string[] = [];
    let rest = text.trim();
    while (rest.length > size) {
        const window = rest.slice(0, size);
        const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('। '));
        const at = cut > size / 2 ? cut + 1 : size;
        out.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
    }
    if (rest) out.push(rest);
    return out;
}

/** "Name:" labels at the start of transcript lines, in order of first use. */
export function speakersIn(transcript: string): string[] {
    const found = new Set<string>();
    for (const m of transcript.matchAll(/^([^\n:]{1,40}):/gm)) found.add(m[1].trim());
    return [...found];
}

/** Every "Old:" line label becomes "New:". */
export function renameSpeaker(transcript: string, from: string, to: string): string {
    return transcript.split('\n').map(line => (line.startsWith(`${from}:`) ? `${to}:${line.slice(from.length + 1)}` : line)).join('\n');
}

const wordsOf = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
/** Words in almost every question, which say nothing about which meeting. */
const QUESTION_WORDS = new Set(['the', 'and', 'what', 'about', 'did', 'does', 'who', 'when', 'how', 'was', 'were', 'for', 'with', 'our', 'that', 'this', 'from', 'have', 'has', 'are', 'you', 'why', 'which', 'any', 'all', 'last', 'meeting', 'meetings', 'decide', 'decided', 'say', 'said', 'kya', 'hai', 'tha']);

/** The meetings most likely to answer a question: most matching words in title, summary and transcript. */
export function pickRelevant<T extends Pick<Meeting, 'title' | 'summary' | 'transcript' | 'heldAt'>>(meetings: T[], question: string, n: number): T[] {
    const words = [...new Set(wordsOf(question))].filter(w => !QUESTION_WORDS.has(w));
    const score = (m: T) => {
        const hay = new Set(wordsOf(`${m.title} ${m.summary} ${m.transcript}`));
        return words.reduce((s, w) => s + (hay.has(w) ? 1 : 0), 0);
    };
    const scored = meetings.map(m => ({ m, s: score(m) }));
    scored.sort((a, b) => b.s - a.s || b.m.heldAt - a.m.heldAt);
    return scored.filter(x => x.s > 0).slice(0, n).map(x => x.m);
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

const who = (attendees: Attendee[]) => (attendees.length ? `\nPeople in the meeting: ${attendees.map(a => a.name).join(', ')}.` : '');
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const labelsSoFar = (known: string[]) => (known.length ? '\nLabels used so far (keep using them for the same people): ' + known.join(', ') + '.' : '');

/** The chat messages that turn a transcript into a summary. */
export function summaryMessages(type: MeetingType, title: string, transcript: string, attendees: Attendee[] = []) {
    return [
        { role: 'system', content: `${BASE} ${BY_TYPE[type]}` },
        { role: 'user', content: `Meeting: ${title}${who(attendees)}\n\nTranscript:\n${transcript}` },
    ];
}

/** The chat messages that list the action items as JSON. */
export function actionItemsMessages(title: string, heldAt: number, transcript: string, attendees: Attendee[]) {
    return [
        {
            role: 'system',
            content: 'List the action items agreed in this meeting transcript: things someone will do. Use only what was said. '
                + 'Reply with only a JSON array, no other text: [{"text": "what to do, short and clear", "owner": "the person\'s name, or empty", "due": "YYYY-MM-DD, or empty"}]. '
                + `Work out dates like "Friday" or "next week" from the meeting date. Reply [] when there are none.`,
        },
        { role: 'user', content: `Meeting: ${title}, held ${day(heldAt)}.${who(attendees)}\n\nTranscript:\n${transcript}` },
    ];
}

/** The chat messages that mark who said what in one piece of a transcript. */
export function speakerMessages(chunk: string, attendees: Attendee[], known: string[]) {
    return [
        {
            role: 'system',
            content: 'Rewrite this meeting transcript piece as lines of "Speaker: what they said", starting a new line whenever the speaker changes. '
                + 'Keep every word exactly as it is; only add the labels and line breaks. '
                + 'Use a person\'s name only when the conversation makes it clear (someone is addressed by name, introduces themselves, or answers to it); otherwise use "Speaker 1", "Speaker 2" and so on. '
                + 'Output only the rewritten transcript.',
        },
        { role: 'user', content: `${who(attendees)}${labelsSoFar(known)}\n\nTranscript piece:\n${chunk}` },
    ];
}

/** The chat messages that answer a question from meeting records. */
export function askMessages(question: string, context: string, history: { q: string; a: string }[] = []) {
    return [
        {
            role: 'system',
            content: 'Answer questions about a team\'s meetings using only the meeting records given. '
                + 'Be short and direct; name the meeting and date when you use one. '
                + 'If the records don\'t say, answer "The meetings don\'t say." Reply in the language of the question. Plain text, no Markdown.',
        },
        { role: 'user', content: `Meeting records:\n${context}` },
        ...history.slice(-6).flatMap(h => [{ role: 'user', content: h.q }, { role: 'assistant', content: h.a }]),
        { role: 'user', content: question },
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
