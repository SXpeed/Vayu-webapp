// Your own account in the control centre: name, password, two-factor,
// signed-in devices, appearance and sign-out. Laid out like the app's
// Profile page, with the security pieces a provider administrator needs.

import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Check, Copy, KeyRound, LogOut, Monitor, Moon, ShieldCheck, Smartphone, Sun } from 'lucide-react';
import { Button, Field, Input, ReadOnlyValue, ToggleRow } from '../components/ui';
import { api, authClient, timeAgo, type ApiError, type Reauth } from './api';
import { Avatar, PageHeader, Section, Skeleton, SkeletonRows, StatusPill, device, useDialogs } from './kit';

interface Me { userId: string; email: string; role: string }
interface SessionRow { id: string; created_at: string; last_active: string; user_agent: string | null; ip: string | null }
interface Account {
    user: { id: string; name: string; email: string; two_factor: number | null; created_at: string };
    sessions: SessionRow[];
    loginMethods: string[];
}

const THEME_KEY = 'vayu_theme';
const readTheme = (): 'light' | 'dark' => (document.documentElement.classList.contains('dark') ? 'dark' : 'light');

/** Better Auth reports a stale sign-in as SESSION_NOT_FRESH. */
const notFresh = (e: { code?: string; message?: string } | null | undefined) =>
    !!e && (e.code === 'SESSION_NOT_FRESH' || /fresh/i.test(e.message ?? ''));

export const ProfilePanel: React.FC<{
    me: Me; reauth: Reauth; onNameChange: (name: string) => void; onSecurityChange: () => void; onSignOut: () => void;
}> = ({ me, reauth, onNameChange, onSecurityChange, onSignOut }) => {
    const dialogs = useDialogs();
    const [account, setAccount] = useState<Account | null>(null);
    const [currentSession, setCurrentSession] = useState<string | null>(null);
    const [twoFactor, setTwoFactor] = useState(false);

    const load = useCallback(async () => {
        try {
            const [acc, sess] = await Promise.all([
                api<Account>(`/admin/accounts/${encodeURIComponent(me.userId)}`),
                authClient.getSession(),
            ]);
            setAccount(acc);
            setCurrentSession(sess.data?.session.id ?? null);
            setTwoFactor(!!(sess.data?.user as { twoFactorEnabled?: boolean } | undefined)?.twoFactorEnabled || !!acc.user.two_factor);
        } catch (e) { toast.error((e as ApiError).message); }
    }, [me.userId]);
    useEffect(() => { load(); }, [load]);

    if (!account) {
        return (
            <div className="space-y-6" aria-busy="true">
                <PageHeader title="Profile" description={me.email} />
                <Skeleton className="h-[132px] rounded-2xl" />
                <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,26rem)] items-start">
                    <div className="space-y-6"><Skeleton className="h-64 rounded-2xl" /><Skeleton className="h-80 rounded-2xl" /></div>
                    <div className="space-y-6"><Skeleton className="h-56 rounded-2xl" /><Skeleton className="h-40 rounded-2xl" /></div>
                </div>
            </div>
        );
    }

    const name = account.user.name;

    return (
        <div className="space-y-6">
            <PageHeader title="Profile" description={me.email} />

            {/* Who you are, at a glance. */}
            <section className="neu-card p-5 lg:p-6 flex flex-wrap items-center gap-5">
                <Avatar name={name || me.email} size={72} />
                <div className="min-w-0 flex-1">
                    <p className="font-serif text-2xl leading-tight text-gray-900 dark:text-gray-100 break-words">{name || 'No name yet'}</p>
                    <p className="mt-1 text-sm font-light text-gray-600 dark:text-gray-400 break-all">{me.email}</p>
                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                        <StatusPill tone="accent">Provider {me.role}</StatusPill>
                        <StatusPill tone={twoFactor ? 'ok' : 'warn'}>{twoFactor ? '2FA on' : '2FA off'}</StatusPill>
                        <span className="text-[11px] font-light text-gray-600 dark:text-gray-400">
                            Signs in with {account.loginMethods.map(m => (m === 'credential' ? 'password' : m[0].toUpperCase() + m.slice(1))).join(' and ') || 'password'}
                            {' · '}joined {new Date(account.user.created_at).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}
                        </span>
                    </div>
                </div>
            </section>

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,26rem)] items-start">
                <div className="space-y-6 min-w-0">
                    <DetailsCard name={name} email={me.email} onSaved={n => { setAccount(a => a && { ...a, user: { ...a.user, name: n } }); onNameChange(n); }} />
                    <PasswordCard hasPassword={account.loginMethods.includes('credential')} onChanged={load} />
                    <DevicesCard sessions={account.sessions} currentId={currentSession} reauth={reauth} onChanged={load} />
                </div>
                <div className="space-y-6 min-w-0">
                    <TwoFactorCard on={twoFactor} dialogs={dialogs} onChanged={() => { load(); onSecurityChange(); }} />
                    <AppearanceCard />
                    <Button variant="danger" block onClick={onSignOut} icon={<LogOut size={16} />} className="uppercase tracking-wider">
                        Sign out
                    </Button>
                </div>
            </div>
        </div>
    );
};

