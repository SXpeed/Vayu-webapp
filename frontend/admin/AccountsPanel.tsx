// Everyone who can sign in, across all organizations.
//
//   #/accounts        the directory, searchable
//   #/accounts/:id    the directory with one person open alongside
//
// Shows who someone is, which organizations they belong to and where they are
// signed in — never a password or a session token. Disabling an account ends
// its sessions at once and blocks new sign-ins by any method.

import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { KeyRound, LogOut, Monitor, Search, ShieldCheck, Smartphone, UserCheck, UserX, Users } from 'lucide-react';
import { Input } from '../components/ui';
import { api, guarded, postJson, timeAgo, type ApiError, type Reauth } from './api';
import { Avatar, Detail, Drawer, EmptyState, PageHeader, Section, SkeletonRows, StatusPill, device, useDialogs } from './kit';

interface AccountRow {
    id: string; name: string; email: string; email_verified: number; two_factor: number | null; created_at: string;
    status: string; organizations: number; active_sessions: number; provider_role: string | null; last_seen: string | null;
}

interface AccountDetail {
    user: { id: string; name: string; email: string; email_verified: number; two_factor: number | null; created_at: string; status: string; status_reason: string | null };
    memberships: { id: string; role: string; status: string; org_id: string; org_name: string; org_status: string }[];
    sessions: { created_at: string; last_active: string; expires_at: string; user_agent: string | null; ip: string | null }[];
    loginMethods: string[];
    providerAdmin: { role: string; status: string } | null;
}

