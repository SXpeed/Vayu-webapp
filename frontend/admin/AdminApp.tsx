// Provider control panel (ateliersupport staff only).
//
// This screen is convenience, not security: every /api/v2/admin call is
// checked on the server (session + provider_admins row + 2FA).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import toast from 'react-hot-toast';
import {
    Activity, Building2, ClipboardList, History, Image as ImageIcon, KeyRound,
    LayoutDashboard, Layers, Mail, Search, ShieldCheck, User as UserIcon, Users,
} from 'lucide-react';
import { api, authClient, guarded, timeAgo, type ApiError, type Reauth } from './api';
import { OrgsPanel } from './OrgsPanel';
import { PlansPanel } from './PlansPanel';
import { BrandingPanel } from './BrandingPanel';
import { OverviewPanel } from './OverviewPanel';
import { ApplicationsPanel } from './ApplicationsPanel';
import { AccountsPanel } from './AccountsPanel';
import { ProfilePanel } from './ProfilePanel';
import { AdminsPanel, HealthPanel, NotificationsPanel } from './SystemPanels';
import { DialogProvider, EmptyState, PageHeader, Section, Segmented, SkeletonRows, StatusPill, useHashRoute } from './kit';
import { CommandPalette, Dock, MoreSheet, PhoneHeader, Sidebar, useSmoothScroll, type NavGroup, type NavItem, type Tab } from './Shell';
import { useBranding } from '../useBranding';
import { Button, Field, Input, ToggleRow } from '../components/ui';

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
    | { kind: 'ready'; userId: string; email: string; role: string; name: string }
    | { kind: 'unavailable'; message: string };

/** Titles for sections whose panel does not render its own page header. */
const HEADERS: Partial<Record<Tab, { title: string; description: string }>> = {
    orgs: { title: 'Organizations', description: 'Every business on the platform' },
    notifications: { title: 'Notifications', description: 'Where notices go and what is queued' },
    branding: { title: 'Branding', description: 'Platform name, logo and colour' },
    security: { title: 'Login & security', description: 'Sign-in methods and administrators' },
    health: { title: 'System health', description: 'Configuration and checks' },
    audit: { title: 'Audit log', description: 'Every administrative action' },
};

const TABS: Tab[] = ['overview', 'applications', 'orgs', 'accounts', 'plans', 'notifications', 'branding', 'security', 'health', 'audit', 'profile'];

const SIDEBAR_KEY = 'ac.sidebar.collapsed';
const readCollapsed = () => { try { return localStorage.getItem(SIDEBAR_KEY) === '1'; } catch { return false; } };

export const AdminApp: React.FC = () => (
    <DialogProvider>
        <ControlCentre />
    </DialogProvider>
);

/** The app's floating shell: inset from the window on a computer, full-bleed on a phone. */
const ShellFrame: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="ac h-dvh flex items-stretch justify-center p-0 lg:p-3 xl:p-4">
        <div className="w-full h-full relative overflow-hidden flex flex-col lg:flex-row bg-[var(--neu-bg)] lg:rounded-[1.5rem] lg:ring-1 lg:ring-gray-900/5 dark:lg:ring-white/5"
            style={{ boxShadow: '0 30px 70px -24px var(--neu-shadow-dark), 0 4px 14px var(--neu-shadow-light)' }}>
            {children}
        </div>
    </div>
);

