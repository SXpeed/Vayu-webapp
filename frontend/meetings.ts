// Meetings: recordings or typed text, with AI transcription (live, part by
// part, while recording), a summary shaped by the meeting type, action items,
// who said what, questions about one meeting or all of them, and translation.
// Shared with the whole workspace: the "meetings" role section decides who
// reads and asks (view) and who records, changes and runs the AI (edit); the
// plan's "meetings" module switches it on per org.
//
// AI: any OpenAI-compatible service, set in wrangler.jsonc (docs/MEETINGS.md).
//
// Storage: one table in the workspace's own database, created on first use;
// audio lives in R2 under the uploader's uploads/ folder, in parts of a few
// minutes (each under the 25 MB a transcription request takes).

import { err, json, runSetupOnce, text } from './rows';
import {
    LANGUAGES, MAX_AUDIO_BYTES, MAX_MEETINGS, MAX_PARTS, SPEAKER_CHUNK, TRANSCRIBE_HINT,
    actionItemsMessages, askMessages, chunkText, parseActionItems, parseMeeting, pickRelevant, speakerMessages, summaryMessages, translateMessages,
    type AudioPart, type Meeting, type MeetingType,
} from './meetingRules';
import { fileUrl, type Ctx, type Env, type SessionData } from './workerEnv';
import { getSession } from './workerRoles';

const ID = String.raw`([\w-]{1,64})`;
const ID_PATH = new RegExp(`^/meetings/${ID}$`);
const PARTS_PATH = new RegExp(`^/meetings/${ID}/parts$`);
const PART_PATH = new RegExp(String.raw`^/meetings/${ID}/parts/(\d{1,4})/transcribe$`);
const FINISH_PATH = new RegExp(`^/meetings/${ID}/finish$`);
const AI_PATH = new RegExp(`^/meetings/${ID}/(summarize|translate|speakers|ask)$`);

type Handler = (ctx: Ctx) => Promise<Response>;
export interface MeetingRoute { method: string; match: (path: string) => boolean; handler: Handler }

/** Added after the first release (2026-11-25): tables made then get them here. */
const ADDED_COLUMNS: Record<string, string> = {
    status: "TEXT NOT NULL DEFAULT 'ready'",
    attendees: "TEXT NOT NULL DEFAULT '[]'",
    parts: "TEXT NOT NULL DEFAULT '[]'",
    action_items: "TEXT NOT NULL DEFAULT '[]'",
    tasks_event_id: "TEXT NOT NULL DEFAULT ''",
};

function ensureTable(db: D1Database): Promise<void> {
    return runSetupOnce(db, 'meetingsTable', async () => {
        await db.prepare(`CREATE TABLE IF NOT EXISTS meetings (
            id               TEXT PRIMARY KEY,
            type             TEXT NOT NULL,
            title            TEXT NOT NULL DEFAULT '',
            held_at          INTEGER NOT NULL,
            transcript       TEXT NOT NULL DEFAULT '',
            summary          TEXT NOT NULL DEFAULT '',
            translation      TEXT NOT NULL DEFAULT '',
            translation_lang TEXT NOT NULL DEFAULT '',
            audio_key        TEXT NOT NULL DEFAULT '',
            audio_type       TEXT NOT NULL DEFAULT '',
            duration_sec     INTEGER NOT NULL DEFAULT 0,
            created_by       TEXT NOT NULL,
            created_by_name  TEXT NOT NULL DEFAULT '',
            created_at       INTEGER NOT NULL,
            updated_at       INTEGER NOT NULL
        )`).run();
        await db.prepare('CREATE INDEX IF NOT EXISTS idx_meetings_held ON meetings (held_at)').run();
        const have = new Set(((await db.prepare('PRAGMA table_info(meetings)').all<{ name: string }>()).results || []).map(c => c.name));
        for (const [column, definition] of Object.entries(ADDED_COLUMNS)) {
            if (have.has(column)) continue;
            try {
                await db.prepare(`ALTER TABLE meetings ADD COLUMN ${column} ${definition}`).run(); // NOSONAR: schema steps run one at a time
            } catch (e) {
                // Another isolate may have added it at the same moment.
                if (!/duplicate column/i.test((e as Error).message)) throw e;
            }
        }
    }, JSON.stringify(ADDED_COLUMNS));
}

async function caller(ctx: Ctx): Promise<SessionData | Response> {
    const session = await getSession(ctx.request, ctx.env.VAYU_KV);
    if (!session) return err('Unauthorized', 401);
    await ensureTable(ctx.env.VAYU_DB);
    return session;
}

