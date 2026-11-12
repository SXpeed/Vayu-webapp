// Social → Replies: WhatsApp conversations with the people invited — what they
// wrote back and the team's answers — answered freely within WhatsApp's 24
// hours, with an approved template after. Email replies go to the workspace's
// own reply-to mailbox. Server: socialInbox.ts.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { AlertCircle, CheckCheck, Clock, Loader2, Mail, MessageCircle, RefreshCw, Search, Send, UserX } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Field, GhostIconButton, Input, PageBody, PageHeader, PageRoot, Pill, Select, Textarea } from '../components/ui';
import { socialService } from '../services/socialService';
import { MEDIA_HEADERS, firstName, inviteProblem, replyWindowLeft, templateTitle, type Channel, type FieldValues, type ReplyMessage, type ReplyThread, type SocialTemplate } from '../socialRules';
import { MediaPicker, Problem, Segmented, SlotInputs, TONE, message, spinner } from './SocialTemplatesView';

const time = (ms: number) => (Date.now() - ms < 86_400_000
    ? new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
    : new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }));
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
const tick = (s?: string) => ({ read: '✓✓ Read', delivered: '✓✓', failed: 'Failed' } as Record<string, string>)[s ?? ''] ?? (s ? '✓' : '');

type Show = 'all' | 'unread' | 'waiting';

/** After their message: whether a free reply is still allowed (WhatsApp's 24 hours). */
function windowNote(t: ReplyThread): string {
    if (t.lastDir !== 'in') return '';
    return replyWindowLeft(t.lastInAt) > 0 ? ' · can reply freely' : ' · template only';
}

const ThreadRows: React.FC<{ threads: ReplyThread[]; onOpen: (phone: string) => void }> = ({ threads, onOpen }) => (
    <ul className="neu-card px-2 py-1">
        {threads.map(t => {
            return (
                <li key={t.phone} className="task-row">
                    <button type="button" onClick={() => onOpen(t.phone)} className="w-full flex items-center gap-3 px-2 py-2.5 text-left rounded-xl active-scale">
                        <span className="w-10 h-10 shrink-0 rounded-full neu-inset flex items-center justify-center text-[12px] font-semibold text-brand-900 dark:text-gold-400">{initials(t.name)}</span>
                        <span className="flex-1 min-w-0">
                            <span className="flex items-center gap-2 min-w-0">
                                <span className={`text-[14px] truncate text-gray-900 dark:text-white ${t.unread ? 'font-semibold' : ''}`}>{t.name || `+${t.phone}`}</span>
                                {t.rsvp && <Badge className={`hidden sm:inline-flex ${t.rsvp === 'yes' ? TONE.approved : ''}`}>{t.rsvp === 'yes' ? 'Coming' : 'Not coming'}</Badge>}
                            </span>
                            <span className={`block text-[12.5px] truncate ${t.unread ? 'text-gray-900 dark:text-white' : 'text-[var(--neu-text-dim)]'}`}>{t.lastDir === 'out' ? 'You: ' : ''}{t.lastText}</span>
                            <span className="block text-[11px] text-[var(--neu-text-dim)] truncate">
                                {t.inviteName}{windowNote(t)}
                            </span>
                        </span>
                        <span className="flex flex-col items-end gap-1 shrink-0">
                            <span className="text-[11px] text-[var(--neu-text-dim)]">{time(t.lastAt)}</span>
                            {t.unread > 0 && <span className="min-w-5 h-5 px-1.5 rounded-full bg-gold-500 text-white text-[11px] font-semibold flex items-center justify-center" aria-label={`${t.unread} unread`}>{t.unread}</span>}
                        </span>
                    </button>
                </li>
            );
        })}
    </ul>
);

