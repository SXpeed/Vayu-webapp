// Social: one place for invites on WhatsApp and by email, through the
// workspace's own MSG91 account. Tabs: Overview (figures, setup, what's
// coming), Invites, Templates, Audience (who each tag reaches, opt-outs) and
// Settings. A new invite is four steps; an invite's page shows each person,
// with search, export, resend-to-failed and cancel. Server: social.ts.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import {
    AlertCircle, AtSign, CalendarCheck, CalendarClock, Check, CheckCheck, ChevronLeft, ChevronRight, CircleDashed, Copy, Download, FileText, LayoutDashboard,
    Loader2, MailOpen, Megaphone, PlugZap, Plus, RefreshCw, Repeat, RotateCcw, Search, Send, Settings, Tags, Trash2, UserX, Users, X,
} from 'lucide-react';
import { useBackClose } from '../hooks/useBackClose';
import { useIsDesktop } from '../hooks/useMediaQuery';
import { PageRoot, PageHeader, PageBody, GhostIconButton, PrimaryIconButton, Button, Card, SectionTitle, Field, Input, Pill, Badge, EmptyState, ToggleRow } from '../components/ui';
import { StatStrip } from '../components/StatStrip';
import { useAppChrome } from '../components/Layout';
import { contactService } from '../services/contactService';
import { saveBlob } from '../services/saveFile';
import { socialService, type Audience, type EmailSender, type Msg91Connection, type Reach } from '../services/socialService';
import { toCsv } from '../invoicingReports';
import {
    MEDIA_HEADERS, MEDIA_RULES, NAME_TOKEN, SAMPLE, STATUS_LABEL, filledBody, firstName, inviteProblem, readLabel, reached, sendSlots, templateTitle,
    type Channel, type FieldValues, type Invite, type Recipient, type RecipientStatus, type SocialTemplate,
} from '../socialRules';
import type { ContactTag } from '../types';
import {
    CHANNEL_ICON, CHANNEL_NAME, MediaPicker, Problem, TONE, TemplateForm, TemplatePage, TemplatePreview, TemplatesPanel, message, spinner, type ChannelFilter,
} from './SocialTemplatesView';

const fmt = (n: number) => n.toLocaleString('en-IN');
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '–');
const when = (ms: number) => new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const INVITE_LABEL = { scheduled: 'Scheduled', sending: 'Sending', sent: 'Sent' };
const CHANNELS: Channel[] = ['whatsapp', 'email'];

const WORDS = {
    whatsapp: { word: 'messages', audience: 'WhatsApp messages', address: 'WhatsApp number', anAddress: 'a WhatsApp number', addressInput: 'tel', billing: 'WhatsApp charges for each message; MSG91 bills your account.' },
    email: { word: 'emails', audience: 'emails', address: 'email address', anAddress: 'an email address', addressInput: 'email', billing: 'MSG91 bills your account for each email.' },
} as const;

type Tab = 'overview' | 'invites' | 'templates' | 'audience' | 'settings';
const TABS: { key: Tab; label: string; Icon: React.ElementType }[] = [
    { key: 'overview', label: 'Overview', Icon: LayoutDashboard }, { key: 'invites', label: 'Invites', Icon: Send },
    { key: 'templates', label: 'Templates', Icon: FileText }, { key: 'audience', label: 'Audience', Icon: Users }, { key: 'settings', label: 'Settings', Icon: Settings },
];

/** Where a new invite starts: a channel, template, tags and inputs already chosen ("Use again", "Invite this tag"). */
export interface Preset { channel?: Channel; templateId?: string; tagIds?: string[]; values?: FieldValues; imageUrl?: string; name?: string }

type Overlay =
    | { kind: 'compose'; preset: Preset }
    | { kind: 'invite'; id: string }
    | { kind: 'newTemplate'; channel: Channel }
    | { kind: 'template'; t: SocialTemplate };

/** What a channel still needs before invites can go: the MSG91 account, a WhatsApp number, or the email sender. */
function setupNeeded(channel: Channel, conn: Msg91Connection | null): string | null {
    if (!conn) return null;
    if (!conn.connected) return 'Connect your MSG91 account';
    if (channel === 'whatsapp' && !conn.number) return 'Connect a WhatsApp number in MSG91';
    if (channel === 'email' && !conn.email) return 'Set who your emails come from';
    return null;
}

const senderName = (conn: Msg91Connection | null) => (conn?.connected && conn.email ? `${conn.email.fromName} <${conn.email.from}>` : '');

/** Totals over invites that have gone out. */
function totalsOf(invites: Invite[]) {
    const done = invites.filter(i => i.status !== 'scheduled');
    const sum = (f: (i: Invite) => number) => done.reduce((s, i) => s + f(i), 0);
    return { invites: done.length, people: sum(i => i.counts.total), delivered: sum(i => reached(i.counts, 'delivered')), read: sum(i => i.counts.read), yes: sum(i => i.counts.yes), failed: sum(i => i.counts.failed) };
}

/* ------------------------------- Pieces ------------------------------- */

const ChannelIcon: React.FC<{ channel: Channel; size?: number }> = ({ channel, size = 15 }) => React.createElement(CHANNEL_ICON[channel], { size, strokeWidth: 1.6, 'aria-label': CHANNEL_NAME[channel] });

/** All / WhatsApp / Email. */
const ChannelSwitch: React.FC<{ value: ChannelFilter; onChange: (c: ChannelFilter) => void }> = ({ value, onChange }) => (
    <div className="flex gap-2">
        {(['all', ...CHANNELS] as ChannelFilter[]).map(c => (
            <Pill key={c} active={value === c} onClick={() => onChange(c)}>{c === 'all' ? 'All' : CHANNEL_NAME[c]}</Pill>
        ))}
    </div>
);

/** The tab row: scrolls sideways on a narrow phone rather than wrapping. */
const TabBar: React.FC<{ tab: Tab; onTab: (t: Tab) => void; badges: Partial<Record<Tab, number>> }> = ({ tab, onTab, badges }) => (
    <nav aria-label="Social sections" className="-mx-4 px-4 overflow-x-auto [scrollbar-width:none]">
        <div className="flex gap-2 w-max pb-0.5">
            {TABS.map(t => (
                <Pill key={t.key} active={tab === t.key} onClick={() => onTab(t.key)}>
                    <t.Icon size={14} className="inline -mt-0.5 mr-1.5" aria-hidden />{t.label}
                    {!!badges[t.key] && <span className="ml-1.5 text-[11px] tabular-nums opacity-70">{badges[t.key]}</span>}
                </Pill>
            ))}
        </div>
    </nav>
);

const inviteLine = (i: Invite): string => (i.status === 'scheduled'
    ? `Goes out ${when(i.sendAt)} · ${fmt(i.counts.total)} people`
    : `${when(i.sendAt)} · ${fmt(i.counts.total)} people · ${pct(reached(i.counts, 'delivered'), i.counts.total)} delivered`);

const InviteRows: React.FC<{ invites: Invite[]; onOpen: (id: string) => void }> = ({ invites, onOpen }) => (
    <ul className="neu-card px-2 py-1">
        {invites.map(i => (
            <li key={i.id} className="task-row">
                <button type="button" onClick={() => onOpen(i.id)} className="w-full flex items-center gap-3 px-2 py-2.5 text-left rounded-xl active-scale">
                    <span className="w-9 h-9 shrink-0 rounded-full neu-inset flex items-center justify-center text-brand-900 dark:text-gold-400"><ChannelIcon channel={i.channel} /></span>
                    <span className="flex-1 min-w-0">
                        <span className="block font-serif text-[15px] leading-snug truncate text-gray-900 dark:text-white">{i.name}</span>
                        <span className="block mt-0.5 text-[11.5px] text-[var(--neu-text-dim)] truncate">{inviteLine(i)}</span>
                    </span>
                    {i.counts.yes > 0 && <Badge className={`hidden sm:inline-flex ${TONE.approved}`}>{fmt(i.counts.yes)} coming</Badge>}
                    <Badge className={TONE[i.status] ?? ''}>{INVITE_LABEL[i.status]}</Badge>
                    <ChevronRight size={16} className="shrink-0 text-[var(--neu-text-dim)]" aria-hidden />
                </button>
            </li>
        ))}
    </ul>
);

