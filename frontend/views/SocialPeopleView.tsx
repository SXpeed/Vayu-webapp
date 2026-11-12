// Social → People: did each contact get the invites? Their latest invite on
// WhatsApp and by email, filters for who got it, who hasn't yet and who it
// failed for, sending it again (to one person or everyone in a filter), and the
// automatic resend settings. Server: socialInbox.ts.
import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { AlertCircle, CheckCheck, ChevronDown, Clock, Loader2, RotateCcw, Search, Send, UserX } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Field, Input, Pill, SectionTitle, Select, ToggleRow } from '../components/ui';
import { StatStrip } from '../components/StatStrip';
import { socialService } from '../services/socialService';
import {
    RESEND_HOURS, RESEND_TRIES, STATUS_LABEL, readLabel, trackState,
    type Channel, type LatestInvite, type PersonTrack, type RecipientStatus, type ResendSettings, type TrackHistory, type TrackState,
} from '../socialRules';
import { CHANNEL_ICON, CHANNEL_NAME, TONE, message, spinner } from './SocialTemplatesView';

type Filter = 'all' | TrackState | 'never';
const FILTERS: { key: Filter; label: string }[] = [
    { key: 'all', label: 'All' }, { key: 'got', label: 'Got it' }, { key: 'waiting', label: 'Not yet' }, { key: 'failed', label: 'Failed' }, { key: 'never', label: 'Never invited' },
];
const CHANNELS: Channel[] = ['whatsapp', 'email'];
const when = (ms: number) => new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const statusLabel = (channel: Channel, s: RecipientStatus) => (s === 'read' ? readLabel(channel) : STATUS_LABEL[s]);
function hoursLabel(h: number): string {
    if (h === 24) return '1 day';
    return h === 1 ? '1 hour' : `${h} hours`;
}
const triesLabel = (n: number) => (n === 1 ? 'once' : `up to ${n} times`);
const rsvpLabel = (r: string) => (r === 'yes' ? 'Coming' : 'Not coming');

/** What automatic resend does now, in one line. */
function resendLine(s: ResendSettings): string {
    if (!s.on) return 'Off: send again by hand from the list below.';
    return `On: after ${hoursLabel(s.afterHours)} without a delivery, sent again ${triesLabel(s.tries)}.`;
}

/**
 * Per channel, so nothing hides: "Got it" when every channel they were sent reached them; "Failed" or
 * "Not yet" when any one did (a WhatsApp that failed shows even if the email arrived).
 */
function matches(p: PersonTrack, f: TrackState): boolean {
    const states = CHANNELS.flatMap(c => (p[c] ? [trackState(p[c].status)] : []));
    return f === 'got' ? states.every(s => s === 'got') : states.includes(f);
}
/** Latest invites that didn't reach them and can still be sent again. */
const resendable = (p: PersonTrack) => CHANNELS.flatMap(c => {
    const l = p[c];
    return l && !l.resent && trackState(l.status) !== 'got' && l.status !== 'queued' ? [l] : [];
});

const StatusBadge: React.FC<{ channel: Channel; latest: LatestInvite | null }> = ({ channel, latest }) => {
    const Icon = CHANNEL_ICON[channel];
    return (
        <Badge className={latest ? TONE[latest.status] ?? '' : 'opacity-60'}>
            <Icon size={11} className="inline -mt-0.5 mr-1" aria-label={CHANNEL_NAME[channel]} />
            {latest ? statusLabel(channel, latest.status) : 'Not sent'}
        </Badge>
    );
};