const ControlCentre: React.FC = () => {
    const branding = useBranding();
    const brand = { appName: branding.appName, logoUrl: branding.logoUrl };
    const [screen, setScreen] = useState<Screen>({ kind: 'loading' });
    const [route, go] = useHashRoute();
    const tab: Tab = (TABS as string[]).includes(route.section) ? route.section as Tab : 'overview';
    const [collapsed, setCollapsed] = useState(readCollapsed);
    const [moreOpen, setMoreOpen] = useState(false);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [badges, setBadges] = useState({ applications: 0, notifications: 0 });
    const [reauthResolve, setReauthResolve] = useState<((ok: boolean) => void) | null>(null);
    const reauth = useCallback(() => new Promise<boolean>(resolve => setReauthResolve(() => resolve)), []);
    const mainRef = useRef<HTMLElement>(null);
    useSmoothScroll(mainRef);

    const refresh = useCallback(async () => {
        try {
            const [me, session] = await Promise.all([
                api<{ userId: string; email: string; role: string }>('/admin/me'),
                authClient.getSession().catch(() => null),
            ]);
            setScreen({ kind: 'ready', userId: me.userId, email: me.email, role: me.role, name: session?.data?.user.name ?? '' });
        } catch (e) {
            const err = e as ApiError;
            if (err.status === 401) setScreen({ kind: 'signed-out' });
            else if (err.code === 'not_provider_admin') setScreen({ kind: 'not-admin' });
            else if (err.code === '2fa_required') setScreen({ kind: 'setup-2fa' });
            else setScreen({ kind: 'unavailable', message: err.message || 'The control centre is unavailable.' });
        }
    }, []);

    // Counts in the menu. Refreshed on navigation and when the window regains
    // focus — no background timer.
    const loadBadges = useCallback(async () => {
        try {
            const o = await api<{ applications: Record<string, number>; notifications: Record<string, number> }>('/admin/overview');
            setBadges({ applications: o.applications.pending_review ?? 0, notifications: o.notifications.pending ?? 0 });
        } catch { /* the badges are a convenience */ }
    }, []);

    useEffect(() => { refresh(); }, [refresh]);
    useEffect(() => { if (screen.kind === 'ready') loadBadges(); }, [screen.kind, tab, loadBadges]);
    useEffect(() => {
        const on = () => { if (document.visibilityState === 'visible' && screen.kind === 'ready') loadBadges(); };
        document.addEventListener('visibilitychange', on);
        return () => document.removeEventListener('visibilitychange', on);
    }, [screen.kind, loadBadges]);

    // Ctrl/⌘ K opens quick jump anywhere.
    useEffect(() => {
        const on = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); }
        };
        window.addEventListener('keydown', on);
        return () => window.removeEventListener('keydown', on);
    }, []);

    // A new screen starts at the top; opening a record inside it does not scroll.
    const lastTab = useRef(tab);
    useEffect(() => {
        if (lastTab.current !== tab) { mainRef.current?.scrollTo({ top: 0 }); lastTab.current = tab; }
        setMoreOpen(false);
    }, [tab]);

    const navigate = useCallback((next: string, id?: string) => go(next, id), [go]);

    const toggleSidebar = () => setCollapsed(c => {
        try { localStorage.setItem(SIDEBAR_KEY, c ? '0' : '1'); } catch { /* private mode */ }
        return !c;
    });

    const signOut = async () => { await authClient.signOut(); setMoreOpen(false); setScreen({ kind: 'signed-out' }); };

    if (screen.kind !== 'ready') {
        return (
            <ShellFrame>
                <div className="flex-1 overflow-y-auto ac-no-scrollbar">
                    <div className="min-h-full flex flex-col items-center justify-center p-6">
                        <div className="w-full max-w-sm space-y-10 ac-enter">
                            <div className="text-center space-y-1">
                                {branding.logoUrl && <img src={branding.logoUrl} alt="" width={80} height={80} className="w-20 h-20 mx-auto mb-2 rounded-2xl object-contain" />}
                                <h1 className="text-4xl sm:text-5xl font-serif text-gold-500 tracking-wide break-words">{branding.appName}</h1>
                                <p className="text-[11px] text-gold-600 dark:text-gold-400 tracking-[0.24em] uppercase">Control centre</p>
                            </div>
                            {screen.kind === 'loading' && <div className="neu-raised rounded-3xl p-8"><SkeletonRows rows={2} /></div>}
                            {screen.kind === 'unavailable' && <div className="neu-raised rounded-3xl p-8 text-sm text-center">{screen.message}</div>}
                            {screen.kind === 'signed-out' && <SignIn onDone={refresh} />}
                            {screen.kind === 'not-admin' && (
                                <div className="neu-raised rounded-3xl p-8 text-center space-y-6">
                                    <p className="text-sm font-light">This account is not a provider administrator.</p>
                                    <button type="button" onClick={signOut} className="w-full neu-raised-sm neu-btn text-gold-700 dark:text-gold-300 rounded-full py-3 text-sm font-medium tracking-wide active-scale">Sign out</button>
                                </div>
                            )}
                            {screen.kind === 'setup-2fa' && (
                                <>
                                    <SetupTwoFactor onDone={refresh} />
                                    <button type="button" onClick={signOut} className="w-full text-[11px] uppercase tracking-[0.16em] text-gray-600 dark:text-gray-400">Sign out</button>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            </ShellFrame>
        );
    }

    const groups: NavGroup[] = [
        { title: 'Business', items: [
            { tab: 'overview', label: 'Overview', short: 'Overview', icon: LayoutDashboard },
            { tab: 'applications', label: 'Applications', short: 'Review', icon: ClipboardList, badge: badges.applications },
            { tab: 'orgs', label: 'Organizations', short: 'Orgs', icon: Building2 },
            { tab: 'accounts', label: 'Accounts', short: 'Accounts', icon: Users },
            { tab: 'plans', label: 'Plans', short: 'Plans', icon: Layers },
        ] },
        { title: 'Platform', items: [
            { tab: 'notifications', label: 'Notifications', short: 'Notices', icon: Mail, badge: badges.notifications },
            { tab: 'branding', label: 'Branding', short: 'Branding', icon: ImageIcon },
            { tab: 'security', label: 'Login & security', short: 'Security', icon: ShieldCheck },
            { tab: 'health', label: 'System health', short: 'Health', icon: Activity },
            { tab: 'audit', label: 'Audit log', short: 'Audit', icon: History },
        ] },
    ];
    const all = groups.flatMap(g => g.items);
    const dockTabs: Tab[] = ['overview', 'applications', 'orgs', 'accounts'];
    const dockItems = dockTabs.map(t => all.find(i => i.tab === t)!);
    const paletteItems: NavItem[] = [...all, { tab: 'profile', label: 'Profile', short: 'Profile', icon: UserIcon }];
    const header = HEADERS[tab];
    // Organization detail has its own header with a way back.
    const showHeader = !!header && !(tab === 'orgs' && route.id);

    return (
        <ShellFrame>
            <Sidebar brand={brand} groups={groups} current={tab} onNavigate={t => navigate(t)}
                collapsed={collapsed} onToggleCollapsed={toggleSidebar} name={screen.name || screen.email}
                onOpenPalette={() => setPaletteOpen(true)} />

            {/* Content column: phone header, the scroller, the phone dock. `min-h-0`
                lets it shrink to the shell instead of growing to the content. */}
            <div className="flex-1 flex flex-col min-w-0 min-h-0 relative">
                <PhoneHeader brand={brand} name={screen.name || screen.email} onOpenPalette={() => setPaletteOpen(true)}
                    onOpenProfile={() => navigate('profile')} onHome={() => navigate('overview')} />

                <main ref={mainRef} id="ac-main"
                    className="flex-1 min-h-0 overflow-y-auto ac-no-scrollbar overscroll-contain neu-scroll-fade"
                    style={{ WebkitOverflowScrolling: 'touch' }}>
                    <div className="w-full max-w-[1200px] mx-auto px-5 md:px-8 lg:px-10 pt-3 md:pt-5 lg:pt-8 pb-[calc(7rem+env(safe-area-inset-bottom,0px))] lg:pb-12">
                        {/* Keyed by section, so each screen fades in; opening a record does not re-animate the list. */}
                        <div key={tab} className="ac-enter space-y-6">
                            {showHeader && header && <PageHeader title={header.title} description={header.description} />}
                            {tab === 'overview' && <OverviewPanel navigate={navigate} />}
                            {tab === 'applications' && <ApplicationsPanel reauth={reauth} routeId={route.id} go={navigate} onCountsChange={loadBadges} />}
                            {tab === 'orgs' && <OrgsPanel reauth={reauth} routeId={route.id} go={navigate} />}
                            {tab === 'accounts' && <AccountsPanel reauth={reauth} routeId={route.id} go={navigate} />}
                            {tab === 'plans' && <PlansPanel routeId={route.id} go={navigate} />}
                            {tab === 'notifications' && <NotificationsPanel onChange={loadBadges} />}
                            {tab === 'branding' && <BrandingPanel />}
                            {tab === 'security' && (
                                <div className="space-y-6">
                                    <LoginMethodsPanel reauth={reauth} />
                                    <AdminsPanel reauth={reauth} myRole={screen.role} myEmail={screen.email} />
                                </div>
                            )}
                            {tab === 'health' && <HealthPanel />}
                            {tab === 'audit' && <AuditPanel />}
                            {tab === 'profile' && (
                                <ProfilePanel me={screen} reauth={reauth}
                                    onNameChange={name => setScreen(s => s.kind === 'ready' ? { ...s, name } : s)}
                                    onSecurityChange={refresh} onSignOut={signOut} />
                            )}
                        </div>
                    </div>
                </main>

                <Dock items={dockItems} current={tab} onNavigate={t => navigate(t)} onMore={() => setMoreOpen(true)} moreBadge={badges.notifications} />
            </div>

            {moreOpen && <MoreSheet items={all.filter(i => !dockTabs.includes(i.tab))} current={tab} name={screen.name} email={screen.email} role={screen.role}
                onPick={t => navigate(t)} onClose={() => setMoreOpen(false)} onSignOut={signOut} />}

            {paletteOpen && <CommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} navigate={navigate} />}

            {reauthResolve && createPortal(
                <>
                    <div className="ac-scrim ac-dialog-scrim neu-scrim" />
                    <div className="ac-dialog neu-modal p-6" role="dialog" aria-modal="true" aria-label="Confirm it's you">
                        <SignIn email={screen.email} title="Confirm it's you" compact onDone={() => { reauthResolve(true); setReauthResolve(null); }} />
                        <div className="mt-3 flex justify-center">
                            <button type="button" className="text-[11px] uppercase tracking-[0.16em] text-gray-600 dark:text-gray-400 py-2"
                                onClick={() => { reauthResolve(false); setReauthResolve(null); }}>Cancel</button>
                        </div>
                    </div>
                </>,
                document.getElementById('ac-overlays') ?? document.body,
            )}
        </ShellFrame>
    );
};

