// Social → Analytics: the workspace's own Instagram and YouTube figures, read
// live through the accounts an admin connects under Setup and keys (Instagram's
// own login, Google's sign-in). Server: socialAnalytics.ts.
import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { AlertCircle, Clapperboard, Clock, Eye, Heart, Loader2, MessageSquare, PlugZap, RefreshCw, Share2, Timer, Trash2, UserPlus } from 'lucide-react';
import { Badge, Button, Card, EmptyState, GhostIconButton, SectionTitle } from '../components/ui';
import { StatStrip } from '../components/StatStrip';
import { socialService } from '../services/socialService';
import type { AnalyticsStatus, DayValue, InstagramReport, YoutubeReport } from '../socialRules';
import { TONE, message, spinner } from './SocialTemplatesView';

/** A connected account: each has its own login, page and figures. */
export type Kind = 'instagram' | 'youtube';
const fmt = (n: number) => n.toLocaleString('en-IN');
const compact = (n: number) => new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : '–');
const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const date = (ms: number) => (ms ? new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '');
const clock = (sec: number) => { const t = Math.round(sec); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const sum = (d: DayValue[]) => d.reduce((s, x) => s + x.value, 0);

/** Instagram has no brand icon in lucide: a plain camera glyph. */
export const InstaGlyph: React.FC<{ size?: number; className?: string }> = ({ size = 15, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className={className} aria-hidden>
        <rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.5" cy="6.5" r="0.8" fill="currentColor" />
    </svg>
);

export const NAMES: Record<Kind, string> = { instagram: 'Instagram', youtube: 'YouTube' };
const SOURCES: Record<string, string> = {
    YT_SEARCH: 'YouTube search', RELATED_VIDEO: 'Suggested videos', SHORTS: 'Shorts feed', EXT_URL: 'Other websites and apps', SUBSCRIBER: 'Subscribers’ feeds',
    BROWSE: 'Home and browse', PLAYLIST: 'Playlists', NO_LINK_OTHER: 'Direct or unknown', CHANNEL: 'Your channel page', NOTIFICATION: 'Notifications',
    YT_OTHER_PAGE: 'Other YouTube pages', END_SCREEN: 'End screens', HASHTAGS: 'Hashtags', SOUND_PAGE: 'Sound pages', YT_CHANNEL: 'Channel pages',
};
const sourceName = (s: string) => SOURCES[s] ?? s.toLowerCase().replaceAll('_', ' ').replace(/^\w/, c => c.toUpperCase());

/** A plain bar per day; the first and last days are labelled. Screen readers get the figures as text. */
export const DayBars: React.FC<{ days: DayValue[]; label: string }> = ({ days, label }) => {
    const max = Math.max(1, ...days.map(d => d.value));
    if (!days.length) return <p className="py-6 text-center text-[13px] text-[var(--neu-text-dim)]">No daily figures yet.</p>;
    const spoken = days.map(d => day(d.date) + ' ' + fmt(d.value)).join(', ');
    return (
        <figure>
            <div className="flex items-end gap-[2px] sm:gap-[3px] h-32" role="img" aria-label={`${label}: ${spoken}`}>
                {days.map(d => (
                    <div key={d.date} className="flex-1 min-w-0 h-full flex items-end" title={`${day(d.date)}: ${fmt(d.value)}`}>
                        <div className="w-full rounded-t-[3px] bg-gold-500/80" style={{ height: `${Math.max(2, (d.value / max) * 100)}%` }} />
                    </div>
                ))}
            </div>
            <figcaption className="mt-1 flex justify-between text-[10.5px] text-[var(--neu-text-dim)]"><span>{day(days[0].date)}</span><span>{day(days.at(-1)!.date)}</span></figcaption>
        </figure>
    );
};

/** Parts Meta or Google didn't give (a retired figure, a missing permission). */
const Problems: React.FC<{ problems: string[] }> = ({ problems }) => (problems.length ? (
    <details className="neu-card px-4 py-3 text-[12.5px] text-[var(--neu-text-dim)]">
        <summary className="cursor-pointer flex items-center gap-1.5"><AlertCircle size={13} className="text-gold-600" />{problems.length === 1 ? 'One figure isn’t available' : `${problems.length} figures aren’t available`}</summary>
        <ul className="mt-2 space-y-1 list-disc pl-5">{problems.map(p => <li key={p}>{p}</li>)}</ul>
    </details>
) : null);

const Thumb: React.FC<{ src: string; className?: string; alt?: string }> = ({ src, className = '', alt = '' }) => (src
    ? <img src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" className={`object-cover bg-[var(--neu-inset,#e5e5e5)] ${className}`} />
    : <span className={`block neu-inset ${className}`} aria-hidden />);

const InstagramView: React.FC<{ r: InstagramReport }> = ({ r }) => {
    const engaged = r.posts.reduce((s, p) => s + p.likes + p.comments + p.shares + p.saves, 0);
    const reach = r.posts.reduce((s, p) => s + p.reach, 0);
    return (
        <div className="space-y-4">
            <StatStrip label={`@${r.username}`} stats={[
                { label: 'Followers', value: compact(r.followers), Icon: UserPlus },
                { label: 'Reach', value: compact(sum(r.reachDaily)), sub: 'Last 28 days', Icon: Eye },
                { label: 'Views', value: compact(r.posts.reduce((s, p) => s + p.views, 0)), sub: `Last ${r.posts.length} posts`, Icon: Eye },
                { label: 'Engagement', value: pct(engaged, reach), sub: 'Likes, comments, shares, saves ÷ reach', Icon: Heart },
            ]} />
            <Card><SectionTitle>Accounts reached, each day</SectionTitle><DayBars days={r.reachDaily} label="Accounts reached each day" /></Card>
            <section>
                <SectionTitle className="px-3">Latest posts</SectionTitle>
                {r.posts.length ? (
                    <ul className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
                        {r.posts.map(p => (
                            <li key={p.id} className="neu-card overflow-hidden flex flex-col">
                                <a href={p.permalink} target="_blank" rel="noreferrer" className="relative block" aria-label={`Open on Instagram: ${p.caption || p.kind}`}>
                                    <Thumb src={p.image} className="w-full aspect-[4/5]" />
                                    <span className="absolute top-2 left-2"><Badge className="!bg-black/55 !text-white">{p.kind}</Badge></span>
                                </a>
                                <div className="p-2.5 space-y-1.5 text-[12px] min-w-0">
                                    <p className="text-gray-900 dark:text-white line-clamp-2 min-h-[2.5em]">{p.caption || '(no caption)'}</p>
                                    <p className="text-[var(--neu-text-dim)]">{date(p.at)}</p>
                                    <div className="grid grid-cols-2 gap-x-2 gap-y-1 tabular-nums text-[var(--neu-text-dim)]">
                                        <span title="Views"><Eye size={12} className="inline -mt-0.5 mr-1" aria-label="Views" />{compact(p.views)}</span>
                                        <span title="Likes"><Heart size={12} className="inline -mt-0.5 mr-1" aria-label="Likes" />{compact(p.likes)}</span>
                                        <span title="Comments"><MessageSquare size={12} className="inline -mt-0.5 mr-1" aria-label="Comments" />{compact(p.comments)}</span>
                                        <span title="Shares"><Share2 size={12} className="inline -mt-0.5 mr-1" aria-label="Shares" />{compact(p.shares)}</span>
                                    </div>
                                    {p.avgWatchSec !== undefined && <p className="text-[var(--neu-text-dim)]"><Timer size={12} className="inline -mt-0.5 mr-1" aria-hidden />{p.avgWatchSec}s average watch</p>}
                                </div>
                            </li>
                        ))}
                    </ul>
                ) : <EmptyState icon={<InstaGlyph size={22} />} title="No posts yet" message="Posts and reels show here once there are some." />}
            </section>
            <Problems problems={r.problems} />
        </div>
    );
};

const YoutubeView: React.FC<{ r: YoutubeReport }> = ({ r }) => {
    const views = r.daily.reduce((s, d) => s + d.views, 0);
    const minutes = r.daily.reduce((s, d) => s + d.minutes, 0);
    const gained = r.daily.reduce((s, d) => s + d.subscribers, 0);
    const totalSource = Math.max(1, r.sources.reduce((s, x) => s + x.views, 0));
    return (
        <div className="space-y-4">
            <StatStrip label={r.title} stats={[
                { label: 'Subscribers', value: compact(r.subscribers), sub: gained ? `+${fmt(gained)} in 28 days` : undefined, Icon: UserPlus },
                { label: 'Views', value: compact(views), sub: 'Last 28 days', Icon: Eye },
                { label: 'Watch time', value: compact(Math.round(minutes / 60)), sub: 'Hours, last 28 days', Icon: Timer },
                { label: 'Average view', value: views ? clock((minutes * 60) / views) : '–', sub: 'Per view', Icon: Clock },
            ]} footer="YouTube’s figures arrive about two days late." />
            <Card><SectionTitle>Views, each day</SectionTitle><DayBars days={r.daily.map(d => ({ date: d.date, value: d.views }))} label="Video views each day" /></Card>
            <div className="grid lg:grid-cols-2 gap-4 lg:items-start">
                <section className="min-w-0">
                    <SectionTitle className="px-3">Top videos, last 28 days</SectionTitle>
                    {r.top.length ? (
                        <ul className="neu-card px-2 py-1">
                            {r.top.map(v => (
                                <li key={v.id} className="task-row">
                                    <a href={`https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`} target="_blank" rel="noreferrer" className="flex items-center gap-3 px-2 py-2.5 rounded-xl">
                                        <Thumb src={v.thumb} className="w-20 aspect-video shrink-0 rounded-lg" />
                                        <span className="flex-1 min-w-0">
                                            <span className="block text-[13.5px] truncate text-gray-900 dark:text-white">{v.title}</span>
                                            <span className="block text-[11.5px] text-[var(--neu-text-dim)] truncate">{date(v.at)} · {fmt(v.likes)} likes · {clock(v.avgViewSec)} average</span>
                                        </span>
                                        <span className="text-right text-[12px] tabular-nums shrink-0">
                                            <span className="block">{compact(v.views)} views</span>
                                            <span className="block text-[var(--neu-text-dim)]">{fmt(Math.round(v.minutes / 60))} h</span>
                                        </span>
                                    </a>
                                </li>
                            ))}
                        </ul>
                    ) : <EmptyState icon={<Clapperboard size={22} strokeWidth={1.5} />} title="No views yet" message="Videos watched in the last 28 days show here." />}
                </section>
                <Card>
                    <SectionTitle>Where viewers find you</SectionTitle>
                    {r.sources.length ? (
                        <ul className="space-y-2.5">
                            {r.sources.slice(0, 8).map(s => (
                                <li key={s.name} className="text-[12.5px]">
                                    <div className="flex justify-between gap-2 mb-1"><span className="truncate">{sourceName(s.name)}</span><span className="tabular-nums text-[var(--neu-text-dim)]">{Math.round((s.views / totalSource) * 100)}%</span></div>
                                    <div className="h-1.5 rounded-full neu-inset overflow-hidden"><div className="h-full rounded-full bg-gold-500/80" style={{ width: `${(s.views / totalSource) * 100}%` }} /></div>
                                </li>
                            ))}
                        </ul>
                    ) : <p className="text-[13px] text-[var(--neu-text-dim)]">Not enough views yet.</p>}
                </Card>
            </div>
            <Problems problems={r.problems} />
        </div>
    );
};

type AnyReport = InstagramReport | YoutubeReport;

const Report: React.FC<{ kind: Kind }> = ({ kind }) => {
    const [report, setReport] = useState<AnyReport | null>(null);
    const [problem, setProblem] = useState('');
    const [busy, setBusy] = useState(false);
    const load = useCallback(async (refresh = false) => {
        setBusy(true); setProblem('');
        try { setReport(await socialService[kind](refresh)); } catch (e) { setProblem(message(e)); } finally { setBusy(false); }
    }, [kind]);
    useEffect(() => { setReport(null); void load(); }, [load]);
    if (!report && busy) return spinner;
    if (!report) return <EmptyState icon={<AlertCircle size={22} strokeWidth={1.5} />} title={`${NAMES[kind]} didn’t load`} message={problem} action={<Button onClick={() => { void load(true); }}>Try again</Button>} />;
    return (
        <div className="space-y-3">
            <div className="flex items-center justify-end gap-2 text-[11.5px] text-[var(--neu-text-dim)]">
                {report.fetchedAt && <span>Updated {new Date(report.fetchedAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}</span>}
                <GhostIconButton label="Refresh" disabled={busy} onClick={() => { void load(true); }} icon={busy ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} className="text-brand-900 dark:text-gold-400" />} />
            </div>
            {problem && <p role="alert" className="text-[12.5px] text-red-700 dark:text-red-400">{problem}</p>}
            {kind === 'instagram' && <InstagramView r={report as InstagramReport} />}
            {kind === 'youtube' && <YoutubeView r={report as YoutubeReport} />}
        </div>
    );
};

/** Sends the browser to Instagram's or Google's login; it comes back to Social. */
async function connect(kind: Kind) {
    try { globalThis.location.href = await socialService.connectAnalytics(kind); } catch (e) { toast.error(message(e)); }
}

const KIND_ICON: Record<Kind, React.ReactNode> = { instagram: <InstaGlyph size={22} />, youtube: <Clapperboard size={22} strokeWidth={1.5} /> };

/** Not connected yet: how to connect it (admins), or who to ask. */
const NotConnected: React.FC<{ kind: Kind; isAdmin: boolean }> = ({ kind, isAdmin }) => {
    const message = kind === 'youtube'
        ? 'Sign in with the Google account that owns your channel. It only reads your figures.'
        : 'Log in with your Instagram Business or Creator account, on Instagram’s own page. It only reads your figures.';
    const action = isAdmin
        ? <Button variant="primary" className="mt-4" icon={<PlugZap size={15} />} onClick={() => { void connect(kind); }}>Connect {NAMES[kind]}</Button>
        : <p className="mt-3 text-[12.5px] text-[var(--neu-text-dim)]">Ask an admin to connect it.</p>;
    return <EmptyState icon={KIND_ICON[kind]} title={`${NAMES[kind]} isn’t connected`} message={message} action={action} />;
};

/** One account's page: its figures, or why there are none yet (not switched on, not connected). */
export const AnalyticsTab: React.FC<{ kind: Kind; isAdmin: boolean }> = ({ kind, isAdmin }) => {
    const [status, setStatus] = useState<AnalyticsStatus | null>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => { socialService.analytics().then(setStatus).catch(() => setFailed(true)); }, []);
    if (failed) return <EmptyState title="Analytics didn’t load" message="Check your connection and try again." />;
    if (!status) return spinner;
    const s = status[kind];
    if (!s.available) {
        const app = kind === 'youtube' ? 'Google' : 'Instagram';
        return <EmptyState icon={<PlugZap size={22} strokeWidth={1.5} />} title="Not switched on yet" message={`${NAMES[kind]} analytics need the platform’s ${app} app, which isn’t set up on this server yet.`} />;
    }
    if (!s.connected) return <NotConnected kind={kind} isAdmin={isAdmin} />;
    return <Report key={kind} kind={kind} />;
};

/** For Setup and keys: the Instagram and YouTube connections, with connect and disconnect (admins). */
export const AnalyticsConnections: React.FC<{ isAdmin: boolean }> = ({ isAdmin }) => {
    const [status, setStatus] = useState<AnalyticsStatus | null>(null);
    const [confirm, setConfirm] = useState<Kind | ''>('');
    const load = useCallback(() => { socialService.analytics().then(setStatus).catch(() => setStatus(null)); }, []);
    useEffect(() => { load(); }, [load]);
    const off = async (p: Kind) => {
        if (confirm !== p) { setConfirm(p); return; }
        try { await socialService.disconnectAnalytics(p); toast.success('Disconnected'); load(); } catch (e) { toast.error(message(e)); } finally { setConfirm(''); }
    };
    if (!status) return null;
    const rows: { p: Kind; title: string; Icon: React.ElementType; line: string; connected: boolean; available: boolean }[] = [
        { p: 'instagram', title: 'Instagram', Icon: InstaGlyph, connected: status.instagram.connected, available: status.instagram.available,
            line: status.instagram.connected ? `@${status.instagram.username}` : 'Instagram login with your Business or Creator account' },
        { p: 'youtube', title: 'YouTube', Icon: Clapperboard, connected: status.youtube.connected, available: status.youtube.available,
            line: status.youtube.connected ? status.youtube.channelTitle : 'Google sign-in with the account that owns the channel' },
    ];
    return (
        <Card className="space-y-2 text-[var(--neu-text)]">
            <SectionTitle>Analytics accounts</SectionTitle>
            <p className="text-[12.5px] text-[var(--neu-text-dim)]">Read-only: figures for Social → Analytics. Nothing is posted.</p>
            <ul>
                {rows.map(r => (
                    <li key={r.p} className="task-row flex flex-wrap items-center gap-3 py-3">
                        <span className="w-10 h-10 shrink-0 rounded-full neu-inset flex items-center justify-center text-brand-900 dark:text-gold-400"><r.Icon size={18} /></span>
                        <span className="flex-1 min-w-[10rem]">
                            <span className="flex items-center gap-2"><span className="font-serif text-[15px] text-gray-900 dark:text-white">{r.title}</span>
                                {r.connected ? <Badge className={TONE.approved}>Connected</Badge> : <Badge>{r.available ? 'Not connected' : 'Not available yet'}</Badge>}</span>
                            <span className="block mt-0.5 text-[11.5px] text-[var(--neu-text-dim)] truncate">{r.line}</span>
                        </span>
                        {isAdmin && r.available && (r.connected
                            ? <Button variant="danger" icon={<Trash2 size={14} />} onClick={() => { void off(r.p); }}>{confirm === r.p ? 'Tap again' : 'Disconnect'}</Button>
                            : <Button variant="primary" icon={<PlugZap size={14} />} onClick={() => { void connect(r.p); }}>Connect</Button>)}
                    </li>
                ))}
            </ul>
        </Card>
    );
};
