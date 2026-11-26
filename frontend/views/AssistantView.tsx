// Ask AI: questions about the workspace's data, typed or spoken, as a chat.
// The server (assistant.ts) answers from read-only lookups the person's role
// allows and streams the answer; chats are saved per person (assistantChats.ts).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Check, Copy, History, Loader2, Mic, Pencil, Plus, RefreshCw, Send, Sparkles, Square, Trash2 } from 'lucide-react';
import { PageRoot, PageHeader, Button, GhostIconButton, PrimaryIconButton, Textarea } from '../components/ui';
import { assistantService, type ChatSummary } from '../services/assistantService';
import type { Asked } from '../services/meetingService';
import { useStickToBottom } from '../hooks/useStickToBottom';
import { pickMime } from './meetings/recorder';
import { Markdown } from './assistant/Markdown';

const EXAMPLES = ['Status of the latest inquiries', 'How much stock is available?', 'Who checked in today?', 'Sales this month', 'Who is on leave this week?', 'What tasks are due this week?'];
/** Quick changes to the last answer: what the button says, and what is asked. */
const REFINE: [string, string][] = [['Shorter', 'Make that shorter.'], ['More detail', 'Give me more detail on that.'], ['As a table', 'Show that as a table.'], ['Simpler', 'Explain that more simply.']];
const MAX_SECONDS = 60;
const DAY_MS = 86_400_000;

interface Turn extends Asked { steps?: string[]; error?: string; stopped?: boolean }

