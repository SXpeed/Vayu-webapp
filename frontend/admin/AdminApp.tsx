// Provider control panel (ateliersupport staff only).
//
// This screen is convenience, not security: every /api/v2/admin call is
// checked on the server (session + provider_admins row + 2FA).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import toast from 'react-hot-toast';
import {
    Activity, Building2, ChevronsLeft, ChevronsRight, ClipboardList, History, Image as ImageIcon, KeyRound,
    LayoutDashboard, Layers, LogOut, Mail, MoreHorizontal, Search, ShieldCheck, Users, X,
} from 'lucide-react';
import { api, authClient, guarded, type ApiError, type Reauth } from './api';
import { OrgsPanel } from './OrgsPanel';
import { PlansPanel } from './PlansPanel';
import { BrandingPanel } from './BrandingPanel';
import { OverviewPanel } from './OverviewPanel';
import { ApplicationsPanel } from './ApplicationsPanel';
import { AccountsPanel } from './AccountsPanel';
import { AdminsPanel, HealthPanel, NotificationsPanel } from './SystemPanels';
import { DialogProvider, Kbd, PageHeader, Section, Segmented, SkeletonRows, StatusPill, useHashRoute } from './kit';
import { useBranding } from '../useBranding';
import { Button, Card, Field, Input, SectionTitle, ToggleRow } from '../components/ui';

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

interface NavItem { tab: Tab; label: string; short: string; icon: React.ReactNode; badge?: number }

/** Titles for sections whose panel does not render its own page header. */
const HEADERS: Partial<Record<Tab, { title: string; description: string }>> = {
    orgs: { title: 'Organizations', description: 'Every business on the platform: members, plan, payments and status.' },
    notifications: { title: 'Notifications', description: 'Where notices go, and the queue of notices waiting to be sent.' },
    branding: { title: 'Branding', description: 'The platform name and logo shown on sign-in, the app and here.' },
    security: { title: 'Login & security', description: 'How people sign in, and who administers the platform.' },
    health: { title: 'System health', description: 'What is configured and what needs attention.' },
    audit: { title: 'Audit log', description: 'Every administrative action, newest first.' },
};

const TABS: Tab[] = ['overview', 'applications', 'orgs', 'accounts', 'plans', 'notifications', 'branding', 'security', 'health', 'audit'];

const SIDEBAR_KEY = 'ac.sidebar.collapsed';
const readCollapsed = () => { try { return localStorage.getItem(SIDEBAR_KEY) === '1'; } catch { return false; } };

export const AdminApp: React.FC = () => (
    <DialogProvider>
        <ControlCentre />
    </DialogProvider>
);