function jsonList(v: unknown): unknown[] {
    try {
        const parsed = JSON.parse(text(v) || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
}

type StoredPart = Omit<AudioPart, 'url'>;

function storedParts(r: Record<string, unknown>): StoredPart[] {
    const parts = jsonList(r.parts) as StoredPart[];
    // A meeting from the first release: one recording in audio_key.
    if (!parts.length && r.audio_key) return [{ key: text(r.audio_key), type: text(r.audio_type), sec: Number(r.duration_sec), text: text(r.transcript) }];
    return parts;
}

const toMeeting = (env: Env, r: Record<string, unknown>): Meeting => ({
    id: text(r.id), type: text(r.type) as MeetingType, title: text(r.title), heldAt: Number(r.held_at),
    status: r.status === 'recording' ? 'recording' : 'ready',
    attendees: jsonList(r.attendees) as Meeting['attendees'],
    parts: storedParts(r).map(p => ({ ...p, url: fileUrl(env, p.key) })),
    transcript: text(r.transcript), summary: text(r.summary),
    actionItems: jsonList(r.action_items) as Meeting['actionItems'], tasksEventId: text(r.tasks_event_id),
    translation: text(r.translation), translationLang: text(r.translation_lang),
    durationSec: Number(r.duration_sec), createdBy: text(r.created_by), createdByName: text(r.created_by_name),
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
});

async function body(ctx: Ctx): Promise<Record<string, unknown>> {
    try {
        const b = await ctx.request.json();
        return b && typeof b === 'object' ? b as Record<string, unknown> : {};
    } catch { return {}; }
}

const getRow = (ctx: Ctx, id: string) =>
    ctx.env.VAYU_DB.prepare('SELECT * FROM meetings WHERE id = ?').bind(id).first<Record<string, unknown>>();

const meetingOr404 = async (ctx: Ctx, id: string): Promise<Record<string, unknown> | Response> =>
    (await getRow(ctx, id)) ?? err('That meeting was not found.', 404);

const reply = async (ctx: Ctx, id: string, extra: Record<string, unknown> = {}) =>
    json({ ...toMeeting(ctx.env, (await getRow(ctx, id))!), ...extra });

/** The parts' text, in order: the transcript while a recording comes in. */
const joinParts = (parts: StoredPart[]) => parts.map(p => p.text.trim()).filter(Boolean).join('\n');

// ── AI settings ─────────────────────────────────────────────────────────────

export interface AiTarget { url: string; key: string; model: string }
type Ai = { text: AiTarget | null; transcribe: AiTarget | null };

const noTrailingSlash = (url: string) => (url.endsWith('/') ? url.slice(0, -1) : url);

export function aiTargets(env: Env): Ai {
    const base = noTrailingSlash(env.MEETING_AI_URL ?? '');
    const key = env.MEETING_AI_KEY ?? '';
    const tBase = noTrailingSlash(env.MEETING_TRANSCRIBE_URL ?? '') || base;
    const tKey = env.MEETING_TRANSCRIBE_KEY || key;
    return {
        text: base && key && env.MEETING_TEXT_MODEL ? { url: base, key, model: env.MEETING_TEXT_MODEL } : null,
        transcribe: tBase && tKey && env.MEETING_TRANSCRIBE_MODEL ? { url: tBase, key: tKey, model: env.MEETING_TRANSCRIBE_MODEL } : null,
    };
}

const AI_TIMEOUT_MS = 5 * 60_000;
const notSetUp = () => err('AI for meetings is not set up yet. Ask the platform team to add the key.', 503);

async function aiFailed(res: Response, what: string): Promise<Response> {
    // Logged for us; the person sees a plain message, never the provider's reply (it can echo the key's account).
    console.error(`Meeting ${what} failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 500)}`);
    return err(`The AI service couldn't ${what} this right now (${res.status}). Try again in a minute.`, 502);
}

async function chat(t: AiTarget, messages: { role: string; content: string }[]): Promise<string | Response> {
    const res = await fetch(`${t.url}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${t.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: t.model, messages, temperature: 0.2 }),
        signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
    if (!res.ok) return aiFailed(res, 'write');
    const data = await res.json<{ choices?: { message?: { content?: string } }[] }>().catch(() => null);
    const out = data?.choices?.[0]?.message?.content?.trim();
    return out || err('The AI service sent back nothing. Try again.', 502);
}

const AUDIO_EXT: Record<string, string> = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };

/** One stored part as text, or why not. */
async function transcribePart(env: Env, t: AiTarget, part: StoredPart): Promise<string | Response> {
    const obj = await env.VAYU_R2.get(part.key);
    if (!obj) return err('The recording is missing.', 404);
    if (obj.size > MAX_AUDIO_BYTES) return err('This part of the recording is over 25 MB, too big to transcribe.', 413);
    const type = (part.type || 'audio/webm').split(';')[0];
    const form = new FormData();
    form.append('file', new File([await obj.arrayBuffer()], `meeting.${AUDIO_EXT[type] ?? 'webm'}`, { type }));
    form.append('model', t.model);
    form.append('prompt', TRANSCRIBE_HINT);
    const res = await fetch(`${t.url}/audio/transcriptions`, {
        method: 'POST', headers: { Authorization: `Bearer ${t.key}` }, body: form, signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
    if (!res.ok) return aiFailed(res, 'transcribe');
    return (await res.json<{ text?: string }>().catch(() => null))?.text?.trim() ?? '';
}

async function saveParts(ctx: Ctx, id: string, parts: StoredPart[], extra = ''): Promise<void> {
    const sec = parts.reduce((s, p) => s + p.sec, 0);
    await ctx.env.VAYU_DB.prepare(`UPDATE meetings SET parts = ?, transcript = ?, duration_sec = ?, updated_at = ?${extra} WHERE id = ?`)
        .bind(JSON.stringify(parts), joinParts(parts), sec, Date.now(), id).run();
}

// ── Handlers ────────────────────────────────────────────────────────────────

// shortcut: the list carries every meeting's full text (up to 500); send previews only if it gets slow.
const list: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const { results } = await ctx.env.VAYU_DB.prepare('SELECT * FROM meetings ORDER BY held_at DESC LIMIT ?').bind(MAX_MEETINGS).all();
    const ai = aiTargets(ctx.env);
    return json({ meetings: results.map(r => toMeeting(ctx.env, r as Record<string, unknown>)), ai: { text: !!ai.text, transcribe: !!ai.transcribe } });
};

/** POST /meetings — typed text, or { recording: true } to start one whose audio arrives in parts. */
const create: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const raw = await body(ctx);
    const m = parseMeeting(raw);
    if ('problem' in m) return err(m.problem);
    const recording = raw.recording === true;
    if (!recording && !m.transcript.trim()) return err('Record the meeting or type what was said.');
    const db = ctx.env.VAYU_DB;
    const count = await db.prepare('SELECT COUNT(*) AS n FROM meetings').first<{ n: number }>();
    if (Number(count?.n ?? 0) >= MAX_MEETINGS) return err(`The workspace can keep up to ${MAX_MEETINGS} meetings. Delete some old ones first.`, 409);
    const now = Date.now();
    const id = `mtg_${now}_${crypto.randomUUID().slice(0, 8)}`;
    await db.prepare(`INSERT INTO meetings (id, type, title, held_at, transcript, summary, status, attendees, created_by, created_by_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, m.type, m.title, m.heldAt, recording ? '' : m.transcript, m.summary, recording ? 'recording' : 'ready',
            JSON.stringify(m.attendees), session.userId, session.name, now, now).run();
    return json(toMeeting(ctx.env, (await getRow(ctx, id))!), 201);
};

const update: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const id = ID_PATH.exec(ctx.path)![1];
    const m = parseMeeting(await body(ctx));
    if ('problem' in m) return err(m.problem);
    const res = await ctx.env.VAYU_DB.prepare(`UPDATE meetings SET type = ?, title = ?, held_at = ?, transcript = ?, summary = ?, attendees = ?,
        action_items = ?, tasks_event_id = ?, updated_at = ? WHERE id = ?`)
        .bind(m.type, m.title, m.heldAt, m.transcript, m.summary, JSON.stringify(m.attendees), JSON.stringify(m.actionItems), m.tasksEventId, Date.now(), id).run();
    if (!res.meta.changes) return err('That meeting was not found.', 404);
    return reply(ctx, id);
};

const remove: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const id = ID_PATH.exec(ctx.path)![1];
    const row = await ctx.env.VAYU_DB.prepare('DELETE FROM meetings WHERE id = ? RETURNING *').bind(id).first<Record<string, unknown>>();
    if (!row) return err('That meeting was not found.', 404);
    const keys = storedParts(row).map(p => p.key);
    if (keys.length) await ctx.env.VAYU_R2.delete(keys);
    return json({ ok: true });
};

/**
 * POST /meetings/:id/parts { audioKey, durationSec, index } — the next few
 * minutes of a recording. Saved first, so nothing is lost; then, when AI is
 * set up, transcribed at once (live text). Sending a part again is harmless.
 */
const addPart: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const id = PARTS_PATH.exec(ctx.path)![1];
    const row = await meetingOr404(ctx, id);
    if (row instanceof Response) return row;
    const raw = await body(ctx);
    const key = typeof raw.audioKey === 'string' ? raw.audioKey : '';
    // The audio must be the caller's own upload: a key is not permission to someone else's file.
    if (!key.startsWith(`uploads/${session.userId}/`) || key.includes('..')) return err('That recording was not found.', 400);
    const parts = storedParts(row);
    const index = Number(raw.index);
    if (parts[index]?.key === key) return reply(ctx, id); // a retry of a part already saved
    if (index !== parts.length) return err('A part of the recording is missing. Keep the app open while it catches up.', 409);
    if (parts.length >= MAX_PARTS) return err('This recording is as long as a meeting can be.', 409);
    const head = await ctx.env.VAYU_R2.head(key);
    if (!head) return err('That recording was not found.', 400);
    const sec = typeof raw.durationSec === 'number' && raw.durationSec > 0 ? Math.min(Math.round(raw.durationSec), 3600) : 0;
    parts.push({ key, type: head.httpMetadata?.contentType ?? '', sec, text: '' });
    await saveParts(ctx, id, parts);

    const t = aiTargets(ctx.env).transcribe;
    if (!t) return reply(ctx, id);
    const heard = await transcribePart(ctx.env, t, parts[index]);
    if (heard instanceof Response) return reply(ctx, id, { transcribeError: (await heard.json<{ error?: string }>()).error });
    parts[index].text = heard;
    await saveParts(ctx, id, parts);
    return reply(ctx, id);
};

