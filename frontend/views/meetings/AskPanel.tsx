// Questions about meetings, answered by the AI from what was said: one
// meeting, or all of them (the server reads the few most relevant).
import React, { useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import { Button, Input } from '../../components/ui';
import type { Asked } from '../../services/meetingService';

export interface AskResult { answer: string; sources?: { id: string; title: string }[] }

const EXAMPLES = ['What did we decide?', 'Who is doing what, and by when?', 'What was left open?'];

export const AskPanel: React.FC<{
    ask: (question: string, history: Asked[]) => Promise<AskResult>;
    enabled: boolean;
    placeholder?: string;
    onOpenSource?: (id: string) => void;
}> = ({ ask, enabled, placeholder = 'Ask about this meeting…', onOpenSource }) => {
    const [question, setQuestion] = useState('');
    const [thread, setThread] = useState<(Asked & { sources?: AskResult['sources'] })[]>([]);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState('');

    const send = async (q: string) => {
        if (!q.trim() || busy) return;
        setBusy(true);
        setProblem('');
        try {
            const r = await ask(q.trim(), thread.map(({ q: qq, a }) => ({ q: qq, a })));
            setThread(t => [...t, { q: q.trim(), a: r.answer, sources: r.sources }]);
            setQuestion('');
        } catch (e) {
            setProblem((e as Error).message || 'That didn’t work. Try again.');
        } finally {
            setBusy(false);
        }
    };

    if (!enabled) return <p className="text-[13px] text-[var(--neu-text-dim)]">Asking needs AI, which isn’t set up yet.</p>;
    return (
        <div className="space-y-3">
            {thread.length === 0 && (
                <div className="flex flex-wrap gap-1.5">
                    {EXAMPLES.map(x => <button key={x} type="button" onClick={() => { void send(x); }} className="neu-pill text-[12px]">{x}</button>)}
                </div>
            )}
            {thread.map(t => (
                <div key={`${t.q}-${t.a.length}`} className="space-y-1.5">
                    <p className="text-[13px] font-medium">{t.q}</p>
                    <p className="text-[14px] leading-relaxed whitespace-pre-wrap rounded-xl bg-black/5 dark:bg-white/5 p-3">{t.a}</p>
                    {t.sources && t.sources.length > 0 && (
                        <p className="text-[11.5px] text-[var(--neu-text-dim)]">
                            From: {t.sources.map(s => (
                                <button key={s.id} type="button" className="underline mr-2" onClick={() => onOpenSource?.(s.id)}>{s.title}</button>
                            ))}
                        </p>
                    )}
                </div>
            ))}
            {busy && <p className="flex items-center gap-2 text-[13px] text-[var(--neu-text-dim)]"><Loader2 size={15} className="animate-spin" />Reading the meetings…</p>}
            {problem && <p role="alert" className="text-[13px] text-red-600 dark:text-red-400">{problem}</p>}
            <form className="flex gap-2" onSubmit={e => { e.preventDefault(); void send(question); }}>
                <Input value={question} onChange={e => setQuestion(e.target.value)} placeholder={placeholder} maxLength={1000} aria-label="Your question" className="flex-1" />
                <Button type="submit" variant="primary" disabled={busy || !question.trim()} icon={<Send size={15} />} aria-label="Ask" />
            </form>
        </div>
    );
};