const ControlCentre: React.FC = () => {
    const branding = useBranding();
    const [screen, setScreen] = useState<Screen>({ kind: 'loading' });
    const [route, go] = useHashRoute();
    const tab: Tab = (TABS as string[]).includes(route.section) ? route.section as Tab : 'overview';
    const [collapsed, setCollapsed] = useState(readCollapsed);
    const [moreOpen, setMoreOpen] = useState(false);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [badges, setBadges] = useState({ applications: 0, notifications: 0 });
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
        if (lastTab.current !== tab) { window.scrollTo({ top: 0 }); lastTab.current = tab; }
        setMoreOpen(false);
    }, [tab]);

    const navigate = useCallback((next: string, id?: string) => go(next, id), [go]);

    const toggleSidebar = () => setCollapsed(c => {
        try { localStorage.setItem(SIDEBAR_KEY, c ? '0' : '1'); } catch { /* private mode */ }
        return !c;
    });

    const signOut = async () => { await authClient.signOut(); setScreen({ kind: 'signed-out' }); };

    if (screen.kind !== 'ready') {
        return (
            <div className="ac min-h-dvh px-4 py-10 lg:py-16">
                <div className="w-full max-w-md mx-auto space-y-6 ac-enter">
                    <header className="flex items-center gap-3">
                        {branding.logoUrl
                            ? <img src={branding.logoUrl} alt="" width={44} height={44} className="w-11 h-11 rounded-2xl object-contain" />
                            : <span className="w-11 h-11 rounded-2xl neu-accent flex items-center justify-center font-serif text-lg">{branding.appName.slice(0, 1).toUpperCase()}</span>}
                        <div>
                            <h1 className="font-serif text-2xl text-[var(--ac-accent)]">{branding.appName}</h1>
                            <p className="text-[11px] uppercase tracking-[0.16em] ac-muted">Control centre</p>
                        </div>
                    </header>
                    {screen.kind === 'loading' && <Card><SkeletonRows rows={2} /></Card>}
                    {screen.kind === 'unavailable' && <Card><p className="text-sm">{screen.message}</p></Card>}
                    {screen.kind === 'signed-out' && <SignIn onDone={refresh} />}
                    {screen.kind === 'not-admin' && (
                        <Card>
                            <p className="text-sm mb-4">This account is not a provider administrator.</p>
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
            { tab: 'overview', label: 'Overview', short: 'Overview', icon: <LayoutDashboard size={18} /> },
            { tab: 'applications', label: 'Applications', short: 'Review', icon: <ClipboardList size={18} />, badge: badges.applications },
            { tab: 'orgs', label: 'Organizations', short: 'Orgs', icon: <Building2 size={18} /> },
            { tab: 'accounts', label: 'Accounts', short: 'Accounts', icon: <Users size={18} /> },
            { tab: 'plans', label: 'Plans', short: 'Plans', icon: <Layers size={18} /> },
        ] },
        { title: 'Platform', items: [
            { tab: 'notifications', label: 'Notifications', short: 'Notices', icon: <Mail size={18} />, badge: badges.notifications },
            { tab: 'branding', label: 'Branding', short: 'Branding', icon: <ImageIcon size={18} /> },
            { tab: 'security', label: 'Login & security', short: 'Security', icon: <ShieldCheck size={18} /> },
            { tab: 'health', label: 'System health', short: 'Health', icon: <Activity size={18} /> },
            { tab: 'audit', label: 'Audit log', short: 'Audit', icon: <History size={18} /> },
        ] },
    ];
    const all = groups.flatMap(g => g.items);
    const dockTabs: Tab[] = ['overview', 'applications', 'orgs', 'accounts'];
    const header = HEADERS[tab];
    // Organization detail has its own header with a way back.
    const showHeader = !!header && !(tab === 'orgs' && route.id);

    const logo = (size: number) => branding.logoUrl
        ? <img src={branding.logoUrl} alt="" width={size} height={size} style={{ width: size, height: size }} className="rounded-xl object-contain shrink-0" />
        : <span style={{ width: size, height: size }} className="rounded-xl neu-accent flex items-center justify-center font-serif shrink-0">{branding.appName.slice(0, 1).toUpperCase()}</span>;

    return (
        <div className="ac min-h-dvh lg:flex">
            {/* ── Desktop sidebar ─────────────────────────────────────── */}
            <aside className={`hidden lg:flex lg:flex-col lg:shrink-0 lg:sticky lg:top-0 lg:h-dvh py-5 gap-5 ${collapsed ? 'lg:w-[4.75rem] px-2.5' : 'lg:w-64 px-4'}`}>
                <div className={`flex items-center gap-3 ${collapsed ? 'justify-center' : 'px-1'}`}>
                    {logo(38)}
                    {!collapsed && (
                        <div className="min-w-0">
                            <p className="font-serif text-lg leading-tight text-[var(--ac-accent)] truncate">{branding.appName}</p>
                            <p className="text-[10px] uppercase tracking-[0.16em] ac-faint">Control centre</p>
                        </div>
                    )}
                </div>

                <button type="button" onClick={() => setPaletteOpen(true)}
                    className={`neu-inset rounded-[12px] h-10 flex items-center gap-2 text-[13px] ac-muted ${collapsed ? 'justify-center' : 'px-3'}`}
                    title="Search or jump (Ctrl K)">
                    <Search size={15} />
                    {!collapsed && <><span className="flex-1 text-left">Search or jump…</span><Kbd>Ctrl K</Kbd></>}
                </button>

                <nav className="flex-1 overflow-y-auto space-y-5 -mx-1 px-1 py-1">
                    {groups.map(g => (
                        <div key={g.title}>
                            {!collapsed && <p className="px-3 mb-2 text-[10px] uppercase tracking-[0.18em] ac-faint">{g.title}</p>}
                            <ul className="space-y-1.5">
                                {g.items.map(item => (
                                    <li key={item.tab}>
                                        <button type="button" onClick={() => navigate(item.tab)} aria-current={tab === item.tab ? 'page' : undefined}
                                            title={collapsed ? item.label : undefined}
                                            className={`ac-nav-item ${collapsed ? 'justify-center !px-0' : ''}`}>
                                            <span className="relative">
                                                {item.icon}
                                                {collapsed && !!item.badge && <span className="absolute -top-1.5 -right-2 ac-count !min-w-[1rem] !h-4 !leading-4 !text-[0.6rem]">{item.badge}</span>}
                                            </span>
                                            {!collapsed && <span className="flex-1 text-left truncate">{item.label}</span>}
                                            {!collapsed && !!item.badge && <span className="ac-count">{item.badge}</span>}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </nav>

                <div className={`space-y-3 ${collapsed ? 'flex flex-col items-center' : ''}`}>
                    {!collapsed && (
                        <div className="neu-inset rounded-[14px] px-3 py-2.5 min-w-0">
                            <p className="text-[12px] truncate">{screen.email}</p>
                            <p className="text-[11px] ac-faint">Provider {screen.role}</p>
                        </div>
                    )}
                    <div className={`flex gap-2 ${collapsed ? 'flex-col' : ''}`}>
                        <button type="button" className={`neu-button ${collapsed ? '!w-10 !px-0' : 'flex-1'}`} onClick={signOut} title="Sign out">
                            <LogOut size={15} />{!collapsed && 'Sign out'}
                        </button>
                        <button type="button" className="neu-button !w-10 !px-0" onClick={toggleSidebar} title={collapsed ? 'Expand menu' : 'Collapse menu'}>
                            {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
                        </button>
                    </div>
                </div>
            </aside>

            {/* ── Phone header ─────────────────────────────────────────── */}
            <header className="lg:hidden sticky top-0 z-30 flex items-center gap-3 px-4 h-16 bg-[var(--ac-bg)]/90 backdrop-blur-sm">
                {logo(34)}
                <div className="min-w-0 flex-1">
                    <p className="font-serif text-base leading-tight text-[var(--ac-accent)] truncate">{branding.appName}</p>
                    <p className="text-[10px] uppercase tracking-[0.16em] ac-faint">Control centre</p>
                </div>
                <button type="button" aria-label="Search or jump" className="neu-button !w-10 !px-0" onClick={() => setPaletteOpen(true)}><Search size={17} /></button>
            </header>

            {/* ── Content ──────────────────────────────────────────────── */}
            <main className="flex-1 min-w-0 px-4 pt-4 pb-28 sm:px-6 lg:px-10 lg:pt-9 lg:pb-12">
                <div className="w-full max-w-[1200px] mx-auto">
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
                    </div>
                </div>
            </main>

            {/* ── Phone tab bar ────────────────────────────────────────── */}
            <nav className="lg:hidden ac-dock" aria-label="Sections">
                {dockTabs.map(t => {
                    const item = all.find(i => i.tab === t)!;
                    return (
                        <button key={t} type="button" onClick={() => navigate(t)} aria-current={tab === t ? 'page' : undefined} className="ac-dock-item">
                            {item.icon}<span>{item.short}</span>
                            {!!item.badge && <span className="ac-count">{item.badge}</span>}
                        </button>
                    );
                })}
                <button type="button" onClick={() => setMoreOpen(true)} aria-current={!dockTabs.includes(tab) ? 'page' : undefined} className="ac-dock-item">
                    <MoreHorizontal size={18} /><span>More</span>
                    {!!badges.notifications && <span className="ac-count">{badges.notifications}</span>}
                </button>
            </nav>

            {moreOpen && <MoreSheet items={all.filter(i => !dockTabs.includes(i.tab))} current={tab} email={screen.email} role={screen.role}
                onPick={t => navigate(t)} onClose={() => setMoreOpen(false)} onSignOut={signOut} />}

            {paletteOpen && <CommandPalette items={all} onClose={() => setPaletteOpen(false)} navigate={navigate} />}

            {reauthResolve && createPortal(
                <div className="ac">
                    <div className="ac-scrim ac-dialog-scrim" />
                    <div className="ac-dialog p-1" role="dialog" aria-modal="true">
                        <SignIn email={screen.email} title="Confirm it's you" onDone={() => { reauthResolve(true); setReauthResolve(null); }} />
                        <div className="px-5 pb-4 flex justify-end">
                            <Button onClick={() => { reauthResolve(false); setReauthResolve(null); }}>Cancel</Button>
                        </div>
                    </div>
                </div>,
                document.getElementById('ac-overlays') ?? document.body,
            )}
        </div>
    );
};

/* ───────────────────────────── Phone "More" ──────────────────────────── */

const MoreSheet: React.FC<{ items: NavItem[]; current: Tab; email: string; role: string; onPick: (t: Tab) => void; onClose: () => void; onSignOut: () => void }> = ({ items, current, email, role, onPick, onClose, onSignOut }) => {
    useEffect(() => {
        const on = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', on);
        return () => window.removeEventListener('keydown', on);
    }, [onClose]);
    return createPortal(
        <div className="ac">
            <div className="ac-scrim" onClick={onClose} />
            <div className="ac-drawer ac-drawer-fit" role="dialog" aria-modal="true" style={{ ['--ac-drawer-width' as string]: '360px' }}>
                <header className="flex items-center justify-between px-5 py-4">
                    <p className="font-serif text-lg">More</p>
                    <button type="button" aria-label="Close" onClick={onClose} className="neu-button !w-9 !h-9 !p-0"><X size={16} /></button>
                </header>
                <div className="flex-1 overflow-y-auto p-4 space-y-2">
                    {items.map(i => (
                        <button key={i.tab} type="button" onClick={() => onPick(i.tab)} aria-current={current === i.tab ? 'page' : undefined} className="ac-nav-item !min-h-[3rem]">
                            {i.icon}<span className="flex-1 text-left">{i.label}</span>{!!i.badge && <span className="ac-count">{i.badge}</span>}
                        </button>
                    ))}
                </div>
                <footer className="px-5 py-4 flex items-center gap-3">
                    <div className="min-w-0 flex-1"><p className="text-[12px] truncate">{email}</p><p className="text-[11px] ac-faint">Provider {role}</p></div>
                    <button type="button" className="neu-button" onClick={onSignOut}><LogOut size={15} /> Sign out</button>
                </footer>
            </div>
        </div>,
        document.getElementById('ac-overlays') ?? document.body,
    );
};

/* ───────────────────────────── Quick jump ────────────────────────────── */

interface Hit { key: string; label: string; hint: string; icon: React.ReactNode; go: () => void }

const CommandPalette: React.FC<{ items: NavItem[]; onClose: () => void; navigate: (section: string, id?: string) => void }> = ({ items, onClose, navigate }) => {
    const [q, setQ] = useState('');
    const [active, setActive] = useState(0);
    const [remote, setRemote] = useState<Hit[]>([]);
    const input = useRef<HTMLInputElement>(null);

    useEffect(() => { input.current?.focus(); }, []);

    // Search organizations and accounts as you type (debounced).
    useEffect(() => {
        const term = q.trim();
        if (term.length < 2) { setRemote([]); return; }
        const t = setTimeout(async () => {
            try {
                const [orgs, accounts] = await Promise.all([
                    api<{ organizations: { id: string; name: string; status: string }[] }>(`/admin/orgs?q=${encodeURIComponent(term)}&limit=5`),
                    api<{ accounts: { id: string; name: string; email: string }[] }>(`/admin/accounts?q=${encodeURIComponent(term)}&limit=5`),
                ]);
                setRemote([
                    ...orgs.organizations.map(o => ({ key: `o-${o.id}`, label: o.name, hint: `Organization · ${o.status}`, icon: <Building2 size={16} />, go: () => navigate('orgs', o.id) })),
                    ...accounts.accounts.map(a => ({ key: `a-${a.id}`, label: a.name, hint: a.email, icon: <Users size={16} />, go: () => navigate('accounts', a.id) })),
                ]);
            } catch { setRemote([]); }
        }, 200);
        return () => clearTimeout(t);
    }, [q, navigate]);

    const hits: Hit[] = useMemo(() => {
        const term = q.trim().toLowerCase();
        const sections = items
            .filter(i => !term || i.label.toLowerCase().includes(term))
            .map(i => ({ key: `s-${i.tab}`, label: i.label, hint: 'Go to section', icon: i.icon, go: () => navigate(i.tab) }));
        return [...sections, ...remote];
    }, [q, items, remote, navigate]);

    useEffect(() => { setActive(0); }, [q]);

    const pick = (h: Hit | undefined) => {
        if (!h) return;
        h.go();
        onClose();
    };

    return createPortal(
        <div className="ac">
            <div className="ac-scrim ac-dialog-scrim" onClick={onClose} />
            <div className="ac-dialog !top-[12vh] overflow-hidden" role="dialog" aria-modal="true" style={{ ['--ac-dialog-width' as string]: '560px' }}
                onKeyDown={e => {
                    if (e.key === 'Escape') onClose();
                    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, hits.length - 1)); }
                    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
                    else if (e.key === 'Enter') { e.preventDefault(); pick(hits[active]); }
                }}>
                <div className="p-3">
                    <div className="neu-field !p-0 flex items-center gap-2 px-3">
                        <Search size={16} className="ml-3 ac-faint shrink-0" />
                        <input ref={input} value={q} onChange={e => setQ(e.target.value)} placeholder="Jump to a section, organization or account…"
                            className="flex-1 min-w-0 bg-transparent py-2.5 pr-3 text-sm outline-none" aria-label="Search" />
                    </div>
                </div>
                <ul className="max-h-[55vh] overflow-y-auto px-2 pb-2" role="listbox">
                    {hits.length === 0 && <li className="px-3 py-6 text-center text-sm ac-muted">No matches.</li>}
                    {hits.map((h, i) => (
                        <li key={h.key} role="option" aria-selected={i === active}>
                            <button type="button" onMouseEnter={() => setActive(i)} onClick={() => pick(h)}
                                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-[12px] text-left ${i === active ? 'neu-inset' : ''}`}>
                                <span className="ac-muted">{h.icon}</span>
                                <span className="min-w-0 flex-1">
                                    <span className="block text-sm truncate">{h.label}</span>
                                    <span className="block text-[12px] ac-faint truncate">{h.hint}</span>
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
                <div className="px-4 py-2.5 flex flex-wrap gap-3 text-[11px] ac-faint" style={{ boxShadow: '0 -1px 0 var(--ac-line)' }}>
                    <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> move</span><span><Kbd>Enter</Kbd> open</span><span><Kbd>Esc</Kbd> close</span>
                </div>
            </div>
        </div>,
        document.getElementById('ac-overlays') ?? document.body,
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
                <p className="py-10 text-center text-sm ac-muted">Nothing matches.</p>
            ) : (
                <ul className="ac-divide">
                    {shown.map(e => (
                        <li key={e.id}>
                            <button type="button" onClick={() => setOpen(open === e.id ? null : e.id)}
                                className="ac-row w-full text-left px-2 py-2.5 grid gap-x-4 gap-y-0.5 grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[9.5rem_minmax(0,1fr)_minmax(0,14rem)]">
                                <span className="text-[12px] ac-faint tabular-nums order-3 sm:order-none col-span-2 sm:col-span-1">{new Date(e.at).toLocaleString()}</span>
                                <span className="text-sm font-medium truncate">{readable(e.action)}</span>
                                <span className="text-[12px] ac-muted truncate text-right sm:text-left">{e.actor_email ?? e.actor_kind}</span>
                            </button>
                            {open === e.id && e.details && (
                                <pre className="mx-2 mb-3 neu-inset rounded-[12px] p-3 text-[11px] font-mono whitespace-pre-wrap break-all ac-enter-soft">
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