/** Automatic resend: admins change it; everyone else sees what it is. */
const AutoResendCard: React.FC<{ settings: ResendSettings; isAdmin: boolean; onChange: (s: ResendSettings) => void }> = ({ settings, isAdmin, onChange }) => {
    const [busy, setBusy] = useState(false);
    const save = async (next: ResendSettings) => {
        setBusy(true);
        try { onChange(await socialService.setResendSettings(next)); toast.success(next.on ? 'Automatic resend is on' : 'Automatic resend is off'); } catch (e) { toast.error(message(e)); } finally { setBusy(false); }
    };
    const line = resendLine(settings);
    return (
        <Card className="space-y-3 text-[var(--neu-text)]">
            {isAdmin
                ? <ToggleRow icon={<RotateCcw size={16} />} title="Resend automatically" description={line} checked={settings.on} disabled={busy} onChange={() => { void save({ ...settings, on: !settings.on }); }} />
                : <p className="text-[13px] text-[var(--neu-text-dim)]"><RotateCcw size={14} className="inline -mt-0.5 mr-1.5" aria-hidden />{line}</p>}
            {isAdmin && settings.on && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Field label="If not delivered after" htmlFor="ar-after">
                        <Select id="ar-after" value={settings.afterHours} disabled={busy} onChange={e => { void save({ ...settings, afterHours: Number(e.target.value) }); }}>
                            {RESEND_HOURS.map(h => <option key={h} value={h}>{hoursLabel(h)}</option>)}
                        </Select>
                    </Field>
                    <Field label="Send again at most" htmlFor="ar-tries">
                        <Select id="ar-tries" value={settings.tries} disabled={busy} onChange={e => { void save({ ...settings, tries: Number(e.target.value) }); }}>
                            {RESEND_TRIES.map(n => <option key={n} value={n}>{n === 1 ? 'Once' : `${n} times`}</option>)}
                        </Select>
                    </Field>
                </div>
            )}
            {settings.on && (
                <p className="text-[11.5px] text-[var(--neu-text-dim)]">
                    Same channel, same message. Never to anyone who got it, answered the RSVP or opted out, and only for invites from the last 7 days.
                    “Not delivered” counts only when MSG91 reports deliveries for that invite (see Setup and keys → Delivery updates). Each WhatsApp message is charged again.
                </p>
            )}
        </Card>
    );
};

const History: React.FC<{ person: PersonTrack }> = ({ person }) => {
    const [rows, setRows] = useState<TrackHistory[] | null>(null);
    useEffect(() => { socialService.personHistory(person.key).then(setRows).catch(() => setRows([])); }, [person.key]);
    if (!rows) return <div className="py-3 flex justify-center text-[var(--neu-text-dim)]"><Loader2 size={16} className="animate-spin" /></div>;
    return (
        <ul className="space-y-1.5 text-[var(--neu-text)]">
            {rows.map(h => (
                <li key={h.recipientId} className="flex items-center gap-2 text-[12.5px] min-w-0">
                    {React.createElement(CHANNEL_ICON[h.channel], { size: 13, className: 'shrink-0 text-[var(--neu-text-dim)]', 'aria-label': CHANNEL_NAME[h.channel] })}
                    <span className="flex-1 min-w-0 truncate">{h.inviteName}{h.auto ? ' · automatic' : ''}</span>
                    <span className="hidden sm:inline text-[11.5px] text-[var(--neu-text-dim)] whitespace-nowrap">{when(h.at)}</span>
                    {h.rsvp && <Badge className={h.rsvp === 'yes' ? TONE.approved : ''}>{h.rsvp === 'yes' ? 'Coming' : 'Not coming'}</Badge>}
                    <Badge className={TONE[h.status] ?? ''}>{statusLabel(h.channel, h.status)}</Badge>
                </li>
            ))}
        </ul>
    );
};