export const RepliesTab: React.FC<{ waReady: boolean; onOpen: (phone: string) => void; onUnread: (n: number) => void }> = ({ waReady, onOpen, onUnread }) => {
    const [channel, setChannel] = useState<Channel>('whatsapp');
    const [data, setData] = useState<{ threads: ReplyThread[]; replyTo: string } | null>(null);
    const [failed, setFailed] = useState(false);
    const [show, setShow] = useState<Show>('all');
    const [query, setQuery] = useState('');
    const load = useCallback(async () => {
        setFailed(false);
        try {
            const d = await socialService.replies();
            setData(d);
            onUnread(d.threads.filter(t => t.unread).length);
        } catch { setFailed(true); }
    }, [onUnread]);
    useEffect(() => { void load(); }, [load]);
    // New replies arrive through MSG91 at any time: look again every 30 seconds while this is open.
    useEffect(() => {
        const timer = setInterval(() => { void load(); }, 30_000);
        return () => clearInterval(timer);
    }, [load]);

    const q = query.trim().toLowerCase();
    const all = (data?.threads ?? []).filter(t => !q || `${t.name} ${t.phone} ${t.lastText}`.toLowerCase().includes(q));
    const match = (t: ReplyThread, s: Show) => s === 'all' || (s === 'unread' ? t.unread > 0 : t.lastDir === 'in');
    const shown = all.filter(t => match(t, show));
    const unread = data?.threads.filter(t => t.unread).length ?? 0;

    let body: React.ReactNode = spinner;
    if (channel === 'email') {
        body = (
            <Card className="space-y-3 text-[var(--neu-text)]">
                <p className="text-[14px] text-gray-900 dark:text-white flex items-center gap-2"><Mail size={16} className="text-gold-500" />Email replies go to your mailbox</p>
                <p className="text-[13px] text-[var(--neu-text-dim)]">
                    {data?.replyTo
                        ? <>When someone answers an email invite, it lands in <b className="text-gray-900 dark:text-white">{data.replyTo}</b>. Answer it from there, as with any email. RSVP buttons and unsubscribe still record here by themselves.</>
                        : <>Set “Replies go to” under Setup and keys → Email sender, so answers to email invites reach your mailbox.</>}
                </p>
                {data?.replyTo && <a href={`mailto:${data.replyTo}`} className="neu-button inline-flex items-center gap-2 w-fit"><Mail size={15} />Open {data.replyTo}</a>}
            </Card>
        );
    } else if (!waReady) {
        body = <EmptyState icon={<MessageCircle size={22} strokeWidth={1.5} />} title="Connect WhatsApp first" message="Replies show here once your MSG91 WhatsApp number is connected and its delivery updates address is set." />;
    } else if (failed) {
        body = <EmptyState title="Replies didn’t load" message="Check your connection and try again." action={<Button onClick={() => { void load(); }}>Try again</Button>} />;
    } else if (data) {
        body = (
            <div className="space-y-3">
                <div className="flex items-center gap-2">
                    <div className="relative flex-1 min-w-0">
                        <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--neu-text-dim)] pointer-events-none" aria-hidden />
                        <Input aria-label="Search replies" placeholder="Search a name, number or message" value={query} onChange={e => setQuery(e.target.value)} className="!pl-10" />
                    </div>
                    <GhostIconButton label="Refresh" onClick={() => { void load(); }} icon={<RefreshCw size={15} className="text-brand-900 dark:text-gold-400" />} />
                </div>
                <div className="flex flex-wrap gap-2">
                    {([['all', 'All'], ['unread', 'Unread'], ['waiting', 'Needs a reply']] as [Show, string][]).map(([k, label]) => (
                        <Pill key={k} active={show === k} onClick={() => setShow(k)}>{label} {all.filter(t => match(t, k)).length}</Pill>
                    ))}
                </div>
                {shown.length
                    ? <ThreadRows threads={shown} onOpen={onOpen} />
                    : <EmptyState icon={<MessageCircle size={22} strokeWidth={1.5} />} title={data.threads.length ? 'Nothing here' : 'No replies yet'}
                        message={data.threads.length ? 'Try another filter or search.' : 'When someone answers a WhatsApp invite, the conversation shows here.'} />}
                <p className="px-3 text-[11.5px] text-[var(--neu-text-dim)]">“STOP” switches that person off and RSVP answers fill in by themselves; they still show here.</p>
            </div>
        );
    }
    return (
        <div className="space-y-3">
            <Segmented label="Channel" value={channel} onChange={setChannel} options={[
                { key: 'whatsapp', label: 'WhatsApp', Icon: MessageCircle, count: unread }, { key: 'email', label: 'Email', Icon: Mail },
            ]} />
            {body}
        </div>
    );
};

/* ------------------------------- One conversation ------------------------------- */

