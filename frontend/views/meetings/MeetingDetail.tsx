// One meeting: the recording, Summary / Action items / Transcript /
// Translation / Ask, the AI tools, and sharing it on.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { CheckSquare, Copy, FileDown, Languages, Loader2, Mail, MessageCircle, Mic, Pencil, Play, Share2, Sparkles, Square, Trash2, UserRound } from 'lucide-react';
import { useBackClose } from '../../hooks/useBackClose';
import { PageRoot, PageHeader, PageBody, Button, Field, Input, Textarea, Select, Pill } from '../../components/ui';
import {
    LANGUAGES, MAX_SUMMARY, MAX_TRANSCRIPT, chunkText, renameSpeaker, speakersIn, typeLabel, SPEAKER_CHUNK,
    type ActionItem, type Meeting, type MeetingInput,
} from '../../meetingRules';
import { meetingService, type MeetingList } from '../../services/meetingService';
import { AskPanel } from './AskPanel';
import { AttendeePicker, type Member } from './AttendeePicker';
import { clock } from './NewMeeting';
import { mailtoUrl, meetingText, printMeeting, whatsappUrl } from './share';

type Tab = 'summary' | 'actions' | 'transcript' | 'translation' | 'ask';
type Source = 'summary' | 'transcript';
type Ai = MeetingList['ai'];
type Work = '' | 'transcribe' | 'summarize' | 'translate' | 'speakers' | 'save' | 'delete' | 'load';

const when = (ms: number) => new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const message = (e: unknown, fallback: string) => (e as Error)?.message || fallback;
const inputOf = (m: Meeting): MeetingInput => ({
    type: m.type, title: m.title, heldAt: m.heldAt, transcript: m.transcript, summary: m.summary,
    attendees: m.attendees, actionItems: m.actionItems, tasksEventId: m.tasksEventId,
});

export interface MeetingDetailProps {
    initial: Meeting;
    autoRun: boolean;
    ai: Ai;
    canEdit: boolean;
    team: Member[];
    /** Adds the action items to Tasks (a calendar event with one to-do each); absent without Calendar edit. */
    onAddTasks?: (m: Meeting) => Promise<void>;
    onDone: () => void;
}

