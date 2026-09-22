// Provider control panel (ateliersupport staff only).
//
// This screen is convenience, not security: every /api/v2/admin call is
// checked on the server (session + provider_admins row + 2FA).

import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, authClient, type ApiError } from './api';
import { OrgsPanel } from './OrgsPanel';
import { PlansPanel } from './PlansPanel';
import { BrandingPanel } from './BrandingPanel';
import { useBranding } from '../useBranding';
import {
    Activity, Building2, ClipboardList, History, Image as ImageIcon, KeyRound, LayoutDashboard, Layers, LogOut,
    Mail, Menu, ShieldCheck, Users, X,
} from 'lucide-react';
import { Button, Card, Field, Input, SectionTitle, ToggleRow } from '../components/ui';
import { OverviewPanel } from './OverviewPanel';
import { ApplicationsPanel } from './ApplicationsPanel';
import { AccountsPanel } from './AccountsPanel';
import { AdminsPanel, HealthPanel, NotificationsPanel } from './SystemPanels';

interface LoginMethods {
    emailPassword: { signIn: boolean; signUp: boolean };
    google: { signIn: boolean; signUp: boolean };
}

interface MethodsInfo {
    stored: LoginMethods;
    effective: LoginMethods;
    googleConfigured: boolean;
    googleRedirectUri: string | null;
    actorHasGoogle: boolean;
}

interface AuditEntry {
    id: string;
    at: number;
    actor_kind: string;
    actor_email: string | null;
    action: string;
    target_type: string | null;
    target_id: string | null;
    details: string | null;
}

type Screen =
    | { kind: 'loading' }
    | { kind: 'signed-out' }
    | { kind: 'not-admin' }
    | { kind: 'setup-2fa' }
    | { kind: 'ready'; email: string; role: string }
    | { kind: 'unavailable'; message: string };

type Tab = 'overview' | 'applications' | 'orgs' | 'accounts' | 'plans' | 'notifications' | 'branding' | 'security' | 'health' | 'audit';

interface NavItem { tab: Tab; label: string; icon: React.ReactNode; badge?: number }

const TAB_TITLES: Record<Tab, string> = {
    overview: 'Overview', applications: 'Applications', orgs: 'Organizations', accounts: 'Accounts', plans: 'Plans',
    notifications: 'Notifications', branding: 'Branding', security: 'Login & security', health: 'System health', audit: 'Audit log',
};