export const AccountsPanel: React.FC<{ reauth: Reauth; routeId?: string; go: (section: string, id?: string) => void }> = ({ reauth, routeId, go }) => {
    const [q, setQ] = useState('');
    const [rows, setRows] = useState<AccountRow[] | null>(null);

    const load = useCallback(async (term: string) => {
        try { setRows((await api<{ accounts: AccountRow[] }>(`/admin/accounts${term ? `?q=${encodeURIComponent(term)}` : ''}`)).accounts); }
        catch (e) { toast.error((e as ApiError).message); }
    }, []);
    // Debounced; the current rows stay until new ones arrive, so nothing flashes.
    useEffect(() => { const t = setTimeout(() => load(q.trim()), q ? 250 : 0); return () => clearTimeout(t); }, [q, load]);

    return (
        <div className="space-y-6">
            <PageHeader title="Accounts" description="Everyone who can sign in" />
            <Section>
                <div className="relative mb-4 md:max-w-sm">
                    <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 ac-faint pointer-events-none" />
                    <Input className="!pl-9" placeholder="Search by name or email…" value={q} onChange={e => setQ(e.target.value)} />
                </div>
                {!rows ? <SkeletonRows rows={7} /> : rows.length === 0 ? (
                    <EmptyState icon={<Users size={20} />} title="No accounts match" />
                ) : (
                    <ul className="ac-divide -mx-2">
                        {rows.map(r => (
                            <li key={r.id}>
                                <button type="button" onClick={() => go('accounts', r.id)}
                                    className="ac-row w-full text-left px-2 py-2.5 grid items-center gap-x-4 gap-y-1 grid-cols-[auto_minmax(0,1fr)_auto] md:grid-cols-[auto_minmax(0,1.6fr)_minmax(0,0.7fr)_minmax(0,0.7fr)_minmax(0,0.8fr)_auto]">
                                    <Avatar name={r.name} />
                                    <span className="min-w-0">
                                        <span className="block text-sm font-medium truncate">{r.name}</span>
                                        <span className="block text-[12px] ac-faint truncate">{r.email}</span>
                                    </span>
                                    <span className="hidden md:block text-[13px] ac-muted">{r.organizations} org{r.organizations === 1 ? '' : 's'}</span>
                                    <span className="hidden md:block text-[13px] ac-muted">{r.active_sessions} device{r.active_sessions === 1 ? '' : 's'}</span>
                                    <span className="hidden md:block text-[12px] ac-faint">{r.last_seen ? `seen ${timeAgo(r.last_seen)}` : 'never signed in'}</span>
                                    <span className="flex flex-wrap justify-end gap-1.5">
                                        {r.status === 'disabled' && <StatusPill status="disabled" />}
                                        {r.provider_role && <StatusPill tone="accent">{r.provider_role}</StatusPill>}
                                        {!r.email_verified && <StatusPill tone="neutral">unverified</StatusPill>}
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </Section>
            <AccountDrawer id={routeId} reauth={reauth} onClose={() => go('accounts')} onOpenOrg={id => go('orgs', id)} onChanged={() => load(q.trim())} />
        </div>
    );
};

function tempPassword(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return btoa(String.fromCodePoint(...bytes)).replace(/[+/=]/g, '').slice(0, 14);
}

const AccountDrawer: React.FC<{ id?: string; reauth: Reauth; onClose: () => void; onOpenOrg: (id: string) => void; onChanged: () => void }> = ({ id, reauth, onClose, onOpenOrg, onChanged }) => {
    const dialogs = useDialogs();
    const [d, setD] = useState<AccountDetail | null>(null);
    const [newPassword, setNewPassword] = useState<string | null>(null);

    const load = useCallback(async () => {
        if (!id) return;
        try { setD(await api<AccountDetail>(`/admin/accounts/${id}`)); } catch (e) { toast.error((e as ApiError).message); }
    }, [id]);
    useEffect(() => { setD(null); setNewPassword(null); load(); }, [load]);

    const run = async (path: string, body: Record<string, unknown>, done: string) => {
        const res = await guarded(reauth, () => api(`/admin/accounts/${id}/${path}`, postJson(body)), m => toast.error(m));
        if (res !== undefined) { toast.success(done); await load(); onChanged(); }
        return res !== undefined;
    };

    const disabled = d?.user.status === 'disabled';

    const signOutAll = async () => {
        if (await dialogs.confirm({ title: 'Sign out everywhere?', body: `${d?.user.name} is signed out on every device and must sign in again.`, confirmLabel: 'Sign out everywhere' })) {
            await run('revoke-sessions', {}, 'Signed out everywhere');
        }
    };
    const reset = async () => {
        if (!(await dialogs.confirm({ title: 'Reset the password?', body: 'A new temporary password is created and shown once. They are signed out everywhere and must use it.', confirmLabel: 'Reset password' }))) return;
        const pw = tempPassword();
        if (await run('reset-password', { temporaryPassword: pw }, 'Password reset')) setNewPassword(pw);
    };
    const toggle = async () => {
        if (disabled) {
            if (await dialogs.confirm({ title: 'Enable this account?', body: 'They will be able to sign in again.', confirmLabel: 'Enable' })) await run('status', { status: 'active' }, 'Account enabled');
            return;
        }
        const reason = await dialogs.prompt({ title: 'Disable this account?', body: 'They are signed out everywhere immediately and cannot sign in by any method until enabled again.', label: 'Reason', multiline: true, minLength: 3, confirmLabel: 'Disable', danger: true });
        if (reason) await run('status', { status: 'disabled', reason }, 'Account disabled');
    };

    return (
        <Drawer open={!!id} onClose={onClose} width={640}
            title={d?.user.name ?? 'Account'}
            meta={d && <>{disabled && <StatusPill status="disabled" />}{d.providerAdmin?.status === 'active' && <StatusPill tone="accent">provider {d.providerAdmin.role}</StatusPill>}</>}
            subtitle={d?.user.email}
            footer={d ? (
                <>
                    <button type="button" className="neu-button" onClick={signOutAll}><LogOut size={15} /> Sign out everywhere</button>
                    <button type="button" className="neu-button" onClick={reset}><KeyRound size={15} /> Reset password</button>
                    <button type="button" className={`neu-button ${disabled ? 'neu-button-primary' : 'neu-button-danger'}`} onClick={toggle}>
                        {disabled ? <><UserCheck size={15} /> Enable</> : <><UserX size={15} /> Disable</>}
                    </button>
                </>
            ) : undefined}>
            {!d ? <SkeletonRows rows={6} /> : (
                <>
                    {newPassword && (
                        <div className="neu-inset rounded-xl p-4 ac-enter-soft">
                            <p className="text-[13px] ac-muted">New temporary password — pass it on privately. It is not shown again.</p>
                            <p className="mt-2 font-mono text-lg tracking-wide select-all break-all">{newPassword}</p>
                        </div>
                    )}
                    {disabled && d.user.status_reason && (
                        <div className="neu-inset rounded-xl p-3.5 text-[13px] text-[var(--ac-bad)]">Disabled: {d.user.status_reason}</div>
                    )}

                    <Section title="Account">
                        <dl className="ac-grid-fit !gap-x-5 !gap-y-4" style={{ ['--ac-min' as string]: '10rem' }}>
                            <Detail label="Email">{d.user.email_verified ? <StatusPill tone="ok">verified</StatusPill> : <StatusPill tone="neutral">not verified</StatusPill>}</Detail>
                            <Detail label="Two-factor">{d.user.two_factor ? <span className="inline-flex items-center gap-1 text-[var(--ac-ok)]"><ShieldCheck size={14} /> On</span> : 'Off'}</Detail>
                            <Detail label="Signs in with">{d.loginMethods.map(m => (m === 'credential' ? 'password' : m)).join(', ') || 'Nothing yet'}</Detail>
                            <Detail label="Joined">{timeAgo(d.user.created_at)}</Detail>
                        </dl>
                    </Section>

                    <Section title="Organizations">
                        {d.memberships.length === 0 ? <p className="text-sm ac-muted">Not a member of any organization.</p> : (
                            <ul className="ac-divide -mx-2">
                                {d.memberships.map(m => (
                                    <li key={m.id}>
                                        <button type="button" onClick={() => onOpenOrg(m.org_id)} className="ac-row w-full text-left px-2 py-2.5 flex flex-wrap items-center gap-2">
                                            <span className="flex-1 min-w-0 text-sm font-medium truncate">{m.org_name}</span>
                                            <StatusPill tone="neutral">{m.role}</StatusPill>
                                            {m.status !== 'active' && <StatusPill status={m.status} />}
                                            {m.org_status !== 'active' && <StatusPill status={m.org_status} />}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </Section>

                    <Section title="Signed-in devices" description={`${d.sessions.length} active`}>
                        {d.sessions.length === 0 ? <p className="text-sm ac-muted">Not signed in anywhere.</p> : (
                            <ul className="space-y-3">
                                {d.sessions.map((s, i) => {
                                    const dv = device(s.user_agent);
                                    return (
                                        <li key={i} className="flex items-center gap-3">
                                            <span className="w-9 h-9 rounded-[12px] neu-inset flex items-center justify-center ac-muted shrink-0">{dv.phone ? <Smartphone size={16} /> : <Monitor size={16} />}</span>
                                            <span className="min-w-0 flex-1">
                                                <span className="block text-sm truncate">{dv.label}</span>
                                                <span className="block text-[12px] ac-faint truncate">{[s.ip || null, `active ${timeAgo(s.last_active)}`, `since ${timeAgo(s.created_at)}`].filter(Boolean).join(' · ')}</span>
                                            </span>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </Section>
                </>
            )}
        </Drawer>
    );
};