/** POST /meetings/:id/parts/:i/transcribe — one part again (or for the first time). */
const retranscribe: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const [, id, i] = PART_PATH.exec(ctx.path)!;
    const row = await meetingOr404(ctx, id);
    if (row instanceof Response) return row;
    const t = aiTargets(ctx.env).transcribe;
    if (!t) return notSetUp();
    const parts = storedParts(row);
    const part = parts[Number(i)];
    if (!part) return err('That part of the recording was not found.', 404);
    const heard = await transcribePart(ctx.env, t, part);
    if (heard instanceof Response) return heard;
    part.text = heard;
    await saveParts(ctx, id, parts);
    return reply(ctx, id);
};

/** POST /meetings/:id/finish — the recording has ended. */
const finish: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const id = FINISH_PATH.exec(ctx.path)![1];
    const res = await ctx.env.VAYU_DB.prepare("UPDATE meetings SET status = 'ready', updated_at = ? WHERE id = ?").bind(Date.now(), id).run();
    if (!res.meta.changes) return err('That meeting was not found.', 404);
    return reply(ctx, id);
};

// ── AI steps on a whole meeting ─────────────────────────────────────────────

type AiStep = (ctx: Ctx, meeting: Meeting, t: AiTarget) => Promise<Response>;

const summarize: AiStep = async (ctx, m, t) => {
    if (!m.transcript.trim()) return err('There is no text to summarize yet.');
    const [summary, items] = await Promise.all([
        chat(t, summaryMessages(m.type, m.title, m.transcript, m.attendees)),
        chat(t, actionItemsMessages(m.title, m.heldAt, m.transcript, m.attendees)),
    ]);
    if (summary instanceof Response) return summary;
    // The summary still counts when the list fails: it lists action items too.
    const actionItems = items instanceof Response ? m.actionItems : parseActionItems(items);
    await ctx.env.VAYU_DB.prepare("UPDATE meetings SET summary = ?, action_items = ?, tasks_event_id = '', updated_at = ? WHERE id = ?")
        .bind(summary, JSON.stringify(actionItems), Date.now(), m.id).run();
    return reply(ctx, m.id);
};