export const MeetingDetail: React.FC<MeetingDetailProps> = ({ initial, autoRun, ai, canEdit, team, onAddTasks, onDone }) => {
    const [m, setM] = useState(initial);
    const [tab, setTab] = useState<Tab>('summary');
    const [working, setWorking] = useState<Work>('');
    const [progress, setProgress] = useState('');
    const [problem, setProblem] = useState('');
    const ran = useRef(false);

    useBackClose(true, () => { if (!working) onDone(); });

    /** Runs one piece of work with the spinner and error line. */
    const work = useCallback(async <T,>(kind: Work, job: () => Promise<T>, fallback: string): Promise<T | null> => {
        setProblem('');
        setWorking(kind);
        try { return await job(); } catch (e) { setProblem(message(e, fallback)); return null; } finally { setWorking(''); setProgress(''); }
    }, []);

    const save = useCallback(async (patch: Partial<MeetingInput>) => {
        const next = await work('save', () => meetingService.update(m.id, { ...inputOf(m), ...patch }), 'Could not save.');
        if (next) setM(next);
        return next;
    }, [m, work]);

    /** Parts with no text yet (AI was off, or live text failed), one after another. */
    const transcribeMissing = useCallback(async (from: Meeting): Promise<Meeting> => {
        let cur = from;
        for (let i = 0; i < cur.parts.length; i++) {
            if (cur.parts[i].text) continue;
            setProgress(`Part ${i + 1} of ${cur.parts.length}`);
            cur = await meetingService.retranscribe(cur.id, i); // NOSONAR: one part at a time, in order
            setM(cur);
        }
        return cur;
    }, []);

    const summarize = useCallback(async (from: Meeting) => {
        const next = await work('summarize', () => meetingService.ai(from.id, 'summarize'), 'Could not write the summary.');
        if (next) { setM(next); setTab('summary'); }
    }, [work]);

    // Right after saving: any text still missing, then the summary and action items.
    useEffect(() => {
        if (!autoRun || ran.current || !canEdit) return;
        ran.current = true;
        void (async () => {
            let cur: Meeting | null = initial;
            if (ai.transcribe && cur.parts.some(p => !p.text)) cur = await work('transcribe', () => transcribeMissing(initial), 'Could not turn the recording into text.');
            if (cur?.transcript.trim() && !cur.summary && ai.text) await summarize(cur);
        })();
    }, [autoRun, canEdit, ai, initial, work, transcribeMissing, summarize]);

    const whoSaidWhat = async () => {
        const labelled = await work('speakers', async () => {
            const total = chunkText(m.transcript, SPEAKER_CHUNK).length;
            const out: string[] = [];
            let known: string[] = [];
            for (let i = 0; i < total; i++) {
                setProgress(`Piece ${i + 1} of ${total}`);
                const r = await meetingService.speakers(m.id, i, known); // NOSONAR: each piece keeps the speaker names found before it
                out.push(r.text);
                known = speakersIn(out.join('\n'));
            }
            return out.join('\n');
        }, 'Could not mark who said what.');
        if (labelled) { await save({ transcript: labelled }); toast.success('Speakers marked. Rename any of them below.'); }
    };

    const remove = async () => {
        const ok = await work('delete', () => meetingService.remove(m.id).then(() => true), 'Could not delete.');
        if (ok) { toast.success('Meeting deleted'); onDone(); }
    };

    const busyLabel: Partial<Record<Work, string>> = {
        transcribe: 'Turning the recording into text…', summarize: 'Writing the summary and action items…',
        translate: 'Translating…', speakers: 'Marking who said what…',
    };
    const openItems = m.actionItems.filter(a => !a.done).length;
    const length = m.durationSec ? ' · ' + clock(m.durationSec) : '';
    const tabs: [Tab, string][] = [
        ['summary', 'Summary'], ['actions', openItems ? `Action items (${openItems})` : 'Action items'],
        ['transcript', 'Transcript'], ['translation', m.translationLang ? `Translation (${m.translationLang})` : 'Translation'], ['ask', 'Ask'],
    ];

    return (
        <PageRoot>
            <PageHeader title={m.title} subtitle={`${typeLabel(m.type)} · ${when(m.heldAt)}${length}`} onBack={() => { if (!working) onDone(); }} />
            <PageBody>
                <div className="space-y-4 text-[var(--neu-text)]">
                    {m.status === 'recording' && <p className="neu-card p-3 text-[13px]">Still recording on another device, or the recording was cut off. What arrived so far is here.</p>}
                    {m.parts.length > 0 && <PartsPlayer m={m} />}
                    {working && busyLabel[working] && (
                        <output className="neu-card p-4 flex items-center gap-3 text-[13px]">
                            <Loader2 size={18} className="animate-spin shrink-0" />{busyLabel[working]}{progress && ` ${progress}`}
                        </output>
                    )}
                    {problem && <p role="alert" className="text-[13px] text-red-600 dark:text-red-400">{problem}</p>}

                    <div className="neu-card p-4 space-y-3">
                        <div className="flex gap-2 flex-wrap">
                            {tabs.map(([t, label]) => <Pill key={t} active={tab === t} onClick={() => setTab(t)}>{label}</Pill>)}
                        </div>
                        {tab === 'summary' && <TextTab text={m.summary} max={MAX_SUMMARY} empty={m.transcript ? 'No summary yet.' : 'The summary is written from the transcript.'} canEdit={canEdit} onSave={summary => save({ summary })} />}
                        {tab === 'actions' && <ActionsTab m={m} canEdit={canEdit} onSave={save} onAddTasks={onAddTasks} />}
                        {tab === 'transcript' && (
                            <>
                                <TextTab text={m.transcript} max={MAX_TRANSCRIPT} empty={m.parts.length ? 'Not transcribed yet.' : 'No text.'} canEdit={canEdit} onSave={transcript => save({ transcript })} />
                                {canEdit && <SpeakerTools m={m} ai={ai} busy={!!working} onWhoSaidWhat={() => { void whoSaidWhat(); }} onRename={(from, to) => save({ transcript: renameSpeaker(m.transcript, from, to) })}
                                    onTranscribe={() => { void work('transcribe', () => transcribeMissing(m), 'Could not turn the recording into text.'); }} />}
                            </>
                        )}
                        {tab === 'translation' && <TextTab text={m.translation} max={MAX_SUMMARY} empty="Translate the summary or transcript below." canEdit={false} onSave={async () => null} />}
                        {tab === 'ask' && <AskPanel enabled={ai.text} ask={async (q, h) => ({ answer: await meetingService.ask(m.id, q, h) })} />}
                    </div>

                    <ShareBar m={m} team={team} />
                    {canEdit && (
                        <AiCard m={m} ai={ai} busy={!!working} team={team}
                            onAttendees={attendees => { void save({ attendees }); }}
                            onSummarize={() => { void summarize(m); }}
                            onTranslate={(lang, source) => { void work('translate', () => meetingService.ai(m.id, 'translate', { lang, source }), 'Could not translate.').then(n => { if (n) { setM(n); setTab('translation'); } }); }}
                            onRemove={() => { void remove(); }} />
                    )}
                </div>
            </PageBody>
        </PageRoot>
    );
};