/* ------------------------------ Sign in ------------------------------ */

/** The app's sign-in form: small-caps labels, deep wells, a raised pill button. */
const SignIn: React.FC<{ onDone: () => void; email?: string; title?: string; compact?: boolean }> = ({ onDone, email: fixedEmail, title, compact = false }) => {
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

    const pillButton = 'w-full neu-raised-sm neu-btn text-gold-700 dark:text-gold-300 rounded-full py-3 text-sm font-medium tracking-wide active-scale disabled:opacity-50';

    return (
        <form onSubmit={submit} className={compact ? 'space-y-5' : 'space-y-6 neu-raised rounded-3xl p-8'}>
            <div className="text-center">
                <h2 className="text-lg font-serif text-gray-800 dark:text-gray-200">{needsCode ? 'Two-factor code' : (title ?? 'Welcome back')}</h2>
                {fixedEmail && <p className="text-[11px] text-gray-600 dark:text-gray-300 mt-1 break-all">{fixedEmail}</p>}
            </div>
            {!needsCode ? (
                methods?.emailPassword.signIn !== false && (
                    <>
                        {!fixedEmail && (
                            <Field label="Email" htmlFor="adm-email">
                                <Input id="adm-email" type="email" autoComplete="username" required value={email}
                                    placeholder="you@example.com" onChange={e => setEmail(e.target.value)} />
                            </Field>
                        )}
                        <Field label="Password" htmlFor="adm-password">
                            <Input id="adm-password" type="password" autoComplete="current-password" required autoFocus={!!fixedEmail}
                                value={password} onChange={e => setPassword(e.target.value)} />
                        </Field>
                        <button type="submit" disabled={busy} className={`${pillButton} mt-2`}>
                            {busy ? 'Signing in…' : 'Sign in'}
                        </button>
                    </>
                )
            ) : (
                <>
                    <Field label="Authenticator code" htmlFor="adm-code" hint="The 6-digit code from your authenticator app.">
                        <Input id="adm-code" inputMode="numeric" autoComplete="one-time-code" required autoFocus
                            value={code} onChange={e => setCode(e.target.value)} />
                    </Field>
                    <button type="submit" disabled={busy} className={pillButton}>Verify</button>
                </>
            )}
            {!needsCode && methods?.google.signIn && (
                <button type="button" onClick={google} className={pillButton}>Continue with Google</button>
            )}
        </form>
    );
};

