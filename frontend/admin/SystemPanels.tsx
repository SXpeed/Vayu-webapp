// Provider administrators, notification delivery, and system health.

import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Activity, CheckCircle2, Mail, ShieldCheck, XCircle } from 'lucide-react';
import { Badge, Button, Card, Field, Input, SectionTitle, Select } from '../components/ui';
import { api, guarded, timeAgo, type ApiError, type Reauth } from './api';

/* -------------------------- Provider admins --------------------------- */

interface AdminRow { user_id: string; role: string; status: string; created_at: number; email: string; name: string; two_factor: number | null }

const ROLE_HINT: Record<string, string> = {
    owner: 'Everything, including who administers the platform',
    admin: 'Organizations, plans, applications and accounts',
    support: 'Same as admin today; support sessions will be limited to this role',
};

export const AdminsPanel: React.FC<{ reauth: Reauth; myRole: string; myEmail: string }> = ({ reauth, myRole, myEmail }) => {
    const [rows, setRows] = useState<AdminRow[] | null>(null);
    const [email, setEmail] = useState('');
    const [role, setRole] = useState('admin');
    const isOwner = myRole === 'owner';

    const load = useCallback(async () => {
        try { setRows((await api<{ admins: AdminRow[] }>('/admin/admins')).admins); } catch (e) { toast.error((e as ApiError).message); }
    }, []);
    useEffect(() => { load(); }, [load]);

    const change = async (init: RequestInit, path: string, done: string) => {
        const res = await guarded(reauth, () => api<{ admins: AdminRow[] }>(path, init), m => toast.error(m));
        if (res) { setRows(res.admins); toast.success(done); }
        return !!res;
    };

    return (
        <Card padding="lg">
            <SectionTitle actions={<ShieldCheck size={16} />}>Provider administrators</SectionTitle>
            <p className="text-[12px] mb-3 text-gray-600 dark:text-gray-400">
                People who can use this control centre. Every one of them must use two-factor authentication.
                {!isOwner && ' Only a platform owner can change this list.'}
            </p>
            {!rows ? <p className="text-sm">Loading…</p> : (
                <ul className="divide-y divide-black/5 dark:divide-white/10 mb-4">
                    {rows.map(r => {
                        const self = r.email === myEmail;
                        return (
                            <li key={r.user_id} className="py-2.5 flex flex-wrap items-center gap-2">
                                <span className="flex-1 min-w-0">
                                    <span className="block text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{r.name}{self ? ' (you)' : ''}</span>
                                    <span className="block text-[12px] text-gray-600 dark:text-gray-400 truncate">{r.email} · {r.two_factor ? '2FA on' : '2FA not set up'}</span>
                                </span>
                                {r.status !== 'active' && <Badge>{r.status}</Badge>}
                                <Select aria-label={`Role for ${r.email}`} className="w-32" value={r.role} disabled={!isOwner || self}
                                    onChange={e => change({ method: 'PATCH', body: JSON.stringify({ role: e.target.value }) }, `/admin/admins/${r.user_id}`, 'Role changed')}>
                                    <option value="owner">owner</option>
                                    <option value="admin">admin</option>
                                    <option value="support">support</option>
                                </Select>
                                <Button disabled={!isOwner || self}
                                    onClick={() => change({ method: 'PATCH', body: JSON.stringify({ status: r.status === 'active' ? 'disabled' : 'active' }) }, `/admin/admins/${r.user_id}`, r.status === 'active' ? 'Access removed' : 'Access restored')}>
                                    {r.status === 'active' ? 'Remove access' : 'Restore'}
                                </Button>
                            </li>
                        );
                    })}
                </ul>
            )}
            {isOwner && (
                <form className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] items-end" onSubmit={async e => {
                    e.preventDefault();
                    if (await change({ method: 'POST', body: JSON.stringify({ email, role }) }, '/admin/admins', 'Administrator added')) setEmail('');
                }}>
                    <Field label="Add an administrator" htmlFor="adm-new" hint="The account must already exist (Accounts).">
                        <Input id="adm-new" type="email" required value={email} onChange={e => setEmail(e.target.value)} />
                    </Field>
                    <Field label="Role" htmlFor="adm-role" hint={ROLE_HINT[role]}>
                        <Select id="adm-role" value={role} onChange={e => setRole(e.target.value)}>
                            <option value="owner">owner</option>
                            <option value="admin">admin</option>
                            <option value="support">support</option>
                        </Select>
                    </Field>
                    <Button type="submit" variant="primary">Add</Button>
                </form>
            )}
        </Card>
    );
};

/* --------------------------- Notifications ---------------------------- */

interface Notice { id: string; kind: string; recipient: string; subject: string; status: string; attempts: number; last_error: string | null; created_at: number; sent_at: number | null }