const translate: AiStep = async (ctx, m, t) => {
    const b = await body(ctx);
    const lang = LANGUAGES.find(l => l === b.lang);
    if (!lang) return err('Pick a language.');
    const fromTranscript = b.source === 'transcript';
    const source = fromTranscript ? m.transcript : m.summary;
    if (!source.trim()) return err(fromTranscript ? 'There is no transcript yet.' : 'Summarize the meeting first.');
    const translation = await chat(t, translateMessages(lang, source));
    if (translation instanceof Response) return translation;
    await ctx.env.VAYU_DB.prepare('UPDATE meetings SET translation = ?, translation_lang = ?, updated_at = ? WHERE id = ?').bind(translation, lang, Date.now(), m.id).run();
    return reply(ctx, m.id);
};

/**
 * Who said what, one piece of the transcript per request ({ chunk, known }),
 * so a long meeting never needs one huge reply. Nothing is saved: the app
 * puts the pieces together and saves the transcript at the end.
 */
const speakers: AiStep = async (ctx, m, t) => {
    const b = await body(ctx);
    const chunks = chunkText(m.transcript, SPEAKER_CHUNK);
    const index = Number(b.chunk);
    if (!Number.isInteger(index) || index < 0 || index >= chunks.length) return err('There is no text to mark speakers in.');
    const known = Array.isArray(b.known) ? b.known.filter((k): k is string => typeof k === 'string').map(k => k.slice(0, 40)).slice(0, 20) : [];
    const labelled = await chat(t, speakerMessages(chunks[index], m.attendees, known));
    if (labelled instanceof Response) return labelled;
    return json({ text: labelled, index, total: chunks.length });
};

