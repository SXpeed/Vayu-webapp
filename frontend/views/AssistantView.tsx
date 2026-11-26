// Ask AI: questions about the workspace's data, typed or spoken. The server
// (assistant.ts) answers from read-only lookups the person's role allows.
import React, { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Loader2, Mic, Square } from 'lucide-react';
import { PageRoot, PageHeader, PageBody, Button } from '../components/ui';
import { assistantService } from '../services/assistantService';
import { AskPanel } from './meetings/AskPanel';
import { pickMime } from './meetings/recorder';

const EXAMPLES = ['Status of the latest inquiries', 'How much stock is available?', 'Who checked in today?', 'Sales this month', 'Who is on leave this week?', 'What tasks are due this week?'];
const MAX_SECONDS = 60;

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

export const AssistantView: React.FC<{ onBack: () => void }> = ({ onBack }) => (
    <PageRoot>
        <PageHeader title="Ask AI" subtitle="Ask about stock, inquiries, sales, billing, attendance, the roster and more" onBack={onBack} />
        <PageBody>
            <div className="neu-card p-4">
                <AskPanel enabled examples={EXAMPLES} busyText="Looking it up…" placeholder="e.g. Status of Priya Shah’s inquiry"
                    ask={async (q, h) => ({ answer: await assistantService.ask(q, h) })}
                    Extra={MicButton} />
            </div>
            <p className="mt-3 text-[11.5px] text-[var(--neu-text-dim)]">It only reads what your role can see. AI can make mistakes: check important numbers on the screen they come from.</p>
        </PageBody>
    </PageRoot>
);
