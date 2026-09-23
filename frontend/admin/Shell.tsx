// The control centre's chrome, built from the organization app's own parts:
// the floating shell, the sidebar with its pressed-in rows and gold edge
// marker, the phone dock with the gliding well, and soft sheets. Someone who
// knows the app should feel at home here.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Lenis from 'lenis';
import { Building2, ChevronLeft, ChevronRight, LogOut, MoreHorizontal, Search, User, Users, X } from 'lucide-react';
import { api } from './api';
import { Avatar, IconButton, Kbd } from './kit';

export type Tab =
    | 'overview' | 'applications' | 'orgs' | 'accounts' | 'plans'
    | 'notifications' | 'branding' | 'security' | 'health' | 'audit' | 'profile';

export interface NavItem { tab: Tab; label: string; short: string; icon: React.ElementType; badge?: number }
export interface NavGroup { title: string; items: NavItem[] }
export interface Brand { appName: string; logoUrl: string | null }

const overlayHost = () => document.getElementById('ac-overlays') ?? document.body;

/* ───────────────────────────── Smooth scroll ─────────────────────────── */

/**
 * The app's smooth wheel scrolling (Lenis) on the content scroller. Wheel
 * only: touch stays native, so phone momentum scrolling is untouched, and
 * nested scrollers keep their own behaviour.
 */
