// Meetings: record or type a meeting, then AI transcription, a summary shaped
// by the meeting type, and translation (meetings.ts). Read needs the
// "meetings" role section at view; recording and AI need edit.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Copy, Keyboard, Languages, Loader2, Mic, Pause, Pencil, Play, Plus, Sparkles, Square, Trash2, Users } from 'lucide-react';
import { useBackClose } from '../hooks/useBackClose';
import { PageRoot, PageHeader, PageBody, PrimaryIconButton, Button, Field, Input, Textarea, Select, Pill, EmptyState } from '../components/ui';
import {
    LANGUAGES, MAX_RECORD_MINUTES, MAX_SUMMARY, MAX_TITLE, MAX_TRANSCRIPT, MEETING_TYPES, parseMeeting, typeLabel,
    type Meeting, type MeetingType,
} from '../meetingRules';
import { meetingService, type MeetingList } from '../services/meetingService';

const when = (ms: number) => new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const toDateInput = (ms: number) => { const d = new Date(ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const fromDateInput = (s: string) => (s ? new Date(`${s}T12:00:00`).getTime() : Date.now());
const message = (e: unknown, fallback: string) => (e as Error)?.message || fallback;
const Spinner = () => <div className="py-16 flex justify-center text-[var(--neu-text-dim)]"><Loader2 size={22} className="animate-spin" /></div>;
const Problem: React.FC<{ text: string }> = ({ text }) => (text ? <p role="alert" className="text-[13px] text-red-600 dark:text-red-400">{text}</p> : null);

type Ai = MeetingList['ai'];

export const MeetingsView: React.FC<{ canEdit: boolean }> = ({ canEdit }) => {
    const [data, setData] = useState<MeetingList | null>(null);
    const [failed, setFailed] = useState(false);
    const [open, setOpen] = useState<{ meeting: Meeting; autoRun: boolean } | 'new' | null>(null);

    const load = useCallback(async () => {
        setFailed(false);
        try { setData(await meetingService.list()); } catch { setFailed(true); }
    }, []);
    useEffect(() => { void load(); }, [load]);

    const ai = data?.ai ?? { text: false, transcribe: false };
    if (open === 'new') return <NewMeeting ai={ai} onCancel={() => setOpen(null)} onSaved={m => { setOpen({ meeting: m, autoRun: true }); void load(); }} />;
    if (open) return <MeetingDetail key={open.meeting.id} initial={open.meeting} autoRun={open.autoRun} ai={ai} canEdit={canEdit} onDone={() => { setOpen(null); void load(); }} />;

    let body: React.ReactNode = <Spinner />;
    if (failed) {
        body = <EmptyState icon={<Users size={22} strokeWidth={1.5} />} title="Meetings didn’t load" message="Check your connection and try again." action={<Button onClick={() => { void load(); }}>Try again</Button>} />;
    } else if (data?.meetings.length === 0) {
        body = <EmptyState icon={<Mic size={22} strokeWidth={1.5} />} title="No meetings yet" message="Record a meeting or type notes, and get a summary you can translate."
            action={canEdit ? <Button variant="primary" icon={<Plus size={15} />} onClick={() => setOpen('new')}>New meeting</Button> : undefined} />;
    } else if (data) {
        body = (
            <ul className="neu-card px-2 py-1">
                {data.meetings.map(m => (
                    <li key={m.id} className="task-row">
                        <button type="button" onClick={() => setOpen({ meeting: m, autoRun: false })} className="w-full flex items-center gap-3 px-2 py-3 text-left rounded-xl active-scale">
                            <span className="flex-1 min-w-0">
                                <span className="block font-serif text-[15px] text-gray-900 dark:text-white truncate">{m.title}</span>
                                <span className="block mt-0.5 text-[11.5px] text-[var(--neu-text-dim)] truncate">
                                    {typeLabel(m.type)} · {when(m.heldAt)}{m.durationSec ? ` · ${clock(m.durationSec)}` : ''} · {m.createdByName}
                                </span>
                            </span>
                            {m.audioKey ? <Mic size={14} className="shrink-0 text-[var(--neu-text-dim)]" aria-label="Recorded" /> : <Keyboard size={14} className="shrink-0 text-[var(--neu-text-dim)]" aria-label="Typed" />}
                            {m.summary && <Sparkles size={14} className="shrink-0 text-gold-700 dark:text-gold-400" aria-label="Summarized" />}
                        </button>
                    </li>
                ))}
            </ul>
        );
    }

    return (
        <PageRoot>
            <PageHeader title="Meetings" subtitle="Record, summarize, translate"
                actions={canEdit ? <PrimaryIconButton onClick={() => setOpen('new')} label="New meeting" icon={<Plus size={16} />} /> : undefined} />
            <PageBody>{body}</PageBody>
        </PageRoot>
    );
};

// ── New meeting: type, then record or type ──────────────────────────────────

function pickMime(): string {
    for (const t of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus']) {
        if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
}

const NewMeeting: React.FC<{ ai: Ai; onCancel: () => void; onSaved: (m: Meeting) => void }> = ({ ai, onCancel, onSaved }) => {
    const [type, setType] = useState<MeetingType>('notes');
    const [title, setTitle] = useState('');
    const [date, setDate] = useState(toDateInput(Date.now()));
    const [mode, setMode] = useState<'record' | 'type'>('record');
    const [text, setText] = useState('');
    const [rec, setRec] = useState<'idle' | 'recording' | 'paused' | 'done'>('idle');
    const [seconds, setSeconds] = useState(0);
    const [audio, setAudio] = useState<{ blob: Blob; url: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState('');
    const [leaving, setLeaving] = useState(false);
    const recorder = useRef<MediaRecorder | null>(null);
    const chunks = useRef<Blob[]>([]);
    const wakeLock = useRef<{ release: () => Promise<void> } | null>(null);

    // Tick while recording; stop at the limit so the file stays transcribable.
    useEffect(() => {
        if (rec !== 'recording') return;
        const t = setInterval(() => setSeconds(s => {
            if (s + 1 >= MAX_RECORD_MINUTES * 60) { recorder.current?.stop(); toast(`Stopped at ${MAX_RECORD_MINUTES} minutes`); }
            return s + 1;
        }), 1000);
        return () => clearInterval(t);
    }, [rec]);
    useEffect(() => () => { recorder.current?.stream.getTracks().forEach(t => t.stop()); void wakeLock.current?.release().catch(() => {}); }, []);
    useEffect(() => () => { if (audio) URL.revokeObjectURL(audio.url); }, [audio]);

    const start = async () => {
        setProblem('');
        if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setProblem('This browser can’t record. Type the meeting instead.'); return; }
        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        } catch (e) {
            setProblem((e as Error).name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in the browser settings and try again.' : 'No microphone was found.');
            return;
        }
        const mimeType = pickMime();
        // 32 kbps speech keeps ~100 minutes under the 25 MB transcription limit.
        const r = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32_000 });
        chunks.current = [];
        r.ondataavailable = e => { if (e.data.size) chunks.current.push(e.data); };
        r.onstop = () => {
            stream.getTracks().forEach(t => t.stop());
            void wakeLock.current?.release().catch(() => {});
            const blob = new Blob(chunks.current, { type: r.mimeType || mimeType || 'audio/webm' });
            setAudio({ blob, url: URL.createObjectURL(blob) });
            setRec('done');
        };
        r.start(1000);
        recorder.current = r;
        setSeconds(0);
        setRec('recording');
        // Keep the screen on: phones stop the microphone when they lock.
        try { wakeLock.current = await (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request('screen') ?? null; } catch { /* not supported */ }
    };
    const pause = () => { recorder.current?.pause(); setRec('paused'); };
    const resume = () => { recorder.current?.resume(); setRec('recording'); };
    const stop = () => recorder.current?.stop();
    const discard = () => { setAudio(null); setRec('idle'); setSeconds(0); };

    const hasWork = rec !== 'idle' || !!text.trim();
    const back = () => {
        if (busy) return;
        if (!hasWork || leaving) { recorder.current?.stop(); onCancel(); return; }
        setLeaving(true);
        setProblem('Not saved yet. Save it, or go back again to throw it away.');
    };
    useBackClose(true, back);

    const save = async () => {
        if (rec === 'recording' || rec === 'paused') { setProblem('Stop the recording first.'); return; }
        const input = parseMeeting({ type, title, heldAt: fromDateInput(date), transcript: mode === 'type' ? text : '' });
        if ('problem' in input) { setProblem(input.problem); return; }
        if (mode === 'record' && !audio) { setProblem('Record the meeting first.'); return; }
        if (mode === 'type' && !text.trim()) { setProblem('Type what was said first.'); return; }
        setBusy(true);
        try {
            const m = await meetingService.create(input, mode === 'record' && audio ? { blob: audio.blob, durationSec: seconds } : undefined);
            toast.success('Meeting saved');
            onSaved(m);
        } catch (e) {
            setProblem(message(e, 'Could not save. Please try again.'));
            setBusy(false);
        }
    };

    const willAi = mode === 'record' ? ai.transcribe && ai.text : ai.text;

    return (
        <PageRoot>
            <PageHeader title="New meeting" subtitle="Record or type" onBack={back} />
            <PageBody>
                <form className="neu-card p-4 lg:p-5 space-y-4 text-[var(--neu-text)]" onChange={() => { setProblem(''); setLeaving(false); }} onSubmit={e => { e.preventDefault(); void save(); }}>
                    <fieldset>
                        <legend className="mb-2 text-[13px] font-medium">Meeting type</legend>
                        <div className="grid grid-cols-2 gap-2">
                            {MEETING_TYPES.map(t => (
                                <Pill key={t.id} active={type === t.id} onClick={() => setType(t.id)} className="!h-auto !py-2 flex-col !items-start text-left">
                                    <span className="font-medium">{t.label}</span>
                                    <span className="text-[11px] opacity-75">{t.hint}</span>
                                </Pill>
                            ))}
                        </div>
                    </fieldset>
                    <Field label="Title (optional)" htmlFor="mtg-title">
                        <Input id="mtg-title" maxLength={MAX_TITLE} autoComplete="off" placeholder={`${typeLabel(type)} meeting`} value={title} onChange={e => setTitle(e.target.value)} />
                    </Field>
                    <Field label="Date" htmlFor="mtg-date">
                        <Input id="mtg-date" type="date" value={date} onChange={e => setDate(e.target.value)} />
                    </Field>

                    <div className="flex gap-2" role="group" aria-label="How to add the meeting">
                        <Pill active={mode === 'record'} onClick={() => { if (rec === 'idle') setMode('record'); }}><Mic size={14} className="inline mr-1" />Record</Pill>
                        <Pill active={mode === 'type'} onClick={() => { if (rec === 'idle') setMode('type'); }}><Keyboard size={14} className="inline mr-1" />Type</Pill>
                    </div>

                    {mode === 'record' ? (
                        <div className="rounded-2xl neu-inset p-4 text-center space-y-3">
                            <p className="font-serif text-3xl tabular-nums" aria-live="polite">{clock(seconds)}</p>
                            {rec === 'recording' && <p className="text-[12px] text-red-600 dark:text-red-400">● Recording. Keep this screen open.</p>}
                            {rec === 'paused' && <p className="text-[12px] text-[var(--neu-text-dim)]">Paused</p>}
                            {rec === 'idle' && <Button type="button" variant="primary" block icon={<Mic size={15} />} onClick={() => { void start(); }}>Start recording</Button>}
                            {(rec === 'recording' || rec === 'paused') && (
                                <div className="flex gap-2">
                                    {rec === 'recording'
                                        ? <Button type="button" block icon={<Pause size={15} />} onClick={pause}>Pause</Button>
                                        : <Button type="button" block icon={<Play size={15} />} onClick={resume}>Resume</Button>}
                                    <Button type="button" variant="primary" block icon={<Square size={15} />} onClick={stop}>Stop</Button>
                                </div>
                            )}
                            {rec === 'done' && audio && (
                                <>
                                    <audio controls src={audio.url} className="w-full" />
                                    <Button type="button" onClick={discard}>Record again</Button>
                                </>
                            )}
                            <p className="text-[11.5px] text-[var(--neu-text-dim)]">Up to {MAX_RECORD_MINUTES} minutes.</p>
                        </div>
                    ) : (
                        <Field label="What was said" htmlFor="mtg-text" hint="Paste or type notes. The summary is written from this.">
                            <Textarea id="mtg-text" rows={12} maxLength={MAX_TRANSCRIPT} value={text} onChange={e => setText(e.target.value)} />
                        </Field>
                    )}

                    <p className="text-[12px] text-[var(--neu-text-dim)]">
                        {willAi ? 'After saving, the summary is written automatically.' : 'AI summaries aren’t set up yet. The meeting is saved, and you can summarize it once they are.'}
                    </p>
                    <Problem text={problem} />
                    <Button type="submit" variant="primary" block disabled={busy}>{busy ? 'Saving…' : 'Save meeting'}</Button>
                </form>
            </PageBody>
        </PageRoot>
    );
};

// ── One meeting: recording, summary, transcript, translation ───────────────

type Tab = 'summary' | 'transcript' | 'translation';

const MeetingDetail: React.FC<{ initial: Meeting; autoRun: boolean; ai: Ai; canEdit: boolean; onDone: () => void }> = ({ initial, autoRun, ai, canEdit, onDone }) => {
    const [m, setM] = useState(initial);
    const [tab, setTab] = useState<Tab>('summary');
    const [working, setWorking] = useState<'' | 'transcribe' | 'summarize' | 'translate' | 'save' | 'delete'>('');
    const [problem, setProblem] = useState('');
    const [lang, setLang] = useState<string>(initial.translationLang || 'Hindi');
    const [source, setSource] = useState<'summary' | 'transcript'>('summary');
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');
    const [audioSrc, setAudioSrc] = useState('');
    const [confirmDelete, setConfirmDelete] = useState(false);
    const ran = useRef(false);

    useBackClose(true, () => { if (!working) onDone(); });
    useEffect(() => () => { if (audioSrc) URL.revokeObjectURL(audioSrc); }, [audioSrc]);

    const run = useCallback(async (action: 'transcribe' | 'summarize' | 'translate', current: Meeting, extra?: Record<string, unknown>): Promise<Meeting | null> => {
        setProblem('');
        setWorking(action);
        try {
            const next = await meetingService.ai(current.id, action, extra);
            setM(next);
            return next;
        } catch (e) {
            setProblem(message(e, 'That didn’t work. Please try again.'));
            return null;
        } finally {
            setWorking('');
        }
    }, []);

    // Right after saving: transcribe a recording, then summarize.
    useEffect(() => {
        if (!autoRun || ran.current || !canEdit) return;
        ran.current = true;
        void (async () => {
            let cur: Meeting | null = initial;
            if (cur.audioKey && !cur.transcript && ai.transcribe) cur = await run('transcribe', cur);
            if (cur?.transcript && !cur.summary && ai.text) await run('summarize', cur);
        })();
    }, [autoRun, canEdit, ai, initial, run]);

    const playRecording = async () => {
        setWorking('save');
        try { setAudioSrc(await meetingService.audioUrl(m)); } catch (e) { setProblem(message(e, 'The recording did not load.')); } finally { setWorking(''); }
    };

    const shown = tab === 'summary' ? m.summary : tab === 'transcript' ? m.transcript : m.translation;
    const startEdit = () => { setDraft(shown); setEditing(true); };
    const saveEdit = async () => {
        const input = parseMeeting({ ...m, [tab]: draft });
        if ('problem' in input) { setProblem(input.problem); return; }
        setWorking('save');
        try { setM(await meetingService.update(m.id, input)); setEditing(false); toast.success('Saved'); } catch (e) { setProblem(message(e, 'Could not save.')); } finally { setWorking(''); }
    };
    const copy = async () => {
        try { await navigator.clipboard.writeText(shown); toast.success('Copied'); } catch { toast.error('Copy didn’t work on this device'); }
    };
    const remove = async () => {
        if (!confirmDelete) { setConfirmDelete(true); return; }
        setWorking('delete');
        try { await meetingService.remove(m.id); toast.success('Meeting deleted'); onDone(); } catch (e) { setProblem(message(e, 'Could not delete.')); setWorking(''); }
    };

    const busyLabel: Record<string, string> = { transcribe: 'Turning the recording into text… long meetings take a minute or two.', summarize: 'Writing the summary…', translate: `Translating into ${lang}…` };
    const empty: Record<Tab, string> = {
        summary: m.transcript ? 'No summary yet.' : 'The summary is written from the transcript.',
        transcript: m.audioKey ? 'Not transcribed yet.' : 'No text.',
        translation: 'Translate the summary or transcript below.',
    };

    return (
        <PageRoot>
            <PageHeader title={m.title} subtitle={`${typeLabel(m.type)} · ${when(m.heldAt)} · ${m.createdByName}`} onBack={() => { if (!working) onDone(); }} />
            <PageBody>
                <div className="space-y-4 text-[var(--neu-text)]">
                    {m.audioKey && (
                        <div className="neu-card p-4">
                            {audioSrc
                                ? <audio controls autoPlay src={audioSrc} className="w-full" />
                                : <Button block icon={<Play size={15} />} disabled={!!working} onClick={() => { void playRecording(); }}>Play recording{m.durationSec ? ` (${clock(m.durationSec)})` : ''}</Button>}
                        </div>
                    )}

                    {working && busyLabel[working] && (
                        <div className="neu-card p-4 flex items-center gap-3 text-[13px]" role="status">
                            <Loader2 size={18} className="animate-spin shrink-0" />{busyLabel[working]}
                        </div>
                    )}
                    <Problem text={problem} />

                    <div className="neu-card p-4 space-y-3">
                        <div className="flex gap-2 flex-wrap" role="tablist">
                            {(['summary', 'transcript', 'translation'] as Tab[]).map(t => (
                                <Pill key={t} active={tab === t} onClick={() => { setTab(t); setEditing(false); }}>
                                    {t === 'summary' ? 'Summary' : t === 'transcript' ? 'Transcript' : `Translation${m.translationLang ? ` (${m.translationLang})` : ''}`}
                                </Pill>
                            ))}
                        </div>
                        {editing ? (
                            <>
                                <Textarea rows={16} value={draft} maxLength={tab === 'summary' ? MAX_SUMMARY : MAX_TRANSCRIPT} onChange={e => setDraft(e.target.value)} aria-label={`Edit ${tab}`} />
                                <div className="flex gap-2">
                                    <Button variant="primary" disabled={!!working} onClick={() => { void saveEdit(); }}>Save</Button>
                                    <Button onClick={() => setEditing(false)}>Cancel</Button>
                                </div>
                            </>
                        ) : shown ? (
                            <>
                                <div className="whitespace-pre-wrap break-words text-[14px] leading-relaxed">{shown}</div>
                                <div className="flex gap-2 flex-wrap">
                                    <Button icon={<Copy size={14} />} onClick={() => { void copy(); }}>Copy</Button>
                                    {canEdit && tab !== 'translation' && <Button icon={<Pencil size={14} />} onClick={startEdit}>Edit</Button>}
                                </div>
                            </>
                        ) : (
                            <p className="text-[13px] text-[var(--neu-text-dim)]">{empty[tab]}</p>
                        )}
                    </div>

                    {canEdit && (
                        <div className="neu-card p-4 space-y-3">
                            {!ai.text && <p className="text-[12.5px] text-[var(--neu-text-dim)]">AI isn’t set up yet, so transcription, summaries and translation are off. Everything else works.</p>}
                            {m.audioKey && (
                                <Button block icon={<Mic size={15} />} disabled={!!working || !ai.transcribe} onClick={() => { void run('transcribe', m); }}>
                                    {m.transcript ? 'Transcribe again' : 'Transcribe recording'}
                                </Button>
                            )}
                            <Button block variant={m.summary ? 'default' : 'primary'} icon={<Sparkles size={15} />} disabled={!!working || !ai.text || !m.transcript.trim()}
                                onClick={() => { void run('summarize', m).then(n => { if (n) setTab('summary'); }); }}>
                                {m.summary ? `Rewrite ${typeLabel(m.type).toLowerCase()} summary` : `Write ${typeLabel(m.type).toLowerCase()} summary`}
                            </Button>
                            <div className="flex gap-2 flex-wrap items-end">
                                <Field label="Translate" htmlFor="mtg-source" className="flex-1 min-w-[8rem]">
                                    <Select id="mtg-source" value={source} onChange={e => setSource(e.target.value as 'summary' | 'transcript')}>
                                        <option value="summary">Summary</option>
                                        <option value="transcript">Transcript</option>
                                    </Select>
                                </Field>
                                <Field label="Into" htmlFor="mtg-lang" className="flex-1 min-w-[8rem]">
                                    <Select id="mtg-lang" value={lang} onChange={e => setLang(e.target.value)}>
                                        {LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
                                    </Select>
                                </Field>
                                <Button icon={<Languages size={15} />} disabled={!!working || !ai.text || !(source === 'summary' ? m.summary : m.transcript).trim()}
                                    onClick={() => { void run('translate', m, { lang, source }).then(n => { if (n) setTab('translation'); }); }}>
                                    Translate
                                </Button>
                            </div>
                            <Button block variant="danger" icon={<Trash2 size={15} />} disabled={!!working} onClick={() => { void remove(); }}>
                                {confirmDelete ? 'Tap again to delete' : 'Delete meeting'}
                            </Button>
                        </div>
                    )}
                </div>
            </PageBody>
        </PageRoot>
    );
};