/** The recording's parts, played one after another. */
const PartsPlayer: React.FC<{ m: Meeting }> = ({ m }) => {
    const [index, setIndex] = useState(-1);
    const [src, setSrc] = useState('');
    const [loading, setLoading] = useState(false);
    useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);
    const play = async (i: number) => {
        if (i >= m.parts.length) { setIndex(-1); return; }
        setLoading(true);
        try { setSrc(await meetingService.audioUrl(m.parts[i])); setIndex(i); } catch { toast.error('The recording did not load.'); } finally { setLoading(false); }
    };
    if (index < 0) {
        return (
            <div className="neu-card p-4">
                <Button block icon={loading ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />} disabled={loading} onClick={() => { void play(0); }}>
                    Play recording{m.durationSec ? ` (${clock(m.durationSec)})` : ''}
                </Button>
            </div>
        );
    }
    return (
        <div className="neu-card p-4 space-y-1">
            <audio controls autoPlay src={src} className="w-full" onEnded={() => { void play(index + 1); }}><track kind="captions" /></audio>
            {m.parts.length > 1 && <p className="text-[11.5px] text-[var(--neu-text-dim)]">Part {index + 1} of {m.parts.length}. The next one plays on its own.</p>}
        </div>
    );
};

/** A tab's text with Copy and Edit, or why there is none yet. */
const TextTab: React.FC<{ text: string; max: number; empty: string; canEdit: boolean; onSave: (t: string) => Promise<unknown> }> = ({ text, max, empty, canEdit, onSave }) => {
    const [draft, setDraft] = useState<string | null>(null);
    const copy = async () => {
        try { await navigator.clipboard.writeText(text); toast.success('Copied'); } catch { toast.error('Copy didn’t work on this device'); }
    };
    if (draft !== null) {
        return (
            <>
                <Textarea rows={16} value={draft} maxLength={max} onChange={e => setDraft(e.target.value)} aria-label="Edit text" />
                <div className="flex gap-2">
                    <Button variant="primary" onClick={() => { void onSave(draft).then(ok => { if (ok) setDraft(null); }); }}>Save</Button>
                    <Button onClick={() => setDraft(null)}>Cancel</Button>
                </div>
            </>
        );
    }
    if (!text) return <p className="text-[13px] text-[var(--neu-text-dim)]">{empty}</p>;
    return (
        <>
            <div className="whitespace-pre-wrap break-words text-[14px] leading-relaxed">{text}</div>
            <div className="flex gap-2 flex-wrap">
                <Button icon={<Copy size={14} />} onClick={() => { void copy(); }}>Copy</Button>
                {canEdit && <Button icon={<Pencil size={14} />} onClick={() => setDraft(text)}>Edit</Button>}
            </div>
        </>
    );
};

