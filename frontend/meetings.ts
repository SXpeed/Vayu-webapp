// Meetings: recordings or typed text, with AI transcription, a summary shaped
// by the meeting type, and translation. Shared with the whole workspace;
// the "meetings" role section decides who sees (view) and who adds, changes
// and runs AI (edit), and the plan's "meetings" module switches it on per org.
//
// AI: any OpenAI-compatible service, chosen later through settings
// (docs/MEETINGS.md). Nothing is chosen in code.
//
// Storage: one table in the workspace's own database, created on first use;
// audio lives in R2 under the uploader's uploads/ folder.

import { err, json, runSetupOnce, text } from './rows';
import {
    LANGUAGES, MAX_AUDIO_BYTES, MAX_MEETINGS, TRANSCRIBE_HINT, parseMeeting, summaryMessages, translateMessages,
    type Meeting, type MeetingType,
} from './meetingRules';
import { fileUrl, type Ctx, type Env, type SessionData } from './workerEnv';
import { getSession } from './workerRoles';

const ID = String.raw`([\w-]{1,64})`;
const ID_PATH = new RegExp(`^/meetings/${ID}$`);
const AI_PATH = new RegExp(`^/meetings/${ID}/(transcribe|summarize|translate)$`);

type Handler = (ctx: Ctx) => Promise<Response>;
export interface MeetingRoute { method: string; match: (path: string) => boolean; handler: Handler }

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
    });
}

async function caller(ctx: Ctx): Promise<SessionData | Response> {
    const session = await getSession(ctx.request, ctx.env.VAYU_KV);
    if (!session) return err('Unauthorized', 401);
    await ensureTable(ctx.env.VAYU_DB);
    return session;
}

