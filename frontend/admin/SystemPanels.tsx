// Provider administrators, notification delivery, and system health.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Activity, CheckCircle2, Mail, RefreshCw, ShieldCheck, TriangleAlert, UserPlus } from 'lucide-react';
import { Button, Field, Input, Select } from '../components/ui';
import { api, guarded, timeAgo, type ApiError, type Reauth } from './api';
import { Avatar, Detail, EmptyState, STAT_TILE_H, Section, Segmented, Skeleton, SkeletonRows, StatTile, StatusPill, useDialogs } from './kit';

/* -------------------------- Provider admins --------------------------- */

interface AdminRow { user_id: string; role: string; status: string; created_at: number; email: string; name: string; two_factor: number | null }

const ROLE_HINT: Record<string, string> = {
    owner: 'Everything, including who administers the platform.',
    admin: 'Organizations, plans, applications and accounts.',
    support: 'Same as admin today; support sessions will be limited to this role.',
};
const ADMIN_ROLES = ['owner', 'admin', 'support'];

export const AdminsPanel: React.FC<{ reauth: Reauth; myRole: string; myEmail: string }> = ({ reauth, myRole, myEmail }) => {
    const [rows, setRows] = useState<AdminRow[] | null>(null);
    const [email, setEmail] = useState('');
    const [role, setRole] = useState('admin');
    const [busy, setBusy] = useState<string | null>(null);
    const isOwner = myRole === 'owner';
    const dialogs = useDialogs();

    const load = useCallback(async () => {
        try { setRows((await api<{ admins: AdminRow[] }>('/admin/admins')).admins); } catch (e) { toast.error((e as ApiError).message); }
    }, []);
    useEffect(() => { load(); }, [load]);

    const change = async (key: string, init: RequestInit, path: string, done: string) => {
        setBusy(key);
        const res = await guarded(reauth, () => api<{ admins: AdminRow[] }>(path, init), m => toast.error(m));
        setBusy(null);
        if (res) { setRows(res.admins); toast.success(done); }
        return !!res;
    };

    const toggle = async (r: AdminRow) => {
        if (r.status === 'active' && !(await dialogs.confirm({
            title: `Remove ${r.name}'s access?`, body: 'They are signed out and can no longer use the control centre. Their account itself stays.',
            confirmLabel: 'Remove access', danger: true,
        }))) return;
        change(r.user_id, { method: 'PATCH', body: JSON.stringify({ status: r.status === 'active' ? 'disabled' : 'active' }) },
            `/admin/admins/${r.user_id}`, r.status === 'active' ? 'Access removed' : 'Access restored');
    };

    return (
        <Section
            title="Provider administrators"
            description={`People who can use this control centre. Every one of them must use two-factor authentication.${isOwner ? '' : ' Only a platform owner can change this list.'}`}
            actions={rows ? <StatusPill tone="neutral">{rows.length}</StatusPill> : <ShieldCheck size={16} className="ac-faint" />}
        >
            {!rows ? <SkeletonRows rows={2} /> : (
                <ul className="ac-divide -mx-2">
                    {rows.map(r => {
                        const self = r.email === myEmail;
                        return (
                            <li key={r.user_id} className="px-2 py-2.5 grid items-center gap-x-3 gap-y-2 grid-cols-[auto_minmax(0,1fr)] md:grid-cols-[auto_minmax(0,1fr)_auto]">
                                <Avatar name={r.name} />
                                <div className="min-w-0">
                                    <p className="text-sm font-medium flex items-center gap-2 min-w-0">
                                        <span className="truncate">{r.name}{self ? ' (you)' : ''}</span>
                                        {r.status !== 'active' && <StatusPill status={r.status} />}
                                    </p>
                                    <p className="text-[12px] ac-faint flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
                                        <span className="truncate">{r.email}</span>
                                        <StatusPill tone={r.two_factor ? 'ok' : 'warn'}>{r.two_factor ? '2FA on' : '2FA not set up'}</StatusPill>
                                    </p>
                                </div>
                                <div className="col-span-2 md:col-span-1 flex items-center justify-end gap-2">
                                    <Select aria-label={`Role for ${r.email}`} className="!w-auto min-w-[8.5rem]" value={r.role} disabled={!isOwner || self || busy === r.user_id}
                                        onChange={e => change(r.user_id, { method: 'PATCH', body: JSON.stringify({ role: e.target.value }) }, `/admin/admins/${r.user_id}`, 'Role changed')}>
                                        {ADMIN_ROLES.map(x => <option key={x} value={x}>{x}</option>)}
                                    </Select>
                                    <Button disabled={!isOwner || self || busy === r.user_id} onClick={() => toggle(r)} className="min-w-[8rem] justify-center">
                                        {r.status === 'active' ? 'Remove access' : 'Restore'}
                                    </Button>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
            {isOwner && (
                <form className="mt-4 rounded-2xl neu-inset p-3.5" onSubmit={async e => {
                    e.preventDefault();
                    if (await change('new', { method: 'POST', body: JSON.stringify({ email, role }) }, '/admin/admins', 'Administrator added')) setEmail('');
                }}>
                    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_auto] items-end">
                        <Field label="Add an administrator" htmlFor="adm-new">
                            <Input id="adm-new" type="email" required placeholder="Existing account email" value={email} onChange={e => setEmail(e.target.value)} />
                        </Field>
                        <Field label="Role" htmlFor="adm-role">
                            <Select id="adm-role" value={role} onChange={e => setRole(e.target.value)}>
                                {ADMIN_ROLES.map(x => <option key={x} value={x}>{x}</option>)}
                            </Select>
                        </Field>
                        <Button type="submit" variant="primary" icon={<UserPlus size={15} />} disabled={busy === 'new'}>Add</Button>
                    </div>
                    <p className="mt-2 text-[12px] ac-faint">
                        <span className="ac-muted">{role}:</span> {ROLE_HINT[role]} The account must already exist (see Accounts).
                    </p>
                </form>
            )}
        </Section>
    );
};

/* --------------------------- Notifications ---------------------------- */

interface Notice { id: string; kind: string; recipient: string; subject: string; status: string; attempts: number; last_error: string | null; created_at: number; sent_at: number | null }

const NOTICE_FILTERS = ['all', 'pending', 'failed', 'sent', 'cancelled'];

export const NotificationsPanel: React.FC<{ onChange?: () => void }> = ({ onChange }) => {
    const dialogs = useDialogs();
    const [data, setData] = useState<{ notifications: Notice[]; counts: Record<string, number> } | null>(null);
    const [providerEmail, setProviderEmail] = useState('');
    const [savedEmail, setSavedEmail] = useState('');
    const [sending, setSending] = useState<boolean | null>(null);
    const [filter, setFilter] = useState('all');
    const [busy, setBusy] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const [list, s] = await Promise.all([
                api<{ notifications: Notice[]; counts: Record<string, number> }>('/admin/notifications'),
                api<{ providerEmail: string | null; emailConfigured?: boolean }>('/admin/settings/notifications'),
            ]);
            setData(list);
            setProviderEmail(s.providerEmail ?? '');
            setSavedEmail(s.providerEmail ?? '');
            setSending(!!s.emailConfigured);
        } catch (e) { toast.error((e as ApiError).message); }
    }, []);
    useEffect(() => { load(); }, [load]);

    const save = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy('email');
        try {
            await api('/admin/settings/notifications', { method: 'PUT', body: JSON.stringify({ providerEmail }) });
            setSavedEmail(providerEmail);
            toast.success('Saved');
        } catch (err) { toast.error((err as ApiError).message); } finally { setBusy(null); }
    };

    const act = async (n: Notice, what: 'retry' | 'cancel') => {
        if (what === 'cancel' && !(await dialogs.confirm({ title: 'Cancel this notice?', body: `“${n.subject}” to ${n.recipient} will not be sent.`, confirmLabel: 'Cancel notice', cancelLabel: 'Keep it', danger: true }))) return;
        setBusy(n.id);
        try { setData(await api(`/admin/notifications/${n.id}/${what}`, { method: 'POST' })); onChange?.(); }
        catch (e) { toast.error((e as ApiError).message); } finally { setBusy(null); }
    };

    const shown = useMemo(() => (data?.notifications ?? []).filter(n => filter === 'all' || n.status === filter), [data, filter]);
    const total = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : 0;

    return (
        <div className="space-y-6">
            <Section title="Where notices go" actions={<Mail size={16} className="ac-faint" />}>
                <form onSubmit={save} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] items-end">
                    <Field label="Your notification email" htmlFor="nt-email">
                        <Input id="nt-email" type="email" value={providerEmail} onChange={e => setProviderEmail(e.target.value)} placeholder="you@yourcompany.com" />
                    </Field>
                    <Button type="submit" variant="primary" disabled={providerEmail === savedEmail || busy === 'email'}>Save</Button>
                </form>
                <p className="mt-2 text-[12px] ac-faint">New and updated applications are sent here.</p>
                {sending === false && (
                    <p className="mt-4 rounded-xl px-3 py-2 text-[13px] bg-[var(--ac-warn-bg)] text-[var(--ac-warn)]">
                        Email sending is not set up, so notices are queued here instead of being sent. Nothing is lost:
                        they go out once it is, and every application is in the queue either way.
                    </p>
                )}
                {sending && (
                    <p className="mt-4 text-[13px] ac-muted">
                        Notices are emailed as soon as they are created. One that fails is tried again after 5 minutes, 30 minutes,
                        2 hours and 12 hours, then marked failed; you can retry it below.
                    </p>
                )}
            </Section>

            <Section title="Outbox" description={data ? `${total} notice${total === 1 ? '' : 's'} in total.` : undefined}>
                <div className="mb-4 max-w-full overflow-x-auto">
                    <Segmented
                        value={filter}
                        onChange={setFilter}
                        options={NOTICE_FILTERS.map(f => ({ value: f, label: f === 'all' ? 'All' : f[0].toUpperCase() + f.slice(1), count: f === 'all' ? (data ? total : undefined) : data?.counts[f] }))}
                    />
                </div>
                {!data ? <SkeletonRows rows={4} /> : shown.length === 0 ? (
                    <EmptyState icon={<Mail size={20} />} title={filter === 'all' ? 'The outbox is empty' : `Nothing ${filter}`} />
                ) : (
                    <ul className="ac-divide -mx-2">
                        {shown.map(n => (
                            <li key={n.id} className="px-2 py-2.5 grid items-center gap-x-3 gap-y-2 grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_auto_6rem]">
                                <div className="min-w-0">
                                    <p className="text-sm font-medium break-words">{n.subject}</p>
                                    <p className="text-[12px] font-light ac-faint break-words">
                                        to {n.recipient} · {n.kind.replace(/_/g, ' ')} · {timeAgo(n.created_at)}
                                        {n.attempts > 1 ? ` · ${n.attempts} tries` : ''}
                                    </p>
                                    {n.last_error && <p className="text-[12px] text-[var(--ac-bad)] break-words">{n.last_error}</p>}
                                </div>
                                <StatusPill status={n.status} />
                                <div className="col-span-2 sm:col-span-1 flex justify-end">
                                    {n.status === 'failed' && <Button disabled={busy === n.id} onClick={() => act(n, 'retry')}>Retry</Button>}
                                    {n.status === 'pending' && <Button disabled={busy === n.id} onClick={() => act(n, 'cancel')}>Cancel</Button>}
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </Section>
        </div>
    );
};

/* ------------------------------ Health -------------------------------- */

interface Health {
    environment: string;
    checks: { name: string; ok: boolean; detail: string }[];
    migrations: string[];
    loginMethods: { emailPassword: { signIn: boolean; signUp: boolean }; google: { signIn: boolean; signUp: boolean } };
    authOrigins: string[];
    flags: Record<string, string>;
}

export const HealthPanel: React.FC = () => {
    const [h, setH] = useState<Health | null>(null);
    const [at, setAt] = useState(0);
    const [loading, setLoading] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try { setH(await api<Health>('/admin/health')); setAt(Date.now()); }
        catch (e) { toast.error((e as ApiError).message); } finally { setLoading(false); }
    }, []);
    useEffect(() => { load(); }, [load]);

    if (!h) {
        return (
            <div className="space-y-6" aria-busy="true">
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-5">
                    {[0, 1, 2, 3].map(i => <Skeleton key={i} className={`${STAT_TILE_H} rounded-2xl`} />)}
                </div>
                <Skeleton className="h-96 rounded-2xl" />
            </div>
        );
    }

    const problems = h.checks.filter(c => !c.ok);
    // Problems first, so what needs doing is at the top.
    const checks = [...problems, ...h.checks.filter(c => c.ok)];
    const signIn = [h.loginMethods.emailPassword.signIn && 'Email', h.loginMethods.google.signIn && 'Google'].filter(Boolean).join(' · ') || 'None';

    return (
        <div className="space-y-6">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-5">
                <HealthTile label="Environment" value={h.environment} />
                <HealthTile label="Checks" value={<span className="tabular-nums">{h.checks.length - problems.length}<span className="ac-faint text-base"> / {h.checks.length}</span></span>}
                    foot={problems.length === 0 ? 'All configured' : `${problems.length} need attention`} tone={problems.length ? 'warn' : 'ok'} />
                <HealthTile label="Migrations" value={<span className="tabular-nums">{h.migrations.length}</span>} foot={h.migrations[h.migrations.length - 1] ?? 'Not recorded'} />
                <HealthTile label="Sign-in" value={signIn} foot={h.loginMethods.emailPassword.signUp ? 'Public sign-up open' : 'Public sign-up closed'} />
            </div>

            <Section
                title="Configuration checks"
                description="Secrets are reported only as configured or missing; their values never leave the server."
                actions={
                    <span className="flex items-center gap-2 text-[12px] ac-faint">
                        {at ? `Checked ${timeAgo(at)}` : ''}
                        <button type="button" onClick={load} disabled={loading} aria-label="Check again" title="Check again"
                            className="neu-button !px-2.5">
                            <RefreshCw size={14} className={loading ? 'ac-spin' : ''} />
                        </button>
                    </span>
                }
            >
                <ul className="ac-divide -mx-2">
                    {checks.map(c => (
                        <li key={c.name} className="px-2 py-3 grid grid-cols-[auto_minmax(0,1fr)] sm:grid-cols-[auto_minmax(0,15rem)_minmax(0,1fr)] gap-x-3 gap-y-0.5 items-start text-[13px]">
                            {c.ok
                                ? <CheckCircle2 size={16} className="text-[var(--ac-ok)] mt-0.5 row-span-2 sm:row-span-1" aria-label="OK" />
                                : <TriangleAlert size={16} className="text-[var(--ac-warn)] mt-0.5 row-span-2 sm:row-span-1" aria-label="Needs attention" />}
                            <span className="font-medium break-words">{c.name}</span>
                            <span className="ac-muted break-words">{c.detail}</span>
                        </li>
                    ))}
                </ul>
            </Section>

            <div className="grid gap-6 grid-cols-1 lg:grid-cols-2 items-start">
                <Section title="Database migrations" actions={<Activity size={16} className="ac-faint" />}>
                    {h.migrations.length === 0 ? <p className="text-sm ac-muted">Not recorded.</p> : (
                        <ol className="font-mono text-[12px] space-y-1.5">
                            {h.migrations.map(m => <li key={m} className="flex items-center gap-2 min-w-0"><CheckCircle2 size={13} className="text-[var(--ac-ok)] shrink-0" /><span className="truncate">{m}</span></li>)}
                        </ol>
                    )}
                </Section>
                <Section title="Settings in effect">
                    <dl className="grid grid-cols-2 gap-x-5 gap-y-4">
                        <Detail label="Email sign-in">{h.loginMethods.emailPassword.signIn ? 'On' : 'Off'}</Detail>
                        <Detail label="Google sign-in">{h.loginMethods.google.signIn ? 'On' : 'Off'}</Detail>
                        <Detail label="Public sign-up">{h.loginMethods.emailPassword.signUp ? 'Open' : 'Closed'}</Detail>
                        {Object.entries(h.flags).map(([k, v]) => <Detail key={k} label={k}><span className="[overflow-wrap:anywhere]">{v}</span></Detail>)}
                        <div className="col-span-2">
                            <Detail label="Allowed addresses">
                                {h.authOrigins.length === 0 ? null : (
                                    <span className="flex flex-col gap-0.5 font-mono text-[12px]">{h.authOrigins.map(o => <span key={o} className="[overflow-wrap:anywhere]">{o}</span>)}</span>
                                )}
                            </Detail>
                        </div>
                    </dl>
                </Section>
            </div>
        </div>
    );
};

const HealthTile: React.FC<{ label: string; value: React.ReactNode; foot?: string; tone?: 'ok' | 'warn' }> = props => <StatTile {...props} />;