/* ---------------------------- 2FA set-up ----------------------------- */

const SetupTwoFactor: React.FC<{ onDone: () => void }> = ({ onDone }) => {
    const [password, setPassword] = useState('');
    const [secret, setSecret] = useState<string | null>(null);
    const [backupCodes, setBackupCodes] = useState<string[]>([]);
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);

    const start = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        const { data, error } = await authClient.twoFactor.enable({ password });
        setBusy(false);
        if (error || !data || !('totpURI' in data)) { toast.error(error?.message || 'Could not start 2FA set-up'); return; }
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

    const pillButton = 'w-full neu-raised-sm neu-btn text-gold-700 dark:text-gold-300 rounded-full py-3 text-sm font-medium tracking-wide active-scale disabled:opacity-50';

    return (
        <div className="neu-raised rounded-3xl p-8 space-y-6">
            <div className="text-center">
                <h2 className="text-lg font-serif text-gray-800 dark:text-gray-200">Set up two-factor</h2>
                <p className="text-[11px] text-gray-600 dark:text-gray-300 mt-1">Provider administrators must use an authenticator app.</p>
            </div>
            {!secret ? (
                <form onSubmit={start} className="space-y-6">
                    <Field label="Confirm your password" htmlFor="tfa-password">
                        <Input id="tfa-password" type="password" autoComplete="current-password" required
                            value={password} onChange={e => setPassword(e.target.value)} />
                    </Field>
                    <button type="submit" disabled={busy} className={pillButton}>Continue</button>
                </form>
            ) : (
                <form onSubmit={confirm} className="space-y-5">
                    <Field label="1. Add this key to your app" hint="Choose “enter a setup key”, time-based.">
                        <p className="neu-value font-mono text-[13px] break-all select-all">{secret}</p>
                    </Field>
                    <Field label="2. Save these backup codes" hint="Each works once if you lose your phone. They are not shown again.">
                        <p className="neu-value font-mono text-[13px] whitespace-pre-wrap select-all">{backupCodes.join('\n')}</p>
                    </Field>
                    <Field label="3. Enter the 6-digit code" htmlFor="tfa-code">
                        <Input id="tfa-code" inputMode="numeric" autoComplete="one-time-code" required
                            value={code} onChange={e => setCode(e.target.value)} />
                    </Field>
                    <button type="submit" disabled={busy} className={pillButton}>Turn on 2FA</button>
                </form>
            )}
        </div>
    );
};

