// Social → WhatsApp invites: connect the workspace's MSG91 number, write
// templates (Meta reviews them), send an invite to tagged contacts with each
// person's name and a picture, and see who it reached. Server: social.ts.
import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { AlertCircle, CalendarCheck, CheckCheck, ChevronRight, Copy, FileText, Loader2, MailOpen, MessageCircle, PlugZap, Plus, RefreshCw, Send, Settings, Trash2 } from 'lucide-react';
import { useBackClose } from '../hooks/useBackClose';
import { PageRoot, PageHeader, PageBody, GhostIconButton, PrimaryIconButton, Button, Card, SectionTitle, Field, Input, Textarea, Select, Pill, Badge, EmptyState, ToggleRow, Divider } from '../components/ui';
import { StatStrip } from '../components/StatStrip';
import { PhotoAttachments } from '../components/PhotoAttachments';
import { useAppChrome } from '../components/Layout';
import { contactService } from '../services/contactService';
import { socialService, type Audience, type WhatsAppConnection } from '../services/socialService';
import {
    FIELDS, LANGUAGES, MAX_BODY, MAX_FOOTER, NAME_TOKEN, RSVP_NO, RSVP_YES, SAMPLE, STATUS_LABEL, fieldLabel, filledBody, firstName, inviteProblem, parseTemplate, reached,
    templateFields, templateSlug, templateTitle, type FieldValues, type Invite, type Recipient, type RecipientStatus, type SocialTemplate,
} from '../socialRules';
import type { ContactTag } from '../types';

type Screen = 'list' | 'connect' | 'templates' | 'newTemplate' | 'compose' | { invite: string };

const fmt = (n: number) => n.toLocaleString('en-IN');
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '–');
const when = (ms: number) => new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const message = (e: unknown) => (e as Error).message || 'Something went wrong. Please try again.';
const spinner = <div className="py-16 flex justify-center text-[var(--neu-text-dim)]"><Loader2 size={22} className="animate-spin" /></div>;

const TONE: Partial<Record<string, string>> = {
    approved: '!text-emerald-700 dark:!text-emerald-400', sent: '!text-emerald-700 dark:!text-emerald-400', read: '!text-emerald-700 dark:!text-emerald-400',
    rejected: '!text-red-700 dark:!text-red-400', failed: '!text-red-700 dark:!text-red-400', scheduled: '!text-gold-700 dark:!text-gold-300',
};
const TEMPLATE_LABEL = { pending: 'In review', approved: 'Approved', rejected: 'Rejected' };
const INVITE_LABEL = { scheduled: 'Scheduled', sending: 'Sending', sent: 'Sent' };

