// Every account that can sign in, across all organizations.
//
// Shows who someone is, which organizations they belong to and where they are
// signed in — never a password or a session token. Disabling an account ends
// its sessions at once and stops new sign-ins by any method.

import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { ArrowLeft, KeyRound, LogOut, UserX, Users } from 'lucide-react';
import { Badge, Button, Card, Input, SectionTitle } from '../components/ui';
import { api, guarded, postJson, timeAgo, type ApiError, type Reauth } from './api';

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

export const AccountsPanel: React.FC<{ reauth: Reauth; onOpenOrg?: (orgId: string) => void }> = ({ reauth, onOpenOrg }) => {
    const [openId, setOpenId] = useState<string | null>(null);
    return openId
        ? <AccountView id={openId} reauth={reauth} onBack={() => setOpenId(null)} onOpenOrg={onOpenOrg} />
        : <AccountList onOpen={setOpenId} />;
};

const AccountList: React.FC<{ onOpen: (id: string) => void }> = ({ onOpen }) => {
    const [q, setQ] = useState('');
    const [rows, setRows] = useState<AccountRow[] | null>(null);

    useEffect(() => {
        const t = setTimeout(() => {
            api<{ accounts: AccountRow[] }>(`/admin/accounts${q ? `?q=${encodeURIComponent(q)}` : ''}`)
                .then(r => setRows(r.accounts)).catch(e => toast.error((e as ApiError).message));
        }, 250);
        return () => clearTimeout(t);
    }, [q]);

    return (
        <Card padding="lg">
            <SectionTitle actions={<Users size={16} />}>Accounts</SectionTitle>
            <Input className="mb-4" placeholder="Search by name or email…" value={q} onChange={e => setQ(e.target.value)} />
            {!rows ? <p className="text-sm">Loading…</p> : rows.length === 0 ? (
                <p className="text-sm text-gray-600 dark:text-gray-400">No accounts match.</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-[13px]">
                        <thead>
                            <tr className="text-left text-[11px] uppercase tracking-[0.1em] text-gray-600 dark:text-gray-400">
                                <th className="py-2 pr-3 font-medium">Account</th>
                                <th className="py-2 pr-3 font-medium">Organizations</th>
                                <th className="py-2 pr-3 font-medium">Signed in</th>
                                <th className="py-2 pr-3 font-medium">Last seen</th>
                                <th className="py-2 font-medium">State</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-black/5 dark:divide-white/10">
                            {rows.map(r => (
                                <tr key={r.id} className="cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/[0.03]" onClick={() => onOpen(r.id)}>
                                    <td className="py-2.5 pr-3">
                                        <span className="block font-medium text-gray-900 dark:text-gray-100">{r.name}</span>
                                        <span className="block text-gray-600 dark:text-gray-400">{r.email}</span>
                                    </td>
                                    <td className="py-2.5 pr-3">{r.organizations}</td>
                                    <td className="py-2.5 pr-3">{r.active_sessions} device{r.active_sessions === 1 ? '' : 's'}</td>
                                    <td className="py-2.5 pr-3 text-gray-600 dark:text-gray-400">{timeAgo(r.last_seen)}</td>
                                    <td className="py-2.5">
                                        <span className="flex flex-wrap gap-1">
                                            {r.status === 'disabled' && <Badge>disabled</Badge>}
                                            {r.provider_role && <Badge>provider {r.provider_role}</Badge>}
                                            {!r.email_verified && <Badge>unverified</Badge>}
                                            {r.two_factor ? <Badge>2FA</Badge> : null}
                                        </span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </Card>
    );
};

function tempPassword(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return btoa(String.fromCodePoint(...bytes)).replace(/[+/=]/g, '').slice(0, 14);
}

const AccountView: React.FC<{ id: string; reauth: Reauth; onBack: () => void; onOpenOrg?: (orgId: string) => void }> = ({ id, reauth, onBack, onOpenOrg }) => {
    const [d, setD] = useState<AccountDetail | null>(null);
    const [newPassword, setNewPassword] = useState<string | null>(null);

    const load = useCallback(async () => {
        try { setD(await api<AccountDetail>(`/admin/accounts/${id}`)); } catch (e) { toast.error((e as ApiError).message); }
    }, [id]);
    useEffect(() => { load(); }, [load]);

    if (!d) return <Card><p className="text-sm">Loading account…</p></Card>;
    const disabled = d.user.status === 'disabled';

    const run = async (path: string, body: Record<string, unknown>, done: string) => {
        const res = await guarded(reauth, () => api(`/admin/accounts/${id}/${path}`, postJson(body)), m => toast.error(m));
        if (res !== undefined) { toast.success(done); await load(); }
        return res !== undefined;
    };

    const toggleDisabled = async () => {
        if (disabled) { await run('status', { status: 'active' }, 'Account enabled'); return; }
        const reason = window.prompt('Why is this account being disabled? It is signed out everywhere immediately.');
        if (reason) await run('status', { status: 'disabled', reason }, 'Account disabled and signed out');
    };

    const reset = async () => {
        if (!window.confirm('Set a new temporary password? The person is signed out everywhere and must use the new one.')) return;
        const pw = tempPassword();
        if (await run('reset-password', { temporaryPassword: pw }, 'Password reset')) setNewPassword(pw);
    };

    return (
        <div className="space-y-6">
            <Card padding="lg">
                <button type="button" onClick={onBack} className="text-[12px] text-gray-600 dark:text-gray-400 flex items-center gap-1 mb-2">
                    <ArrowLeft size={14} /> All accounts
                </button>
                <div className="flex flex-wrap items-center gap-3">
                    <h2 className="font-serif text-xl text-gray-900 dark:text-gray-100">{d.user.name}</h2>
                    {disabled && <Badge>disabled</Badge>}
                    {d.providerAdmin?.status === 'active' && <Badge>provider {d.providerAdmin.role}</Badge>}
                </div>
                <p className="text-[12px] text-gray-600 dark:text-gray-400 mt-1">
                    {d.user.email} · {d.user.email_verified ? 'email verified' : 'email not verified'} · {d.user.two_factor ? '2FA on' : '2FA off'}
                    {' · '}signs in with {d.loginMethods.map(m => (m === 'credential' ? 'password' : m)).join(', ') || 'nothing yet'}
                    {' · '}joined {timeAgo(d.user.created_at)}
                </p>
                {disabled && d.user.status_reason && <p className="text-[12px] mt-2 text-amber-700 dark:text-amber-400">Disabled: {d.user.status_reason}</p>}
                <div className="mt-4 flex flex-wrap gap-2">
                    <Button icon={<LogOut size={16} />} onClick={() => run('revoke-sessions', {}, 'Signed out everywhere')}>Sign out everywhere</Button>
                    <Button icon={<KeyRound size={16} />} onClick={reset}>Reset password</Button>
                    <Button variant={disabled ? 'primary' : 'danger'} icon={<UserX size={16} />} onClick={toggleDisabled}>
                        {disabled ? 'Enable account' : 'Disable account'}
                    </Button>
                </div>
                {newPassword && (
                    <div className="mt-4 neu-inset rounded-xl p-3 text-[13px]">
                        New temporary password — pass it on privately; it is not shown again:
                        <span className="block font-mono text-base mt-1 select-all">{newPassword}</span>
                    </div>
                )}
            </Card>

            <Card padding="lg">
                <SectionTitle>Organizations</SectionTitle>
                {d.memberships.length === 0 ? <p className="text-sm text-gray-600 dark:text-gray-400">Not a member of any organization.</p> : (
                    <ul className="divide-y divide-black/5 dark:divide-white/10">
                        {d.memberships.map(m => (
                            <li key={m.id} className="py-2 flex flex-wrap items-center gap-2 text-sm">
                                <button type="button" className="font-medium text-gray-900 dark:text-gray-100 hover:underline" onClick={() => onOpenOrg?.(m.org_id)}>{m.org_name}</button>
                                <Badge>{m.role}</Badge>
                                {m.status !== 'active' && <Badge>{m.status}</Badge>}
                                {m.org_status !== 'active' && <Badge>org {m.org_status}</Badge>}
                            </li>
                        ))}
                    </ul>
                )}
            </Card>

            <Card padding="lg">
                <SectionTitle>Signed-in devices</SectionTitle>
                {d.sessions.length === 0 ? <p className="text-sm text-gray-600 dark:text-gray-400">Not signed in anywhere.</p> : (
                    <ul className="divide-y divide-black/5 dark:divide-white/10">
                        {d.sessions.map((s, i) => (
                            <li key={i} className="py-2 text-[13px] text-gray-800 dark:text-gray-200">
                                <span className="block truncate">{s.user_agent ?? 'Unknown device'}</span>
                                <span className="block text-[12px] text-gray-600 dark:text-gray-400">
                                    {s.ip ?? 'unknown address'} · active {timeAgo(s.last_active)} · since {timeAgo(s.created_at)}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </Card>
        </div>
    );
};