/* ------------------------------- Overview ------------------------------- */

interface Step { done: boolean; title: string; line: string }

/** What is left to set up, in order; empty when everything is ready. */
function setupSteps(conn: Msg91Connection | null, approved: Record<Channel, number>): Step[] {
    const c = conn?.connected ? conn : null;
    return [
        { done: !!c, title: 'Connect MSG91', line: 'Paste your MSG91 auth key (with “IP security” off).' },
        { done: !!c?.number, title: 'WhatsApp number', line: 'Set up your WhatsApp Business number in MSG91.' },
        { done: !!c?.email, title: 'Email sender', line: 'Verify a domain in MSG91 → Email → Domains, then set it here.' },
        { done: approved.whatsapp + approved.email > 0, title: 'An approved template', line: 'Write one, or approve one in MSG91; it shows here by itself.' },
    ];
}

const SetupCard: React.FC<{ steps: Step[]; onSettings: () => void; isAdmin: boolean }> = ({ steps, onSettings, isAdmin }) => {
    const left = steps.filter(s => !s.done).length;
    if (!left) return null;
    return (
        <Card className="space-y-3 text-[var(--neu-text)]">
            <SectionTitle actions={isAdmin ? <Button onClick={onSettings} icon={<PlugZap size={15} />}>Set up</Button> : undefined}>Getting ready · {steps.length - left} of {steps.length} done</SectionTitle>
            <ol className="space-y-2.5">
                {steps.map(s => (
                    <li key={s.title} className="flex items-start gap-2.5">
                        {s.done ? <Check size={16} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="Done" /> : <CircleDashed size={16} className="mt-0.5 shrink-0 text-[var(--neu-text-dim)]" aria-label="To do" />}
                        <span className="min-w-0">
                            <span className={`block text-[13.5px] ${s.done ? 'text-[var(--neu-text-dim)] line-through' : 'text-gray-900 dark:text-white'}`}>{s.title}</span>
                            {!s.done && <span className="block text-[12px] text-[var(--neu-text-dim)]">{s.line}</span>}
                        </span>
                    </li>
                ))}
            </ol>
        </Card>
    );
};

const ChannelCard: React.FC<{ channel: Channel; conn: Msg91Connection | null; invites: Invite[]; canSend: boolean; onNew: () => void; onSetup: () => void }> = ({ channel, conn, invites, canSend, onNew, onSetup }) => {
    const need = setupNeeded(channel, conn);
    const t = totalsOf(invites.filter(i => i.channel === channel));
    let from = 'Not set up';
    if (!need && conn?.connected) from = channel === 'email' ? conn.email?.from ?? '' : `+${conn.number}`;
    return (
        <Card className="space-y-3 text-[var(--neu-text)]">
            <div className="flex items-center gap-3">
                <span className="w-10 h-10 shrink-0 rounded-full neu-inset flex items-center justify-center text-brand-900 dark:text-gold-400"><ChannelIcon channel={channel} size={18} /></span>
                <span className="flex-1 min-w-0">
                    <span className="block font-serif text-[16px] text-gray-900 dark:text-white">{CHANNEL_NAME[channel]} invites</span>
                    <span className="block text-[11.5px] text-[var(--neu-text-dim)] truncate">{from}</span>
                </span>
                <Badge className={need ? '' : TONE.approved}>{need ? 'Needs setup' : 'Ready'}</Badge>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
                {[['Invites', fmt(t.invites)], ['Delivered', pct(t.delivered, t.people)], ['Coming', fmt(t.yes)]].map(([label, value]) => (
                    <div key={label} className="neu-inset rounded-xl py-2">
                        <p className="font-serif text-[17px] tabular-nums text-gray-900 dark:text-white">{value}</p>
                        <p className="text-[10.5px] uppercase tracking-wider text-[var(--neu-text-dim)]">{label}</p>
                    </div>
                ))}
            </div>
            {need
                ? <Button block onClick={onSetup} icon={<PlugZap size={15} />}>{need}</Button>
                : canSend && <Button block variant="primary" onClick={onNew} icon={<Plus size={15} />}>New {CHANNEL_NAME[channel]} invite</Button>}
        </Card>
    );
};

const Overview: React.FC<{
    conn: Msg91Connection | null; invites: Invite[]; approved: Record<Channel, number>; isAdmin: boolean; canSend: boolean;
    go: (t: Tab) => void; compose: (p: Preset) => void; openInvite: (id: string) => void;
}> = ({ conn, invites, approved, isAdmin, canSend, go, compose, openInvite }) => {
    const t = totalsOf(invites);
    const upcoming = invites.filter(i => i.status === 'scheduled').sort((a, b) => a.sendAt - b.sendAt);
    const recent = invites.filter(i => i.status !== 'scheduled').slice(0, 5);
    return (
        <div className="space-y-4">
            <SetupCard steps={setupSteps(conn, approved)} onSettings={() => go('settings')} isAdmin={isAdmin} />
            <StatStrip label="All invites" stats={[
                { label: 'Invited', value: fmt(t.people), sub: t.invites === 1 ? '1 invite' : `${fmt(t.invites)} invites`, Icon: Send },
                { label: 'Delivered', value: pct(t.delivered, t.people), sub: t.failed ? `${fmt(t.failed)} failed` : fmt(t.delivered), Icon: CheckCheck },
                { label: 'Read / opened', value: pct(t.read, t.people), sub: fmt(t.read), Icon: MailOpen },
                { label: 'Coming', value: fmt(t.yes), sub: 'RSVP yes', Icon: CalendarCheck },
            ]} />
            <div className="grid md:grid-cols-2 gap-4">
                {CHANNELS.map(c => <ChannelCard key={c} channel={c} conn={conn} invites={invites} canSend={canSend} onNew={() => compose({ channel: c })} onSetup={() => go('settings')} />)}
            </div>
            {upcoming.length > 0 && (
                <section>
                    <SectionTitle className="px-3"><CalendarClock size={13} className="inline -mt-0.5 mr-1.5" aria-hidden />Coming up</SectionTitle>
                    <InviteRows invites={upcoming} onOpen={openInvite} />
                </section>
            )}
            <section>
                <SectionTitle className="px-3" actions={invites.length > 0 ? <Button onClick={() => go('invites')} icon={<ChevronRight size={15} />}>All invites</Button> : undefined}>Recent</SectionTitle>
                {recent.length
                    ? <InviteRows invites={recent} onOpen={openInvite} />
                    : <EmptyState icon={<Megaphone size={22} strokeWidth={1.5} />} title="No invites sent yet" message="Pick a template, choose who gets it by contact tag, and send now or later." />}
            </section>
        </div>
    );
};

/* ------------------------------- Invites tab ------------------------------- */

type StateFilter = 'all' | Invite['status'];