const PersonRow: React.FC<{ p: PersonTrack; open: boolean; onToggle: () => void; canSend: boolean; onResend: (ids: string[], what: string) => Promise<void> }> = ({ p, open, onToggle, canSend, onResend }) => {
    const [busy, setBusy] = useState('');
    const latest = CHANNELS.map(c => p[c]).filter((l): l is LatestInvite => !!l).sort((a, b) => b.at - a.at)[0];
    const again = resendable(p);
    const failedReason = CHANNELS.map(c => p[c]).find(l => l?.status === 'failed' && l.reason)?.reason;
    return (
        <li className="task-row">
            <button type="button" aria-expanded={open} onClick={onToggle} className="w-full flex items-center gap-3 px-2 py-2.5 text-left rounded-xl active-scale">
                <span className="flex-1 min-w-0">
                    <span className="block text-[14px] truncate text-gray-900 dark:text-white">{p.name || latest?.address}</span>
                    <span className="block text-[11.5px] text-[var(--neu-text-dim)] truncate">
                        {latest ? `${latest.inviteName} · ${when(latest.at)}` : ''}{p.rsvp ? ` · ${rsvpLabel(p.rsvp)}` : ''}
                    </span>
                </span>
                <span className="flex flex-col sm:flex-row items-end sm:items-center gap-1 shrink-0">
                    {CHANNELS.map(c => <StatusBadge key={c} channel={c} latest={p[c]} />)}
                </span>
                <ChevronDown size={16} className={`shrink-0 text-[var(--neu-text-dim)] transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
            </button>
            {open && (
                <div className="px-3 pb-3 space-y-3">
                    {failedReason && <p className="text-[12px] text-red-700 dark:text-red-400 flex items-start gap-1.5"><AlertCircle size={13} className="mt-0.5 shrink-0" />{failedReason}</p>}
                    <History person={p} />
                    {canSend && again.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                            {again.map(l => {
                                const channel: Channel = l.address.includes('@') ? 'email' : 'whatsapp';
                                return (
                                    <Button key={l.recipientId} disabled={!!busy} icon={busy === l.recipientId ? <Loader2 size={14} className="animate-spin" /> : React.createElement(CHANNEL_ICON[channel], { size: 14 })}
                                        onClick={() => { setBusy(l.recipientId); void onResend([l.recipientId], `${CHANNEL_NAME[channel]} sent again to ${p.name || l.address}`).finally(() => setBusy('')); }}>
                                        Send {CHANNEL_NAME[channel]} again
                                    </Button>
                                );
                            })}
                        </div>
                    )}
                    {CHANNELS.some(c => p[c]?.resent) && <p className="text-[11.5px] text-[var(--neu-text-dim)]">Already sent again; its result shows as their latest.</p>}
                </div>
            )}
        </li>
    );
};

/** "Send again to all": a second tap confirms. */
const BulkResend: React.FC<{ count: number; confirm: boolean; busy: boolean; onSend: () => void }> = ({ count, confirm, busy, onSend }) => (
    <Card className="flex flex-col sm:flex-row sm:items-center gap-3 !py-3">
        <p className="flex-1 text-[13px] text-[var(--neu-text-dim)]">{count === 1 ? '1 invite here' : `${count} invites here`} didn’t reach them. Send the same message again?</p>
        <Button variant="primary" disabled={busy} onClick={onSend} icon={busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}>
            {confirm ? `Tap again to send ${count}` : 'Send again to all'}
        </Button>
    </Card>
);

/** The people in the chosen filter, the never-invited list, or why it's empty. */
const PeopleList: React.FC<{
    filter: Filter; shown: PersonTrack[]; never: { contactId: string; name: string }[]; anyone: boolean;
    open: string; onToggle: (key: string) => void; canSend: boolean; onResend: (ids: string[], what: string) => Promise<void>;
}> = ({ filter, shown, never, anyone, open, onToggle, canSend, onResend }) => {
    if (filter === 'never') {
        if (!never.length) return <EmptyState icon={<UserX size={22} strokeWidth={1.5} />} title="Everyone was invited" message="Every contact with a number or address has been sent at least one invite." />;
        return (
            <ul className="neu-card px-2 py-1">
                {never.map(c => <li key={c.contactId} className="task-row px-2 py-2.5 text-[14px] text-gray-900 dark:text-white truncate">{c.name}</li>)}
            </ul>
        );
    }
    if (!shown.length) {
        return anyone
            ? <EmptyState icon={<CheckCheck size={22} strokeWidth={1.5} />} title="Nobody here" message="Try another filter or search." />
            : <EmptyState icon={<CheckCheck size={22} strokeWidth={1.5} />} title="No invites sent yet" message="Once invites go out, each person’s delivery shows here." />;
    }
    return (
        <ul className="neu-card px-2 py-1">
            {shown.map(p => <PersonRow key={p.key} p={p} open={open === p.key} onToggle={() => onToggle(p.key)} canSend={canSend} onResend={onResend} />)}
        </ul>
    );
};

export const PeopleTab: React.FC<{ canSend: boolean; isAdmin: boolean }> = ({ canSend, isAdmin }) => {
    const [data, setData] = useState<{ people: PersonTrack[]; never: { contactId: string; name: string }[]; settings: ResendSettings } | null>(null);
    const [failed, setFailed] = useState(false);
    const [filter, setFilter] = useState<Filter>('all');
    const [query, setQuery] = useState('');
    const [open, setOpen] = useState('');
    const [confirmAll, setConfirmAll] = useState(false);
    const [busyAll, setBusyAll] = useState(false);
    const load = useCallback(async () => {
        setFailed(false);
        try { setData(await socialService.people()); } catch { setFailed(true); }
    }, []);
    useEffect(() => { void load(); }, [load]);

    const resend = async (ids: string[], said: string) => {
        try {
            const r = await socialService.resend(ids);
            toast.success(r.people === 1 ? said : `Sending again to ${r.people} people`);
            if (r.problems.length) toast.error(r.problems[0]);
            await load();
        } catch (e) { toast.error(message(e)); }
    };

    if (failed) return <EmptyState title="People didn’t load" message="Check your connection and try again." action={<Button onClick={() => { void load(); }}>Try again</Button>} />;
    if (!data) return spinner;
    const q = query.trim().toLowerCase();
    const people = data.people.filter(p => !q || `${p.name} ${p.whatsapp?.address ?? ''} ${p.email?.address ?? ''}`.toLowerCase().includes(q));
    const never = data.never.filter(c => !q || c.name.toLowerCase().includes(q));
    const count = (f: Filter) => (f === 'never' ? never.length : people.filter(p => f === 'all' || matches(p, f)).length);
    const shown = filter === 'never' ? [] : people.filter(p => filter === 'all' || matches(p, filter));
    const bulkIds = filter === 'failed' || filter === 'waiting' ? shown.flatMap(p => resendable(p).map(l => l.recipientId)) : [];
    const sendAll = async () => {
        if (!confirmAll) { setConfirmAll(true); return; }
        setBusyAll(true);
        await resend(bulkIds, 'Sent again');
        setBusyAll(false); setConfirmAll(false);
    };

    return (
        <div className="space-y-4">
            <StatStrip label="Did they get it?" stats={[
                { label: 'Got it', value: String(count('got')), sub: 'Delivered or read', Icon: CheckCheck },
                { label: 'Not yet', value: String(count('waiting')), sub: 'No delivery report', Icon: Clock },
                { label: 'Failed', value: String(count('failed')), sub: 'Wrong number, bounced', Icon: AlertCircle, alert: count('failed') > 0 },
                { label: 'Never invited', value: String(count('never')), sub: 'Have an address', Icon: UserX },
            ]} footer="Each person’s latest invite on each channel. Someone whose WhatsApp failed but whose email arrived counts under both." />
            <AutoResendCard settings={data.settings} isAdmin={isAdmin} onChange={s => setData(d => (d ? { ...d, settings: s } : d))} />
            <section className="space-y-3">
                <SectionTitle className="px-3">People</SectionTitle>
                <div className="relative">
                    <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--neu-text-dim)] pointer-events-none" aria-hidden />
                    <Input aria-label="Search people" placeholder="Search a name, number or address" value={query} onChange={e => setQuery(e.target.value)} className="!pl-10" />
                </div>
                <div className="-mx-4 px-4 overflow-x-auto [scrollbar-width:none]">
                    <div className="flex gap-2 w-max">
                        {FILTERS.map(f => <Pill key={f.key} active={filter === f.key} onClick={() => { setFilter(f.key); setConfirmAll(false); }}>{f.label} {count(f.key)}</Pill>)}
                    </div>
                </div>
                {canSend && bulkIds.length > 0 && <BulkResend count={bulkIds.length} confirm={confirmAll} busy={busyAll} onSend={() => { void sendAll(); }} />}
                <PeopleList filter={filter} shown={shown} never={never} anyone={data.people.length > 0} open={open}
                    onToggle={key => setOpen(open === key ? '' : key)} canSend={canSend} onResend={resend} />
            </section>
        </div>
    );
};