export const AdminApp: React.FC = () => {
    const branding = useBranding();
    const [screen, setScreen] = useState<Screen>({ kind: 'loading' });
    const [tab, setTab] = useState<Tab>('overview');
    const [focusId, setFocusId] = useState<string | undefined>(undefined);
    const [menuOpen, setMenuOpen] = useState(false);
    const [badges, setBadges] = useState<{ applications: number; notifications: number }>({ applications: 0, notifications: 0 });
    // Sensitive actions may need a sign-in newer than 30 minutes. The panel
    // asks here and the caller retries once.
    const [reauthResolve, setReauthResolve] = useState<((ok: boolean) => void) | null>(null);
    const reauth = useCallback(() => new Promise<boolean>(resolve => setReauthResolve(() => resolve)), []);

    const refresh = useCallback(async () => {
        try {
            const me = await api<{ email: string; role: string }>('/admin/me');
            setScreen({ kind: 'ready', email: me.email, role: me.role });
        } catch (e) {
            const err = e as ApiError;
            if (err.status === 401) setScreen({ kind: 'signed-out' });
            else if (err.code === 'not_provider_admin') setScreen({ kind: 'not-admin' });
            else if (err.code === '2fa_required') setScreen({ kind: 'setup-2fa' });
            else setScreen({ kind: 'unavailable', message: err.message || 'The control panel is unavailable.' });
        }
    }, []);

    const loadBadges = useCallback(async () => {
        try {
            const o = await api<{ applications: Record<string, number>; notifications: Record<string, number> }>('/admin/overview');
            setBadges({ applications: o.applications.pending_review ?? 0, notifications: o.notifications.pending ?? 0 });
        } catch { /* badges are a convenience */ }
    }, []);

    useEffect(() => { refresh(); }, [refresh]);
    useEffect(() => { if (screen.kind === 'ready') loadBadges(); }, [screen.kind, loadBadges]);

    const signOut = async () => {
        await authClient.signOut();
        setScreen({ kind: 'signed-out' });
    };

    const navigate = (next: string, id?: string) => {
        setTab(next as Tab);
        setFocusId(id);
        setMenuOpen(false);
        window.scrollTo({ top: 0 });
    };

    if (screen.kind !== 'ready') {
        return (
            <div className="min-h-dvh px-4 py-8 lg:py-12">
                <div className="w-full max-w-md mx-auto space-y-6">
                    <header className="flex items-center gap-3">
                        {branding.logoUrl && <img src={branding.logoUrl} alt="" className="w-10 h-10 rounded-xl object-contain" />}
                        <div>
                            <h1 className="font-serif text-2xl text-gold-700 dark:text-gold-300">{branding.appName}</h1>
                            <p className="text-[11px] uppercase tracking-[0.14em] text-gray-600 dark:text-gray-400">Control centre</p>
                        </div>
                    </header>
                    {screen.kind === 'loading' && <p className="text-sm text-gray-600 dark:text-gray-400">Loading…</p>}
                    {screen.kind === 'unavailable' && <Card><p className="text-sm">{screen.message}</p></Card>}
                    {screen.kind === 'signed-out' && <SignIn onDone={refresh} />}
                    {screen.kind === 'not-admin' && (
                        <Card>
                            <p className="text-sm mb-3">This account is not a provider administrator.</p>
                            <Button onClick={signOut} icon={<LogOut size={16} />}>Sign out</Button>
                        </Card>
                    )}
                    {screen.kind === 'setup-2fa' && (
                        <>
                            <SetupTwoFactor onDone={refresh} />
                            <Button onClick={signOut} icon={<LogOut size={16} />}>Sign out</Button>
                        </>
                    )}
                </div>
            </div>
        );
    }

    const groups: { title: string; items: NavItem[] }[] = [
        { title: 'Business', items: [
            { tab: 'overview', label: 'Overview', icon: <LayoutDashboard size={17} /> },
            { tab: 'applications', label: 'Applications', icon: <ClipboardList size={17} />, badge: badges.applications },
            { tab: 'orgs', label: 'Organizations', icon: <Building2 size={17} /> },
            { tab: 'accounts', label: 'Accounts', icon: <Users size={17} /> },
            { tab: 'plans', label: 'Plans', icon: <Layers size={17} /> },
        ] },
        { title: 'Platform', items: [
            { tab: 'notifications', label: 'Notifications', icon: <Mail size={17} />, badge: badges.notifications },
            { tab: 'branding', label: 'Branding', icon: <ImageIcon size={17} /> },
            { tab: 'security', label: 'Login & security', icon: <ShieldCheck size={17} /> },
            { tab: 'health', label: 'System health', icon: <Activity size={17} /> },
            { tab: 'audit', label: 'Audit log', icon: <History size={17} /> },
        ] },
    ];

    const nav = (
        <nav className="space-y-6">
            {groups.map(g => (
                <div key={g.title}>
                    <p className="px-3 mb-2 text-[10px] uppercase tracking-[0.16em] text-gray-500 dark:text-gray-400">{g.title}</p>
                    <ul className="space-y-1">
                        {g.items.map(item => (
                            <li key={item.tab}>
                                <button
                                    type="button"
                                    onClick={() => navigate(item.tab)}
                                    aria-current={tab === item.tab ? 'page' : undefined}
                                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm transition-colors ${
                                        tab === item.tab
                                            ? 'neu-inset text-gold-700 dark:text-gold-300 font-medium'
                                            : 'text-gray-700 dark:text-gray-300 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'}`}
                                >
                                    {item.icon}
                                    <span className="flex-1 text-left">{item.label}</span>
                                    {!!item.badge && (
                                        <span className="min-w-[1.4rem] h-5 px-1.5 rounded-full bg-gold-500 text-[11px] leading-5 text-center text-white">{item.badge}</span>
                                    )}
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            ))}
        </nav>
    );

    const brandBlock = (
        <div className="flex items-center gap-3 px-3">
            {branding.logoUrl
                ? <img src={branding.logoUrl} alt="" className="w-9 h-9 rounded-xl object-contain" />
                : <span className="w-9 h-9 rounded-xl neu-accent flex items-center justify-center font-serif">{branding.appName.slice(0, 1).toUpperCase()}</span>}
            <div className="min-w-0">
                <p className="font-serif text-lg leading-tight text-gold-700 dark:text-gold-300 truncate">{branding.appName}</p>
                <p className="text-[10px] uppercase tracking-[0.16em] text-gray-500 dark:text-gray-400">Control centre</p>
            </div>
        </div>
    );

    const me = (
        <div className="px-3 pt-4 border-t border-black/5 dark:border-white/10">
            <p className="text-[12px] text-gray-900 dark:text-gray-100 truncate">{screen.email}</p>
            <p className="text-[11px] text-gray-600 dark:text-gray-400 mb-2">Provider {screen.role}</p>
            <Button onClick={signOut} icon={<LogOut size={15} />}>Sign out</Button>
        </div>
    );

    return (
        <div className="min-h-dvh lg:flex">
            {/* Desktop sidebar */}
            <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:shrink-0 lg:sticky lg:top-0 lg:h-dvh py-6 px-3 gap-6 border-r border-black/5 dark:border-white/10">
                {brandBlock}
                <div className="flex-1 overflow-y-auto">{nav}</div>
                {me}
            </aside>

            {/* Phone header + drawer */}
            <header className="lg:hidden flex items-center justify-between px-4 py-3 sticky top-0 z-20 bg-[var(--neu-bg)] border-b border-black/5 dark:border-white/10">
                {brandBlock}
                <button type="button" aria-label="Menu" onClick={() => setMenuOpen(true)} className="neu-button !px-3"><Menu size={18} /></button>
            </header>
            {menuOpen && (
                <div className="lg:hidden fixed inset-0 z-30 bg-black/30" onClick={() => setMenuOpen(false)}>
                    <div className="absolute right-0 top-0 h-full w-72 bg-[var(--neu-bg)] p-4 flex flex-col gap-6 overflow-y-auto" onClick={e => e.stopPropagation()}>
                        <div className="flex justify-end"><button type="button" aria-label="Close" onClick={() => setMenuOpen(false)} className="neu-button !px-3"><X size={18} /></button></div>
                        {nav}
                        {me}
                    </div>
                </div>
            )}

            <main className="flex-1 min-w-0 px-4 py-6 lg:px-10 lg:py-10">
                <div className="w-full max-w-6xl mx-auto space-y-6">
                    <h1 className="font-serif text-2xl lg:text-3xl text-gray-900 dark:text-gray-100">{TAB_TITLES[tab]}</h1>
                    {tab === 'overview' && <OverviewPanel navigate={navigate} />}
                    {tab === 'applications' && <ApplicationsPanel reauth={reauth} focusId={focusId} onCountsChange={loadBadges} />}
                    {tab === 'orgs' && <OrgsPanel reauth={reauth} focusId={focusId} />}
                    {tab === 'accounts' && <AccountsPanel reauth={reauth} onOpenOrg={id => navigate('orgs', id)} />}
                    {tab === 'plans' && <PlansPanel />}
                    {tab === 'notifications' && <NotificationsPanel />}
                    {tab === 'branding' && <BrandingPanel />}
                    {tab === 'security' && (
                        <div className="space-y-6">
                            <LoginMethodsPanel email={screen.email} />
                            <AdminsPanel reauth={reauth} myRole={screen.role} myEmail={screen.email} />
                        </div>
                    )}
                    {tab === 'health' && <HealthPanel />}
                    {tab === 'audit' && <AuditPanel />}
                </div>
            </main>

            {reauthResolve && (
                <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4">
                    <div className="w-full max-w-md">
                        <SignIn
                            email={screen.email}
                            title="Confirm it's you"
                            onDone={() => { reauthResolve(true); setReauthResolve(null); }}
                        />
                        <div className="mt-3 flex justify-end">
                            <Button onClick={() => { reauthResolve(false); setReauthResolve(null); }}>Cancel</Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

/* ------------------------------ Sign in ------------------------------ */

const SignIn: React.FC<{ onDone: () => void; email?: string; title?: string }> = ({ onDone, email: fixedEmail, title }) => {
    const [methods, setMethods] = useState<LoginMethods | null>(null);
    const [email, setEmail] = useState(fixedEmail ?? '');
    const [password, setPassword] = useState('');
    const [code, setCode] = useState('');
    const [needsCode, setNeedsCode] = useState(false);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        api<LoginMethods>('/public/login-methods').then(setMethods).catch(() => setMethods(null));
    }, []);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        try {
            if (!needsCode) {
                const { data, error } = await authClient.signIn.email({ email, password });
                if (error) throw new Error(error.message || 'Sign-in failed');
                if ((data as { twoFactorRedirect?: boolean })?.twoFactorRedirect) {
                    setNeedsCode(true);
                    return;
                }
            } else {
                const { error } = await authClient.twoFactor.verifyTotp({ code: code.trim() });
                if (error) throw new Error(error.message || 'That code did not work');
            }
            onDone();
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setBusy(false);
        }
    };

    const google = async () => {
        const { error } = await authClient.signIn.social({ provider: 'google', callbackURL: '/admin' });
        if (error) toast.error(error.message || 'Google sign-in failed');
    };

    return (
        <Card padding="lg">
            <SectionTitle>{title ?? 'Sign in'}</SectionTitle>
            <form onSubmit={submit} className="space-y-4">
                {!needsCode ? (
                    methods?.emailPassword.signIn !== false && (
                        <>
                            <Field label="Email" htmlFor="adm-email">
                                <Input id="adm-email" type="email" autoComplete="username" required value={email}
                                    readOnly={!!fixedEmail} onChange={e => setEmail(e.target.value)} />
                            </Field>
                            <Field label="Password" htmlFor="adm-password">
                                <Input id="adm-password" type="password" autoComplete="current-password" required
                                    value={password} onChange={e => setPassword(e.target.value)} />
                            </Field>
                            <Button type="submit" variant="primary" block disabled={busy}>
                                {busy ? 'Signing in…' : 'Sign in'}
                            </Button>
                        </>
                    )
                ) : (
                    <>
                        <Field label="Authenticator code" htmlFor="adm-code" hint="The 6-digit code from your authenticator app.">
                            <Input id="adm-code" inputMode="numeric" autoComplete="one-time-code" required
                                value={code} onChange={e => setCode(e.target.value)} />
                        </Field>
                        <Button type="submit" variant="primary" block disabled={busy}>Verify</Button>
                    </>
                )}
            </form>
            {!needsCode && methods?.google.signIn && (
                <div className="mt-4">
                    <Button block onClick={google}>Continue with Google</Button>
                </div>
            )}
        </Card>
    );
};

/* ---------------------------- 2FA set-up ----------------------------- */

const SetupTwoFactor: React.FC<{ onDone: () => void }> = ({ onDone }) => {
    const [password, setPassword] = useState('');
    const [secret, setSecret] = useState<string | null>(null);
    const [uri, setUri] = useState<string | null>(null);
    const [backupCodes, setBackupCodes] = useState<string[]>([]);
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);

    const start = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        const { data, error } = await authClient.twoFactor.enable({ password });
        setBusy(false);
        if (error || !data || !('totpURI' in data)) { toast.error(error?.message || 'Could not start 2FA set-up'); return; }
        setUri(data.totpURI);
        setSecret(new URL(data.totpURI).searchParams.get('secret'));
        setBackupCodes(data.backupCodes);
    };

    const confirm = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        const { error } = await authClient.twoFactor.verifyTotp({ code: code.trim() });
        setBusy(false);
        if (error) { toast.error(error.message || 'That code did not work'); return; }
        toast.success('Two-factor authentication is on');
        onDone();
    };

    return (
        <Card padding="lg">
            <SectionTitle>Set up two-factor authentication</SectionTitle>
            <p className="text-sm mb-4 text-gray-700 dark:text-gray-300">
                Provider administrators must use an authenticator app (Google Authenticator, 1Password, Authy…).
            </p>
            {!secret ? (
                <form onSubmit={start} className="space-y-4">
                    <Field label="Confirm your password" htmlFor="tfa-password">
                        <Input id="tfa-password" type="password" autoComplete="current-password" required
                            value={password} onChange={e => setPassword(e.target.value)} />
                    </Field>
                    <Button type="submit" variant="primary" disabled={busy}>Continue</Button>
                </form>
            ) : (
                <form onSubmit={confirm} className="space-y-4">
                    <Field label="1. Add this key to your authenticator app" hint="Choose “enter a setup key”, type: time-based.">
                        <p className="neu-value font-mono break-all select-all">{secret}</p>
                    </Field>
                    {uri && <p className="text-[11px] break-all text-gray-600 dark:text-gray-400">{uri}</p>}
                    <Field label="2. Save these backup codes somewhere safe" hint="Each works once if you lose your phone. They are not shown again.">
                        <p className="neu-value font-mono text-sm whitespace-pre-wrap select-all">{backupCodes.join('\n')}</p>
                    </Field>
                    <Field label="3. Enter the 6-digit code it shows" htmlFor="tfa-code">
                        <Input id="tfa-code" inputMode="numeric" autoComplete="one-time-code" required
                            value={code} onChange={e => setCode(e.target.value)} />
                    </Field>
                    <Button type="submit" variant="primary" disabled={busy}>Turn on 2FA</Button>
                </form>
            )}
        </Card>
    );
};

/* --------------------------- Login methods --------------------------- */

const LoginMethodsPanel: React.FC<{ email: string }> = ({ email }) => {
    const [info, setInfo] = useState<MethodsInfo | null>(null);
    const [draft, setDraft] = useState<LoginMethods | null>(null);
    const [saving, setSaving] = useState(false);
    const [reauth, setReauth] = useState(false);

    const load = useCallback(async () => {
        try {
            const data = await api<MethodsInfo>('/admin/settings/login-methods');
            setInfo(data);
            setDraft(data.stored);
        } catch (e) {
            toast.error((e as ApiError).message);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    if (!info || !draft) return <Card><p className="text-sm">Loading login methods…</p></Card>;

    const flip = (group: keyof LoginMethods, field: 'signIn' | 'signUp') =>
        setDraft(d => d && ({ ...d, [group]: { ...d[group], [field]: !d[group][field] } }));

    const dirty = JSON.stringify(draft) !== JSON.stringify(info.stored);

    const save = async () => {
        setSaving(true);
        try {
            await api('/admin/settings/login-methods', { method: 'PUT', body: JSON.stringify(draft) });
            toast.success('Login methods saved');
            await load();
        } catch (e) {
            const err = e as ApiError;
            if (err.code === 'reauth_required') setReauth(true);
            else toast.error(err.message);
        } finally {
            setSaving(false);
        }
    };

    const linkGoogle = async () => {
        const { error } = await authClient.linkSocial({ provider: 'google', callbackURL: '/admin' });
        if (error) toast.error(error.message || 'Could not link Google');
    };

    return (
        <Card padding="lg">
            <SectionTitle actions={<KeyRound size={16} />}>Login methods</SectionTitle>
            <p className="text-[12px] mb-3 text-gray-600 dark:text-gray-400">
                Applies to everyone: organization users and provider admins. Signing in never grants access to an
                organization by itself; membership is checked separately.
            </p>

            <div className="space-y-1">
                <ToggleRow title="Email & password sign-in" description="Local accounts."
                    checked={draft.emailPassword.signIn} onChange={() => flip('emailPassword', 'signIn')} />
                <ToggleRow title="Email & password sign-up" description="Public account creation. Keep off until verification email is set up."
                    checked={draft.emailPassword.signUp} onChange={() => flip('emailPassword', 'signUp')} />
                <ToggleRow title="Google sign-in"
                    description={info.googleConfigured ? 'Existing accounts only, once they have linked Google.' : 'Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.'}
                    checked={draft.google.signIn} disabled={!info.googleConfigured} onChange={() => flip('google', 'signIn')} />
                <ToggleRow title="Google sign-up" description="Lets new people create an account with Google."
                    checked={draft.google.signUp} disabled={!info.googleConfigured} onChange={() => flip('google', 'signUp')} />
            </div>

            <div className="mt-4 p-3 rounded-xl neu-inset text-[12px] space-y-1 text-gray-700 dark:text-gray-300">
                <p><ShieldCheck size={13} className="inline mr-1" />
                    Google: {info.googleConfigured ? 'credentials configured' : 'not configured'}
                    {info.googleConfigured && (info.actorHasGoogle ? ' · your admin login has Google linked' : ' · your admin login has no Google linked')}
                </p>
                {info.googleRedirectUri && (
                    <p className="break-all">Redirect URI to register in Google Cloud: <span className="font-mono select-all">{info.googleRedirectUri}</span></p>
                )}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
                <Button variant="primary" onClick={save} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save changes'}</Button>
                {dirty && <Button onClick={() => setDraft(info.stored)}>Discard</Button>}
                {info.googleConfigured && info.effective.google.signIn && !info.actorHasGoogle && (
                    <Button onClick={linkGoogle}>Link my Google account</Button>
                )}
            </div>

            {reauth && (
                <div className="mt-6">
                    <SignIn email={email} title="Confirm it's you" onDone={() => { setReauth(false); save(); }} />
                </div>
            )}
        </Card>
    );
};

/* ------------------------------- Audit ------------------------------- */

const AuditPanel: React.FC = () => {
    const [entries, setEntries] = useState<AuditEntry[] | null>(null);

    useEffect(() => {
        api<{ entries: AuditEntry[] }>('/admin/audit?limit=50')
            .then(r => setEntries(r.entries))
            .catch(e => toast.error((e as ApiError).message));
    }, []);

    return (
        <Card padding="lg">
            <SectionTitle actions={<History size={16} />}>Recent audit events</SectionTitle>
            {!entries ? (
                <p className="text-sm">Loading…</p>
            ) : entries.length === 0 ? (
                <p className="text-sm text-gray-600 dark:text-gray-400">Nothing recorded yet.</p>
            ) : (
                <ul className="divide-y divide-black/5 dark:divide-white/10">
                    {entries.map(e => (
                        <li key={e.id} className="py-2 text-[13px] text-gray-800 dark:text-gray-200">
                            <span className="font-mono text-[11px] text-gray-600 dark:text-gray-400 mr-2">
                                {new Date(e.at).toLocaleString()}
                            </span>
                            <strong>{e.action}</strong>
                            <span className="text-gray-600 dark:text-gray-400"> · {e.actor_email ?? e.actor_kind}</span>
                        </li>
                    ))}
                </ul>
            )}
        </Card>
    );
};