const CONTEXT_PER_MEETING = 8_000;
const when = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const record = (m: Pick<Meeting, 'title' | 'heldAt' | 'summary' | 'transcript'>, room: number) =>
    `Meeting: ${m.title} (${when(m.heldAt)})\nSummary:\n${m.summary || '(none yet)'}\nTranscript:\n${m.transcript.slice(0, room)}`;

function parseHistory(raw: unknown): { q: string; a: string }[] {
    if (!Array.isArray(raw)) return [];
    return raw.slice(-6).flatMap(h => {
        const r = (h && typeof h === 'object' ? h : {}) as Record<string, unknown>;
        return typeof r.q === 'string' && typeof r.a === 'string' ? [{ q: r.q.slice(0, 2000), a: r.a.slice(0, 4000) }] : [];
    });
}

async function answer(t: AiTarget, raw: Record<string, unknown>, context: string): Promise<string | Response> {
    const question = typeof raw.question === 'string' ? raw.question.trim().slice(0, 1000) : '';
    if (!question) return err('Type a question.');
    return chat(t, askMessages(question, context, parseHistory(raw.history)));
}

/** POST /meetings/:id/ask { question, history } — about this meeting. */
const askOne: AiStep = async (ctx, m, t) => {
    const out = await answer(t, await body(ctx), record(m, 300_000));
    return out instanceof Response ? out : json({ answer: out });
};

const AI_STEPS: Record<string, AiStep> = { summarize, translate, speakers, ask: askOne };

/** POST /meetings/:id/(summarize|translate|speakers|ask). */
const runAi: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const [, id, action] = AI_PATH.exec(ctx.path)!;
    const row = await meetingOr404(ctx, id);
    if (row instanceof Response) return row;
    const t = aiTargets(ctx.env).text;
    if (!t) return notSetUp();
    return AI_STEPS[action](ctx, toMeeting(ctx.env, row), t);
};

/** POST /meetings/ask { question, history } — across every meeting: the most relevant few are read. */
const askAll: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const t = aiTargets(ctx.env).text;
    if (!t) return notSetUp();
    const raw = await body(ctx);
    const { results } = await ctx.env.VAYU_DB.prepare('SELECT id, title, held_at, summary, transcript FROM meetings ORDER BY held_at DESC LIMIT ?').bind(MAX_MEETINGS).all();
    const all = results.map(r => ({ id: text(r.id), title: text(r.title), heldAt: Number(r.held_at), summary: text(r.summary), transcript: text(r.transcript) }));
    let picked = pickRelevant(all, typeof raw.question === 'string' ? raw.question : '', 6);
    if (!picked.length) picked = all.slice(0, 6); // nothing matched by word: the latest meetings
    if (!picked.length) return err('There are no meetings yet.');
    const out = await answer(t, raw, picked.map(m => record(m, CONTEXT_PER_MEETING)).join('\n\n---\n\n'));
    return out instanceof Response ? out : json({ answer: out, sources: picked.map(m => ({ id: m.id, title: m.title, heldAt: m.heldAt })) });
};

export const meetingRoutes: MeetingRoute[] = [
    { method: 'GET', match: p => p === '/meetings', handler: list },
    { method: 'POST', match: p => p === '/meetings', handler: create },
    { method: 'POST', match: p => p === '/meetings/ask', handler: askAll },
    { method: 'PUT', match: p => ID_PATH.test(p), handler: update },
    { method: 'DELETE', match: p => ID_PATH.test(p), handler: remove },
    { method: 'POST', match: p => PARTS_PATH.test(p), handler: addPart },
    { method: 'POST', match: p => PART_PATH.test(p), handler: retranscribe },
    { method: 'POST', match: p => FINISH_PATH.test(p), handler: finish },
    { method: 'POST', match: p => AI_PATH.test(p), handler: runAi },
];