/* ───────────────────────────── Details ───────────────────────────────── */

const DetailsCard: React.FC<{ name: string; email: string; onSaved: (name: string) => void }> = ({ name, email, onSaved }) => {
    const [value, setValue] = useState(name);
    const [busy, setBusy] = useState(false);
    const trimmed = value.trim();
    const dirty = trimmed !== name;
    const valid = trimmed.length >= 2 && trimmed.length <= 80;

    const save = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!dirty || !valid) return;
        setBusy(true);
        const { error } = await authClient.updateUser({ name: trimmed });
        setBusy(false);
        if (error) { toast.error(error.message || 'Could not save your name'); return; }
        onSaved(trimmed);
        toast.success('Name saved');
    };

    return (
        <Section title="Personal details">
            <form onSubmit={save} className="space-y-4">
                <Field label="Full name" htmlFor="pf-name" hint="Shown in the audit log and to other administrators.">
                    <Input id="pf-name" value={value} maxLength={80} onChange={e => setValue(e.target.value)} autoComplete="name" />
                </Field>
                <Field label="Email address" hint="This is how you sign in, so it can't be changed here.">
                    <ReadOnlyValue className="break-all">{email}</ReadOnlyValue>
                </Field>
                <div className="flex flex-wrap justify-end gap-2.5">
                    <Button type="button" onClick={() => setValue(name)} disabled={!dirty || busy}>Discard</Button>
                    <Button type="submit" variant="primary" icon={<Check size={14} />} disabled={!dirty || !valid || busy}>{busy ? 'Saving…' : 'Save'}</Button>
                </div>
            </form>
        </Section>
    );
};

/* ───────────────────────────── Password ──────────────────────────────── */

const PasswordCard: React.FC<{ hasPassword: boolean; onChanged: () => void }> = ({ hasPassword, onChanged }) => {
    const [current, setCurrent] = useState('');
    const [next, setNext] = useState('');
    const [again, setAgain] = useState('');
    const [signOutOthers, setSignOutOthers] = useState(true);
    const [busy, setBusy] = useState(false);

    const tooShort = next.length > 0 && next.length < 10;
    const mismatch = again.length > 0 && again !== next;
    const ready = current.length > 0 && next.length >= 10 && next === again;

    const save = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!ready) return;
        setBusy(true);
        const { error } = await authClient.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: signOutOthers });
        setBusy(false);
        if (error) { toast.error(error.message || 'Could not change your password'); return; }
        setCurrent(''); setNext(''); setAgain('');
        toast.success(signOutOthers ? 'Password changed. Your other devices are signed out.' : 'Password changed');
        onChanged();
    };

    if (!hasPassword) {
        return (
            <Section title="Password" actions={<KeyRound size={16} className="ac-faint" />}>
                <p className="text-sm font-light text-gray-700 dark:text-gray-300">You sign in with Google, so there is no password on this account.</p>
            </Section>
        );
    }

    return (
        <Section title="Password" description="At least 10 characters. A passphrase of a few words is easiest to remember." actions={<KeyRound size={16} className="ac-faint" />}>
            <form onSubmit={save} className="space-y-4">
                <Field label="Current password" htmlFor="pf-current">
                    <Input id="pf-current" type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="New password" htmlFor="pf-new" hint={tooShort ? 'Needs at least 10 characters.' : ' '}>
                        <Input id="pf-new" type="password" autoComplete="new-password" value={next} maxLength={128} onChange={e => setNext(e.target.value)} aria-invalid={tooShort} />
                    </Field>
                    <Field label="Repeat it" htmlFor="pf-again" hint={mismatch ? 'The two don’t match.' : ' '}>
                        <Input id="pf-again" type="password" autoComplete="new-password" value={again} maxLength={128} onChange={e => setAgain(e.target.value)} aria-invalid={mismatch} />
                    </Field>
                </div>
                <ToggleRow title="Sign out my other devices" description="Recommended if you think someone else knows the old password."
                    checked={signOutOthers} onChange={() => setSignOutOthers(v => !v)} />
                <div className="flex justify-end">
                    <Button type="submit" variant="primary" disabled={!ready || busy}>{busy ? 'Changing…' : 'Change password'}</Button>
                </div>
            </form>
        </Section>
    );
};