/** The message as it looks in WhatsApp. */
const Bubble: React.FC<{ body: string; footer?: string; rsvp: boolean; imageUrl?: string; image: boolean; values: FieldValues }> = ({ body, footer, rsvp, imageUrl, image, values }) => (
    <div className="neu-inset rounded-2xl p-4">
        <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-white dark:bg-[#1f2c22] px-3.5 py-2.5 shadow-sm">
            {image && (imageUrl
                ? <img src={imageUrl} alt="" className="mb-2 w-full max-h-56 object-cover rounded-lg" />
                : <div className="mb-2 h-28 rounded-lg bg-black/5 dark:bg-white/10 flex items-center justify-center text-[11.5px] text-gray-500">Your picture</div>)}
            <p className="text-[13.5px] leading-relaxed whitespace-pre-line break-words text-gray-900 dark:text-gray-100">{filledBody(body, values) || 'Your message'}</p>
            {footer && <p className="mt-1 text-[11.5px] text-gray-500">{footer}</p>}
            {rsvp && <div className="mt-2 pt-2 border-t border-black/10 dark:border-white/10 grid grid-cols-2 text-center text-[13px] text-sky-700 dark:text-sky-400"><span>{RSVP_YES}</span><span>{RSVP_NO}</span></div>}
            <p className="mt-1 text-right text-[10px] text-gray-500">10:42 <CheckCheck size={12} className="inline text-sky-500" /></p>
        </div>
    </div>
);

const Problem: React.FC<{ children?: React.ReactNode }> = ({ children }) =>
    (children ? <p role="alert" className="text-[13px] text-red-600 dark:text-red-400 flex items-start gap-1.5"><AlertCircle size={14} className="mt-0.5 shrink-0" />{children}</p> : null);

const inviteLine = (i: Invite): string => (i.status === 'scheduled'
    ? `Goes out ${when(i.sendAt)} · ${fmt(i.counts.total)} people`
    : `${when(i.sendAt)} · ${fmt(i.counts.total)} people · ${pct(reached(i.counts, 'delivered'), i.counts.total)} delivered`);

/** The figures across every invite sent, and the invites themselves. */
const InviteList: React.FC<{ invites: Invite[]; onOpen: (id: string) => void }> = ({ invites, onOpen }) => {
    const done = invites.filter(i => i.status !== 'scheduled');
    const sum = (f: (i: Invite) => number) => done.reduce((s, i) => s + f(i), 0);
    const total = sum(i => i.counts.total);
    return (
        <>
            <StatStrip label="All invites" stats={[
                { label: 'Sent to', value: fmt(total), sub: done.length === 1 ? '1 invite' : `${done.length} invites`, Icon: Send },
                { label: 'Delivered', value: pct(sum(i => reached(i.counts, 'delivered')), total), Icon: CheckCheck },
                { label: 'Read', value: pct(sum(i => i.counts.read), total), Icon: MailOpen },
                { label: 'RSVP yes', value: fmt(sum(i => i.counts.yes)), sub: `${fmt(sum(i => i.counts.failed))} failed`, Icon: CalendarCheck },
            ]} />
            <ul className="neu-card px-2 py-1">
                {invites.map(i => (
                    <li key={i.id} className="task-row">
                        <button type="button" onClick={() => onOpen(i.id)} className="w-full flex items-center gap-3 px-2 py-2.5 text-left rounded-xl active-scale">
                            <span className="flex-1 min-w-0">
                                <span className="block font-serif text-[15.5px] leading-snug truncate text-gray-900 dark:text-white">{i.name}</span>
                                <span className="block mt-0.5 text-[11.5px] text-[var(--neu-text-dim)] truncate">{inviteLine(i)}</span>
                            </span>
                            <Badge className={TONE[i.status] ?? ''}>{INVITE_LABEL[i.status]}</Badge>
                            <ChevronRight size={16} className="shrink-0 text-[var(--neu-text-dim)]" aria-hidden />
                        </button>
                    </li>
                ))}
            </ul>
        </>
    );
};

/** What the first screen shows: still loading, a problem, what to do first, or the invites. */
const ListBody: React.FC<{
    failed: boolean; conn: WhatsAppConnection | null; invites: Invite[] | null; isAdmin: boolean; canSend: boolean; onRetry: () => void; go: (s: Screen) => void;
}> = ({ failed, conn, invites, isAdmin, canSend, onRetry, go }) => {
    if (failed) {
        return <EmptyState icon={<MessageCircle size={22} strokeWidth={1.5} />} title="Invites didn’t load" message="Check your connection and try again." action={<Button onClick={onRetry}>Try again</Button>} />;
    }
    if (conn && !conn.connected) {
        return (
            <EmptyState icon={<PlugZap size={22} strokeWidth={1.5} />} title="Connect your WhatsApp number"
                message={isAdmin ? 'Invites go out from your own WhatsApp Business number, through your MSG91 account.' : 'Ask an admin to connect the workspace’s MSG91 WhatsApp number.'}
                action={isAdmin ? <Button variant="primary" className="mt-4" icon={<PlugZap size={15} />} onClick={() => go('connect')}>Connect</Button> : undefined} />
        );
    }
    if (!invites) return spinner;
    if (invites.length === 0) {
        return (
            <EmptyState icon={<MessageCircle size={22} strokeWidth={1.5} />} title="No invites yet" message="Write a template, wait for Meta to approve it, then send it to a contact tag."
                action={canSend ? <Button variant="primary" className="mt-4" icon={<Plus size={15} />} onClick={() => go('compose')}>New invite</Button> : undefined} />
        );
    }
    return <InviteList invites={invites} onOpen={id => go({ invite: id })} />;
};

export const SocialInvitesView: React.FC<{ onBack: () => void }> = ({ onBack }) => {
    const { can, isAdmin } = useAppChrome();
    const canSend = can('social', 'edit');
    const [screen, setScreen] = useState<Screen>('list');
    const [conn, setConn] = useState<WhatsAppConnection | null>(null);
    const [invites, setInvites] = useState<Invite[] | null>(null);
    const [failed, setFailed] = useState(false);
    const home = () => setScreen('list');
    useBackClose(screen !== 'list', home);

    const load = useCallback(async () => {
        setFailed(false);
        try {
            const [c, list] = await Promise.all([socialService.connection(), socialService.invites()]);
            setConn(c); setInvites(list);
        } catch { setFailed(true); }
    }, []);
    useEffect(() => { if (screen === 'list') void load(); }, [screen, load]);

    if (screen === 'connect') return <Connect conn={conn} onBack={home} onChange={setConn} />;
    if (screen === 'templates') return <Templates canSend={canSend} onBack={home} onNew={() => setScreen('newTemplate')} />;
    if (screen === 'newTemplate') return <TemplateForm onDone={() => setScreen('templates')} />;
    if (screen === 'compose') return <Compose onBack={home} onTemplates={() => setScreen('templates')} onSent={inv => setScreen({ invite: inv.id })} />;
    if (typeof screen === 'object') return <InviteDetail id={screen.invite} onBack={home} />;

    const connected = !!conn?.connected;
    return (
        <PageRoot>
            <PageHeader title="WhatsApp invites" subtitle={conn?.connected ? `From +${conn.number}` : 'Through your MSG91 account'} onBack={onBack} actions={<>
                {isAdmin && connected && <GhostIconButton label="WhatsApp connection" onClick={() => setScreen('connect')} icon={<Settings size={15} className="text-brand-900 dark:text-gold-400" />} />}
                {connected && <GhostIconButton label="Templates" onClick={() => setScreen('templates')} icon={<FileText size={15} className="text-brand-900 dark:text-gold-400" />} />}
                {connected && canSend && <PrimaryIconButton label="New invite" onClick={() => setScreen('compose')} icon={<Plus size={16} />} />}
            </>} />
            <PageBody>
                <ListBody failed={failed} conn={conn} invites={invites} isAdmin={isAdmin} canSend={canSend} onRetry={() => { void load(); }} go={setScreen} />
            </PageBody>
        </PageRoot>
    );
};

/* ------------------------------- Connect ------------------------------- */

const Connect: React.FC<{ conn: WhatsAppConnection | null; onBack: () => void; onChange: (c: WhatsAppConnection) => void }> = ({ conn, onBack, onChange }) => {
    const [authKey, setAuthKey] = useState('');
    const [number, setNumber] = useState(conn?.connected ? conn.number : '');
    const [busy, setBusy] = useState(false);
    const [confirmOff, setConfirmOff] = useState(false);
    const [problem, setProblem] = useState('');

    const run = async (work: () => Promise<WhatsAppConnection>, said: string) => {
        setBusy(true); setProblem('');
        try { onChange(await work()); setAuthKey(''); setConfirmOff(false); toast.success(said); } catch (e) { setProblem(message(e)); } finally { setBusy(false); }
    };
    const copy = async (text: string) => {
        try { await navigator.clipboard.writeText(text); toast.success('Copied'); } catch { toast.error('Could not copy. Select it and copy by hand.'); }
    };

    return (
        <PageRoot width="narrow">
            <PageHeader title="Connect WhatsApp" subtitle="Through your own MSG91 account" onBack={onBack} />
            <PageBody>
                {conn?.connected && (
                    <Card className="space-y-3 text-[var(--neu-text)]">
                        <SectionTitle>Delivery updates</SectionTitle>
                        <p className="text-[13px] text-[var(--neu-text-dim)]">Paste this address into MSG91 → WhatsApp → Webhook (New), for the delivery, read, failed and inbound events. Without it, invites stay at “Sending” and RSVPs don’t show.</p>
                        <p className="neu-value text-[12px] break-all">{conn.webhookUrl}</p>
                        <Button icon={<Copy size={15} />} onClick={() => { void copy(conn.webhookUrl); }}>Copy address</Button>
                        <p className="text-[11.5px] text-[var(--neu-text-dim)]">Keep it private: anyone with this address can report deliveries for your invites.</p>
                    </Card>
                )}
                <form className="neu-card p-4 lg:p-5 space-y-4 text-[var(--neu-text)]" onSubmit={e => { e.preventDefault(); void run(() => socialService.connect(authKey, number), 'WhatsApp connected'); }}>
                    <ol className="list-decimal pl-5 space-y-1 text-[13px] text-[var(--neu-text-dim)]">
                        <li>In MSG91, set up your WhatsApp Business number (Meta verifies the business).</li>
                        <li>Open MSG91 → Authkey, create a key and turn off its “IP security”.</li>
                        <li>Paste the key and the number here.</li>
                    </ol>
                    <Field label="MSG91 auth key" htmlFor="wa-key" hint={conn?.connected ? 'Saved. Leave empty to keep it; paste a new key to replace it.' : 'Stored encrypted. It is never shown again.'}>
                        <Input id="wa-key" type="password" autoComplete="off" value={authKey} onChange={e => setAuthKey(e.target.value)} />
                    </Field>
                    <Field label="WhatsApp number (optional)" htmlFor="wa-number" hint="Leave empty to use the number on your MSG91 account. It is the number MSG91 shows under WhatsApp, which may differ from your phone number.">
                        <Input id="wa-number" type="tel" inputMode="tel" value={number} onChange={e => setNumber(e.target.value)} />
                    </Field>
                    <Problem>{problem}</Problem>
                    <Button type="submit" variant="primary" block disabled={busy || (!conn?.connected && authKey.trim().length < 10)}
                        icon={busy ? <Loader2 size={15} className="animate-spin" /> : <PlugZap size={15} />}>{conn?.connected ? 'Save' : 'Connect'}</Button>
                    {conn?.connected && (
                        <Button type="button" variant="danger" block disabled={busy} icon={<Trash2 size={15} />}
                            onClick={() => { if (confirmOff) void run(socialService.disconnect, 'WhatsApp disconnected'); else setConfirmOff(true); }}>
                            {confirmOff ? 'Tap again: invites still sending will fail' : 'Disconnect'}
                        </Button>
                    )}
                </form>
            </PageBody>
        </PageRoot>
    );
};

/* ------------------------------- Templates ------------------------------- */

const Templates: React.FC<{ canSend: boolean; onBack: () => void; onNew: () => void }> = ({ canSend, onBack, onNew }) => {
    const [templates, setTemplates] = useState<SocialTemplate[] | null>(null);
    const [busy, setBusy] = useState(false);
    const [removing, setRemoving] = useState('');
    const [skipped, setSkipped] = useState(0);

    // Opening the list asks MSG91: how Meta's review went, and any templates made in MSG91's own panel.
    const load = useCallback(async () => {
        setBusy(true);
        try {
            const got = await socialService.refreshTemplates();
            setTemplates(got.templates); setSkipped(got.skipped);
            if (!got.checked) toast.error('MSG91 did not answer. Showing what was last known.');
        } catch (e) { toast.error(message(e)); setTemplates(t => t ?? []); } finally { setBusy(false); }
    }, []);
    useEffect(() => { void load(); }, [load]);

    const remove = async (t: SocialTemplate) => {
        if (removing !== t.id) { setRemoving(t.id); return; }
        try { await socialService.removeTemplate(t.id); setTemplates(list => (list ?? []).filter(x => x.id !== t.id)); } catch (e) { toast.error(message(e)); }
        setRemoving('');
    };

    return (
        <PageRoot>
            <PageHeader title="Templates" subtitle="WhatsApp only sends messages Meta has approved" onBack={onBack} actions={<>
                <GhostIconButton label="Check approvals" disabled={busy} onClick={() => { void load(); }} icon={busy ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} className="text-brand-900 dark:text-gold-400" />} />
                {canSend && <PrimaryIconButton label="New template" onClick={onNew} icon={<Plus size={16} />} />}
            </>} />
            <PageBody>
                {!templates && spinner}
                {templates?.length === 0 && (
                    <EmptyState icon={<FileText size={22} strokeWidth={1.5} />} title="No templates yet" message="Templates already approved on your MSG91 account show here by themselves. Or start from a ready-made invite and send it for approval; Meta usually answers within a day."
                        action={canSend ? <Button variant="primary" className="mt-4" icon={<Plus size={15} />} onClick={onNew}>New template</Button> : undefined} />
                )}
                {skipped > 0 && <p className="px-3 text-[12.5px] text-[var(--neu-text-dim)]">{skipped} more on your MSG91 account can’t be sent from here yet (a video or document on top, or a link or button that needs filling in).</p>}
                {templates?.map(t => (
                    <Card key={t.id} className="space-y-3 text-[var(--neu-text)]">
                        <div className="flex items-center gap-2">
                            <p className="flex-1 min-w-0 font-serif text-[15.5px] truncate text-gray-900 dark:text-white">{templateTitle(t.name)}</p>
                            <Badge className={TONE[t.status] ?? ''}>{TEMPLATE_LABEL[t.status]}</Badge>
                        </div>
                        <Bubble body={t.body} footer={t.footer} rsvp={t.rsvp} image={t.image} values={SAMPLE} />
                        {t.status === 'rejected' && <Problem>{t.reason ? `Meta refused it: ${t.reason}` : 'Meta refused it. Change the words and send it again under a new name.'}</Problem>}
                        {canSend && <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => { void remove(t); }}>{removing === t.id ? 'Tap again to remove' : 'Remove'}</Button>}
                    </Card>
                ))}
            </PageBody>
        </PageRoot>
    );
};