/** Checkable action items, and adding them to Tasks. */
const ActionsTab: React.FC<{ m: Meeting; canEdit: boolean; onSave: (p: Partial<MeetingInput>) => Promise<Meeting | null>; onAddTasks?: (m: Meeting) => Promise<void> }> = ({ m, canEdit, onSave, onAddTasks }) => {
    const [adding, setAdding] = useState(false);
    if (!m.actionItems.length) return <p className="text-[13px] text-[var(--neu-text-dim)]">{m.summary ? 'No action items were agreed.' : 'Action items are listed when the summary is written.'}</p>;
    const toggle = (a: ActionItem) => { void onSave({ actionItems: m.actionItems.map(x => (x.id === a.id ? { ...x, done: !x.done } : x)) }); };
    const add = async () => {
        if (!onAddTasks) return;
        setAdding(true);
        try {
            await onAddTasks(m);
            await onSave({ tasksEventId: `added:${Date.now()}` });
            toast.success('Added to Tasks, in the calendar on the meeting day');
        } catch (e) { toast.error(message(e, 'Could not add them to Tasks.')); } finally { setAdding(false); }
    };
    return (
        <>
            <ul className="space-y-1">
                {m.actionItems.map(a => (
                    <li key={a.id}>
                        <button type="button" disabled={!canEdit} onClick={() => toggle(a)} className="w-full flex items-start gap-2.5 rounded-xl px-2 py-2 text-left active-scale" aria-pressed={a.done}>
                            {a.done ? <CheckSquare size={17} className="shrink-0 mt-0.5 text-gold-700 dark:text-gold-400" /> : <Square size={17} className="shrink-0 mt-0.5 text-[var(--neu-text-dim)]" />}
                            <span className={`flex-1 text-[14px] ${a.done ? 'line-through opacity-60' : ''}`}>
                                {a.text}
                                <span className="block text-[11.5px] text-[var(--neu-text-dim)]">{[a.owner || 'No owner', a.due && `by ${a.due}`].filter(Boolean).join(' · ')}</span>
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
            {canEdit && onAddTasks && (
                <Button block icon={<CheckSquare size={15} />} disabled={adding || !!m.tasksEventId} onClick={() => { void add(); }}>
                    {m.tasksEventId ? 'Added to Tasks' : 'Add to Tasks'}
                </Button>
            )}
        </>
    );
};

/** Who said what, renaming a speaker, and text for parts that have none. */
const SpeakerTools: React.FC<{ m: Meeting; ai: Ai; busy: boolean; onWhoSaidWhat: () => void; onRename: (from: string, to: string) => Promise<unknown>; onTranscribe: () => void }> = ({ m, ai, busy, onWhoSaidWhat, onRename, onTranscribe }) => {
    const speakers = speakersIn(m.transcript);
    const [from, setFrom] = useState('');
    const [to, setTo] = useState('');
    const missing = m.parts.filter(p => !p.text).length;
    return (
        <div className="space-y-3 border-t border-black/5 dark:border-white/10 pt-3">
            {missing > 0 && ai.transcribe && <Button block icon={<Mic size={15} />} disabled={busy} onClick={onTranscribe}>Transcribe {missing} part{missing === 1 ? '' : 's'} with no text</Button>}
            <Button block icon={<UserRound size={15} />} disabled={busy || !ai.text || !m.transcript.trim()} onClick={onWhoSaidWhat}>
                {speakers.length ? 'Mark who said what again' : 'Mark who said what'}
            </Button>
            <p className="text-[11.5px] text-[var(--neu-text-dim)]">The AI works it out from the words (names used, replies), not from voices. Check it, and rename speakers here.</p>
            {speakers.length > 0 && (
                <form className="flex gap-2 flex-wrap items-end" onSubmit={e => { e.preventDefault(); if (from && to.trim()) void onRename(from, to.trim()).then(() => { setFrom(''); setTo(''); }); }}>
                    <Field label="Rename" htmlFor="mtg-from" className="flex-1 min-w-[8rem]">
                        <Select id="mtg-from" value={from} onChange={e => setFrom(e.target.value)}>
                            <option value="">Choose a speaker</option>
                            {speakers.map(s => <option key={s} value={s}>{s}</option>)}
                        </Select>
                    </Field>
                    <Field label="To" htmlFor="mtg-to" className="flex-1 min-w-[8rem]">
                        <Input id="mtg-to" value={to} maxLength={40} onChange={e => setTo(e.target.value)} placeholder="e.g. Priya" />
                    </Field>
                    <Button type="submit" disabled={busy || !from || !to.trim()}>Rename</Button>
                </form>
            )}
        </div>
    );
};

/** Share sheet, WhatsApp, email to the people in the meeting, and PDF. */
const ShareBar: React.FC<{ m: Meeting; team: Member[] }> = ({ m, team }) => {
    const textOut = meetingText(m);
    const emails = m.attendees.map(a => team.find(t => t.id === a.id)?.email).filter((e): e is string => !!e);
    const share = async () => {
        try { await navigator.share({ title: m.title, text: textOut }); } catch { /* closed */ }
    };
    const canShare = typeof navigator.share === 'function';
    return (
        <div className="neu-card p-4 flex gap-2 flex-wrap">
            {canShare && <Button icon={<Share2 size={15} />} onClick={() => { void share(); }}>Share</Button>}
            <a className="neu-button" href={whatsappUrl(textOut)} target="_blank" rel="noopener noreferrer"><MessageCircle size={15} />WhatsApp</a>
            <a className="neu-button" href={mailtoUrl(emails, m.title, textOut)}><Mail size={15} />Email{emails.length ? ` ${emails.length}` : ''}</a>
            <Button icon={<FileDown size={15} />} onClick={() => { if (!printMeeting(m)) toast.error('Allow pop-ups for this site to save the PDF.'); }}>PDF</Button>
        </div>
    );
};

/** People, summary, translation and delete: for people who can record. */
const AiCard: React.FC<{
    m: Meeting; ai: Ai; busy: boolean; team: Member[];
    onAttendees: (a: Meeting['attendees']) => void; onSummarize: () => void; onTranslate: (lang: string, source: Source) => void; onRemove: () => void;
}> = ({ m, ai, busy, team, onAttendees, onSummarize, onTranslate, onRemove }) => {
    const [lang, setLang] = useState<string>(m.translationLang || 'Hindi');
    const [source, setSource] = useState<Source>('summary');
    const [confirmDelete, setConfirmDelete] = useState(false);
    return (
        <div className="neu-card p-4 space-y-3">
            <AttendeePicker team={team} value={m.attendees} onChange={onAttendees} />
            {!ai.text && <p className="text-[12.5px] text-[var(--neu-text-dim)]">AI isn’t set up yet, so summaries, speakers, questions and translation are off. Everything else works.</p>}
            <Button block variant={m.summary ? 'default' : 'primary'} icon={<Sparkles size={15} />} disabled={busy || !ai.text || !m.transcript.trim()} onClick={onSummarize}>
                {`${m.summary ? 'Rewrite' : 'Write'} ${typeLabel(m.type).toLowerCase()} summary and action items`}
            </Button>
            <div className="flex gap-2 flex-wrap items-end">
                <Field label="Translate" htmlFor="mtg-source" className="flex-1 min-w-[8rem]">
                    <Select id="mtg-source" value={source} onChange={e => setSource(e.target.value as Source)}>
                        <option value="summary">Summary</option>
                        <option value="transcript">Transcript</option>
                    </Select>
                </Field>
                <Field label="Into" htmlFor="mtg-lang" className="flex-1 min-w-[8rem]">
                    <Select id="mtg-lang" value={lang} onChange={e => setLang(e.target.value)}>
                        {LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
                    </Select>
                </Field>
                <Button icon={<Languages size={15} />} disabled={busy || !ai.text || !m[source].trim()} onClick={() => onTranslate(lang, source)}>Translate</Button>
            </div>
            <Button block variant="danger" icon={<Trash2 size={15} />} disabled={busy} onClick={() => { if (confirmDelete) onRemove(); else setConfirmDelete(true); }}>
                {confirmDelete ? 'Tap again to delete' : 'Delete meeting'}
            </Button>
        </div>
    );
};
