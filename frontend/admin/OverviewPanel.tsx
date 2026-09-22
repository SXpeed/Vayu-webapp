// The control centre's first screen: what needs attention, at a glance.

import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { AlertTriangle, Building2, ClipboardList, Hourglass, Mail, Users } from 'lucide-react';
import { Card, SectionTitle } from '../components/ui';
import { api, timeAgo, type ApiError } from './api';

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
}

export type Navigate = (tab: string, focusId?: string) => void;

const Tile: React.FC<{ icon: React.ReactNode; label: string; value: number | string; hint?: string; tone?: 'warn' | 'ok'; onClick?: () => void }> = ({ icon, label, value, hint, tone, onClick }) => (
    <button
        type="button"
        onClick={onClick}
        disabled={!onClick}
        className={`neu-card p-4 text-left w-full ${onClick ? 'cursor-pointer hover:-translate-y-0.5 transition-transform' : 'cursor-default'}`}
    >
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.12em] text-gray-600 dark:text-gray-400">
            {icon}{label}
        </div>
        <p className={`mt-2 font-serif text-3xl ${tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-gray-900 dark:text-gray-100'}`}>{value}</p>
        {hint && <p className="text-[11px] mt-1 text-gray-600 dark:text-gray-400">{hint}</p>}
    </button>
);

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

export const OverviewPanel: React.FC<{ navigate: Navigate }> = ({ navigate }) => {
    const [data, setData] = useState<Overview | null>(null);

    useEffect(() => {
        api<Overview>('/admin/overview').then(setData).catch(e => toast.error((e as ApiError).message));
    }, []);

    if (!data) return <Card><p className="text-sm">Loading overview…</p></Card>;

    const waiting = (data.applications.pending_review ?? 0) + (data.applications.needs_information ?? 0);
    const orgTotal = sum(data.organizations);

    return (
        <div className="space-y-6">
            <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
                <Tile icon={<ClipboardList size={14} />} label="Applications to review" value={data.applications.pending_review ?? 0}
                    hint={`${data.applications.needs_information ?? 0} waiting on the applicant`} tone={waiting ? 'warn' : undefined}
                    onClick={() => navigate('applications')} />
                <Tile icon={<Building2 size={14} />} label="Organizations" value={orgTotal}
                    hint={`${data.organizations.active ?? 0} active · ${data.organizations.suspended ?? 0} suspended`}
                    onClick={() => navigate('orgs')} />
                <Tile icon={<Users size={14} />} label="Accounts" value={data.totals.users}
                    hint={`${data.totals.new_users_7d} new this week · ${data.totals.disabled_users} disabled`}
                    onClick={() => navigate('accounts')} />
                <Tile icon={<Mail size={14} />} label="Notices waiting" value={data.notifications.pending ?? 0}
                    hint="No email provider yet" tone={(data.notifications.pending ?? 0) ? 'warn' : undefined}
                    onClick={() => navigate('notifications')} />
            </div>

            <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
                <Tile icon={<Hourglass size={14} />} label="Trials ending in 7 days" value={data.trialsEndingThisWeek} />
                <Tile icon={<AlertTriangle size={14} />} label="Awaiting payment" value={data.subscriptions.payment_required ?? 0}
                    tone={(data.subscriptions.payment_required ?? 0) ? 'warn' : undefined} />
                <Tile icon={<Users size={14} />} label="Team memberships" value={data.totals.memberships} />
                <Tile icon={<Building2 size={14} />} label="Published plans" value={data.totals.plans} onClick={() => navigate('plans')} />
            </div>

            <div className="grid gap-6 grid-cols-1 lg:grid-cols-2">
                <Card padding="lg">
                    <SectionTitle>Waiting for you</SectionTitle>
                    {data.recentApplications.length === 0 ? (
                        <p className="text-sm text-gray-600 dark:text-gray-400">No applications need a decision.</p>
                    ) : (
                        <ul className="divide-y divide-black/5 dark:divide-white/10">
                            {data.recentApplications.map(a => (
                                <li key={a.id}>
                                    <button type="button" onClick={() => navigate('applications', a.id)} className="w-full text-left py-2.5 flex items-center gap-3">
                                        <span className="flex-1 min-w-0">
                                            <span className="block text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{a.business_name}</span>
                                            <span className="block text-[12px] text-gray-600 dark:text-gray-400 truncate">{a.email}</span>
                                        </span>
                                        <span className="text-[11px] text-gray-600 dark:text-gray-400 whitespace-nowrap">
                                            {a.review_status === 'needs_information' ? 'waiting on them' : timeAgo(a.submitted_at)}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </Card>

                <Card padding="lg">
                    <SectionTitle>Recent activity</SectionTitle>
                    <ul className="space-y-2">
                        {data.recentAudit.map((e, i) => (
                            <li key={i} className="text-[13px] flex gap-3 text-gray-800 dark:text-gray-200">
                                <span className="text-[11px] text-gray-600 dark:text-gray-400 w-20 shrink-0">{timeAgo(e.at)}</span>
                                <span className="font-mono text-[12px] flex-1 truncate">{e.action}</span>
                                <span className="text-[12px] text-gray-600 dark:text-gray-400 truncate max-w-[40%]">{e.actor_email ?? e.actor_kind}</span>
                            </li>
                        ))}
                    </ul>
                    <button type="button" onClick={() => navigate('audit')} className="mt-3 text-[12px] text-gold-700 dark:text-gold-300">Full audit log →</button>
                </Card>
            </div>

            {data.planMix.length > 0 && (
                <Card padding="lg">
                    <SectionTitle>Organizations by plan</SectionTitle>
                    <div className="space-y-2">
                        {data.planMix.map(p => {
                            const total = data.planMix.reduce((a, b) => a + b.n, 0);
                            return (
                                <div key={p.plan} className="flex items-center gap-3 text-sm">
                                    <span className="w-32 truncate text-gray-800 dark:text-gray-200">{p.plan}</span>
                                    <span className="flex-1 h-2 rounded-full neu-inset overflow-hidden">
                                        <span className="block h-full bg-gold-500/70" style={{ width: `${Math.round((p.n / total) * 100)}%` }} />
                                    </span>
                                    <span className="w-8 text-right text-gray-700 dark:text-gray-300">{p.n}</span>
                                </div>
                            );
                        })}
                    </div>
                </Card>
            )}
        </div>
    );
};
