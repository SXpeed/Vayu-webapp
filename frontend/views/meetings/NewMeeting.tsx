// A new meeting: its type and people, then recorded (saved and transcribed
// part by part as it goes), an uploaded recording, or typed notes.
import React, { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Keyboard, Loader2, Mic, Pause, Play, Square, Upload } from 'lucide-react';
import { useBackClose } from '../../hooks/useBackClose';
import { PageRoot, PageHeader, PageBody, Button, Field, Input, Textarea, Pill } from '../../components/ui';
import { MAX_RECORD_MINUTES, MAX_TITLE, MAX_TRANSCRIPT, MEETING_TYPES, PART_SECONDS, parseMeeting, typeLabel, type Attendee, type Meeting, type MeetingInput, type MeetingType } from '../../meetingRules';
import { meetingService, type MeetingList } from '../../services/meetingService';
import { AttendeePicker, type Member } from './AttendeePicker';
import { PartQueue } from './partQueue';
import { SegmentRecorder, splitAudioFile } from './recorder';

type Mode = 'record' | 'upload' | 'type';
type Phase = 'form' | 'recording' | 'paused' | 'saving';

export const clock = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const mm = String(Math.floor((sec % 3600) / 60)).padStart(h ? 2 : 1, '0');
    const hh = h ? h + ':' : '';
    return `${hh}${mm}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
};
const toDateInput = (ms: number) => { const d = new Date(ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const fromDateInput = (s: string) => (s ? new Date(`${s}T12:00:00`).getTime() : Date.now());
const MIC_BLOCKED = 'The microphone is blocked for this site. Tap the icon left of the web address → Permissions (or Site settings) → Microphone → Allow, then reload. In the installed app: phone Settings → Apps → this app → Permissions → Microphone.';

type WakeLock = { release: () => Promise<void> };
async function keepScreenOn(): Promise<WakeLock | null> {
    try {
        return await (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<WakeLock> } }).wakeLock?.request('screen') ?? null;
    } catch { return null; }
}

/** The browser's microphone permission, when it can say. */
function useMicPermission(): PermissionState | '' {
    const [mic, setMic] = useState<PermissionState | ''>('');
    useEffect(() => {
        let status: PermissionStatus | null = null;
        navigator.permissions?.query({ name: 'microphone' as PermissionName })
            .then(s => { status = s; setMic(s.state); s.onchange = () => setMic(s.state); })
            .catch(() => { /* Firefox and older Safari can't say */ });
        return () => { if (status) status.onchange = null; };
    }, []);
    return mic;
}

export const NewMeeting: React.FC<{ ai: MeetingList['ai']; team: Member[]; onCancel: () => void; onSaved: (m: Meeting) => void }> = ({ ai, team, onCancel, onSaved }) => {
    const [type, setType] = useState<MeetingType>('notes');
    const [title, setTitle] = useState('');
    const [date, setDate] = useState(toDateInput(Date.now()));
    const [attendees, setAttendees] = useState<Attendee[]>([]);
    const [mode, setMode] = useState<Mode>('record');
    const [text, setText] = useState('');
    const [phase, setPhase] = useState<Phase>('form');
    const [elapsed, setElapsed] = useState(0);
    const [live, setLive] = useState('');
    const [waiting, setWaiting] = useState(0);
    const [problem, setProblem] = useState('');
    const [leaving, setLeaving] = useState(false);
    const recorder = useRef<SegmentRecorder | null>(null);
    const queue = useRef<PartQueue | null>(null);
    const meetingId = useRef('');
    const wakeLock = useRef<WakeLock | null>(null);

    // Leaving mid-recording (another tab, say) still saves what was recorded.
    useEffect(() => () => {
        const r = recorder.current;
        const q = queue.current;
        if (!r || !q) return;
        void r.stop().then(() => q.drained()).then(() => meetingService.finish(meetingId.current)).catch(() => {});
        void wakeLock.current?.release().catch(() => {});
    }, []);

    const details = (): MeetingInput | null => {
        const input = parseMeeting({ type, title, heldAt: fromDateInput(date), attendees, transcript: mode === 'type' ? text : '' });
        if ('problem' in input) { setProblem(input.problem); return null; }
        return input;
    };

    /** The meeting on the server, with a queue taking its parts. */
    const begin = async (input: MeetingInput): Promise<PartQueue> => {
        const m = await meetingService.create(input, true);
        meetingId.current = m.id;
        const q = new PartQueue(m.id,
            next => { setLive(next.transcript); if (next.transcribeError) setProblem(`Live text paused: ${next.transcribeError}`); },
            (n, p) => { setWaiting(n); if (p) setProblem(p); });
        queue.current = q;
        return q;
    };

    const end = async () => {
        setPhase('saving');
        await queue.current!.drained();
        const m = await meetingService.finish(meetingId.current);
        recorder.current = null;
        queue.current = null;
        toast.success('Meeting saved');
        onSaved(m);
    };

    const start = async () => {
        setProblem('');
        const input = details();
        if (!input) return;
        if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setProblem('This browser can’t record. Upload a recording or type the meeting instead.'); return; }
        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        } catch (e) {
            setProblem((e as Error).name === 'NotAllowedError' ? MIC_BLOCKED : 'No microphone was found.');
            return;
        }
        try {
            const q = await begin(input);
            const r = new SegmentRecorder(stream, PART_SECONDS, part => q.add(part), sec => {
                setElapsed(sec);
                if (sec >= MAX_RECORD_MINUTES * 60) { toast(`Stopped at ${MAX_RECORD_MINUTES / 60} hours`); void stop(); }
            });
            recorder.current = r;
            r.start();
            setPhase('recording');
            wakeLock.current = await keepScreenOn(); // phones stop the microphone when they lock
        } catch (e) {
            stream.getTracks().forEach(t => t.stop());
            setProblem((e as Error).message || 'Could not start. Please try again.');
        }
    };
    const pause = () => { recorder.current?.pause(); setPhase('paused'); };
    const resume = () => { recorder.current?.resume(); setPhase('recording'); };
    const stop = async () => {
        if (!recorder.current) return;
        await recorder.current.stop();
        void wakeLock.current?.release().catch(() => {});
        await end();
    };

    const upload = async (file: File) => {
        setProblem('');
        const input = details();
        if (!input) return;
        setPhase('saving');
        try {
            const parts = await splitAudioFile(file);
            const q = await begin(input);
            parts.forEach(p => q.add(p));
            await end();
        } catch (e) {
            setPhase('form');
            setProblem((e as Error).name === 'EncodingError' ? 'That file couldn’t be read as audio.' : (e as Error).message || 'Could not upload. Please try again.');
        }
    };

    const saveTyped = async () => {
        const input = details();
        if (!input) return;
        if (!text.trim()) { setProblem('Type what was said first.'); return; }
        setPhase('saving');
        try {
            const m = await meetingService.create(input);
            toast.success('Meeting saved');
            onSaved(m);
        } catch (e) {
            setProblem((e as Error).message || 'Could not save. Please try again.');
            setPhase('form');
        }
    };

    const busy = phase !== 'form';
    const back = () => {
        if (phase === 'recording' || phase === 'paused') { setProblem('Recording. Tap Stop to save it first.'); return; }
        if (phase === 'saving') return;
        if (!text.trim() || leaving) { onCancel(); return; }
        setLeaving(true);
        setProblem('Not saved yet. Save it, or go back again to throw it away.');
    };
    useBackClose(true, back);

    const willAi = mode === 'type' ? ai.text : ai.transcribe;

    return (
        <PageRoot>
            <PageHeader title="New meeting" subtitle="Record, upload or type" onBack={back} />
            <PageBody>
                <form className="neu-card p-4 lg:p-5 space-y-4 text-[var(--neu-text)]" onChange={() => { setProblem(''); setLeaving(false); }} onSubmit={e => { e.preventDefault(); void saveTyped(); }}>
                    <TypePicker value={type} onChange={setType} disabled={busy} />
                    <Field label="Title (optional)" htmlFor="mtg-title">
                        <Input id="mtg-title" maxLength={MAX_TITLE} autoComplete="off" placeholder={`${typeLabel(type)} meeting`} value={title} onChange={e => setTitle(e.target.value)} disabled={busy} />
                    </Field>
                    <Field label="Date" htmlFor="mtg-date">
                        <Input id="mtg-date" type="date" value={date} onChange={e => setDate(e.target.value)} disabled={busy} />
                    </Field>
                    <AttendeePicker team={team} value={attendees} onChange={setAttendees} />

                    <fieldset className="flex gap-2 flex-wrap">
                        <legend className="sr-only">How to add the meeting</legend>
                        <Pill active={mode === 'record'} onClick={() => { if (!busy) setMode('record'); }}><Mic size={14} className="inline mr-1" />Record</Pill>
                        <Pill active={mode === 'upload'} onClick={() => { if (!busy) setMode('upload'); }}><Upload size={14} className="inline mr-1" />Upload</Pill>
                        <Pill active={mode === 'type'} onClick={() => { if (!busy) setMode('type'); }}><Keyboard size={14} className="inline mr-1" />Type</Pill>
                    </fieldset>

                    {mode === 'record' && (
                        <RecordPanel phase={phase} elapsed={elapsed} live={live} waiting={waiting} liveOn={ai.transcribe}
                            onStart={() => { void start(); }} onPause={pause} onResume={resume} onStop={() => { void stop(); }} />
                    )}
                    {mode === 'upload' && <UploadPanel busy={busy} waiting={waiting} onFile={f => { void upload(f); }} />}
                    {mode === 'type' && (
                        <Field label="What was said" htmlFor="mtg-text" hint="Paste or type notes. The summary is written from this.">
                            <Textarea id="mtg-text" rows={12} maxLength={MAX_TRANSCRIPT} value={text} onChange={e => setText(e.target.value)} />
                        </Field>
                    )}

                    <p className="text-[12px] text-[var(--neu-text-dim)]">
                        {willAi ? 'After saving, the summary and action items are written automatically.' : 'AI isn’t set up yet. The meeting is saved, and you can summarize it once it is.'}
                    </p>
                    {problem && <p role="alert" className="text-[13px] text-red-600 dark:text-red-400">{problem}</p>}
                    {mode === 'type' && <Button type="submit" variant="primary" block disabled={busy}>{busy ? 'Saving…' : 'Save meeting'}</Button>}
                </form>
            </PageBody>
        </PageRoot>
    );
};

const TypePicker: React.FC<{ value: MeetingType; onChange: (t: MeetingType) => void; disabled: boolean }> = ({ value, onChange, disabled }) => (
    <fieldset>
        <legend className="mb-2 text-[13px] font-medium">Meeting type</legend>
        <div className="grid grid-cols-2 gap-2">
            {MEETING_TYPES.map(t => (
                <Pill key={t.id} active={value === t.id} onClick={() => { if (!disabled) onChange(t.id); }} className="!h-auto !py-2 flex-col !items-start text-left">
                    <span className="font-medium">{t.label}</span>
                    <span className="text-[11px] opacity-75">{t.hint}</span>
                </Pill>
            ))}
        </div>
    </fieldset>
);

const Waiting: React.FC<{ n: number }> = ({ n }) => (n ? <p className="text-[12px] text-[var(--neu-text-dim)]">{n} part{n === 1 ? '' : 's'} still uploading. Keep this screen open.</p> : null);

const RecordPanel: React.FC<{
    phase: Phase; elapsed: number; live: string; waiting: number; liveOn: boolean;
    onStart: () => void; onPause: () => void; onResume: () => void; onStop: () => void;
}> = ({ phase, elapsed, live, waiting, liveOn, onStart, onPause, onResume, onStop }) => {
    const mic = useMicPermission();
    const recording = phase === 'recording' || phase === 'paused';
    return (
        <div className="rounded-2xl neu-inset p-4 space-y-3">
            <p className="font-serif text-3xl tabular-nums text-center" aria-live="polite">{clock(elapsed)}</p>
            {phase === 'recording' && <p className="text-center text-[12px] text-red-600 dark:text-red-400">● Recording. Keep this screen open.</p>}
            {phase === 'paused' && <p className="text-center text-[12px] text-[var(--neu-text-dim)]">Paused</p>}
            {phase === 'form' && mic === 'prompt' && <p className="text-[12px] text-[var(--neu-text-dim)]">Your browser will ask for the microphone. Choose <b>Allow on every visit</b> (or <b>Allow</b>) and it won’t ask again.</p>}
            {phase === 'form' && mic === 'denied' && <p className="text-[12px] text-red-600 dark:text-red-400">{MIC_BLOCKED}</p>}
            {phase === 'form' && <Button type="button" variant="primary" block icon={<Mic size={15} />} onClick={onStart}>Start recording</Button>}
            {recording && (
                <div className="flex gap-2">
                    {phase === 'recording'
                        ? <Button type="button" block icon={<Pause size={15} />} onClick={onPause}>Pause</Button>
                        : <Button type="button" block icon={<Play size={15} />} onClick={onResume}>Resume</Button>}
                    <Button type="button" variant="primary" block icon={<Square size={15} />} onClick={onStop}>Stop and save</Button>
                </div>
            )}
            {phase === 'saving' && <p className="flex items-center justify-center gap-2 text-[13px]"><Loader2 size={16} className="animate-spin" />Saving the last part…</p>}
            <Waiting n={waiting} />
            {recording && liveOn && (
                <div className="max-h-48 overflow-y-auto rounded-xl bg-black/5 dark:bg-white/5 p-3 text-[13px] whitespace-pre-wrap" aria-live="polite">
                    {live || `Live text appears here every ${PART_SECONDS / 60} minutes.`}
                </div>
            )}
            <p className="text-center text-[11.5px] text-[var(--neu-text-dim)]">Up to {MAX_RECORD_MINUTES / 60} hours. Saved every {PART_SECONDS / 60} minutes as you go.</p>
        </div>
    );
};

const UploadPanel: React.FC<{ busy: boolean; waiting: number; onFile: (f: File) => void }> = ({ busy, waiting, onFile }) => (
    <div className="rounded-2xl neu-inset p-4 space-y-3 text-center">
        {busy ? (
            <p className="flex items-center justify-center gap-2 text-[13px]"><Loader2 size={16} className="animate-spin" />Uploading the recording…</p>
        ) : (
            <label className="neu-button neu-button-primary w-full cursor-pointer">
                <Upload size={15} />Choose a recording
                <input type="file" accept="audio/*,video/mp4,.m4a,.mp3,.wav,.ogg,.webm" className="sr-only" onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
            </label>
        )}
        <Waiting n={waiting} />
        <p className="text-[11.5px] text-[var(--neu-text-dim)]">A voice memo or any audio file. Long ones are split automatically.</p>
    </div>
);
