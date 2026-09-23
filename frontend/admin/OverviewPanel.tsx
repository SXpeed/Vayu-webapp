// The first screen: what needs attention right now, and the state of things.
//
// Refreshes itself every minute while the tab is visible and on return to
// the tab — and never while hidden. A refresh keeps the current numbers on
// screen until the new ones arrive, so nothing flickers or jumps.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
    AlertTriangle, ArrowRight, Building2, CheckCircle2, ClipboardList, CreditCard, Hourglass, Mail, RefreshCw, Users, Wrench,
} from 'lucide-react';
import { api, timeAgo, type ApiError } from './api';
import { PageHeader, STAT_TILE_H, Section, Skeleton, StatTile, StatusPill } from './kit';

interface Overview {
    organizations: Record<string, number>;
    applications: Record<string, number>;
    subscriptions: Record<string, number>;
    notifications: Record<string, number>;
    totals: { users: number; admins: number; memberships: number; plans: number; disabled_users: number; new_users_7d: number };
    planMix: { plan: string; n: number }[];
    recentApplications: { id: string; business_name: string; review_status: string; submitted_at: number; email: string }[];
    recentAudit: { at: number; action: string; actor_kind: string; actor_email: string | null }[];
    trialsEndingThisWeek: number;
    failedSetups: number;
    generatedAt: number;
}

interface Health { checks: { name: string; ok: boolean; detail: string }[] }

export type Navigate = (tab: string, focusId?: string) => void;

const REFRESH_MS = 60_000;
// Written out in full so Tailwind generates them.
const TONE_TEXT = { bad: 'text-[var(--ac-bad)]', warn: 'text-[var(--ac-warn)]', info: 'text-[var(--ac-info)]' } as const;
const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
const readable = (action: string) => action.replace(/[._]/g, ' ').replace(/^./, c => c.toUpperCase());

/** A metric tile. The number is tabular, so updates never change its width. */
// Six tiles: two rows of three on a computer, three rows of two on a phone.
const TILE_GRID = 'grid grid-cols-2 lg:grid-cols-3 gap-3 lg:gap-5';

const Tile: React.FC<{ icon: React.ReactNode; label: string; value: number; hint?: string; tone?: 'warn' | 'bad'; onClick?: () => void }> = ({ hint, ...rest }) => (
    <StatTile {...rest} foot={hint} />
);