/* --------------------------- Login methods --------------------------- */

const LoginMethodsPanel: React.FC<{ reauth: Reauth }> = ({ reauth }) => {
    const [info, setInfo] = useState<MethodsInfo | null>(null);
    const [draft, setDraft] = useState<LoginMethods | null>(null);
    const [saving, setSaving] = useState(false);

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

    if (!info || !draft) return <Section title="Login methods"><SkeletonRows rows={4} /></Section>;

    const flip = (group: keyof LoginMethods, field: 'signIn' | 'signUp') =>
        setDraft(d => d && ({ ...d, [group]: { ...d[group], [field]: !d[group][field] } }));

    const dirty = JSON.stringify(draft) !== JSON.stringify(info.stored);

    const save = async () => {
        setSaving(true);
        // Changing how people sign in needs a recent sign-in; the shared prompt asks for one.
        const ok = await guarded(reauth, () => api('/admin/settings/login-methods', { method: 'PUT', body: JSON.stringify(draft) }), m => toast.error(m));
        if (ok !== undefined) { toast.success('Login methods saved'); await load(); }
        setSaving(false);
    };

    const linkGoogle = async () => {
        const { error } = await authClient.linkSocial({ provider: 'google', callbackURL: '/admin' });
        if (error) toast.error(error.message || 'Could not link Google');
    };

    const group = (title: string, tone: React.ReactNode, children: React.ReactNode) => (
        <div className="rounded-2xl neu-inset px-4 py-3 min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                <p className="text-sm font-medium">{title}</p>
                {tone}
            </div>
            <div className="space-y-1">{children}</div>
        </div>
    );

    return (
        <Section
            title="Login methods"
            description="Applies to everyone: organization users and provider admins. Signing in never grants access to an organization by itself; membership is checked separately."
            actions={<KeyRound size={16} className="ac-faint" />}
        >
            <div className="grid gap-4 md:grid-cols-2">
                {group('Email and password',
                    <StatusPill tone={info.effective.emailPassword.signIn ? 'ok' : 'neutral'}>{info.effective.emailPassword.signIn ? 'In use' : 'Off'}</StatusPill>,
                    <>
                        <ToggleRow title="Sign-in" description="Local accounts."
                            checked={draft.emailPassword.signIn} onChange={() => flip('emailPassword', 'signIn')} />
                        <ToggleRow title="Open sign-up" description="Public account creation. Keep off until verification email is set up."
                            checked={draft.emailPassword.signUp} onChange={() => flip('emailPassword', 'signUp')} />
                    </>)}
                {group('Google',
                    <StatusPill tone={info.googleConfigured ? (info.effective.google.signIn ? 'ok' : 'neutral') : 'warn'}>
                        {info.googleConfigured ? (info.effective.google.signIn ? 'In use' : 'Off') : 'Not configured'}
                    </StatusPill>,
                    <>
                        <ToggleRow title="Sign-in"
                            description={info.googleConfigured ? 'Existing accounts only, once they have linked Google.' : 'Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.'}
                            checked={draft.google.signIn} disabled={!info.googleConfigured} onChange={() => flip('google', 'signIn')} />
                        <ToggleRow title="Sign-up" description="Lets new people create an account with Google."
                            checked={draft.google.signUp} disabled={!info.googleConfigured} onChange={() => flip('google', 'signUp')} />
                    </>)}
            </div>

            {info.googleConfigured && (
                <div className="mt-4 text-[12px] ac-muted space-y-1">
                    <p><ShieldCheck size={13} className="inline mr-1 -mt-0.5" />
                        {info.actorHasGoogle ? 'Your admin login has Google linked.' : 'Your admin login has no Google linked.'}
                    </p>
                    {info.googleRedirectUri && (
                        <p className="break-all">Redirect URI to register in Google Cloud: <span className="font-mono select-all">{info.googleRedirectUri}</span></p>
                    )}
                </div>
            )}

            {/* Always rendered, so the card never changes height when something is toggled. */}
            <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                <span className={`text-[12px] mr-auto transition-opacity ${dirty ? 'opacity-100 text-[var(--ac-warn)]' : 'opacity-0'}`} aria-live="polite">
                    {dirty ? 'Unsaved changes' : 'No changes'}
                </span>
                {info.googleConfigured && info.effective.google.signIn && !info.actorHasGoogle && (
                    <Button onClick={linkGoogle}>Link my Google account</Button>
                )}
                <Button onClick={() => setDraft(info.stored)} disabled={!dirty || saving}>Discard</Button>
                <Button variant="primary" onClick={save} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save changes'}</Button>
            </div>
        </Section>
    );
};