const InvitesTab: React.FC<{ invites: Invite[]; filter: ChannelFilter; onFilter: (c: ChannelFilter) => void; openInvite: (id: string) => void; canSend: boolean; compose: () => void }> = ({ invites, filter, onFilter, openInvite, canSend, compose }) => {
    const [state, setState] = useState<StateFilter>('all');
    const [query, setQuery] = useState('');
    const q = query.trim().toLowerCase();
    const byChannel = invites.filter(i => (filter === 'all' || i.channel === filter) && (!q || `${i.name} ${templateTitle(i.templateName)} ${i.createdByName}`.toLowerCase().includes(q)));
    const shown = byChannel.filter(i => state === 'all' || i.status === state);
    const count = (s: StateFilter) => byChannel.filter(i => s === 'all' || i.status === s).length;
    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[12rem]">
                    <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--neu-text-dim)] pointer-events-none" aria-hidden />
                    <Input aria-label="Search invites" placeholder="Search invites" value={query} onChange={e => setQuery(e.target.value)} className="!pl-10" />
                </div>
                {canSend && <Button variant="primary" icon={<Plus size={15} />} onClick={compose}>New invite</Button>}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
                <ChannelSwitch value={filter} onChange={onFilter} />
                <div className="flex flex-wrap gap-2">
                    {(['all', 'scheduled', 'sending', 'sent'] as StateFilter[]).map(s => <Pill key={s} active={state === s} onClick={() => setState(s)}>{s === 'all' ? 'Any state' : INVITE_LABEL[s]} {count(s)}</Pill>)}
                </div>
            </div>
            {shown.length
                ? <InviteRows invites={shown} onOpen={openInvite} />
                : <EmptyState icon={<Send size={22} strokeWidth={1.5} />} title={invites.length ? 'None match' : 'No invites yet'} message={invites.length ? 'Try another search or filter.' : 'Your invites and how each did will show here.'} />}
        </div>
    );
};

/* ------------------------------- Audience tab ------------------------------- */

