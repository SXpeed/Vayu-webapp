// Meetings: the list (search, and questions across every meeting), a new
// meeting (views/meetings/NewMeeting.tsx) and one meeting
// (views/meetings/MeetingDetail.tsx). Server: meetings.ts. Read needs the
// "meetings" role section at view; recording and the AI tools need edit.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Keyboard, Loader2, MessagesSquare, Mic, Plus, Search, Sparkles, Users } from 'lucide-react';
import { PageRoot, PageHeader, PageBody, PrimaryIconButton, Button, Input, EmptyState } from '../components/ui';
import { typeLabel, type Meeting } from '../meetingRules';
import { meetingService, type MeetingList } from '../services/meetingService';
import { AskPanel } from './meetings/AskPanel';
import type { Member } from './meetings/AttendeePicker';
import { MeetingDetail, type MeetingDetailProps } from './meetings/MeetingDetail';
import { NewMeeting, clock } from './meetings/NewMeeting';

const when = (ms: number) => new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

type Open = { meeting: Meeting; autoRun: boolean } | 'new' | 'ask' | null;

export const MeetingsView: React.FC<{ canEdit: boolean; team: Member[]; onAddTasks?: MeetingDetailProps['onAddTasks'] }> = ({ canEdit, team, onAddTasks }) => {
    const [data, setData] = useState<MeetingList | null>(null);
    const [failed, setFailed] = useState(false);
    const [open, setOpen] = useState<Open>(null);
    const [query, setQuery] = useState('');

    const load = useCallback(async () => {
        setFailed(false);
        try { setData(await meetingService.list()); } catch { setFailed(true); }
    }, []);
    useEffect(() => { void load(); }, [load]);

    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!data || !q) return data?.meetings ?? [];
        return data.meetings.filter(m => `${m.title} ${m.summary} ${m.transcript} ${m.attendees.map(a => a.name).join(' ')}`.toLowerCase().includes(q));
    }, [data, query]);

    const ai = data?.ai ?? { text: false, transcribe: false };
    const close = () => { setOpen(null); void load(); };
    const openById = (id: string) => { const m = data?.meetings.find(x => x.id === id); if (m) setOpen({ meeting: m, autoRun: false }); };

    if (open === 'new') return <NewMeeting ai={ai} team={team} onCancel={() => setOpen(null)} onSaved={m => { setOpen({ meeting: m, autoRun: true }); void load(); }} />;
    if (open === 'ask') return <AskAll ai={ai} onBack={() => setOpen(null)} onOpen={openById} />;
    if (open) return <MeetingDetail key={open.meeting.id} initial={open.meeting} autoRun={open.autoRun} ai={ai} canEdit={canEdit} team={team} onAddTasks={onAddTasks} onDone={close} />;

    let body: React.ReactNode = <div className="py-16 flex justify-center text-[var(--neu-text-dim)]"><Loader2 size={22} className="animate-spin" /></div>;
    if (failed) {
        body = <EmptyState icon={<Users size={22} strokeWidth={1.5} />} title="Meetings didn’t load" message="Check your connection and try again." action={<Button onClick={() => { void load(); }}>Try again</Button>} />;
    } else if (data?.meetings.length === 0) {
        body = <EmptyState icon={<Mic size={22} strokeWidth={1.5} />} title="No meetings yet" message="Record, upload or type a meeting. You get a summary, action items and who said what, and can ask questions about it."
            action={canEdit ? <Button variant="primary" icon={<Plus size={15} />} onClick={() => setOpen('new')}>New meeting</Button> : undefined} />;
    } else if (data) {
        body = (
            <div className="space-y-3">
                <div className="flex gap-2">
                    <div className="relative flex-1">
                        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--neu-text-dim)]" aria-hidden />
                        <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search meetings" aria-label="Search meetings" className="!pl-9" />
                    </div>
                    {ai.text && <Button icon={<MessagesSquare size={15} />} onClick={() => setOpen('ask')}>Ask</Button>}
                </div>
                {shown.length === 0 ? <p className="text-center text-[13px] text-[var(--neu-text-dim)] py-6">No meeting mentions “{query}”.</p> : <MeetingRows meetings={shown} onOpen={m => setOpen({ meeting: m, autoRun: false })} />}
            </div>
        );
    }

    return (
        <PageRoot>
            <PageHeader title="Meetings" subtitle="Record, summarize, ask"
                actions={canEdit ? <PrimaryIconButton onClick={() => setOpen('new')} label="New meeting" icon={<Plus size={16} />} /> : undefined} />
            <PageBody>{body}</PageBody>
        </PageRoot>
    );
};

const MeetingRows: React.FC<{ meetings: Meeting[]; onOpen: (m: Meeting) => void }> = ({ meetings, onOpen }) => (
    <ul className="neu-card px-2 py-1">
        {meetings.map(m => {
            const open = m.actionItems.filter(a => !a.done).length;
            const meta = [typeLabel(m.type), when(m.heldAt), m.durationSec ? clock(m.durationSec) : '', open ? `${open} to do` : '', m.createdByName].filter(Boolean).join(' · ');
            return (
                <li key={m.id} className="task-row">
                    <button type="button" onClick={() => onOpen(m)} className="w-full flex items-center gap-3 px-2 py-3 text-left rounded-xl active-scale">
                        <span className="flex-1 min-w-0">
                            <span className="block font-serif text-[15px] text-gray-900 dark:text-white truncate">{m.title}</span>
                            <span className="block mt-0.5 text-[11.5px] text-[var(--neu-text-dim)] truncate">{meta}</span>
                        </span>
                        {m.parts.length ? <Mic size={14} className="shrink-0 text-[var(--neu-text-dim)]" aria-label="Recorded" /> : <Keyboard size={14} className="shrink-0 text-[var(--neu-text-dim)]" aria-label="Typed" />}
                        {m.summary && <Sparkles size={14} className="shrink-0 text-gold-700 dark:text-gold-400" aria-label="Summarized" />}
                    </button>
                </li>
            );
        })}
    </ul>
);

const AskAll: React.FC<{ ai: MeetingList['ai']; onBack: () => void; onOpen: (id: string) => void }> = ({ ai, onBack, onOpen }) => (
    <PageRoot>
        <PageHeader title="Ask your meetings" subtitle="Answers from what was said" onBack={onBack} />
        <PageBody>
            <div className="neu-card p-4">
                <AskPanel enabled={ai.text} placeholder="e.g. What did we decide about the monsoon show?" onOpenSource={onOpen}
                    ask={(q, h) => meetingService.askAll(q, h)} />
            </div>
        </PageBody>
    </PageRoot>
);