/* ───────────────────────────── Two-factor ────────────────────────────── */

const TwoFactorCard: React.FC<{ on: boolean; dialogs: ReturnType<typeof useDialogs>; onChanged: () => void }> = ({ on, dialogs, onChanged }) => {
    const [setup, setSetup] = useState<{ secret: string; codes: string[] } | null>(null);
    const [codes, setCodes] = useState<string[] | null>(null);
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);

    const askPassword = (title: string, confirmLabel: string, body?: string, danger = false) =>
        dialogs.prompt({ title, body, label: 'Your password', inputType: 'password', minLength: 1, confirmLabel, danger });

    const start = async () => {
        const password = await askPassword('Turn on two-factor authentication', 'Continue', 'Confirm your password to create a key for your authenticator app.');
        if (!password) return;
        setBusy(true);
        const { data, error } = await authClient.twoFactor.enable({ password });
        setBusy(false);
        if (error || !data || !('totpURI' in data)) { toast.error(error?.message || 'Could not start set-up'); return; }
        setSetup({ secret: new URL(data.totpURI).searchParams.get('secret') ?? '', codes: data.backupCodes });
    };

    const confirm = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        const { error } = await authClient.twoFactor.verifyTotp({ code: code.trim() });
        setBusy(false);
        if (error) { toast.error(error.message || 'That code did not work'); return; }
        setSetup(null); setCode('');
        toast.success('Two-factor authentication is on');
        onChanged();
    };

    const newCodes = async () => {
        const password = await askPassword('New backup codes', 'Create new codes', 'Your old backup codes stop working.');
        if (!password) return;
        setBusy(true);
        const { data, error } = await authClient.twoFactor.generateBackupCodes({ password });
        setBusy(false);
        if (error || !data) { toast.error(error?.message || 'Could not create new codes'); return; }
        setCodes(data.backupCodes);
    };

    const turnOff = async () => {
        const password = await askPassword('Turn off two-factor authentication?',
            'Turn off', 'Provider administrators are required to use it. With it off, the control centre asks you to set it up again before letting you in.', true);
        if (!password) return;
        setBusy(true);
        const { error } = await authClient.twoFactor.disable({ password });
        setBusy(false);
        if (error) { toast.error(error.message || 'Could not turn it off'); return; }
        toast.success('Two-factor authentication is off');
        onChanged();
    };

    return (
        <Section title="Two-factor authentication" actions={<StatusPill tone={on ? 'ok' : 'warn'}>{on ? 'On' : 'Off'}</StatusPill>}
            description="A 6-digit code from an authenticator app, on top of your password. Required for everyone who uses this control centre.">
            {setup ? (
                <form onSubmit={confirm} className="space-y-4">
                    <Field label="1. Add this key to your authenticator app" hint="Choose “enter a setup key”, time-based.">
                        <CopyValue value={setup.secret} mono />
                    </Field>
                    <Field label="2. Save these backup codes" hint="Each works once if you lose your phone. They are not shown again.">
                        <CopyValue value={setup.codes.join('\n')} mono multiline />
                    </Field>
                    <Field label="3. Enter the code it shows" htmlFor="pf-code">
                        <Input id="pf-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} />
                    </Field>
                    <div className="flex flex-wrap justify-end gap-2.5">
                        <Button type="button" onClick={() => { setSetup(null); setCode(''); }}>Cancel</Button>
                        <Button type="submit" variant="primary" disabled={busy || code.trim().length < 6}>Turn on</Button>
                    </div>
                </form>
            ) : on ? (
                <div className="space-y-4">
                    {codes && (
                        <Field label="Your new backup codes" hint="Save them now. They are not shown again.">
                            <CopyValue value={codes.join('\n')} mono multiline />
                        </Field>
                    )}
                    <div className="flex flex-wrap gap-2.5">
                        <Button onClick={newCodes} disabled={busy} icon={<ShieldCheck size={15} />}>New backup codes</Button>
                        <Button variant="danger" onClick={turnOff} disabled={busy}>Turn off</Button>
                    </div>
                </div>
            ) : (
                <Button variant="primary" onClick={start} disabled={busy} icon={<ShieldCheck size={15} />}>Set up two-factor</Button>
            )}
        </Section>
    );
};