const AudienceTab: React.FC<{ canSend: boolean; ready: Record<Channel, boolean>; compose: (p: Preset) => void; onContacts: () => void }> = ({ canSend, ready, compose, onContacts }) => {
    const [reach, setReach] = useState<Reach | null>(null);
    const [failed, setFailed] = useState(false);
    const [query, setQuery] = useState('');
    const load = useCallback(async () => {
        setFailed(false);
        try { setReach(await socialService.reach()); } catch { setFailed(true); }
    }, []);
    useEffect(() => { void load(); }, [load]);
    if (failed) return <EmptyState title="Audience didn’t load" message="Check your connection and try again." action={<Button onClick={() => { void load(); }}>Try again</Button>} />;
    if (!reach) return spinner;
    const q = query.trim().toLowerCase();
    const optouts = reach.optouts.filter(o => !q || o.address.includes(q));
    const invite = (tagId: string, channel: Channel) => compose({ channel, tagIds: [tagId] });
    return (
        <div className="space-y-4">
            <StatStrip label="Your audience" stats={[
                { label: 'Contacts', value: fmt(reach.totals.contacts), Icon: Users },
                { label: 'On WhatsApp', value: fmt(reach.totals.whatsapp), sub: 'With a number', Icon: CHANNEL_ICON.whatsapp },
                { label: 'By email', value: fmt(reach.totals.email), sub: 'With an address', Icon: CHANNEL_ICON.email },
                { label: 'Opted out', value: fmt(reach.totals.optedOut), sub: 'STOP or unsubscribe', Icon: UserX },
            ]} />
            <section className="space-y-2">
                <SectionTitle className="px-3" actions={<Button onClick={onContacts} icon={<Tags size={15} />}>Manage tags</Button>}>Who each tag reaches</SectionTitle>
                <p className="px-3 text-[12px] text-[var(--neu-text-dim)]">Invites go to contacts by tag. Keep a tag for people who agreed to hear from you, like “WhatsApp OK”.</p>
                {reach.tags.length ? (
                    <ul className="neu-card px-2 py-1">
                        {reach.tags.map(t => (
                            <li key={t.tagId} className="task-row flex flex-wrap items-center gap-x-3 gap-y-2 px-2 py-2.5">
                                <span className="flex-1 min-w-[9rem]">
                                    <span className="block text-[14px] text-gray-900 dark:text-white truncate">{t.name}</span>
                                    <span className="block text-[11.5px] text-[var(--neu-text-dim)]">{fmt(t.contacts)} contacts · {fmt(t.whatsapp)} on WhatsApp · {fmt(t.email)} by email</span>
                                </span>
                                {canSend && CHANNELS.filter(c => ready[c] && t[c] > 0).map(c => (
                                    <Button key={c} aria-label={`Invite “${t.name}” on ${CHANNEL_NAME[c]}`} onClick={() => invite(t.tagId, c)} icon={<Send size={14} />}>{CHANNEL_NAME[c]}</Button>
                                ))}
                            </li>
                        ))}
                    </ul>
                ) : <EmptyState icon={<Tags size={22} strokeWidth={1.5} />} title="No tags yet" message="Add a tag in Contacts and put it on the people you invite." action={<Button className="mt-4" onClick={onContacts}>Open Contacts</Button>} />}
            </section>
            <section className="space-y-2">
                <SectionTitle className="px-3">Opted out ({fmt(reach.optouts.length)})</SectionTitle>
                <p className="px-3 text-[12px] text-[var(--neu-text-dim)]">They replied STOP on WhatsApp or unsubscribed from an email, and are never sent another invite.</p>
                {reach.optouts.length > 8 && <Input aria-label="Search opted out" placeholder="Search a number or address" value={query} onChange={e => setQuery(e.target.value)} />}
                {!reach.optouts.length && <p className="px-3 text-[12.5px] text-[var(--neu-text-dim)]">Nobody so far.</p>}
                {optouts.length > 0 && (
                    <ul className="neu-card px-2 py-1 max-h-80 overflow-y-auto">
                        {optouts.map(o => (
                            <li key={o.address} className="task-row flex items-center gap-3 px-2 py-2">
                                <ChannelIcon channel={o.address.includes('@') ? 'email' : 'whatsapp'} size={14} />
                                <span className="flex-1 min-w-0 text-[13px] truncate">{o.address.includes('@') ? o.address : `+${o.address}`}</span>
                                <span className="text-[11.5px] text-[var(--neu-text-dim)]">{when(o.at)}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
};

/* ------------------------------- Settings tab ------------------------------- */

const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast.success('Copied'); } catch { toast.error('Could not copy. Select it and copy by hand.'); }
};

/** The address MSG91 sends delivery reports and replies to: one for WhatsApp and email. */
const WebhookCard: React.FC<{ url: string }> = ({ url }) => (
    <Card className="space-y-3 text-[var(--neu-text)]">
        <SectionTitle>Delivery updates</SectionTitle>
        <p className="text-[13px] text-[var(--neu-text-dim)]">Paste this address into MSG91 → Webhook (New), under WhatsApp (delivered, read, failed, inbound) and under Email (delivered, opened, failed, unsubscribed). Without it, invites stay at “Sending” and replies don’t show.</p>
        <p className="neu-value text-[12px] break-all">{url}</p>
        <Button icon={<Copy size={15} />} onClick={() => { void copy(url); }}>Copy address</Button>
        <p className="text-[11.5px] text-[var(--neu-text-dim)]">Keep it private: anyone with this address can report deliveries for your invites.</p>
    </Card>
);

/** Who emails come from: a domain verified in MSG91, an address on it, a name, and where replies go. */
const EmailSenderForm: React.FC<{ current: EmailSender | null; onSaved: (c: Msg91Connection) => void }> = ({ current, onSaved }) => {
    const [s, setS] = useState<EmailSender>(current ?? { domain: '', from: '', fromName: '', replyTo: '' });
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState('');
    const set = (p: Partial<EmailSender>) => { setS(x => ({ ...x, ...p })); setProblem(''); };
    const save = async () => {
        setBusy(true);
        try { onSaved(await socialService.setEmailSender(s)); toast.success('Email sender saved'); } catch (e) { setProblem(message(e)); } finally { setBusy(false); }
    };
    return (
        <form className="neu-card p-4 lg:p-5 space-y-4 text-[var(--neu-text)]" onSubmit={e => { e.preventDefault(); void save(); }}>
            <SectionTitle>Email sender</SectionTitle>
            <p className="text-[13px] text-[var(--neu-text-dim)]">In MSG91 → Email → Domains, add your domain and finish its verification (the DNS records it lists). Then give it here.</p>
            <div className="grid sm:grid-cols-2 gap-3">
                <Field label="Sending domain" htmlFor="em-domain" hint="Verified in MSG91"><Input id="em-domain" value={s.domain} onChange={e => set({ domain: e.target.value })} autoComplete="off" placeholder="galleryvayu.com" /></Field>
                <Field label="From address" htmlFor="em-from" hint="On that domain"><Input id="em-from" type="email" value={s.from} onChange={e => set({ from: e.target.value })} placeholder={s.domain ? `invites@${s.domain}` : 'invites@yourgallery.com'} /></Field>
                <Field label="From name" htmlFor="em-name"><Input id="em-name" value={s.fromName} onChange={e => set({ fromName: e.target.value })} placeholder="Vayu Gallery" /></Field>
                <Field label="Replies go to (optional)" htmlFor="em-reply"><Input id="em-reply" type="email" value={s.replyTo} onChange={e => set({ replyTo: e.target.value })} /></Field>
            </div>
            <Problem>{problem}</Problem>
            <Button type="submit" variant="primary" disabled={busy} icon={busy ? <Loader2 size={15} className="animate-spin" /> : <AtSign size={15} />}>Save sender</Button>
        </form>
    );
};

const AccountForm: React.FC<{ conn: Msg91Connection | null; onChange: (c: Msg91Connection) => void }> = ({ conn, onChange }) => {
    const connected = conn?.connected ? conn : null;
    const [authKey, setAuthKey] = useState('');
    const [number, setNumber] = useState(connected?.number ?? '');
    const [busy, setBusy] = useState(false);
    const [confirmOff, setConfirmOff] = useState(false);
    const [problem, setProblem] = useState('');
    const run = async (work: () => Promise<Msg91Connection>, said: string) => {
        setBusy(true); setProblem('');
        try { onChange(await work()); setAuthKey(''); setConfirmOff(false); toast.success(said); } catch (e) { setProblem(message(e)); } finally { setBusy(false); }
    };
    return (
        <form className="neu-card p-4 lg:p-5 space-y-4 text-[var(--neu-text)]" onSubmit={e => { e.preventDefault(); void run(() => socialService.connect(authKey, number), 'MSG91 connected'); }}>
            <SectionTitle actions={connected ? <Badge className={TONE.approved}>Connected</Badge> : undefined}>MSG91 account</SectionTitle>
            <ol className="list-decimal pl-5 space-y-1 text-[13px] text-[var(--neu-text-dim)]">
                <li>Open MSG91 → Authkey, create a key and turn off its “IP security”.</li>
                <li>For WhatsApp, set up your WhatsApp Business number in MSG91 (Meta verifies the business).</li>
                <li>Paste the key here.</li>
            </ol>
            <div className="grid sm:grid-cols-2 gap-3">
                <Field label="MSG91 auth key" htmlFor="wa-key" hint={connected ? 'Saved. Leave empty to keep it.' : 'Stored encrypted. Never shown again.'}>
                    <Input id="wa-key" type="password" autoComplete="off" value={authKey} onChange={e => setAuthKey(e.target.value)} />
                </Field>
                <Field label="WhatsApp number (optional)" htmlFor="wa-number" hint={connected && !connected.number ? 'None on this account: email only.' : 'Empty: the one on your MSG91 account.'}>
                    <Input id="wa-number" type="tel" inputMode="tel" value={number} onChange={e => setNumber(e.target.value)} />
                </Field>
            </div>
            <Problem>{problem}</Problem>
            <div className="flex flex-col sm:flex-row gap-2">
                <Button type="submit" variant="primary" className="sm:flex-1" disabled={busy || (!connected && authKey.trim().length < 10)}
                    icon={busy ? <Loader2 size={15} className="animate-spin" /> : <PlugZap size={15} />}>{connected ? 'Save' : 'Connect'}</Button>
                {connected && (
                    <Button type="button" variant="danger" className="sm:flex-1" disabled={busy} icon={<Trash2 size={15} />}
                        onClick={() => { if (confirmOff) void run(socialService.disconnect, 'MSG91 disconnected'); else setConfirmOff(true); }}>
                        {confirmOff ? 'Tap again: invites still sending will fail' : 'Disconnect'}
                    </Button>
                )}
            </div>
        </form>
    );
};

const SettingsTab: React.FC<{ conn: Msg91Connection | null; isAdmin: boolean; onChange: (c: Msg91Connection) => void }> = ({ conn, isAdmin, onChange }) => {
    if (!isAdmin) return <EmptyState icon={<Settings size={22} strokeWidth={1.5} />} title="Only an admin can change this" message="Ask an admin to connect MSG91 and set the email sender." />;
    const connected = conn?.connected ? conn : null;
    return (
        <div className="grid lg:grid-cols-2 gap-4 lg:items-start">
            <div className="space-y-4">
                <AccountForm conn={conn} onChange={onChange} />
                {connected && <EmailSenderForm current={connected.email} onSaved={onChange} />}
            </div>
            {connected && <WebhookCard url={connected.webhookUrl} />}
        </div>
    );
};

/* ------------------------------- New invite: four steps ------------------------------- */

const STEPS = ['Message', 'People', 'Details', 'Review'] as const;

function audienceHint(channel: Channel, a: Audience | null): string {
    const { audience, anAddress } = WORDS[channel];
    if (!a) return `Tag the contacts who agreed to ${audience} (in Contacts), then choose that tag.`;
    const stopped = a.optedOut ? ` (${fmt(a.optedOut)} opted out)` : '';
    return `${fmt(a.reachable)} of ${fmt(a.total)} have ${anAddress}${stopped}. Only message people who agreed to hear from you.`;
}

function sendLabelOf(count: number, later: boolean, confirm: boolean, busy: boolean, word: string): string {
    if (busy) return 'Sending…';
    if (confirm) return `Tap again to ${later ? 'schedule' : 'send'} ${fmt(count)} ${word}`;
    return later ? `Schedule for ${fmt(count)}` : `Send to ${fmt(count)}`;
}

/** The inputs a template needs when sending: its fields, the place, the end of a link, an offer code. */
const SlotInputs: React.FC<{ template: SocialTemplate; values: FieldValues; onChange: (v: FieldValues) => void }> = ({ template, values, onChange }) => {
    const slots = sendSlots(template);
    // A template from MSG91's panel has numbered fields; the first is nearly always the person's name.
    const firstNumbered = slots.find(s => /^\d+$/.test(s.key))?.key;
    if (!slots.length) return <p className="text-[13px] text-[var(--neu-text-dim)]">Nothing to fill in: each person’s name is added for you.</p>;
    return (
        <>
            {slots.map(s => (
                <Field key={s.key} label={s.label} htmlFor={`inv-${s.key}`} hint={s.key === firstNumbered ? `${NAME_TOKEN} puts each person’s own first name there.` : s.hint}>
                    <Input id={`inv-${s.key}`} maxLength={200} placeholder={template.samples[s.key] || (SAMPLE as Record<string, string>)[s.key] || ''} value={values[s.key] ?? ''}
                        onChange={e => onChange({ ...values, [s.key]: e.target.value })} />
                </Field>
            ))}
        </>
    );
};

/** Step 1: the channel and an approved template, as cards. */
const TemplateChooser: React.FC<{ templates: SocialTemplate[]; value: string; onPick: (id: string) => void; onTemplates: () => void }> = ({ templates, value, onPick, onTemplates }) => {
    const [query, setQuery] = useState('');
    const q = query.trim().toLowerCase();
    const shown = templates.filter(t => !q || `${templateTitle(t.name)} ${t.body}`.toLowerCase().includes(q));
    if (!templates.length) {
        return <EmptyState icon={<FileText size={22} strokeWidth={1.5} />} title="No approved template yet" message="Invites go out from approved templates only." action={<Button variant="primary" className="mt-4" onClick={onTemplates}>Open templates</Button>} />;
    }
    return (
        <div className="space-y-2">
            {templates.length > 5 && <Input aria-label="Search templates" placeholder="Search templates" value={query} onChange={e => setQuery(e.target.value)} />}
            <ul className="grid gap-2" aria-label="Approved templates">
                {shown.map(t => (
                    <li key={t.id}>
                        <button type="button" onClick={() => onPick(t.id)} aria-pressed={t.id === value}
                            className={`w-full text-left rounded-xl p-3 border transition-colors active-scale ${t.id === value ? 'border-gold-500 neu-inset' : 'border-[var(--neu-line)] hover:border-gold-500/60'}`}>
                            <span className="flex items-center gap-2">
                                <span className="flex-1 min-w-0 font-serif text-[15px] truncate text-gray-900 dark:text-white">{templateTitle(t.name)}</span>
                                {t.id === value && <Check size={16} className="text-gold-600 dark:text-gold-400" aria-hidden />}
                            </span>
                            {t.channel === 'email' && <span className="block text-[12.5px] truncate">{filledBody(t.headerText, SAMPLE, t.samples)}</span>}
                            <span className="mt-0.5 text-[12px] text-[var(--neu-text-dim)] line-clamp-2 break-words">{filledBody(t.body, SAMPLE, t.samples).replaceAll(/\s+/g, ' ')}</span>
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    );
};

const StepBar: React.FC<{ step: number; reachable: number; onStep: (i: number) => void }> = ({ step, reachable, onStep }) => (
    <ol className="flex gap-1.5" aria-label="Steps">
        {STEPS.map((label, i) => (
            <li key={label} className="flex-1 min-w-0">
                <button type="button" disabled={i > reachable} onClick={() => onStep(i)} aria-current={i === step ? 'step' : undefined}
                    className="w-full text-left disabled:opacity-40 disabled:cursor-not-allowed">
                    <span className={`block h-1 rounded-full ${i <= step ? 'bg-gold-500' : 'bg-black/10 dark:bg-white/10'}`} />
                    <span className={`block mt-1.5 text-[11px] font-semibold uppercase tracking-wider truncate ${i === step ? 'text-gold-700 dark:text-gold-300' : 'text-[var(--neu-text-dim)]'}`}>{i + 1} {label}</span>
                </button>
            </li>
        ))}
    </ol>
);

const defaultName = (t: SocialTemplate | undefined) => (t ? `${templateTitle(t.name)}, ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : '');

interface Draft { template?: SocialTemplate; audience: Audience | null; values: FieldValues; mediaUrl: string; name: string; later: boolean; sendAt: string }

/** Why step `i` can't be left yet, or ''. */
function stepProblemOf(i: number, d: Draft): string {
    if (i === 0) return d.template ? '' : 'Choose a template.';
    if (i === 1) return d.audience?.reachable ? '' : 'Choose a tag with people to send to.';
    if (i === 2) return (d.template && inviteProblem(d.template, d.values, d.mediaUrl)) || '';
    if (!d.name.trim()) return 'Give the invite a name.';
    return d.later && !d.sendAt ? 'Choose when to send it.' : '';
}

const StepMessage: React.FC<{
    channel: Channel; ready: Record<Channel, boolean>; templates: SocialTemplate[] | null; templateId: string;
    onChannel: (c: Channel) => void; onPick: (id: string) => void; onTemplates: () => void;
}> = ({ channel, ready, templates, templateId, onChannel, onPick, onTemplates }) => (
    <>
        <Field label="Send by">
            <div className="flex gap-2 mt-1">
                {CHANNELS.map(c => (
                    <Pill key={c} active={channel === c} onClick={() => { if (ready[c]) onChannel(c); else toast(`${CHANNEL_NAME[c]} isn’t set up yet: see Settings.`); }}>
                        <ChannelIcon channel={c} size={13} /> <span className="ml-1">{CHANNEL_NAME[c]}</span>{!ready[c] && <span className="ml-1 opacity-60">· set up first</span>}
                    </Pill>
                ))}
            </div>
        </Field>
        <Field label="Template">{templates ? <TemplateChooser templates={templates} value={templateId} onPick={onPick} onTemplates={onTemplates} /> : spinner}</Field>
    </>
);

const StepPeople: React.FC<{ channel: Channel; tags: ContactTag[]; tagIds: string[]; audience: Audience | null; onToggle: (id: string) => void }> = ({ channel, tags, tagIds, audience, onToggle }) => (
    <Field label="Send to contacts tagged" hint={audienceHint(channel, audience)}>
        <div className="flex flex-wrap gap-2 mt-1">
            {tags.map(t => <Pill key={t.id} active={tagIds.includes(t.id)} onClick={() => onToggle(t.id)}>{t.name}</Pill>)}
            {!tags.length && <p className="text-[12.5px] text-[var(--neu-text-dim)]">No tags yet. Add one in Contacts.</p>}
        </div>
    </Field>
);

const StepDetails: React.FC<{
    channel: Channel; template: SocialTemplate; values: FieldValues; onValues: (v: FieldValues) => void; media: string[]; onMedia: (u: string[]) => void;
    onUploading: (b: boolean) => void; testTo: string; onTestTo: (v: string) => void; testing: boolean; testDisabled: boolean; onTest: () => void;
}> = ({ channel, template, values, onValues, media, onMedia, onUploading, testTo, onTestTo, testing, testDisabled, onTest }) => {
    const words = WORDS[channel];
    const thing = template.header === 'image' ? 'picture' : template.header;
    return (
        <>
            <SlotInputs template={template} values={values} onChange={onValues} />
            {MEDIA_HEADERS.has(template.header) && (
                <Field label={`The ${thing} on top (${MEDIA_RULES[template.header]?.words})`}>
                    <MediaPicker kind={template.header} urls={media} onChange={onMedia} onUploadingChange={onUploading} />
                </Field>
            )}
            <Field label={`Try it on one ${words.address} first (optional)`} htmlFor="inv-test">
                <div className="flex gap-2">
                    <Input id="inv-test" type={words.addressInput} inputMode={words.addressInput} placeholder={`Your ${words.address}`} value={testTo} onChange={e => onTestTo(e.target.value)} />
                    <Button type="button" disabled={testDisabled || !testTo.trim()} onClick={onTest} icon={testing ? <Loader2 size={15} className="animate-spin" /> : undefined}>Test</Button>
                </div>
            </Field>
        </>
    );
};

const StepReview: React.FC<{
    channel: Channel; template?: SocialTemplate; audience: Audience | null; tagNames: string; sender: string;
    name: string; onName: (v: string) => void; later: boolean; onLater: () => void; sendAt: string; onSendAt: (v: string) => void;
}> = ({ channel, template, audience, tagNames, sender, name, onName, later, onLater, sendAt, onSendAt }) => (
    <>
        <Field label="Name (only your team sees this)" htmlFor="inv-name"><Input id="inv-name" maxLength={120} value={name} onChange={e => onName(e.target.value)} /></Field>
        <dl className="neu-inset rounded-xl p-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
            <dt className="text-[var(--neu-text-dim)]">By</dt><dd className="min-w-0 truncate">{CHANNEL_NAME[channel]}</dd>
            <dt className="text-[var(--neu-text-dim)]">Template</dt><dd className="min-w-0 truncate">{template ? templateTitle(template.name) : ''}</dd>
            <dt className="text-[var(--neu-text-dim)]">To</dt><dd className="min-w-0">{fmt(audience?.reachable ?? 0)} people · {tagNames}</dd>
            {sender && channel === 'email' && <><dt className="text-[var(--neu-text-dim)]">From</dt><dd className="min-w-0 truncate">{sender}</dd></>}
        </dl>
        <ToggleRow title="Send later" description={later ? 'At the time below' : 'Off: it goes as soon as you send'} checked={later} onChange={onLater} />
        {later && <Field label="Send at" htmlFor="inv-when"><Input id="inv-when" type="datetime-local" value={sendAt} onChange={e => onSendAt(e.target.value)} /></Field>}
        <p className="text-[11.5px] text-[var(--neu-text-dim)]">{WORDS[channel].billing}</p>
    </>
);

const StepButtons: React.FC<{ step: number; disabled: boolean; sending: boolean; sendLabel: string; onBack: () => void }> = ({ step, disabled, sending, sendLabel, onBack }) => {
    const last = step === STEPS.length - 1;
    const sendIcon = sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />;
    return (
        <div className="flex gap-2 pt-1">
            {step > 0 && <Button type="button" onClick={onBack} icon={<ChevronLeft size={15} />}>Back</Button>}
            <Button type="submit" variant="primary" className="flex-1" disabled={disabled} icon={last ? sendIcon : <ChevronRight size={15} />}>
                {last ? sendLabel : `Next: ${STEPS[step + 1]}`}
            </Button>
        </div>
    );
};

const Compose: React.FC<{
    preset: Preset; ready: Record<Channel, boolean>; sender: string; onBack: () => void; onTemplates: () => void; onSent: (i: Invite) => void;
}> = ({ preset, ready, sender, onBack, onTemplates, onSent }) => {
    const isDesktop = useIsDesktop();
    const firstReady = CHANNELS.find(c => ready[c]) ?? 'whatsapp';
    const [channel, setChannel] = useState<Channel>(preset.channel && ready[preset.channel] ? preset.channel : firstReady);
    const [step, setStep] = useState(0);
    const [templates, setTemplates] = useState<SocialTemplate[] | null>(null);
    const [tags, setTags] = useState<ContactTag[]>([]);
    const [templateId, setTemplateId] = useState(preset.templateId ?? '');
    const [tagIds, setTagIds] = useState<string[]>(preset.tagIds ?? []);
    const [values, setValues] = useState<FieldValues>(preset.values ?? {});
    const [media, setMedia] = useState<string[]>(preset.imageUrl ? [preset.imageUrl] : []);
    const [name, setName] = useState(preset.name ?? '');
    const [later, setLater] = useState(false);
    const [sendAt, setSendAt] = useState('');
    const [testTo, setTestTo] = useState('');
    const [audience, setAudience] = useState<Audience | null>(null);
    const [uploading, setUploading] = useState(false);
    const [busy, setBusy] = useState<'' | 'test' | 'send'>('');
    const [confirm, setConfirm] = useState(false);
    const [problem, setProblem] = useState('');

    useEffect(() => { contactService.getTags().then(setTags).catch(() => setTags([])); }, []);
    useEffect(() => {
        setTemplates(null);
        socialService.templates(channel).then(t => setTemplates(t.filter(x => x.status === 'approved'))).catch(e => { toast.error(message(e)); setTemplates([]); });
    }, [channel]);
    useEffect(() => {
        setAudience(null);
        if (!tagIds.length) return;
        let stale = false;
        socialService.audience(channel, tagIds).then(a => { if (!stale) setAudience(a); }).catch(() => { /* the hint stays empty; sending checks again */ });
        return () => { stale = true; };
    }, [channel, tagIds]);

    const template = templates?.find(t => t.id === templateId);
    const pick = (id: string) => {
        const t = templates?.find(x => x.id === id);
        setTemplateId(id); setProblem('');
        // A template from MSG91's panel: its first numbered field starts as the person's name.
        const first = t ? sendSlots(t).find(s => /^\d+$/.test(s.key))?.key : undefined;
        if (id !== preset.templateId) { setValues(first ? { [first]: NAME_TOKEN } : {}); setMedia([]); }
    };
    const switchChannel = (c: Channel) => { setChannel(c); setTemplateId(''); setValues({}); setMedia([]); setProblem(''); };
    const mediaUrl = media[0] ?? '';

    const draft: Draft = { template, audience, values, mediaUrl, name, later, sendAt };
    const stepProblem = (i: number) => stepProblemOf(i, draft);
    const furthest = [0, 1, 2].find(i => stepProblem(i)) ?? 3;
    const next = () => {
        const p = stepProblem(step);
        setProblem(p);
        if (p) return;
        if (step === 2 && !name.trim()) setName(defaultName(template));
        setStep(s => s + 1);
    };

    const test = async () => {
        const p = stepProblem(2);
        if (p) { setProblem(p); return; }
        setBusy('test');
        try { await socialService.test(channel, templateId, values, mediaUrl, testTo); toast.success(`Test sent. Check ${channel === 'email' ? 'that inbox' : 'WhatsApp on that number'}.`); } catch (e) { setProblem(message(e)); }
        setBusy('');
    };
    const send = async () => {
        const p = [0, 1, 2, 3].map(stepProblem).find(Boolean);
        if (p) { setProblem(p); return; }
        // Two taps: this sends real messages your MSG91 account is charged for.
        if (!confirm) { setConfirm(true); return; }
        setBusy('send');
        try {
            const made = await socialService.send(channel, { name: name.trim(), templateId, tagIds, values, imageUrl: mediaUrl, sendAt: later ? new Date(sendAt).getTime() : 0 });
            toast.success(later ? 'Invite scheduled' : 'Sending');
            onSent(made);
        } catch (e) { setProblem(message(e)); setBusy(''); setConfirm(false); }
    };

    const toggleTag = (id: string) => { setTagIds(ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id])); setProblem(''); setConfirm(false); };
    const tagNames = tags.filter(t => tagIds.includes(t.id)).map(t => t.name).join(', ');
    const back = () => { setStep(s => s - 1); setProblem(''); };
    const steps: React.ReactNode[] = [
        <StepMessage key="m" channel={channel} ready={ready} templates={templates} templateId={templateId} onChannel={switchChannel} onPick={pick} onTemplates={onTemplates} />,
        <StepPeople key="p" channel={channel} tags={tags} tagIds={tagIds} audience={audience} onToggle={toggleTag} />,
        template && <StepDetails key="d" channel={channel} template={template} values={values} onValues={v => { setValues(v); setProblem(''); }} media={media} onMedia={setMedia}
            onUploading={setUploading} testTo={testTo} onTestTo={setTestTo} testing={busy === 'test'} testDisabled={!!busy || uploading} onTest={() => { void test(); }} />,
        <StepReview key="r" channel={channel} template={template} audience={audience} tagNames={tagNames} sender={sender}
            name={name} onName={v => { setName(v); setConfirm(false); }} later={later} onLater={() => { setLater(l => !l); setConfirm(false); }} sendAt={sendAt} onSendAt={v => { setSendAt(v); setConfirm(false); }} />,
    ];

    const title = `New ${CHANNEL_NAME[channel]} invite`;
    const last = step === STEPS.length - 1;
    return (
        <PageRoot width="wide">
            <PageHeader title={title} subtitle={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`} onBack={step ? back : onBack}
                actions={step ? <GhostIconButton label="Close" onClick={onBack} icon={<X size={16} />} /> : undefined} />
            <PageBody>
                <div className="grid lg:grid-cols-2 gap-4 lg:items-start">
                    <form className="neu-card p-4 lg:p-5 space-y-4 text-[var(--neu-text)]" onSubmit={e => { e.preventDefault(); if (last) void send(); else next(); }}>
                        <StepBar step={step} reachable={furthest} onStep={i => { setStep(i); setProblem(''); }} />
                        {steps[step]}
                        <Problem>{problem}</Problem>
                        <StepButtons step={step} disabled={uploading || (last && !!busy)} sending={busy === 'send'} onBack={back}
                            sendLabel={sendLabelOf(audience?.reachable ?? 0, later, confirm, busy === 'send', WORDS[channel].word)} />
                    </form>
                    {(isDesktop || step >= 2) && template && (
                        <section className="lg:sticky lg:top-4">
                            <SectionTitle className="px-3">Preview, as {firstName(SAMPLE.name)} sees it</SectionTitle>
                            <TemplatePreview t={template} mediaUrl={mediaUrl} values={{ ...values, name: SAMPLE.name }} sender={sender} />
                        </section>
                    )}
                </div>
            </PageBody>
        </PageRoot>
    );
};

/* ------------------------------- One invite ------------------------------- */

type RecipientFilter = 'all' | RecipientStatus | 'yes' | 'no';

const filtersFor = (channel: Channel): { key: RecipientFilter; label: string }[] => [
    { key: 'all', label: 'All' }, { key: 'delivered', label: 'Delivered' }, { key: 'read', label: readLabel(channel) },
    { key: 'yes', label: 'Coming' }, { key: 'no', label: 'Not coming' }, { key: 'failed', label: 'Failed' }, { key: 'submitted', label: 'Sending' },
];

const statusLabel = (channel: Channel, s: RecipientStatus) => (s === 'read' ? readLabel(channel) : STATUS_LABEL[s]);
const addressText = (channel: Channel, r: Recipient) => (channel === 'email' ? r.phone : `+${r.phone}`);
const matchesFilter = (r: Recipient, f: RecipientFilter) => f === 'all' || (f === 'yes' || f === 'no' ? r.rsvp === f : r.status === f);

function inviteSubtitle(i: Invite): string {
    const sent = i.status === 'scheduled' ? `goes out ${when(i.sendAt)}` : when(i.sendAt);
    return `${CHANNEL_NAME[i.channel]} · ${templateTitle(i.templateName)} · ${sent} · ${i.createdByName}`;
}

/** Everyone on the invite as a spreadsheet: name, address, status, reason, RSVP, time. */
async function exportPeople(invite: Invite, people: Recipient[]) {
    const rows = people.map(r => [r.name, addressText(invite.channel, r), statusLabel(invite.channel, r.status), r.reason, r.rsvp, new Date(r.at).toISOString()]);
    const csv = toCsv([['Name', invite.channel === 'email' ? 'Email' : 'WhatsApp', 'Status', 'Reason', 'RSVP', 'Updated'], ...rows]);
    await saveBlob(new Blob([csv], { type: 'text/csv' }), `${invite.name.replaceAll(/[^\w -]+/g, '').trim() || 'invite'}.csv`);
}

const InviteActions: React.FC<{ invite: Invite; canSend: boolean; onUseAgain: () => void; onRetried: (i: Invite) => void; onCancelled: () => void }> = ({ invite, canSend, onUseAgain, onRetried, onCancelled }) => {
    const [busy, setBusy] = useState('');
    const [confirm, setConfirm] = useState('');
    const act = async (key: string, work: () => Promise<void>) => {
        if (confirm !== key) { setConfirm(key); return; }
        setBusy(key);
        try { await work(); } catch (e) { toast.error(message(e)); } finally { setBusy(''); setConfirm(''); }
    };
    if (!canSend) return null;
    const failed = invite.counts.failed;
    return (
        <div className="flex flex-wrap gap-2">
            <Button onClick={onUseAgain} icon={<Repeat size={15} />}>Use again</Button>
            {invite.status === 'sent' && failed > 0 && (
                <Button disabled={!!busy} icon={busy === 'retry' ? <Loader2 size={15} className="animate-spin" /> : <RotateCcw size={15} />}
                    onClick={() => { void act('retry', async () => { const made = await socialService.retryFailed(invite.id); toast.success('Sending again to those who failed'); onRetried(made); }); }}>
                    {confirm === 'retry' ? `Tap again to resend to ${fmt(failed)}` : `Resend to ${fmt(failed)} failed`}
                </Button>
            )}
            {invite.status === 'scheduled' && (
                <Button variant="danger" disabled={!!busy} icon={busy === 'cancel' ? <Loader2 size={15} className="animate-spin" /> : <X size={15} />}
                    onClick={() => { void act('cancel', async () => { await socialService.cancel(invite.id); toast.success('Invite cancelled'); onCancelled(); }); }}>
                    {confirm === 'cancel' ? 'Tap again to cancel it' : 'Cancel invite'}
                </Button>
            )}
        </div>
    );
};

const InviteDetail: React.FC<{ id: string; canSend: boolean; onBack: () => void; onUseAgain: (p: Preset) => void; onOpen: (id: string) => void }> = ({ id, canSend, onBack, onUseAgain, onOpen }) => {
    const [data, setData] = useState<{ invite: Invite; recipients: Recipient[] } | null>(null);
    const [failed, setFailed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [filter, setFilter] = useState<RecipientFilter>('all');
    const [query, setQuery] = useState('');

    const load = useCallback(async () => {
        setBusy(true); setFailed(false);
        try { setData(await socialService.invite(id)); } catch { setFailed(true); } finally { setBusy(false); }
    }, [id]);
    useEffect(() => { setData(null); void load(); }, [load]);
    // Reports keep arriving for a while after sending: look again every 15 seconds while any are due.
    const waiting = !!data && (data.invite.status === 'sending' || data.invite.counts.submitted + data.invite.counts.queued > 0);
    useEffect(() => {
        if (!waiting) return;
        const timer = setInterval(() => { void load(); }, 15_000);
        return () => clearInterval(timer);
    }, [waiting, load]);

    const invite = data?.invite;
    const c = invite?.counts;
    const q = query.trim().toLowerCase();
    const people = (data?.recipients ?? []).filter(r => !q || `${r.name} ${r.phone}`.toLowerCase().includes(q));
    const shown = people.filter(r => matchesFilter(r, filter));
    const channel = invite?.channel ?? 'whatsapp';
    const readNote = channel === 'email' ? 'Opened is counted only when the reader’s email app loads pictures.' : 'Read is counted only for people who keep read receipts on.';
    return (
        <PageRoot width="wide">
            <PageHeader title={invite?.name ?? 'Invite'} onBack={onBack} subtitle={invite ? inviteSubtitle(invite) : undefined}
                actions={<>
                    {data && <GhostIconButton label="Download the list (CSV)" onClick={() => { void exportPeople(data.invite, data.recipients); }} icon={<Download size={15} className="text-brand-900 dark:text-gold-400" />} />}
                    <GhostIconButton label="Refresh" disabled={busy} onClick={() => { void load(); }} icon={busy ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} className="text-brand-900 dark:text-gold-400" />} />
                </>} />
            <PageBody>
                {!data && !failed && spinner}
                {failed && !data && <EmptyState title="The invite didn’t load" message="Check your connection and try again." action={<Button onClick={() => { void load(); }}>Try again</Button>} />}
                {invite && c && (
                    <>
                        <StatStrip label="How it did" cols="grid-cols-2 md:grid-cols-3 lg:grid-cols-6" stats={[
                            { label: 'People', value: fmt(c.total), sub: c.queued ? `${fmt(c.queued)} waiting` : undefined, Icon: Send },
                            { label: 'Delivered', value: fmt(reached(c, 'delivered')), sub: pct(reached(c, 'delivered'), c.total), Icon: CheckCheck },
                            { label: readLabel(channel), value: fmt(c.read), sub: pct(c.read, c.total), Icon: MailOpen },
                            { label: 'Coming', value: fmt(c.yes), sub: c.no ? `${fmt(c.no)} can’t` : undefined, Icon: CalendarCheck },
                            { label: 'Failed', value: fmt(c.failed), sub: pct(c.failed, c.total), Icon: AlertCircle, alert: c.failed > 0 },
                            { label: 'No report yet', value: fmt(c.submitted + c.sent), sub: 'Awaiting MSG91', Icon: Loader2 },
                        ]} footer={readNote} />
                        <InviteActions invite={invite} canSend={canSend}
                            onUseAgain={() => onUseAgain({ channel: invite.channel, templateId: invite.templateId, tagIds: invite.tagIds, values: invite.values, imageUrl: invite.imageUrl })}
                            onRetried={made => onOpen(made.id)} onCancelled={onBack} />
                        <div className="flex flex-wrap items-center gap-2">
                            <div className="relative flex-1 min-w-[12rem]">
                                <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--neu-text-dim)] pointer-events-none" aria-hidden />
                                <Input aria-label="Search people" placeholder="Search a name, number or address" value={query} onChange={e => setQuery(e.target.value)} className="!pl-10" />
                            </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {filtersFor(channel).map(f => <Pill key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>{f.label} {people.filter(r => matchesFilter(r, f.key)).length}</Pill>)}
                        </div>
                        <ul className="neu-card px-2 py-1">
                            {shown.map(r => (
                                <li key={r.id} className="task-row flex items-center gap-3 px-2 py-2.5">
                                    <span className="flex-1 min-w-0">
                                        <span className="block text-[13.5px] truncate text-gray-900 dark:text-white">{r.name || addressText(channel, r)}</span>
                                        <span className="block text-[11.5px] text-[var(--neu-text-dim)] truncate">{r.status === 'failed' && r.reason ? r.reason : addressText(channel, r)}</span>
                                    </span>
                                    {r.rsvp && <Badge className={r.rsvp === 'yes' ? TONE.approved : ''}>{r.rsvp === 'yes' ? 'Coming' : 'Not coming'}</Badge>}
                                    <Badge className={TONE[r.status] ?? ''}>{statusLabel(channel, r.status)}</Badge>
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

/* ------------------------------- The Social space ------------------------------- */

/** The template builder, switchable between WhatsApp and email (each with its own draft). */
const TemplateBuilder: React.FC<{ initial: Channel; ready: Record<Channel, boolean>; sender: string; onDone: () => void }> = ({ initial, ready, sender, onDone }) => {
    const [channel, setChannel] = useState(initial);
    return <TemplateForm key={channel} channel={channel} sender={sender} onDone={onDone} onChannel={setChannel} channels={CHANNELS.filter(c => ready[c])} />;
};

export const SocialSpace: React.FC<{ onBack: () => void; onContacts: () => void }> = ({ onBack, onContacts }) => {
    const { can, isAdmin } = useAppChrome();
    const canSend = can('social', 'edit');
    const [tab, setTab] = useState<Tab>('overview');
    const [filter, setFilter] = useState<ChannelFilter>('all');
    const [overlay, setOverlay] = useState<Overlay | null>(null);
    const [conn, setConn] = useState<Msg91Connection | null>(null);
    const [invites, setInvites] = useState<Invite[] | null>(null);
    const [approved, setApproved] = useState<Record<Channel, number>>({ whatsapp: 0, email: 0 });
    const [failed, setFailed] = useState(false);
    const close = () => setOverlay(null);
    useBackClose(overlay !== null, close);

    const ready = useMemo(() => ({ whatsapp: !!conn && !setupNeeded('whatsapp', conn), email: !!conn && !setupNeeded('email', conn) }), [conn]);
    const load = useCallback(async () => {
        setFailed(false);
        try {
            const [c, wa, em] = await Promise.all([socialService.connection(), socialService.invites('whatsapp'), socialService.invites('email')]);
            setConn(c);
            setInvites([...wa, ...em].sort((a, b) => b.createdAt - a.createdAt));
            if (c.connected) {
                const [tw, te] = await Promise.all((['whatsapp', 'email'] as const).map(ch => socialService.templates(ch).catch(() => [])));
                setApproved({ whatsapp: tw.filter(t => t.status === 'approved').length, email: te.filter(t => t.status === 'approved').length });
            }
        } catch { setFailed(true); }
    }, []);
    useEffect(() => { if (!overlay) void load(); }, [overlay, load]);

    const sender = senderName(conn);
    const compose = (preset: Preset = {}) => setOverlay({ kind: 'compose', preset: preset.channel || filter === 'all' ? preset : { ...preset, channel: filter } });
    const openInvite = (id: string) => setOverlay({ kind: 'invite', id });

    if (overlay?.kind === 'compose') {
        return <Compose key={JSON.stringify(overlay.preset)} preset={overlay.preset} ready={ready} sender={sender} onBack={close}
            onTemplates={() => { setTab('templates'); close(); }} onSent={inv => openInvite(inv.id)} />;
    }
    if (overlay?.kind === 'invite') return <InviteDetail key={overlay.id} id={overlay.id} canSend={canSend} onBack={close} onUseAgain={compose} onOpen={openInvite} />;
    if (overlay?.kind === 'newTemplate') return <TemplateBuilder initial={overlay.channel} ready={ready} sender={sender} onDone={() => { setTab('templates'); close(); }} />;
    if (overlay?.kind === 'template') {
        return <TemplatePage t={overlay.t} sender={sender} canSend={canSend} onBack={close} onUse={() => compose({ channel: overlay.t.channel, templateId: overlay.t.id })} />;
    }

    const anyReady = ready.whatsapp || ready.email;
    const scheduled = invites?.filter(i => i.status === 'scheduled').length ?? 0;
    let subtitle = 'Invites on WhatsApp and by email';
    if (conn && !conn.connected) subtitle = 'Not connected to MSG91 yet';
    const newTemplateChannel: Channel = filter === 'all' ? (CHANNELS.find(c => ready[c]) ?? 'whatsapp') : filter;

    let body: React.ReactNode = spinner;
    if (failed) body = <EmptyState icon={<Megaphone size={22} strokeWidth={1.5} />} title="Social didn’t load" message="Check your connection and try again." action={<Button onClick={() => { void load(); }}>Try again</Button>} />;
    else if (invites && conn) {
        const views: Record<Tab, React.ReactNode> = {
            overview: <Overview conn={conn} invites={invites} approved={approved} isAdmin={isAdmin} canSend={canSend} go={setTab} compose={compose} openInvite={openInvite} />,
            invites: <InvitesTab invites={invites} filter={filter} onFilter={setFilter} openInvite={openInvite} canSend={canSend && anyReady} compose={() => compose()} />,
            templates: (
                <div className="space-y-3">
                    <ChannelSwitch value={filter} onChange={setFilter} />
                    <TemplatesPanel filter={filter} ready={ready} sender={sender} canSend={canSend} onNew={() => setOverlay({ kind: 'newTemplate', channel: newTemplateChannel })}
                        onUse={t => compose({ channel: t.channel, templateId: t.id })} onOpen={t => setOverlay({ kind: 'template', t })} />
                </div>
            ),
            audience: <AudienceTab canSend={canSend} ready={ready} compose={compose} onContacts={onContacts} />,
            settings: <SettingsTab conn={conn} isAdmin={isAdmin} onChange={setConn} />,
        };
        body = views[tab];
    }

    return (
        <PageRoot width="wide">
            <PageHeader title="Social" subtitle={subtitle} onBack={onBack}
                actions={canSend && anyReady ? <PrimaryIconButton label="New invite" onClick={() => compose()} icon={<Plus size={16} />} /> : undefined}>
                <TabBar tab={tab} onTab={setTab} badges={{ invites: scheduled }} />
            </PageHeader>
            <PageBody>{body}</PageBody>
        </PageRoot>
    );
};