export function useSmoothScroll(ref: React.RefObject<HTMLElement | null>) {
    useEffect(() => {
        const wrapper = ref.current;
        if (!wrapper) return;
        if (globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const lenis = new Lenis({
            wrapper,
            content: wrapper,
            autoRaf: true,
            duration: 0.9,
            prevent: node =>
                node !== wrapper &&
                node instanceof HTMLElement &&
                node.scrollHeight > node.clientHeight &&
                /(auto|scroll)/.test(getComputedStyle(node).overflowY),
        });
        return () => lenis.destroy();
    }, [ref]);
}

/* ───────────────────────────── Brand mark ────────────────────────────── */

export const BrandMark: React.FC<{ brand: Brand; size?: number; onClick?: () => void }> = ({ brand, size = 44, onClick }) => {
    const inner = brand.logoUrl
        ? <img src={brand.logoUrl} alt="" width={size} height={size} className="w-full h-full object-contain" />
        : <span className="font-serif text-lg">{brand.appName.slice(0, 1).toUpperCase()}</span>;
    const cls = `rounded-2xl shrink-0 flex items-center justify-center overflow-hidden ${brand.logoUrl ? 'neu-raised-sm p-1.5' : 'neu-accent'}`;
    const style = { width: size, height: size };
    return onClick
        ? <button type="button" onClick={onClick} aria-label="Go to overview" className={`${cls} neu-btn active-scale`} style={style}>{inner}</button>
        : <span className={cls} style={style}>{inner}</span>;
};

/* ───────────────────────────── Sidebar ───────────────────────────────── */

/**
 * The app's Sidebar, row for row: flat at rest, softly raised under the
 * pointer, pressed in with gold ink and an edge marker when active. The
 * collapse button rides the rail's edge; the collapsed rail shows one
 * floating label beside the hovered icon.
 */
export const Sidebar: React.FC<{
    brand: Brand; groups: NavGroup[]; current: Tab; onNavigate: (t: Tab) => void;
    collapsed: boolean; onToggleCollapsed: () => void; name: string; onOpenPalette: () => void;
}> = ({ brand, groups, current, onNavigate, collapsed, onToggleCollapsed, name, onOpenPalette }) => {
    const [tip, setTip] = useState<{ label: string; top: number; left: number } | null>(null);
    const showTip = (label: string) => (e: React.SyntheticEvent<HTMLElement>) => {
        if (!collapsed) return;
        const r = e.currentTarget.getBoundingClientRect();
        setTip({ label, top: r.top + r.height / 2, left: r.right + 12 });
    };
    const hideTip = () => setTip(null);

    const row = ({ key, label, icon: Icon, active, onClick, badge, trailing, a11y }: {
        key: string; label: string; icon: React.ElementType; active: boolean; onClick: () => void;
        badge?: number; trailing?: React.ReactNode; a11y?: string;
    }) => (
        <button
            key={key}
            type="button"
            onClick={onClick}
            onMouseEnter={showTip(a11y ?? label)}
            onMouseLeave={hideTip}
            onFocus={showTip(a11y ?? label)}
            onBlur={hideTip}
            aria-label={a11y ?? label}
            aria-current={active ? 'page' : undefined}
            className={`neu-nav-row group relative flex items-center active-scale text-left
                ${collapsed ? 'justify-center w-10 h-10 mx-auto rounded-xl' : 'w-full gap-3.5 px-3 py-2 rounded-xl'}
                ${active
                    ? 'neu-nav-row-active neu-inset text-gold-700 dark:text-gold-300'
                    : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white'}`}
        >
            {active && !collapsed && <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-r-full bg-gold-500" />}
            <span className="relative shrink-0">
                <Icon size={18} strokeWidth={active ? 2.1 : 1.7}
                    className={`transition-colors ${active ? 'text-gold-600 dark:text-gold-300' : 'text-gray-500 dark:text-gray-400 group-hover:text-gray-900 dark:group-hover:text-white'}`} />
                {collapsed && !!badge && <span className="absolute -top-1 -right-1.5 w-2 h-2 rounded-full bg-gold-500 ring-2 ring-[var(--neu-bg)]" />}
            </span>
            {!collapsed && (
                <>
                    <span className={`flex-1 min-w-0 text-[13px] tracking-wide leading-none truncate ${active ? 'font-medium' : 'font-light'}`}>{label}</span>
                    {!!badge && <span className="ac-count">{badge}</span>}
                    {trailing}
                </>
            )}
        </button>
    );

    return (
        <aside
            className={`hidden lg:flex relative flex-col shrink-0 h-full z-30 bg-[var(--neu-bg)] transition-[width] duration-300 ease-out
                ${collapsed ? 'w-20 px-2 py-4' : 'w-60 px-3.5 py-4'}`}
            style={{ boxShadow: '6px 0 14px var(--neu-shadow-dark), 2px 0 6px var(--neu-shadow-light)' }}
        >
            <button
                type="button"
                onClick={() => { hideTip(); onToggleCollapsed(); }}
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                aria-expanded={!collapsed}
                className="absolute top-[30px] -right-3.5 z-40 w-7 h-7 rounded-full neu-raised-sm neu-btn flex items-center justify-center text-gray-500 dark:text-gray-400 hover:text-[var(--neu-gold)] active-scale"
            >
                {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
            </button>

            <div className={`flex items-center ${collapsed ? 'justify-center mb-4' : 'gap-3 px-0.5 mb-5'}`}>
                <BrandMark brand={brand} onClick={() => onNavigate('overview')} />
                {!collapsed && (
                    <div className="min-w-0 flex-1">
                        <p className="font-serif text-lg leading-tight text-gold-700 dark:text-gold-300 truncate">{brand.appName}</p>
                        <p className="mt-0.5 text-[9px] font-medium uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">Control centre</p>
                    </div>
                )}
            </div>

            <nav
                onScroll={hideTip}
                className={`flex-1 overflow-y-auto ac-no-scrollbar px-2 -mx-2 py-2 [mask-image:linear-gradient(to_bottom,transparent,#000_12px,#000_calc(100%-12px),transparent)] ${collapsed ? 'space-y-2.5' : 'space-y-4'}`}
            >
                <div className="space-y-1">
                    {row({
                        key: 'search', label: 'Search', a11y: 'Search or jump (Ctrl K)', icon: Search, active: false, onClick: onOpenPalette,
                        trailing: <Kbd>Ctrl K</Kbd>,
                    })}
                </div>
                {groups.map((group, gi) => (
                    <div key={group.title}>
                        {collapsed
                            ? (gi >= 0 && <div className="neu-divider w-7 mx-auto mb-2.5" />)
                            : <p className="px-3 mb-2 text-[9px] font-medium uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">{group.title}</p>}
                        <div className="space-y-1">
                            {group.items.map(item => row({
                                key: item.tab, label: item.label, icon: item.icon, active: current === item.tab,
                                onClick: () => onNavigate(item.tab), badge: item.badge,
                            }))}
                        </div>
                    </div>
                ))}
            </nav>

            <div className={collapsed ? 'mt-2 space-y-1' : 'mt-2 pt-2 w-full space-y-1 border-t border-gray-200/70 dark:border-white/5'}>
                {collapsed && <div className="neu-divider w-7 mx-auto mb-2.5" />}
                {row({
                    key: 'profile', label: name || 'Profile', a11y: 'Profile', icon: User,
                    active: current === 'profile', onClick: () => onNavigate('profile'),
                })}
            </div>

            {collapsed && tip && createPortal(
                <span role="tooltip"
                    className="fixed z-[90] pointer-events-none -translate-y-1/2 whitespace-nowrap rounded-xl px-3 py-1.5 text-xs font-medium neu-raised-sm text-[var(--neu-text)] bg-[var(--neu-bg)] animate-fade-in"
                    style={{ top: tip.top, left: tip.left }}>
                    {tip.label}
                </span>,
                document.body,
            )}
        </aside>
    );
};

/* ───────────────────────────── Phone header ──────────────────────────── */

/** A slim brand row with search and your profile, above the scroller. */
export const PhoneHeader: React.FC<{ brand: Brand; name: string; onOpenPalette: () => void; onOpenProfile: () => void; onHome: () => void }> = ({ brand, name, onOpenPalette, onOpenProfile, onHome }) => (
    <header className="lg:hidden shrink-0 flex items-center gap-3 px-5 pt-[calc(0.75rem+env(safe-area-inset-top,0px))] pb-1.5">
        <BrandMark brand={brand} size={38} onClick={onHome} />
        <div className="min-w-0 flex-1">
            <p className="font-serif text-base leading-tight text-gold-700 dark:text-gold-300 truncate">{brand.appName}</p>
            <p className="mt-0.5 text-[9px] font-medium uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">Control centre</p>
        </div>
        <IconButton label="Search or jump" onClick={onOpenPalette}><Search size={17} className="text-brand-900 dark:text-gold-400" /></IconButton>
        <button type="button" onClick={onOpenProfile} aria-label="Profile" title="Profile" className="rounded-full neu-raised-sm neu-btn active-scale p-[3px]">
            <Avatar name={name || '?'} size={30} />
        </button>
    </header>
);

/* ───────────────────────────── Phone dock ────────────────────────────── */

/** The app's BottomNav: one extruded bar, one concave well gliding to the tab. */
export const Dock: React.FC<{ items: NavItem[]; current: Tab; onNavigate: (t: Tab) => void; onMore: () => void; moreBadge?: number }> = ({ items, current, onNavigate, onMore, moreBadge }) => {
    const all = [...items.map(i => ({ key: i.tab, label: i.short, icon: i.icon, badge: i.badge, onClick: () => onNavigate(i.tab), active: current === i.tab })),
        { key: 'more', label: 'More', icon: MoreHorizontal, badge: moreBadge, onClick: onMore, active: !items.some(i => i.tab === current) }];
    const activeIndex = all.findIndex(i => i.active);
    return (
        <nav aria-label="Sections"
            className="lg:hidden neu-dock-scrim absolute bottom-0 inset-x-0 z-40 px-3 pt-5 pb-[calc(max(env(safe-area-inset-bottom,0px)-18px,0px)+10px)] pointer-events-none">
            <div className="neu-dock pointer-events-auto mx-auto max-w-md flex p-[5px]"
                style={{ '--dock-count': all.length, '--dock-index': Math.max(activeIndex, 0) } as React.CSSProperties}>
                <span aria-hidden="true" className="neu-dock-well" />
                {all.map(item => {
                    const Icon = item.icon;
                    return (
                        <button key={item.key} type="button" onClick={item.onClick} aria-current={item.active ? 'page' : undefined}
                            className="neu-dock-item relative flex-1 min-w-0 h-[52px] flex flex-col items-center justify-center gap-[5px]">
                            <span className="relative">
                                <Icon size={19} strokeWidth={item.active ? 2.2 : 1.8} className="neu-dock-icon" />
                                {!!item.badge && <span className="ac-count absolute -top-2 -right-3 !min-w-[1.05rem] !h-[1.05rem] !text-[9px]">{item.badge}</span>}
                            </span>
                            <span className={`max-w-full truncate text-[9.5px] leading-none ${item.active ? 'font-semibold' : 'font-medium'}`}>{item.label}</span>
                        </button>
                    );
                })}
            </div>
        </nav>
    );
};

/* ───────────────────────────── More sheet ────────────────────────────── */

export const MoreSheet: React.FC<{
    items: NavItem[]; current: Tab; name: string; email: string; role: string;
    onPick: (t: Tab) => void; onClose: () => void; onSignOut: () => void;
}> = ({ items, current, name, email, role, onPick, onClose, onSignOut }) => {
    useEffect(() => {
        const on = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', on);
        return () => window.removeEventListener('keydown', on);
    }, [onClose]);
    return createPortal(
        <>
            <div className="ac-scrim neu-scrim" onClick={onClose} />
            <div className="ac-drawer ac-drawer-fit neu-modal" role="dialog" aria-modal="true" aria-label="More" style={{ ['--ac-drawer-width' as string]: '380px' }}>
                <header className="flex items-center justify-between px-5 py-4">
                    <p className="font-serif text-lg text-gold-700 dark:text-gold-300">More</p>
                    <IconButton label="Close" onClick={onClose}><X size={16} /></IconButton>
                </header>
                <div className="flex-1 overflow-y-auto ac-no-scrollbar px-4 py-4 space-y-4">
                    <button type="button" onClick={() => onPick('profile')} aria-current={current === 'profile' ? 'page' : undefined}
                        className={`w-full flex items-center gap-3 p-3 rounded-2xl text-left active-scale ${current === 'profile' ? 'neu-inset' : 'neu-raised-sm neu-btn'}`}>
                        <Avatar name={name || email} size={44} />
                        <span className="min-w-0 flex-1">
                            <span className="block font-serif text-base text-gray-900 dark:text-gray-100 truncate">{name || 'Your profile'}</span>
                            <span className="block text-[11px] font-light text-gray-600 dark:text-gray-400 truncate">{email}</span>
                            <span className="block mt-0.5 text-[9px] font-medium uppercase tracking-[0.16em] text-gold-700 dark:text-gold-300">Provider {role}</span>
                        </span>
                        <ChevronRight size={16} className="text-gray-400 shrink-0" />
                    </button>
                    <div className="space-y-1">
                        {items.map(i => {
                            const Icon = i.icon;
                            const active = current === i.tab;
                            return (
                                <button key={i.tab} type="button" onClick={() => onPick(i.tab)} aria-current={active ? 'page' : undefined}
                                    className={`neu-nav-row relative w-full flex items-center gap-3.5 px-3 py-3 rounded-xl text-left active-scale ${active ? 'neu-nav-row-active neu-inset text-gold-700 dark:text-gold-300' : 'text-gray-700 dark:text-gray-200'}`}>
                                    {active && <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-r-full bg-gold-500" />}
                                    <Icon size={18} strokeWidth={active ? 2.1 : 1.7} className={active ? 'text-gold-600 dark:text-gold-300' : 'text-gray-500 dark:text-gray-400'} />
                                    <span className={`flex-1 text-sm ${active ? 'font-medium' : 'font-light'}`}>{i.label}</span>
                                    {!!i.badge && <span className="ac-count">{i.badge}</span>}
                                </button>
                            );
                        })}
                    </div>
                </div>
                <footer className="px-4 py-3">
                    <button type="button" onClick={onSignOut} className="neu-button neu-button-danger w-full uppercase tracking-wider">
                        <LogOut size={16} /> Sign out
                    </button>
                </footer>
            </div>
        </>,
        overlayHost(),
    );
};

/* ───────────────────────────── Quick jump ────────────────────────────── */

interface Hit { key: string; label: string; hint: string; icon: React.ReactNode; go: () => void }

export const CommandPalette: React.FC<{ items: NavItem[]; onClose: () => void; navigate: (section: string, id?: string) => void }> = ({ items, onClose, navigate }) => {
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
            .map(i => { const Icon = i.icon; return { key: `s-${i.tab}`, label: i.label, hint: 'Go to section', icon: <Icon size={16} />, go: () => navigate(i.tab) }; });
        return [...sections, ...remote];
    }, [q, items, remote, navigate]);

    useEffect(() => { setActive(0); }, [q]);

    const pick = (h: Hit | undefined) => {
        if (!h) return;
        h.go();
        onClose();
    };

    return createPortal(
        <>
            <div className="ac-scrim ac-dialog-scrim neu-scrim" onClick={onClose} />
            <div className="ac-dialog neu-modal !top-[12vh] overflow-hidden" role="dialog" aria-modal="true" aria-label="Search" style={{ ['--ac-dialog-width' as string]: '560px' }}
                onKeyDown={e => {
                    if (e.key === 'Escape') onClose();
                    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, hits.length - 1)); }
                    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
                    else if (e.key === 'Enter') { e.preventDefault(); pick(hits[active]); }
                }}>
                <div className="p-4">
                    <label className="neu-field !py-0 flex items-center gap-2.5 cursor-text">
                        <Search size={16} className="text-gold-600 dark:text-gold-400 shrink-0" />
                        <input ref={input} value={q} onChange={e => setQ(e.target.value)} placeholder="Jump to a section, organization or account…"
                            className="flex-1 min-w-0 bg-transparent py-2.5 text-sm outline-none" aria-label="Search" />
                    </label>
                </div>
                <ul className="max-h-[55vh] overflow-y-auto ac-no-scrollbar px-3 pb-3 space-y-1" role="listbox">
                    {hits.length === 0 && <li className="px-3 py-8 text-center text-sm font-serif text-gray-600 dark:text-gray-300">No matches</li>}
                    {hits.map((h, i) => (
                        <li key={h.key} role="option" aria-selected={i === active}>
                            <button type="button" onMouseEnter={() => setActive(i)} onClick={() => pick(h)}
                                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-shadow ${i === active ? 'neu-inset text-gold-700 dark:text-gold-300' : 'text-gray-700 dark:text-gray-200'}`}>
                                <span className={i === active ? 'text-gold-600 dark:text-gold-300' : 'text-gray-500 dark:text-gray-400'}>{h.icon}</span>
                                <span className="min-w-0 flex-1">
                                    <span className="block text-sm truncate">{h.label}</span>
                                    <span className="block text-[11px] font-light text-gray-600 dark:text-gray-400 truncate">{h.hint}</span>
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
                <div className="px-4 py-2.5 flex flex-wrap gap-3 text-[11px] ac-faint" style={{ boxShadow: '0 -1px 0 var(--neu-line)' }}>
                    <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> move</span><span><Kbd>Enter</Kbd> open</span><span><Kbd>Esc</Kbd> close</span>
                </div>
            </div>
        </>,
        overlayHost(),
    );
};