const Bubble: React.FC<{ m: ReplyMessage }> = ({ m }) => {
    const ours = m.dir !== 'in';
    return (
        <li className={`flex ${ours ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] sm:max-w-[70%] rounded-2xl px-3 py-2 text-[13.5px] ${ours ? 'bg-gold-500/15 rounded-br-sm text-gray-900 dark:text-white' : 'neu-card rounded-bl-sm'}`}>
                {(m.dir === 'invite' || m.template) && <p className="mb-1 text-[10.5px] uppercase tracking-wider text-[var(--neu-text-dim)]">{m.dir === 'invite' ? 'Invite' : 'Template'}{m.template ? ` · ${m.template}` : ''}</p>}
                <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{m.body}</p>
                <p className="mt-1 text-right text-[10.5px] text-[var(--neu-text-dim)]">{m.byName ? `${m.byName} · ` : ''}{time(m.at)}{m.status ? ` · ${tick(m.status)}` : ''}</p>
            </div>
        </li>
    );
};

/** After WhatsApp's 24 hours: an approved template, with its inputs and file. */
const TemplateReply: React.FC<{ phone: string; name: string; onSent: () => void }> = ({ phone, name, onSent }) => {
    const [templates, setTemplates] = useState<SocialTemplate[] | null>(null);
    const [id, setId] = useState('');
    const [values, setValues] = useState<FieldValues>({});
    const [media, setMedia] = useState<string[]>([]);
    const [uploading, setUploading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState('');
    useEffect(() => { socialService.templates('whatsapp').then(list => setTemplates(list.filter(t => t.status === 'approved'))).catch(() => setTemplates([])); }, []);
    const t = templates?.find(x => x.id === id);
    const send = async () => {
        if (!t) return;
        const missing = inviteProblem(t, values, media[0] ?? '');
        if (missing) { setProblem(missing); return; }
        setBusy(true); setProblem('');
        try { await socialService.reply(phone, { templateId: t.id, values, imageUrl: media[0] ?? '' }); toast.success('Sent'); setId(''); setValues({}); setMedia([]); onSent(); } catch (e) { setProblem(message(e)); } finally { setBusy(false); }
    };
    if (!templates) return <div className="py-2 flex justify-center text-[var(--neu-text-dim)]"><Loader2 size={16} className="animate-spin" /></div>;
    if (!templates.length) return <p className="text-[12.5px] text-[var(--neu-text-dim)]">No approved WhatsApp template yet. Make one under Templates.</p>;
    return (
        <div className="space-y-3">
            <Field label="Approved template" htmlFor="rt-template">
                <Select id="rt-template" value={id} onChange={e => { setId(e.target.value); setValues({}); setMedia([]); setProblem(''); }}>
                    <option value="">Choose one…</option>
                    {templates.map(x => <option key={x.id} value={x.id}>{templateTitle(x.name)}</option>)}
                </Select>
            </Field>
            {t && <SlotInputs template={t} values={values} onChange={setValues} />}
            {t && MEDIA_HEADERS.has(t.header) && <MediaPicker kind={t.header} urls={media} onChange={setMedia} onUploadingChange={setUploading} />}
            <Problem>{problem}</Problem>
            <Button variant="primary" block disabled={!t || busy || uploading} onClick={() => { void send(); }} icon={busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}>
                Send to {firstName(name || 'them')}
            </Button>
        </div>
    );
};

/** Free text within WhatsApp's 24 hours. */
const FreeReply: React.FC<{ phone: string; left: number; onSent: () => Promise<void> }> = ({ phone, left, onSent }) => {
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState('');
    const hours = Math.max(1, Math.floor(left / 3_600_000));
    const send = async () => {
        const words = text.trim();
        if (!words) return;
        setBusy(true); setProblem('');
        try { await socialService.reply(phone, { text: words }); setText(''); await onSent(); } catch (e) {
            setProblem(message(e));
            if ((e as Error & { code?: string }).code === 'window_closed') await onSent();
        } finally { setBusy(false); }
    };
    return (
        <>
            <p className="text-[12px] text-[var(--neu-text-dim)] flex items-center gap-1.5"><Clock size={13} aria-hidden />You can reply freely for {hours} more hour{hours === 1 ? '' : 's'}.</p>
            <Textarea aria-label="Your reply" rows={2} maxLength={4096} value={text} onChange={e => setText(e.target.value)} placeholder="Type a reply…"
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
            <Problem>{problem}</Problem>
            <div className="flex items-center gap-2">
                <span className="flex-1 min-w-0 text-[11.5px] text-[var(--neu-text-dim)] truncate">Sent from your WhatsApp number</span>
                <Button variant="primary" disabled={busy || !text.trim()} onClick={() => { void send(); }} icon={busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}>Send</Button>
            </div>
        </>
    );
};

/** What can be sent now: nothing (they said STOP), free text (within 24 hours), or an approved template. */
const Composer: React.FC<{ phone: string; name: string; optedOut: boolean; lastInAt: number; left: number; onSent: () => Promise<void> }> = ({ phone, name, optedOut, lastInAt, left, onSent }) => {
    if (optedOut) {
        return <p className="text-[13px] text-[var(--neu-text-dim)] flex items-start gap-2"><UserX size={15} className="mt-0.5 shrink-0" />{firstName(name)} replied STOP, so they can’t be messaged.</p>;
    }
    if (left > 0) return <FreeReply phone={phone} left={left} onSent={onSent} />;
    const why = lastInAt ? `It has been over 24 hours since ${firstName(name)} wrote.` : `${firstName(name)} hasn’t written yet.`;
    return (
        <>
            <p className="text-[12.5px] text-gold-700 dark:text-gold-300 flex items-start gap-1.5">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                {why} WhatsApp only allows an approved template now; free replies open again when they answer.
            </p>
            <TemplateReply phone={phone} name={name} onSent={() => { void onSent(); }} />
        </>
    );
};

export const ThreadPage: React.FC<{ phone: string; canSend: boolean; onBack: () => void }> = ({ phone, canSend, onBack }) => {
    const [data, setData] = useState<Awaited<ReturnType<typeof socialService.thread>> | null>(null);
    const [failed, setFailed] = useState(false);
    const [now, setNow] = useState(Date.now());
    const listRef = useRef<HTMLOListElement>(null);
    const load = useCallback(async () => {
        try { setData(await socialService.thread(phone)); setNow(Date.now()); setFailed(false); } catch { setFailed(true); }
    }, [phone]);
    useEffect(() => { void load(); }, [load]);
    useEffect(() => {
        const timer = setInterval(() => { void load(); }, 15_000);
        return () => clearInterval(timer);
    }, [load]);
    // Open on the latest message, and follow new ones.
    const count = data?.messages.length ?? 0;
    useEffect(() => { if (count) listRef.current?.lastElementChild?.scrollIntoView({ block: 'end' }); }, [count]);

    const left = data ? replyWindowLeft(data.lastInAt, now, data.windowMs) : 0;
    const name = data?.name || `+${phone}`;
    return (
        <PageRoot>
            <PageHeader title={name} subtitle={`WhatsApp · +${phone}`} onBack={onBack}
                actions={<GhostIconButton label="Refresh" onClick={() => { void load(); }} icon={<RefreshCw size={15} className="text-brand-900 dark:text-gold-400" />} />} />
            <PageBody>
                {!data && !failed && spinner}
                {failed && !data && <EmptyState title="The conversation didn’t load" message="Check your connection and try again." action={<Button onClick={() => { void load(); }}>Try again</Button>} />}
                {data && (
                    <div className="space-y-4">
                        <ol ref={listRef} aria-label="Messages" className="space-y-2">
                            {data.messages.map(m => <Bubble key={m.id} m={m} />)}
                            {!data.messages.length && <li className="py-6 text-center text-[13px] text-[var(--neu-text-dim)]">No messages yet.</li>}
                        </ol>
                        {canSend && (
                            <Card className="space-y-3 lg:sticky lg:bottom-4 text-[var(--neu-text)]">
                                <Composer phone={phone} name={name} optedOut={data.optedOut} lastInAt={data.lastInAt} left={left} onSent={load} />
                            </Card>
                        )}
                        <p className="px-3 text-[11.5px] text-[var(--neu-text-dim)] flex items-center gap-1.5"><CheckCheck size={12} aria-hidden />Read ticks show for people who keep read receipts on.</p>
                    </div>
                )}
            </PageBody>
        </PageRoot>
    );
};