export const OverviewPanel: React.FC<{ navigate: Navigate }> = ({ navigate }) => {
    const [data, setData] = useState<Overview | null>(null);
    const [health, setHealth] = useState<Health | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [, tick] = useState(0);
    const timer = useRef<number | undefined>(undefined);

    const load = useCallback(async (manual = false) => {
        if (manual) setRefreshing(true);
        try {
            const [o, h] = await Promise.all([api<Overview>('/admin/overview'), api<Health>('/admin/health')]);
            setData(o);
            setHealth(h);
        } catch (e) {
            if (manual) toast.error((e as ApiError).message);
        } finally { setRefreshing(false); }
    }, []);

    useEffect(() => {
        load();
        const schedule = () => {
            window.clearInterval(timer.current);
            if (document.visibilityState === 'visible') timer.current = window.setInterval(() => load(), REFRESH_MS);
        };
        const onVisible = () => {
            if (document.visibilityState === 'visible') load();
            schedule(); // always: stops the timer when hidden, restarts it when shown
        };
        schedule();
        document.addEventListener('visibilitychange', onVisible);
        // Keeps "updated … ago" current without refetching.
        const clock = window.setInterval(() => tick(t => t + 1), 15_000);
        return () => { window.clearInterval(timer.current); window.clearInterval(clock); document.removeEventListener('visibilitychange', onVisible); };
    }, [load]);

    const header = (
        <PageHeader
            title="Overview"
            description="Platform at a glance"
            actions={
                <div className="flex items-center gap-3">
                    <span className="text-[12px] ac-faint whitespace-nowrap min-w-[7.5rem] text-right">
                        {data ? <>Updated {timeAgo(data.generatedAt)}</> : 'Loading…'}
                    </span>
                    <button type="button" className="neu-button !w-10 !px-0" title="Refresh" onClick={() => load(true)} disabled={refreshing}>
                        <RefreshCw size={16} className={refreshing ? 'ac-spin' : ''} />
                    </button>
                </div>
            }
        />
    );

    if (!data) {
        return (
            <div className="space-y-6">
                {header}
                <Skeleton className="h-28 rounded-2xl" />
                <div className={TILE_GRID}>{[0, 1, 2, 3, 4, 5].map(i => <Skeleton key={i} className={`${STAT_TILE_H} rounded-2xl`} />)}</div>
                <div className="grid gap-6 lg:grid-cols-2"><Skeleton className="h-64 rounded-2xl" /><Skeleton className="h-64 rounded-2xl" /></div>
            </div>
        );
    }

    const pending = data.applications.pending_review ?? 0;
    const waitingOn = data.applications.needs_information ?? 0;
    const awaitingPayment = data.subscriptions.payment_required ?? 0;
    const notices = data.notifications.pending ?? 0;
    const healthIssues = (health?.checks ?? []).filter(c => !c.ok && c.name !== 'Google sign-in');

    const attention: { key: string; tone: 'bad' | 'warn' | 'info'; icon: React.ReactNode; text: string; action: string; go: () => void }[] = [];
    if (data.failedSetups) attention.push({ key: 'setup', tone: 'bad', icon: <Wrench size={16} />, text: `${data.failedSetups} approved workspace${data.failedSetups === 1 ? '' : 's'} failed to set up`, action: 'Retry', go: () => navigate('applications') });
    if (pending) attention.push({ key: 'review', tone: 'warn', icon: <ClipboardList size={16} />, text: `${pending} application${pending === 1 ? '' : 's'} waiting for your decision`, action: 'Review', go: () => navigate('applications') });
    if (awaitingPayment) attention.push({ key: 'pay', tone: 'warn', icon: <CreditCard size={16} />, text: `${awaitingPayment} organization${awaitingPayment === 1 ? '' : 's'} approved but awaiting payment`, action: 'Open', go: () => navigate('orgs') });
    if (data.trialsEndingThisWeek) attention.push({ key: 'trial', tone: 'info', icon: <Hourglass size={16} />, text: `${data.trialsEndingThisWeek} trial${data.trialsEndingThisWeek === 1 ? '' : 's'} end this week`, action: 'Open', go: () => navigate('orgs') });
    if (notices) attention.push({ key: 'mail', tone: 'info', icon: <Mail size={16} />, text: `${notices} notice${notices === 1 ? '' : 's'} waiting for an email provider`, action: 'View', go: () => navigate('notifications') });
    if (healthIssues.length) attention.push({ key: 'health', tone: 'warn', icon: <AlertTriangle size={16} />, text: `${healthIssues.length} configuration item${healthIssues.length === 1 ? '' : 's'} need attention`, action: 'Check', go: () => navigate('health') });

    return (
        <div className="space-y-6">
            {header}

            <Section title="Needs attention">
                {attention.length === 0 ? (
                    <p className="flex items-center gap-2 text-sm text-[var(--ac-ok)]"><CheckCircle2 size={17} /> Nothing needs you right now.</p>
                ) : (
                    <ul className="space-y-2">
                        {attention.map(a => (
                            <li key={a.key}>
                                <button type="button" onClick={a.go} className="ac-row w-full flex items-center gap-3 px-2 py-2 text-left">
                                    <span className={`w-8 h-8 rounded-[10px] neu-inset flex items-center justify-center shrink-0 ${TONE_TEXT[a.tone]}`}>{a.icon}</span>
                                    <span className="flex-1 min-w-0 text-sm">{a.text}</span>
                                    <span className="text-[12px] text-[var(--ac-accent)] font-medium inline-flex items-center gap-1 shrink-0">{a.action} <ArrowRight size={13} /></span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </Section>

            <div className={TILE_GRID}>
                <Tile icon={<ClipboardList size={15} />} label="To review" value={pending} hint={`${waitingOn} waiting on applicant`} tone={pending ? 'warn' : undefined} onClick={() => navigate('applications')} />
                <Tile icon={<Building2 size={15} />} label="Organizations" value={sum(data.organizations)} hint={`${data.organizations.active ?? 0} active · ${data.organizations.suspended ?? 0} suspended`} onClick={() => navigate('orgs')} />
                <Tile icon={<Users size={15} />} label="Accounts" value={data.totals.users} hint={`${data.totals.new_users_7d} new this week`} onClick={() => navigate('accounts')} />
                <Tile icon={<CreditCard size={15} />} label="Unpaid" value={awaitingPayment} tone={awaitingPayment ? 'warn' : undefined} hint="Approved, not yet paid" />
                <Tile icon={<Hourglass size={15} />} label="Trials ending" value={data.trialsEndingThisWeek} hint="In the next 7 days" />
                <Tile icon={<Mail size={15} />} label="Notices" value={notices} hint="No email provider yet" onClick={() => navigate('notifications')} />
            </div>

            <div className="grid gap-6 grid-cols-1 lg:grid-cols-2">
                <Section title="Waiting for you" actions={<button type="button" className="text-[12px] text-[var(--ac-accent)] font-medium" onClick={() => navigate('applications')}>All applications</button>}>
                    {data.recentApplications.length === 0 ? (
                        <p className="text-sm ac-muted py-2">No applications need a decision.</p>
                    ) : (
                        <ul className="ac-divide -mx-2">
                            {data.recentApplications.map(a => (
                                <li key={a.id}>
                                    <button type="button" onClick={() => navigate('applications', a.id)} className="ac-row w-full text-left px-2 py-2.5 flex items-center gap-3">
                                        <span className="flex-1 min-w-0">
                                            <span className="block text-sm font-medium truncate">{a.business_name}</span>
                                            <span className="block text-[12px] ac-faint truncate">{a.email} · {timeAgo(a.submitted_at)}</span>
                                        </span>
                                        <StatusPill status={a.review_status} />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </Section>

                <Section title="Recent activity" actions={<button type="button" className="text-[12px] text-[var(--ac-accent)] font-medium" onClick={() => navigate('audit')}>Full audit log</button>}>
                    <ul className="space-y-2.5">
                        {data.recentAudit.map((e, i) => (
                            <li key={i} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 text-[13px]">
                                <span className="text-[12px] ac-faint tabular-nums">{timeAgo(e.at)}</span>
                                <span className="min-w-0">
                                    <span className="block break-words">{readable(e.action)}</span>
                                    <span className="block text-[12px] ac-faint truncate">{e.actor_email ?? e.actor_kind}</span>
                                </span>
                            </li>
                        ))}
                    </ul>
                </Section>
            </div>

            {data.planMix.length > 0 && (
                <Section title="Organizations by plan">
                    <div className="space-y-3">
                        {data.planMix.map(p => {
                            const total = data.planMix.reduce((a, b) => a + b.n, 0) || 1;
                            return (
                                <div key={p.plan} className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)_2.5rem] items-center gap-3 text-sm">
                                    <span className="truncate">{p.plan}</span>
                                    <span className="h-2.5 rounded-full neu-inset overflow-hidden">
                                        <span className="block h-full rounded-full bg-gradient-to-r from-[#f0d68a] to-[#d4af37] transition-[width] duration-500" style={{ width: `${Math.round((p.n / total) * 100)}%` }} />
                                    </span>
                                    <span className="text-right tabular-nums ac-muted">{p.n}</span>
                                </div>
                            );
                        })}
                    </div>
                </Section>
            )}
        </div>
    );
};