const STARTERS: { title: string; body: string }[] = [
    { title: 'Exhibition opening', body: 'Hello {{name}}, you are invited to the opening of {{event}} on {{date}} at {{venue}}. We would love to see you there.' },
    { title: 'Private viewing', body: 'Hello {{name}}, we are holding a private viewing of {{event}} on {{date}} at {{venue}}, for a few of our collectors. Do join us.' },
    { title: 'Reminder', body: 'Hello {{name}}, a reminder that {{event}} is on {{date}} at {{venue}}. We look forward to seeing you.' },
];

const TemplateForm: React.FC<{ onDone: () => void }> = ({ onDone }) => {
    const [title, setTitle] = useState(STARTERS[0].title);
    const [language, setLanguage] = useState('en');
    const [body, setBody] = useState(STARTERS[0].body);
    const [footer, setFooter] = useState('Reply STOP to opt out');
    const [image, setImage] = useState(false);
    const [rsvp, setRsvp] = useState(true);
    const [sample, setSample] = useState<string[]>([]);
    const [uploading, setUploading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState('');

    // WhatsApp wants a unique name per template: the date keeps a second "Exhibition opening" from clashing.
    const name = templateSlug(`${title} ${new Date().toISOString().slice(2, 10)}`);
    const submit = async () => {
        const t = parseTemplate({ name, language, body, footer, image, rsvp });
        if ('problem' in t) { setProblem(t.problem); return; }
        if (image && !sample[0]) { setProblem('Add a sample picture: Meta wants to see one when it reviews the template.'); return; }
        setBusy(true);
        try {
            await socialService.createTemplate({ ...t, sampleImageUrl: sample[0] });
            toast.success('Sent to Meta for approval');
            onDone();
        } catch (e) { setProblem(message(e)); setBusy(false); }
    };

    return (
        <PageRoot>
            <PageHeader title="New template" onBack={onDone} />
            <PageBody>
                <div className="grid lg:grid-cols-2 gap-4 lg:items-start">
                    <form className="neu-card p-4 lg:p-5 space-y-4 text-[var(--neu-text)]" onChange={() => setProblem('')} onSubmit={e => { e.preventDefault(); void submit(); }}>
                        <Field label="Start from">
                            <div className="flex flex-wrap gap-2 mt-1">
                                {STARTERS.map(s => <Pill key={s.title} active={title === s.title && body === s.body} onClick={() => { setTitle(s.title); setBody(s.body); setProblem(''); }}>{s.title}</Pill>)}
                            </div>
                        </Field>
                        <Field label="Name (only your team sees this)" htmlFor="tpl-title"><Input id="tpl-title" maxLength={40} value={title} onChange={e => setTitle(e.target.value)} /></Field>
                        <Field label="Message" htmlFor="tpl-body" hint={`${body.length} / ${MAX_BODY}. Tap a field to add it; each person gets their own name.`}>
                            <Textarea id="tpl-body" rows={6} maxLength={MAX_BODY} value={body} onChange={e => setBody(e.target.value)} />
                            <div className="flex flex-wrap gap-2 mt-2">
                                {FIELDS.map(f => <Pill key={f} onClick={() => { setBody(b => `${b}${b && !/\s$/.test(b) ? ' ' : ''}{{${f}}} `); setProblem(''); }}>+ {f}</Pill>)}
                            </div>
                        </Field>
                        <Field label="Small print (optional)" htmlFor="tpl-footer"><Input id="tpl-footer" maxLength={MAX_FOOTER} value={footer} onChange={e => setFooter(e.target.value)} /></Field>
                        <Field label="Language" htmlFor="tpl-lang">
                            <Select id="tpl-lang" value={language} onChange={e => setLanguage(e.target.value)}>
                                {Object.entries(LANGUAGES).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                            </Select>
                        </Field>
                        <ToggleRow title="Ask for RSVP" description={`Adds “${RSVP_YES}” and “${RSVP_NO}” buttons; answers show on the invite`} checked={rsvp} onChange={() => { setRsvp(r => !r); setProblem(''); }} />
                        <ToggleRow title="Picture on top" description="You choose the picture each time you send (JPG or PNG, up to 5 MB)" checked={image} onChange={() => { setImage(i => !i); setProblem(''); }} />
                        {image && (
                            <Field label="One sample picture for Meta’s review">
                                <PhotoAttachments urls={sample} onUploadingChange={setUploading} onAdd={urls => setSample(urls.slice(-1))} onRemove={() => setSample([])} />
                            </Field>
                        )}
                        <Problem>{problem}</Problem>
                        <Button type="submit" variant="primary" block disabled={busy || uploading} icon={busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}>
                            {busy ? 'Sending…' : 'Send for approval'}
                        </Button>
                        <p className="text-[11.5px] text-[var(--neu-text-dim)]">Meta reviews every template, usually within a day. It can’t be changed afterwards; make a new one instead.</p>
                    </form>
                    <section>
                        <SectionTitle className="px-3">Preview</SectionTitle>
                        <Bubble body={body} footer={footer} rsvp={rsvp} image={image} imageUrl={sample[0]} values={SAMPLE} />
                    </section>
                </div>
            </PageBody>
        </PageRoot>
    );
};

/* ------------------------------- New invite ------------------------------- */

function audienceHint(a: Audience | null): string {
    if (!a) return 'Tag the contacts who agreed to WhatsApp messages (in Contacts), then choose that tag.';
    const stopped = a.optedOut ? ` (${fmt(a.optedOut)} replied STOP)` : '';
    return `${fmt(a.reachable)} of ${fmt(a.total)} can be reached${stopped}. Only message people who agreed to hear from you on WhatsApp.`;
}

const Compose: React.FC<{ onBack: () => void; onTemplates: () => void; onSent: (i: Invite) => void }> = ({ onBack, onTemplates, onSent }) => {
    const [templates, setTemplates] = useState<SocialTemplate[] | null>(null);
    const [tags, setTags] = useState<ContactTag[]>([]);
    const [name, setName] = useState('');
    const [templateId, setTemplateId] = useState('');
    const [tagIds, setTagIds] = useState<string[]>([]);
    const [values, setValues] = useState<FieldValues>({});
    const [images, setImages] = useState<string[]>([]);
    const [sendAt, setSendAt] = useState('');
    const [testPhone, setTestPhone] = useState('');
    const [audience, setAudience] = useState<Audience | null>(null);
    const [uploading, setUploading] = useState(false);
    const [busy, setBusy] = useState<'' | 'test' | 'send'>('');
    const [confirm, setConfirm] = useState(false);
    const [problem, setProblem] = useState('');

    useEffect(() => {
        Promise.all([socialService.templates(), contactService.getTags()]).then(([t, g]) => {
            const approved = t.filter(x => x.status === 'approved');
            setTemplates(approved); setTags(g); setTemplateId(approved[0]?.id ?? '');
        }).catch(e => { toast.error(message(e)); setTemplates([]); });
    }, []);
    useEffect(() => {
        setAudience(null); setConfirm(false);
        if (!tagIds.length) return;
        let stale = false;
        socialService.audience(tagIds).then(a => { if (!stale) setAudience(a); }).catch(() => { /* the hint stays empty; sending checks again */ });
        return () => { stale = true; };
    }, [tagIds]);

    const template = templates?.find(t => t.id === templateId);
    const fields = template ? templateFields(template.body).filter(f => f !== 'name') : [];
    // A template from MSG91's panel has numbered fields; the first is nearly always the person's name.
    const numbered = fields.includes('1');
    useEffect(() => { if (numbered) setValues(v => (v['1'] ? v : { ...v, 1: NAME_TOKEN })); }, [numbered, templateId]);
    const imageUrl = images[0] ?? '';
    const input = () => ({ name: name.trim(), templateId, tagIds, values, imageUrl, sendAt: sendAt ? new Date(sendAt).getTime() : 0 });
    const ready = (): boolean => {
        const p = template ? inviteProblem(template, values, imageUrl) : 'Choose a template.';
        setProblem(p ?? '');
        return !p;
    };

    const test = async () => {
        if (!ready()) return;
        setBusy('test');
        try { await socialService.test(templateId, values, imageUrl, testPhone); toast.success('Test sent. Check WhatsApp on that number.'); } catch (e) { setProblem(message(e)); }
        setBusy('');
    };
    const send = async () => {
        if (!ready()) return;
        if (!name.trim()) { setProblem('Give the invite a name.'); return; }
        if (!audience?.reachable) { setProblem('Choose who to send it to.'); return; }
        // Two taps: this sends real messages your MSG91 account is charged for.
        if (!confirm) { setConfirm(true); return; }
        setBusy('send');
        try { const made = await socialService.send(input()); toast.success(sendAt ? 'Invite scheduled' : 'Sending'); onSent(made); } catch (e) { setProblem(message(e)); setBusy(''); setConfirm(false); }
    };

    if (!templates) return <PageRoot><PageHeader title="New invite" onBack={onBack} /><PageBody>{spinner}</PageBody></PageRoot>;
    if (!templates.length) {
        return (
            <PageRoot><PageHeader title="New invite" onBack={onBack} /><PageBody>
                <EmptyState icon={<FileText size={22} strokeWidth={1.5} />} title="No approved template yet" message="WhatsApp only sends approved templates. Write one, or check whether Meta has approved yours."
                    action={<Button variant="primary" className="mt-4" onClick={onTemplates}>Open templates</Button>} />
            </PageBody></PageRoot>
        );
    }

    let sendLabel = sendAt ? `Schedule for ${fmt(audience?.reachable ?? 0)}` : `Send to ${fmt(audience?.reachable ?? 0)}`;
    if (confirm) sendLabel = `Tap again to ${sendAt ? 'schedule' : 'send'} ${fmt(audience?.reachable ?? 0)} messages`;
    if (busy === 'send') sendLabel = 'Sending…';
    const preview = { ...values, name: SAMPLE.name };
    const toggleTag = (id: string) => setTagIds(ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]));

    return (
        <PageRoot>
            <PageHeader title="New WhatsApp invite" onBack={onBack} />
            <PageBody>
                <div className="grid lg:grid-cols-2 gap-4 lg:items-start">
                    <form className="neu-card p-4 lg:p-5 space-y-4 text-[var(--neu-text)]" onChange={() => { setProblem(''); setConfirm(false); }} onSubmit={e => { e.preventDefault(); void send(); }}>
                        <Field label="Name (only your team sees this)" htmlFor="inv-name"><Input id="inv-name" maxLength={120} placeholder="Monsoon Show opening" value={name} onChange={e => setName(e.target.value)} /></Field>
                        <Field label="Send to contacts tagged"
                            hint={audienceHint(audience)}>
                            <div className="flex flex-wrap gap-2 mt-1">
                                {tags.map(t => <Pill key={t.id} active={tagIds.includes(t.id)} onClick={() => toggleTag(t.id)}>{t.name}</Pill>)}
                                {!tags.length && <p className="text-[12.5px] text-[var(--neu-text-dim)]">No tags yet. Add one in Contacts.</p>}
                            </div>
                        </Field>
                        <Field label="Template">
                            <div className="flex flex-wrap gap-2 mt-1">
                                {templates.map(t => <Pill key={t.id} active={templateId === t.id} onClick={() => { setTemplateId(t.id); setProblem(''); setConfirm(false); }}>{templateTitle(t.name)}</Pill>)}
                            </div>
                        </Field>
                        {fields.map((f, i) => (
                            <Field key={f} label={fieldLabel(f)} htmlFor={`inv-${f}`}
                                hint={numbered && i === 0 ? `${NAME_TOKEN} puts each person’s own first name there.` : undefined}>
                                <Input id={`inv-${f}`} maxLength={200} placeholder={(SAMPLE as Record<string, string>)[f]} value={values[f] ?? ''} onChange={e => setValues(v => ({ ...v, [f]: e.target.value }))} />
                            </Field>
                        ))}
                        {template?.image && (
                            <Field label="One picture (JPG or PNG, up to 5 MB)">
                                <PhotoAttachments urls={images} onUploadingChange={setUploading} onAdd={urls => setImages(urls.slice(-1))} onRemove={() => setImages([])} />
                            </Field>
                        )}
                        <Field label="Send" htmlFor="inv-when" hint="Leave empty to send now"><Input id="inv-when" type="datetime-local" value={sendAt} onChange={e => setSendAt(e.target.value)} /></Field>
                        <Divider />
                        <Field label="Try it on one number first" htmlFor="inv-test">
                            <div className="flex gap-2">
                                <Input id="inv-test" type="tel" inputMode="tel" placeholder="Your WhatsApp number" value={testPhone} onChange={e => setTestPhone(e.target.value)} />
                                <Button type="button" disabled={!!busy || uploading || !testPhone.trim()} onClick={() => { void test(); }}
                                    icon={busy === 'test' ? <Loader2 size={15} className="animate-spin" /> : undefined}>Test</Button>
                            </div>
                        </Field>
                        <Problem>{problem}</Problem>
                        <Button type="submit" variant="primary" block disabled={!!busy || uploading} icon={busy === 'send' ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}>{sendLabel}</Button>
                        <p className="text-[11.5px] text-[var(--neu-text-dim)]">WhatsApp charges for each message; MSG91 bills your account.</p>
                    </form>
                    <section>
                        <SectionTitle className="px-3">Preview, as {firstName(SAMPLE.name)} sees it</SectionTitle>
                        {template && <Bubble body={template.body} footer={template.footer} rsvp={template.rsvp} image={template.image} imageUrl={imageUrl} values={preview} />}
                    </section>
                </div>
            </PageBody>
        </PageRoot>
    );
};