/** A value in the app's read-only well, with a copy button. */
const CopyValue: React.FC<{ value: string; mono?: boolean; multiline?: boolean }> = ({ value, mono, multiline }) => {
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1600); }
        catch { toast.error('Copy it by hand; the browser blocked the clipboard.'); }
    };
    return (
        <div className="flex items-start gap-2">
            <p className={`neu-value flex-1 min-w-0 select-all break-all ${mono ? 'font-mono text-[13px]' : ''} ${multiline ? 'whitespace-pre-wrap' : ''}`}>{value}</p>
            <button type="button" onClick={copy} aria-label="Copy" title="Copy"
                className="w-9 h-9 shrink-0 neu-raised-sm neu-btn rounded-full flex items-center justify-center active-scale text-gray-700 dark:text-gray-200">
                {copied ? <Check size={15} className="text-[var(--ac-ok)]" /> : <Copy size={15} />}
            </button>
        </div>
    );
};

/* ───────────────────────────── Devices ───────────────────────────────── */

const DevicesCard: React.FC<{ sessions: SessionRow[]; currentId: string | null; reauth: Reauth; onChanged: () => void }> = ({ sessions, currentId, reauth, onChanged }) => {
    const dialogs = useDialogs();
    const [busy, setBusy] = useState<string | null>(null);
    const others = sessions.filter(s => s.id !== currentId);

    const signOutOne = async (s: SessionRow) => {
        setBusy(s.id);
        try {
            // Finding a session's token needs a recent sign-in; ask for one if needed.
            let list = await authClient.listSessions();
            if (list.error && notFresh(list.error) && await reauth()) list = await authClient.listSessions();
            if (list.error) throw new Error(list.error.message || 'Could not list your devices');
            const target = (list.data ?? []).find(x => x.id === s.id);
            if (target) {
                const { error } = await authClient.revokeSession({ token: target.token });
                if (error) throw new Error(error.message || 'Could not sign that device out');
            }
            toast.success('Signed out');
            onChanged();
        } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
    };

    const signOutOthers = async () => {
        if (!(await dialogs.confirm({ title: 'Sign out your other devices?', body: 'Every device except this one needs to sign in again.', confirmLabel: 'Sign them out' }))) return;
        setBusy('others');
        const { error } = await authClient.revokeOtherSessions();
        setBusy(null);
        if (error) { toast.error(error.message || 'Could not sign them out'); return; }
        toast.success('Your other devices are signed out');
        onChanged();
    };

    return (
        <Section title="Signed-in devices" description={`${sessions.length} active`}
            actions={others.length > 0 ? <Button onClick={signOutOthers} disabled={busy === 'others'}>Sign out others</Button> : undefined}>
            {sessions.length === 0 ? <SkeletonRows rows={1} /> : (
                <ul className="ac-divide -mx-2">
                    {sessions.map(s => {
                        const d = device(s.user_agent);
                        const Icon = d.phone ? Smartphone : Monitor;
                        const mine = s.id === currentId;
                        return (
                            <li key={s.id} className="px-2 py-3 grid items-center gap-x-3 gap-y-2 grid-cols-[auto_minmax(0,1fr)_auto]">
                                <span className="w-9 h-9 rounded-full neu-inset flex items-center justify-center text-gray-600 dark:text-gray-300"><Icon size={16} /></span>
                                <div className="min-w-0">
                                    <p className="text-sm flex flex-wrap items-center gap-2">
                                        <span className="truncate">{d.label}</span>
                                        {mine && <StatusPill tone="ok">This device</StatusPill>}
                                    </p>
                                    <p className="text-[11px] font-light text-gray-600 dark:text-gray-400 truncate">
                                        {[s.ip || null, `active ${timeAgo(s.last_active)}`, `since ${timeAgo(s.created_at)}`].filter(Boolean).join(' · ')}
                                    </p>
                                </div>
                                {mine ? <span /> : (
                                    <Button onClick={() => signOutOne(s)} disabled={busy === s.id} className="!px-3.5">{busy === s.id ? '…' : 'Sign out'}</Button>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </Section>
    );
};

/* ───────────────────────────── Appearance ────────────────────────────── */

const AppearanceCard: React.FC = () => {
    const [theme, setTheme] = useState(readTheme);
    const toggle = () => {
        const next = theme === 'dark' ? 'light' : 'dark';
        document.documentElement.classList.toggle('dark', next === 'dark');
        document.querySelector('meta[name="theme-color"]')?.setAttribute('content', next === 'dark' ? '#22252b' : '#e9edf4');
        try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
        setTheme(next);
    };
    return (
        <Section title="Appearance">
            <ToggleRow icon={theme === 'dark' ? <Moon size={18} /> : <Sun size={18} />} title="Dark mode"
                description="Shared with the app on this browser." checked={theme === 'dark'} onChange={toggle} />
        </Section>
    );
};