/* ------------------------------- Audit ------------------------------- */

const AUDIT_AREAS: { value: string; label: string; match: (a: string) => boolean }[] = [
    { value: 'all', label: 'All', match: () => true },
    { value: 'applications', label: 'Applications', match: a => a.startsWith('application.') },
    { value: 'orgs', label: 'Organizations', match: a => /^(org\.|membership\.|subscription\.|entitlement\.|payments\.)/.test(a) },
    { value: 'accounts', label: 'Accounts', match: a => /^(user\.|provider_admin\.)/.test(a) },
    { value: 'plans', label: 'Plans', match: a => a.startsWith('plan.') },
    { value: 'settings', label: 'Settings', match: a => /^(settings\.|branding\.|notification\.)/.test(a) },
];

const readable = (action: string) => action.replace(/[._]/g, ' ').replace(/^./, c => c.toUpperCase());

const AuditPanel: React.FC = () => {
    const [entries, setEntries] = useState<AuditEntry[] | null>(null);
    const [limit, setLimit] = useState(50);
    const [area, setArea] = useState('all');
    const [q, setQ] = useState('');
    const [open, setOpen] = useState<string | null>(null);

    useEffect(() => {
        api<{ entries: AuditEntry[] }>(`/admin/audit?limit=${limit}`)
            .then(r => setEntries(r.entries))
            .catch(e => toast.error((e as ApiError).message));
    }, [limit]);

    const match = AUDIT_AREAS.find(a => a.value === area)!.match;
    const term = q.trim().toLowerCase();
    const shown = (entries ?? []).filter(e => match(e.action) && (!term
        || e.action.toLowerCase().includes(term) || (e.actor_email ?? '').toLowerCase().includes(term)
        || (e.details ?? '').toLowerCase().includes(term)));

    return (
        <Section>
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mb-4">
                <Segmented value={area} onChange={setArea} options={AUDIT_AREAS.map(a => ({ value: a.value, label: a.label }))} />
                <div className="relative md:w-72">
                    <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 ac-faint pointer-events-none" />
                    <Input className="!pl-9" placeholder="Search actions, people, details…" value={q} onChange={e => setQ(e.target.value)} />
                </div>
            </div>
            {!entries ? <SkeletonRows rows={8} /> : shown.length === 0 ? (
                <EmptyState icon={<History size={20} />} title="Nothing matches" body="Try another area or search." />
            ) : (
                <ul className="ac-divide">
                    {shown.map(e => (
                        <li key={e.id}>
                            <button type="button" onClick={() => setOpen(open === e.id ? null : e.id)}
                                className="ac-row w-full text-left px-2 py-2.5 grid gap-x-4 gap-y-0.5 grid-cols-1 sm:items-center sm:grid-cols-[9.5rem_minmax(0,1fr)_minmax(0,14rem)]">
                                <span className="hidden sm:block text-[12px] ac-faint tabular-nums">{new Date(e.at).toLocaleString()}</span>
                                {/* Wraps rather than cutting off; the phone puts who and when underneath. */}
                                <span className="text-sm font-medium break-words">{readable(e.action)}</span>
                                <span className="text-[12px] font-light ac-muted truncate">
                                    {e.actor_email ?? e.actor_kind}<span className="sm:hidden"> · {timeAgo(e.at)}</span>
                                </span>
                            </button>
                            {open === e.id && e.details && (
                                <pre className="mx-2 mb-3 neu-inset rounded-xl p-3 text-[11px] font-mono whitespace-pre-wrap break-all ac-enter-soft">
                                    {(() => { try { return JSON.stringify(JSON.parse(e.details), null, 2); } catch { return e.details; } })()}
                                </pre>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {entries && entries.length >= limit && limit < 200 && (
                <div className="mt-4 text-center"><button type="button" className="neu-button" onClick={() => setLimit(l => Math.min(l + 50, 200))}>Load more</button></div>
            )}
        </Section>
    );
};