/* ------------------------------- One invite ------------------------------- */

const FILTERS: { key: 'all' | RecipientStatus | 'yes'; label: string }[] = [
    { key: 'all', label: 'All' }, { key: 'delivered', label: 'Delivered' }, { key: 'read', label: 'Read' },
    { key: 'yes', label: 'RSVP yes' }, { key: 'failed', label: 'Failed' }, { key: 'submitted', label: 'Sending' },
];

function inviteSubtitle(i: Invite): string {
    const sent = i.status === 'scheduled' ? `goes out ${when(i.sendAt)}` : when(i.sendAt);
    return `${templateTitle(i.templateName)} · ${sent} · ${i.createdByName}`;
}

const InviteDetail: React.FC<{ id: string; onBack: () => void }> = ({ id, onBack }) => {
    const [data, setData] = useState<{ invite: Invite; recipients: Recipient[] } | null>(null);
    const [failed, setFailed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [filter, setFilter] = useState<typeof FILTERS[number]['key']>('all');

    const load = useCallback(async () => {
        setBusy(true); setFailed(false);
        try { setData(await socialService.invite(id)); } catch { setFailed(true); } finally { setBusy(false); }
    }, [id]);
    useEffect(() => { void load(); }, [load]);
    // Reports keep arriving for a while after sending: look again every 15 seconds while any are due.
    const waiting = !!data && (data.invite.status === 'sending' || data.invite.counts.submitted + data.invite.counts.queued > 0);
    useEffect(() => {
        if (!waiting) return;
        const timer = setInterval(() => { void load(); }, 15_000);
        return () => clearInterval(timer);
    }, [waiting, load]);

    const c = data?.invite.counts;
    const shown = (data?.recipients ?? []).filter(r => filter === 'all' || (filter === 'yes' ? r.rsvp === 'yes' : r.status === filter));
    return (
        <PageRoot>
            <PageHeader title={data?.invite.name ?? 'Invite'} onBack={onBack}
                subtitle={data ? inviteSubtitle(data.invite) : undefined}
                actions={<GhostIconButton label="Refresh" disabled={busy} onClick={() => { void load(); }} icon={busy ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} className="text-brand-900 dark:text-gold-400" />} />} />
            <PageBody>
                {!data && !failed && spinner}
                {failed && !data && <EmptyState title="The invite didn’t load" message="Check your connection and try again." action={<Button onClick={() => { void load(); }}>Try again</Button>} />}
                {data && c && (
                    <>
                        <StatStrip label="How it did" cols="grid-cols-2 md:grid-cols-3" stats={[
                            { label: 'People', value: fmt(c.total), sub: c.queued ? `${fmt(c.queued)} waiting to send` : undefined, Icon: Send },
                            { label: 'Delivered', value: fmt(reached(c, 'delivered')), sub: pct(reached(c, 'delivered'), c.total), Icon: CheckCheck },
                            { label: 'Read', value: fmt(c.read), sub: pct(c.read, c.total), Icon: MailOpen },
                            { label: 'RSVP yes', value: fmt(c.yes), sub: c.no ? `${fmt(c.no)} said no` : undefined, Icon: CalendarCheck },
                            { label: 'Failed', value: fmt(c.failed), sub: pct(c.failed, c.total), Icon: AlertCircle, alert: c.failed > 0 },
                            { label: 'No report yet', value: fmt(c.submitted + c.sent), sub: 'Sent, awaiting report', Icon: Loader2 },
                        ]} footer="Read is counted only for people who keep read receipts on." />
                        <div className="flex flex-wrap gap-2">
                            {FILTERS.map(f => <Pill key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>{f.label}</Pill>)}
                        </div>
                        <ul className="neu-card px-2 py-1">
                            {shown.map(r => (
                                <li key={r.id} className="task-row flex items-center gap-3 px-2 py-2.5">
                                    <span className="flex-1 min-w-0">
                                        <span className="block text-[13.5px] truncate text-gray-900 dark:text-white">{r.name || `+${r.phone}`}</span>
                                        <span className="block text-[11.5px] text-[var(--neu-text-dim)] truncate">{r.status === 'failed' && r.reason ? r.reason : `+${r.phone}`}</span>
                                    </span>
                                    {r.rsvp && <Badge className={r.rsvp === 'yes' ? TONE.approved : ''}>{r.rsvp === 'yes' ? 'Coming' : 'Not coming'}</Badge>}
                                    <Badge className={TONE[r.status] ?? ''}>{STATUS_LABEL[r.status]}</Badge>
                                </li>
                            ))}
                            {!shown.length && <li className="px-2 py-6 text-center text-[13px] text-[var(--neu-text-dim)]">Nobody here.</li>}
                        </ul>
                    </>
                )}
            </PageBody>
        </PageRoot>
    );
};