export const NotificationsPanel: React.FC = () => {
    const [data, setData] = useState<{ notifications: Notice[]; counts: Record<string, number> } | null>(null);
    const [providerEmail, setProviderEmail] = useState('');

    const load = useCallback(async () => {
        try {
            setData(await api('/admin/notifications'));
            const s = await api<{ providerEmail: string | null }>('/admin/settings/notifications');
            setProviderEmail(s.providerEmail ?? '');
        } catch (e) { toast.error((e as ApiError).message); }
    }, []);
    useEffect(() => { load(); }, [load]);

    const save = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            await api('/admin/settings/notifications', { method: 'PUT', body: JSON.stringify({ providerEmail }) });
            toast.success('Saved');
        } catch (err) { toast.error((err as ApiError).message); }
    };

    const act = async (id: string, what: 'retry' | 'cancel') => {
        try { setData(await api(`/admin/notifications/${id}/${what}`, { method: 'POST' })); } catch (e) { toast.error((e as ApiError).message); }
    };

    return (
        <div className="space-y-6">
            <Card padding="lg">
                <SectionTitle actions={<Mail size={16} />}>Where notices go</SectionTitle>
                <form onSubmit={save} className="grid gap-3 sm:grid-cols-[1fr_auto] items-end">
                    <Field label="Your notification email" htmlFor="nt-email" hint="New and updated applications are sent here.">
                        <Input id="nt-email" type="email" value={providerEmail} onChange={e => setProviderEmail(e.target.value)} placeholder="you@yourcompany.com" />
                    </Field>
                    <Button type="submit" variant="primary">Save</Button>
                </form>
                <p className="text-[12px] mt-3 text-amber-700 dark:text-amber-400">
                    No email provider is connected yet, so notices are queued here instead of being sent. Nothing is lost:
                    they go out once a provider is connected, and every application is in the queue either way.
                </p>
            </Card>

            <Card padding="lg">
                <SectionTitle>Outbox</SectionTitle>
                {!data ? <p className="text-sm">Loading…</p> : (
                    <>
                        <p className="text-[12px] mb-3 text-gray-600 dark:text-gray-400">
                            {Object.entries(data.counts).map(([k, v]) => `${v} ${k}`).join(' · ') || 'Empty'}
                        </p>
                        <ul className="divide-y divide-black/5 dark:divide-white/10">
                            {data.notifications.map(n => (
                                <li key={n.id} className="py-2.5 flex flex-wrap items-center gap-2 text-[13px]">
                                    <span className="flex-1 min-w-0">
                                        <span className="block font-medium text-gray-900 dark:text-gray-100 truncate">{n.subject}</span>
                                        <span className="block text-[12px] text-gray-600 dark:text-gray-400 truncate">
                                            to {n.recipient} · {n.kind.replace(/_/g, ' ')} · {timeAgo(n.created_at)}
                                            {n.last_error ? ` · ${n.last_error}` : ''}
                                        </span>
                                    </span>
                                    <Badge>{n.status}</Badge>
                                    {n.status === 'failed' && <Button onClick={() => act(n.id, 'retry')}>Retry</Button>}
                                    {n.status === 'pending' && <Button onClick={() => act(n.id, 'cancel')}>Cancel</Button>}
                                </li>
                            ))}
                        </ul>
                    </>
                )}
            </Card>
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
    useEffect(() => { api<Health>('/admin/health').then(setH).catch(e => toast.error((e as ApiError).message)); }, []);
    if (!h) return <Card><p className="text-sm">Checking…</p></Card>;
    const problems = h.checks.filter(c => !c.ok).length;

    return (
        <div className="space-y-6">
            <Card padding="lg">
                <SectionTitle actions={<Activity size={16} />}>System health</SectionTitle>
                <p className="text-sm mb-4 text-gray-700 dark:text-gray-300">
                    Environment: <strong>{h.environment}</strong> · {problems === 0 ? 'everything configured' : `${problems} item${problems === 1 ? '' : 's'} need attention`}
                </p>
                <ul className="divide-y divide-black/5 dark:divide-white/10">
                    {h.checks.map(c => (
                        <li key={c.name} className="py-2.5 flex items-start gap-3 text-[13px]">
                            {c.ok
                                ? <CheckCircle2 size={16} className="text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" />
                                : <XCircle size={16} className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />}
                            <span className="w-52 shrink-0 font-medium text-gray-900 dark:text-gray-100">{c.name}</span>
                            <span className="text-gray-700 dark:text-gray-300">{c.detail}</span>
                        </li>
                    ))}
                </ul>
                <p className="text-[11px] mt-3 text-gray-600 dark:text-gray-400">Secrets are reported only as configured or missing; their values never leave the server.</p>
            </Card>
            <div className="grid gap-6 grid-cols-1 lg:grid-cols-2">
                <Card padding="lg">
                    <SectionTitle>Database migrations</SectionTitle>
                    {h.migrations.length === 0 ? <p className="text-sm">Not recorded.</p> : (
                        <ul className="font-mono text-[12px] space-y-1 text-gray-800 dark:text-gray-200">{h.migrations.map(m => <li key={m}>{m}</li>)}</ul>
                    )}
                </Card>
                <Card padding="lg">
                    <SectionTitle>Configuration</SectionTitle>
                    <ul className="text-[13px] space-y-1 text-gray-800 dark:text-gray-200">
                        <li>Sign-in: email {h.loginMethods.emailPassword.signIn ? 'on' : 'off'} · Google {h.loginMethods.google.signIn ? 'on' : 'off'}</li>
                        <li>Public sign-up: {h.loginMethods.emailPassword.signUp ? 'open' : 'closed'}</li>
                        <li>Allowed addresses: {h.authOrigins.join(', ') || '—'}</li>
                        {Object.entries(h.flags).map(([k, v]) => <li key={k}>{k}: {v}</li>)}
                    </ul>
                </Card>
            </div>
        </div>
    );
};