const newId = () => `chat_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
const when = (ms: number) => {
    const days = Math.floor((new Date().setHours(24, 0, 0, 0) - ms) / DAY_MS);
    if (days < 1) return 'Today';
    if (days < 2) return 'Yesterday';
    return days < 7 ? 'This week' : 'Earlier';
};

/** Tap to talk, tap again to stop: the words are sent as the question. */
const MicButton: React.FC<{ onText: (q: string) => void; disabled: boolean }> = ({ onText, disabled }) => {
    const [state, setState] = useState<'idle' | 'recording' | 'hearing'>('idle');
    const rec = useRef<MediaRecorder | null>(null);
    useEffect(() => () => rec.current?.stream.getTracks().forEach(t => t.stop()), []);

    const start = async () => {
        if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return toast.error('This browser can’t record. Type the question instead.');
        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        } catch (e) {
            return toast.error((e as Error).name === 'NotAllowedError' ? 'The microphone is blocked. Allow it in the browser’s site settings.' : 'No microphone was found.');
        }
        const mime = pickMime();
        const r = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32_000 } : undefined);
        const chunks: Blob[] = [];
        r.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
        const limit = setTimeout(() => { if (r.state !== 'inactive') r.stop(); }, MAX_SECONDS * 1000);
        r.onstop = async () => {
            clearTimeout(limit);
            stream.getTracks().forEach(t => t.stop());
            rec.current = null;
            setState('hearing');
            try {
                const q = (await assistantService.transcribe(new Blob(chunks, { type: r.mimeType || mime || 'audio/webm' }))).trim();
                if (q) onText(q); else toast.error('Nothing was heard. Try again a little closer.');
            } catch (e) {
                toast.error((e as Error).message || 'That didn’t work. Try again.');
            } finally { setState('idle'); }
        };
        rec.current = r;
        r.start();
        setState('recording');
    };

    if (state === 'hearing') return <Button type="button" disabled icon={<Loader2 size={15} className="animate-spin" />} aria-label="Listening to your question" />;
    return state === 'recording'
        ? <Button type="button" variant="danger" onClick={() => rec.current?.stop()} icon={<Square size={15} />} aria-label="Stop and ask" aria-pressed />
        : <Button type="button" disabled={disabled} onClick={() => { void start(); }} icon={<Mic size={15} />} aria-label="Ask by voice" />;
};

const CopyButton: React.FC<{ text: string }> = ({ text }) => {
    const [done, setDone] = useState(false);
    const copy = () => navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }, () => toast.error('Couldn’t copy. Select the text instead.'));
    return (
        <button type="button" onClick={() => { void copy(); }} className="neu-pill text-[12px] inline-flex items-center gap-1" aria-label="Copy the answer">
            {done ? <Check size={13} /> : <Copy size={13} />}{done ? 'Copied' : 'Copy'}
        </button>
    );
};

/** A question, editable: a new wording asks again from there. */
const Question: React.FC<{ q: string; canEdit: boolean; onAsk: (q: string) => void }> = ({ q, canEdit, onAsk }) => {
    const [draft, setDraft] = useState<string | null>(null);
    if (draft !== null) {
        return (
            <form className="ml-auto w-full max-w-[85%] space-y-2" onSubmit={e => { e.preventDefault(); if (draft.trim()) { onAsk(draft.trim()); setDraft(null); } }}>
                <Textarea value={draft} onChange={e => setDraft(e.target.value)} rows={3} maxLength={1000} aria-label="Edit your question" className="w-full" autoFocus />
                <p className="text-[11.5px] text-[var(--neu-text-dim)]">Asking again replaces this answer and anything after it.</p>
                <div className="flex justify-end gap-2">
                    <Button type="button" onClick={() => setDraft(null)}>Cancel</Button>
                    <Button type="submit" variant="primary" disabled={!draft.trim()}>Ask again</Button>
                </div>
            </form>
        );
    }
    return (
        <div className="group flex justify-end items-start gap-1.5">
            {canEdit && (
                <button type="button" onClick={() => setDraft(q)} className="mt-1.5 p-1.5 rounded-full text-[var(--neu-text-dim)] opacity-100 lg:opacity-0 lg:group-hover:opacity-100 focus:opacity-100" aria-label="Edit this question">
                    <Pencil size={13} />
                </button>
            )}
            <p className="max-w-[85%] rounded-2xl rounded-tr-md px-3.5 py-2 text-[14px] whitespace-pre-wrap bg-gold-500/15 dark:bg-gold-400/15">{q}</p>
        </div>
    );
};

export const AssistantView: React.FC<{ onBack: () => void }> = ({ onBack }) => {
    const [chats, setChats] = useState<ChatSummary[]>([]);
    const [chatId, setChatId] = useState<string | null>(null);
    const [turnsState, setTurnsState] = useState<Turn[]>([]);
    const turns = turnsState;
    const turnsRef = useRef<Turn[]>([]);
    const setTurns = useCallback((f: (t: Turn[]) => Turn[]) => { turnsRef.current = f(turnsRef.current); setTurnsState(turnsRef.current); }, []);
    const [question, setQuestion] = useState('');
    const [busy, setBusy] = useState(false);
    const [opening, setOpening] = useState(false);
    const [showHistory, setShowHistory] = useState(false);
    const stopRef = useRef<AbortController | null>(null);
    const { scrollerRef, contentRef, scrollToLatest } = useStickToBottom(chatId ?? 'new');

    useEffect(() => {
        assistantService.chats().then(setChats, () => toast.error('Couldn’t load your past chats.'));
        return () => stopRef.current?.abort();
    }, []);

    /** Asks `q` as turn `at`: a new question (at the end), an edited one, or the same one again. */
    const run = async (at: number, q: string) => {
        if (busy || !q.trim()) return;
        const history = turnsRef.current.slice(0, at).filter(t => t.a).map(({ q: qq, a }) => ({ q: qq, a }));
        setTurns(t => [...t.slice(0, at), { q, a: '', steps: [] }]);
        const patch = (p: Partial<Turn> | ((t: Turn) => Partial<Turn>)) => setTurns(t => t.map((x, i) => (i === at ? { ...x, ...(typeof p === 'function' ? p(x) : p) } : x)));
        setQuestion('');
        setBusy(true);
        scrollToLatest();
        const stop = new AbortController();
        stopRef.current = stop;
        try {
            await assistantService.ask(q, history, e => {
                if ('text' in e) patch(x => ({ a: x.a + e.text }));
                else if ('step' in e) patch(x => ({ steps: [...(x.steps ?? []), e.step] }));
                else patch({ error: e.error });
            }, stop.signal);
            if (stop.signal.aborted) patch({ stopped: true });
        } catch (e) {
            patch({ error: (e as Error).message || 'That didn’t work. Try again.' });
        } finally {
            setBusy(false);
            stopRef.current = null;
        }
        const keep = turnsRef.current.filter(t => t.a).map(({ q: qq, a }) => ({ q: qq, a }));
        if (!keep.length) return;
        const id = chatId ?? newId();
        setChatId(id);
        try {
            const saved = await assistantService.save(id, keep);
            setChats(c => [saved, ...c.filter(x => x.id !== id)]);
        } catch (e) {
            toast.error(`This chat wasn’t saved: ${(e as Error).message}`);
        }
    };

    const startNew = () => {
        stopRef.current?.abort();
        setChatId(null);
        setTurns(() => []);
        setShowHistory(false);
    };

    const open = async (id: string) => {
        if (busy) return;
        setShowHistory(false);
        setOpening(true);
        try {
            const c = await assistantService.chat(id);
            setChatId(c.id);
            setTurns(() => c.turns);
        } catch (e) {
            toast.error((e as Error).message || 'Couldn’t open that chat.');
        } finally { setOpening(false); }
    };

    const remove = async (c: ChatSummary) => {
        if (!globalThis.confirm(`Delete the chat “${c.title}”?`)) return;
        try {
            await assistantService.remove(c.id);
            setChats(list => list.filter(x => x.id !== c.id));
            if (c.id === chatId) startNew();
        } catch (e) { toast.error((e as Error).message || 'Couldn’t delete that chat.'); }
    };

    const clearAll = async () => {
        if (!globalThis.confirm('Delete all your Ask AI chats? This can’t be undone.')) return;
        try {
            await assistantService.clear();
            setChats([]);
            startNew();
            toast.success('Chat history cleared');
        } catch (e) { toast.error((e as Error).message || 'Couldn’t clear the history.'); }
    };

    const last = turns.length - 1;
    const groups = chats.reduce<[string, ChatSummary[]][]>((g, c) => {
        const label = when(c.updatedAt);
        if (g.at(-1)?.[0] === label) g.at(-1)![1].push(c); else g.push([label, [c]]);
        return g;
    }, []);

    return (
        <PageRoot width="full">
            <PageHeader title="Ask AI" subtitle="Stock, inquiries, sales, billing, attendance, the roster and more" onBack={onBack}
                actions={<>
                    <span className="lg:hidden"><GhostIconButton onClick={() => setShowHistory(s => !s)} label={showHistory ? 'Back to the chat' : 'Past chats'} icon={<History size={16} />} /></span>
                    <PrimaryIconButton onClick={startNew} label="New chat" icon={<Plus size={16} />} disabled={!turns.length && !busy} />
                </>} />
            <div className="flex-1 min-h-0 flex text-[var(--neu-text)]">
                {/* Past chats: beside the chat on desktop, in its place on a phone. */}
                <aside aria-label="Past chats" className={`${showHistory ? 'flex' : 'hidden'} lg:flex flex-col w-full lg:w-72 shrink-0 min-h-0 lg:border-r border-black/5 dark:border-white/10`}>
                    <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-3 lg:px-4 pt-2 pb-[calc(6rem+var(--safe-bottom-ui))] lg:pb-4 space-y-4">
                        {!chats.length && <p className="text-[13px] text-[var(--neu-text-dim)] px-2 pt-2">Your chats will show here.</p>}
                        {groups.map(([label, list]) => (
                            <section key={label}>
                                <h3 className="px-2 pb-1 text-[11px] uppercase tracking-wider text-[var(--neu-text-dim)]">{label}</h3>
                                <ul className="space-y-0.5">
                                    {list.map(c => (
                                        <li key={c.id} className={`group flex items-center rounded-xl ${c.id === chatId ? 'bg-black/5 dark:bg-white/10' : 'hover:bg-black/5 dark:hover:bg-white/5'}`}>
                                            <button type="button" onClick={() => { void open(c.id); }} className="flex-1 min-w-0 text-left px-2 py-2 text-[13px] truncate" aria-current={c.id === chatId ? 'true' : undefined}>{c.title}</button>
                                            <button type="button" onClick={() => { void remove(c); }} className="p-2 text-[var(--neu-text-dim)] opacity-100 lg:opacity-0 lg:group-hover:opacity-100 focus:opacity-100" aria-label={`Delete the chat “${c.title}”`}>
                                                <Trash2 size={14} />
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        ))}
                        {chats.length > 0 && (
                            <Button type="button" variant="danger" block onClick={() => { void clearAll(); }} icon={<Trash2 size={14} />}>Clear all history</Button>
                        )}
                    </div>
                </aside>

                <section aria-label="Chat" className={`${showHistory ? 'hidden' : 'flex'} lg:flex flex-1 min-w-0 min-h-0 flex-col`}>
                    <div ref={scrollerRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain no-scrollbar neu-scroll-fade px-4 pt-3">
                        <div ref={contentRef} className="max-w-3xl mx-auto space-y-5 pb-4" aria-busy={busy}>
                            {opening && <p className="flex justify-center pt-10"><Loader2 size={20} className="animate-spin text-[var(--neu-text-dim)]" aria-label="Opening the chat" /></p>}
                            {!opening && !turns.length && (
                                <div className="pt-8 lg:pt-16 text-center space-y-5">
                                    <span className="inline-flex w-12 h-12 rounded-full items-center justify-center neu-raised-sm text-gold-700 dark:text-gold-300"><Sparkles size={22} /></span>
                                    <div>
                                        <h2 className="text-[20px] font-serif">What would you like to know?</h2>
                                        <p className="mt-1 text-[13px] text-[var(--neu-text-dim)]">Ask in your own words, or tap the mic and say it.</p>
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-left">
                                        {EXAMPLES.map(x => (
                                            <button key={x} type="button" onClick={() => { void run(0, x); }} className="neu-raised-sm neu-btn rounded-xl px-3.5 py-3 text-[13px] active-scale">{x}</button>
                                        ))}
                                    </div>
                                </div>
                            )}
                            {!opening && turns.map((t, i) => {
                                const live = busy && i === last;
                                return (
                                    <div key={`${i}-${t.q}`} className="space-y-2.5">
                                        <Question q={t.q} canEdit={!busy} onAsk={q => { void run(i, q); }} />
                                        <div className="flex gap-2.5">
                                            <span className="mt-0.5 shrink-0 w-7 h-7 rounded-full inline-flex items-center justify-center neu-raised-sm text-gold-700 dark:text-gold-300" aria-hidden><Sparkles size={14} /></span>
                                            <div className="flex-1 min-w-0 space-y-2">
                                                {live && !t.a && (
                                                    <ul className="space-y-1 text-[13px] text-[var(--neu-text-dim)]">
                                                        {(t.steps ?? []).map((s, j) => <li key={`${j}-${s}`} className="flex items-center gap-2"><Check size={13} />{s}</li>)}
                                                        <li className="flex items-center gap-2"><Loader2 size={13} className="animate-spin" />{t.steps?.length ? 'Writing the answer…' : 'Thinking…'}</li>
                                                    </ul>
                                                )}
                                                {t.a && <Markdown text={t.a} />}
                                                {t.stopped && <p className="text-[12px] text-[var(--neu-text-dim)]">Stopped.</p>}
                                                {t.error && <p role="alert" className="text-[13px] text-red-600 dark:text-red-400">{t.error}</p>}
                                                {!live && (t.a || t.error) && (
                                                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                                                        {t.a && <CopyButton text={t.a} />}
                                                        {i === last && (
                                                            <button type="button" onClick={() => { void run(i, t.q); }} className="neu-pill text-[12px] inline-flex items-center gap-1" aria-label="Ask the same question again">
                                                                <RefreshCw size={13} />Regenerate
                                                            </button>
                                                        )}
                                                        {i === last && t.a && REFINE.map(([label, ask]) => (
                                                            <button key={label} type="button" onClick={() => { void run(turns.length, ask); }} className="neu-pill text-[12px]">{label}</button>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    <div className="px-4 pt-2 pb-[calc(6rem+var(--safe-bottom-ui))] lg:pb-4">
                        <form className="max-w-3xl mx-auto flex items-end gap-2 neu-card rounded-2xl p-2" onSubmit={e => { e.preventDefault(); void run(turns.length, question.trim()); }}>
                            <Textarea value={question} onChange={e => setQuestion(e.target.value)} rows={Math.min(6, question.split('\n').length)} maxLength={1000}
                                placeholder={turns.length ? 'Ask a follow-up…' : 'e.g. Status of Priya Shah’s inquiry'} aria-label="Your question"
                                className="flex-1 resize-none !shadow-none !bg-transparent"
                                onKeyDown={e => {
                                    // Enter asks; Shift+Enter starts a new line.
                                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void run(turns.length, question.trim()); }
                                }} />
                            <MicButton onText={q => { void run(turns.length, q); }} disabled={busy} />
                            {busy
                                ? <Button type="button" variant="danger" onClick={() => stopRef.current?.abort()} icon={<Square size={15} />} aria-label="Stop the answer" />
                                : <Button type="submit" variant="primary" disabled={!question.trim()} icon={<Send size={15} />} aria-label="Ask" />}
                        </form>
                        <p className="max-w-3xl mx-auto mt-2 text-center text-[11px] text-[var(--neu-text-dim)]">It only reads what your role can see. AI can make mistakes: check important numbers on the screen they come from.</p>
                    </div>
                </section>
            </div>
        </PageRoot>
    );
};