const toMeeting = (env: Env, r: Record<string, unknown>): Meeting => ({
    id: text(r.id), type: text(r.type) as MeetingType, title: text(r.title), heldAt: Number(r.held_at),
    transcript: text(r.transcript), summary: text(r.summary), translation: text(r.translation), translationLang: text(r.translation_lang),
    audioKey: text(r.audio_key), audioUrl: r.audio_key ? fileUrl(env, text(r.audio_key)) : '', audioType: text(r.audio_type),
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

// ── AI settings ─────────────────────────────────────────────────────────────

interface AiTarget { url: string; key: string; model: string }

const noTrailingSlash = (url: string) => (url.endsWith('/') ? url.slice(0, -1) : url);

function aiTargets(env: Env): { text: AiTarget | null; transcribe: AiTarget | null } {
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
const notSetUp = () => err('AI for meetings is not set up yet. Ask the platform team to choose a model.', 503);

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

// ── Handlers ────────────────────────────────────────────────────────────────

// shortcut: the list carries every meeting's full text (up to 500); send previews only if it gets slow.
const list: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const { results } = await ctx.env.VAYU_DB.prepare('SELECT * FROM meetings ORDER BY held_at DESC LIMIT ?').bind(MAX_MEETINGS).all();
    const ai = aiTargets(ctx.env);
    return json({ meetings: results.map(r => toMeeting(ctx.env, r as Record<string, unknown>)), ai: { text: !!ai.text, transcribe: !!ai.transcribe } });
};

const create: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const raw = await body(ctx);
    const m = parseMeeting(raw);
    if ('problem' in m) return err(m.problem);
    // The audio must be the caller's own upload: a key is not permission to someone else's file.
    const audioKey = typeof raw.audioKey === 'string' ? raw.audioKey : '';
    let audioType = '';
    if (audioKey) {
        if (!audioKey.startsWith(`uploads/${session.userId}/`) || audioKey.includes('..')) return err('That recording was not found.', 400);
        const head = await ctx.env.VAYU_R2.head(audioKey);
        if (!head) return err('That recording was not found.', 400);
        audioType = head.httpMetadata?.contentType ?? '';
    }
    if (!audioKey && !m.transcript.trim()) return err('Record the meeting or type what was said.');
    const db = ctx.env.VAYU_DB;
    const count = await db.prepare('SELECT COUNT(*) AS n FROM meetings').first<{ n: number }>();
    if (Number(count?.n ?? 0) >= MAX_MEETINGS) return err(`The workspace can keep up to ${MAX_MEETINGS} meetings. Delete some old ones first.`, 409);
    const durationSec = typeof raw.durationSec === 'number' && raw.durationSec > 0 ? Math.min(Math.floor(raw.durationSec), 24 * 3600) : 0;
    const now = Date.now();
    const id = `mtg_${now}_${crypto.randomUUID().slice(0, 8)}`;
    await db.prepare(`INSERT INTO meetings (id, type, title, held_at, transcript, summary, audio_key, audio_type, duration_sec, created_by, created_by_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, m.type, m.title, m.heldAt, m.transcript, m.summary, audioKey, audioType, durationSec, session.userId, session.name, now, now).run();
    return json(toMeeting(ctx.env, (await getRow(ctx, id))!), 201);
};

const update: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const id = ID_PATH.exec(ctx.path)![1];
    const m = parseMeeting(await body(ctx));
    if ('problem' in m) return err(m.problem);
    const res = await ctx.env.VAYU_DB.prepare('UPDATE meetings SET type = ?, title = ?, held_at = ?, transcript = ?, summary = ?, updated_at = ? WHERE id = ?')
        .bind(m.type, m.title, m.heldAt, m.transcript, m.summary, Date.now(), id).run();
    if (!res.meta.changes) return err('That meeting was not found.', 404);
    return json(toMeeting(ctx.env, (await getRow(ctx, id))!));
};

const remove: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const id = ID_PATH.exec(ctx.path)![1];
    const row = await ctx.env.VAYU_DB.prepare('DELETE FROM meetings WHERE id = ? RETURNING audio_key').bind(id).first<{ audio_key: string }>();
    if (!row) return err('That meeting was not found.', 404);
    if (row.audio_key) await ctx.env.VAYU_R2.delete(row.audio_key);
    return json({ ok: true });
};

type AiStep = (ctx: Ctx, meeting: Meeting, ai: ReturnType<typeof aiTargets>) => Promise<Response | null>;

const transcribe: AiStep = async (ctx, meeting, ai) => {
    if (!ai.transcribe) return notSetUp();
    if (!meeting.audioKey) return err('This meeting has no recording.');
    const obj = await ctx.env.VAYU_R2.get(meeting.audioKey);
    if (!obj) return err('The recording is missing.', 404);
    // shortcut: one file per request, so recordings over 25 MB (~100 min) are refused; split into parts if longer meetings are needed.
    if (obj.size > MAX_AUDIO_BYTES) return err('This recording is too long to transcribe in one go (over 25 MB).', 413);
    const type = (meeting.audioType || 'audio/webm').split(';')[0];
    const form = new FormData();
    form.append('file', new File([await obj.arrayBuffer()], `meeting.${AUDIO_EXT[type] ?? 'webm'}`, { type }));
    form.append('model', ai.transcribe.model);
    form.append('prompt', TRANSCRIBE_HINT);
    const res = await fetch(`${ai.transcribe.url}/audio/transcriptions`, {
        method: 'POST', headers: { Authorization: `Bearer ${ai.transcribe.key}` }, body: form, signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
    if (!res.ok) return aiFailed(res, 'transcribe');
    const transcript = (await res.json<{ text?: string }>().catch(() => null))?.text?.trim();
    if (!transcript) return err('No speech was heard in this recording.', 422);
    await ctx.env.VAYU_DB.prepare('UPDATE meetings SET transcript = ?, updated_at = ? WHERE id = ?').bind(transcript, Date.now(), meeting.id).run();
    return null;
};

const summarize: AiStep = async (ctx, meeting, ai) => {
    if (!ai.text) return notSetUp();
    if (!meeting.transcript.trim()) return err('There is no text to summarize yet.');
    const summary = await chat(ai.text, summaryMessages(meeting.type, meeting.title, meeting.transcript));
    if (summary instanceof Response) return summary;
    await ctx.env.VAYU_DB.prepare('UPDATE meetings SET summary = ?, updated_at = ? WHERE id = ?').bind(summary, Date.now(), meeting.id).run();
    return null;
};

const translate: AiStep = async (ctx, meeting, ai) => {
    if (!ai.text) return notSetUp();
    const b = await body(ctx);
    const lang = LANGUAGES.find(l => l === b.lang);
    if (!lang) return err('Pick a language.');
    const fromTranscript = b.source === 'transcript';
    const source = fromTranscript ? meeting.transcript : meeting.summary;
    if (!source.trim()) return err(fromTranscript ? 'There is no transcript yet.' : 'Summarize the meeting first.');
    const translation = await chat(ai.text, translateMessages(lang, source));
    if (translation instanceof Response) return translation;
    await ctx.env.VAYU_DB.prepare('UPDATE meetings SET translation = ?, translation_lang = ?, updated_at = ? WHERE id = ?').bind(translation, lang, Date.now(), meeting.id).run();
    return null;
};

const AI_STEPS: Record<string, AiStep> = { transcribe, summarize, translate };

/** POST /meetings/:id/(transcribe|summarize|translate) — runs one AI step and returns the updated meeting. */
const runAi: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const [, id, action] = AI_PATH.exec(ctx.path)!;
    const row = await getRow(ctx, id);
    if (!row) return err('That meeting was not found.', 404);
    const refused = await AI_STEPS[action](ctx, toMeeting(ctx.env, row), aiTargets(ctx.env));
    return refused ?? json(toMeeting(ctx.env, (await getRow(ctx, id))!));
};

export const meetingRoutes: MeetingRoute[] = [
    { method: 'GET', match: p => p === '/meetings', handler: list },
    { method: 'POST', match: p => p === '/meetings', handler: create },
    { method: 'PUT', match: p => ID_PATH.test(p), handler: update },
    { method: 'DELETE', match: p => ID_PATH.test(p), handler: remove },
    { method: 'POST', match: p => AI_PATH.test(p), handler: runAi },
];
