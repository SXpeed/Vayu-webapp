import React, { useState } from 'react';
import {
    Home, Image, Library, BookOpen, MessageCircle, Search, Users,
    CalendarDays, Clock, FileText, CreditCard, User, ShieldCheck, Wind,
    ChevronLeft, ChevronRight,
} from 'lucide-react';
import { ViewState } from '../types';
import { CanFn, canOpenView } from '../access';
import { APP_NAME } from '../brand';

interface NavItem {
    id: ViewState;
    label: string;
    icon: React.ElementType;
}

const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
    {
        title: 'Studio',
        items: [
            { id: 'home', label: 'Home', icon: Home },
            { id: 'artworks', label: 'Inventory', icon: Image },
            { id: 'collections', label: 'Collections', icon: Library },
            { id: 'catalogs', label: 'Catalogs', icon: BookOpen },
        ],
    },
    {
        title: 'Clients',
        items: [
            { id: 'contacts', label: 'Contacts', icon: Users },
            { id: 'calendar', label: 'Calendar', icon: CalendarDays },
            { id: 'attendance', label: 'Attendance', icon: Clock },
        ],
    },
    {
        title: 'Commerce',
        items: [
            { id: 'invoice', label: 'Invoices', icon: FileText },
            { id: 'payments', label: 'Payments', icon: CreditCard },
            { id: 'inquiry', label: 'Inquiry', icon: Search },
            { id: 'messaging', label: 'Messages', icon: MessageCircle },
        ],
    },
];

interface SidebarProps {
    currentView: ViewState;
    onNavigate: (view: ViewState) => void;
    isAdmin?: boolean;
    /** Sections the person's role can't open are left out. */
    can: CanFn;
    onOpenAdmin?: () => void;
    /** Icon-only rail instead of the full 15rem sidebar. */
    collapsed?: boolean;
    onToggleCollapsed?: () => void;
    /** Shown on the profile row when expanded. */
    userName?: string;
}

/**
 * Desktop navigation sidebar (lg+). Replaces the phone BottomNav, which
 * Layout hides on lg screens.
 *
 * This is the only chrome in the app: it owns the brand mark, primary
 * navigation, the admin entry point and the profile link, so none of those
 * are repeated in a top bar or in any view's header.
 *
 * Rows are deliberately plain — one icon, one label, no chip. Stacking eleven
 * raised squares down the rail made it read as a column of boxes; now the row
 * itself is the only surface: flat at rest, softly raised under the pointer,
 * pressed in when active with gold ink and an edge marker.
 */
export const Sidebar: React.FC<SidebarProps> = ({
    currentView, onNavigate, isAdmin = false, can, onOpenAdmin,
    collapsed = false, onToggleCollapsed, userName,
}) => {
    // Only what this role can open; groups left empty disappear.
    const groups = NAV_GROUPS
        .map(g => ({ ...g, items: g.items.filter(item => canOpenView(can, item.id)) }))
        .filter(g => g.items.length > 0);
    // Collapsed rail: one floating label beside the hovered/focused icon.
    // Rendered fixed, outside the scrolling list, so the list's overflow
    // clip can't cut it off.
    const [tip, setTip] = useState<{ label: string; top: number; left: number } | null>(null);
    const showTip = (label: string) => (e: React.SyntheticEvent<HTMLElement>) => {
        if (!collapsed) return;
        const r = e.currentTarget.getBoundingClientRect();
        setTip({ label, top: r.top + r.height / 2, left: r.right + 12 });
    };
    const hideTip = () => setTip(null);

    /** One row renderer for nav items, admin and profile — same geometry,
     *  so nothing drifts between the groups and the footer. */
    const renderRow = (
        { label, icon: Icon, isActive, onClick, key, a11yLabel }:
            { label: string; icon: React.ElementType; isActive: boolean; onClick: () => void; key: string; a11yLabel?: string },
    ) => (
        <button
            key={key}
            onClick={onClick}
            onMouseEnter={showTip(a11yLabel ?? label)}
            onMouseLeave={hideTip}
            onFocus={showTip(a11yLabel ?? label)}
            onBlur={hideTip}
            aria-label={a11yLabel ?? label}
            aria-current={isActive ? 'page' : undefined}
            className={`neu-nav-row group relative flex items-center active-scale text-left
                ${collapsed ? 'justify-center w-10 h-10 mx-auto rounded-xl' : 'w-full gap-3.5 px-3 py-2 rounded-xl'}
                ${isActive
                    ? 'neu-nav-row-active neu-inset text-gold-700 dark:text-gold-300'
                    : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white'
                }`}
        >
            {/* Gold edge marker on the full sidebar. The collapsed rail's
                pressed-in square well already says "you are here". */}
            {isActive && !collapsed && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-r-full bg-gold-500" />
            )}
            <Icon
                size={18}
                strokeWidth={isActive ? 2.1 : 1.7}
                className={`shrink-0 transition-colors ${isActive
                    ? 'text-gold-600 dark:text-gold-300'
                    : 'text-gray-500 dark:text-gray-400 group-hover:text-gray-900 dark:group-hover:text-white'
                    }`}
            />
            {!collapsed && (
                <span className={`text-[13px] tracking-wide leading-none truncate ${isActive ? 'font-medium' : 'font-light'}`}>
                    {label}
                </span>
            )}
        </button>
    );

    return (
        <aside
            className={`hidden lg:flex relative flex-col shrink-0 h-full z-30 bg-[var(--neu-bg)] transition-[width] duration-300 ease-out
                ${collapsed ? 'w-20 px-2 py-4' : 'w-60 px-3.5 py-4'}`}
            style={{ boxShadow: '6px 0 14px var(--neu-shadow-dark), 2px 0 6px var(--neu-shadow-light)' }}
        >
            {/* Collapse / expand: a small raised button riding the rail's edge,
                level with the brand mark — out of the way of the list. */}
            {onToggleCollapsed && (
                <button
                    onClick={() => { hideTip(); onToggleCollapsed(); }}
                    aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                    title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                    aria-expanded={!collapsed}
                    className="absolute top-[30px] -right-3.5 z-40 w-7 h-7 rounded-full neu-raised-sm neu-btn flex items-center justify-center text-gray-500 dark:text-gray-400 hover:text-[var(--neu-gold)] active-scale"
                >
                    {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
                </button>
            )}

            {/* Brand */}
            <div className={`flex items-center ${collapsed ? 'justify-center mb-4' : 'gap-3 px-0.5 mb-5'}`}>
                <button
                    onClick={() => onNavigate('home')}
                    onMouseEnter={showTip(`${APP_NAME} — Home`)}
                    onMouseLeave={hideTip}
                    aria-label="Go to home"
                    className="w-11 h-11 rounded-2xl neu-accent neu-btn flex items-center justify-center shrink-0 active-scale"
                >
                    <Wind size={20} />
                </button>
                {!collapsed && (
                    <div className="min-w-0 flex-1">
                        <p className="font-serif text-lg leading-tight text-gold-700 dark:text-gold-300 truncate">{APP_NAME}</p>
                    </div>
                )}
            </div>

            {/* Grouped nav. The scroll clip (`overflow-y-auto` clips both axes) must
                never touch the raised hover shadow — `px-2 -mx-2 py-2` keeps an
                8px buffer around every row. The ends fade out, so on a short
                screen it's clear the list scrolls. */}
            <nav
                onScroll={hideTip}
                className={`flex-1 overflow-y-auto no-scrollbar px-2 -mx-2 py-2 [mask-image:linear-gradient(to_bottom,transparent,#000_12px,#000_calc(100%-12px),transparent)] ${collapsed ? 'space-y-2.5' : 'space-y-4'}`}
            >
                {groups.map((group, gi) => (
                    <div key={group.title}>
                        {collapsed ? (
                            gi > 0 && <div className="neu-divider w-7 mx-auto mb-2.5" />
                        ) : (
                            <p className="px-3 mb-2 text-[9px] font-medium uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">
                                {group.title}
                            </p>
                        )}
                        <div className="space-y-1">
                            {group.items.map((item) => renderRow({
                                key: item.id,
                                label: item.label,
                                icon: item.icon,
                                isActive: currentView === item.id,
                                onClick: () => onNavigate(item.id),
                            }))}
                        </div>
                    </div>
                ))}
            </nav>

            {/* Footer — admin + profile */}
            <div className={collapsed ? 'mt-2 space-y-1' : 'mt-2 pt-2 w-full space-y-1 border-t border-gray-200/70 dark:border-white/5'}>
                {collapsed && <div className="neu-divider w-7 mx-auto mb-2.5" />}
                {isAdmin && onOpenAdmin && renderRow({
                    key: 'admin',
                    label: 'Admin',
                    icon: ShieldCheck,
                    isActive: false,
                    onClick: onOpenAdmin,
                })}
                {renderRow({
                    key: 'profile',
                    // Shows who is signed in, but still announces where it goes.
                    label: userName && !collapsed ? userName : 'Profile',
                    a11yLabel: 'Profile',
                    icon: User,
                    isActive: currentView === 'profile',
                    onClick: () => onNavigate('profile'),
                })}
            </div>

            {collapsed && tip && (
                <span
                    role="tooltip"
                    className="fixed z-[90] pointer-events-none -translate-y-1/2 whitespace-nowrap rounded-xl px-3 py-1.5 text-xs font-medium neu-raised-sm text-[var(--neu-text)] animate-fade-in"
                    style={{ top: tip.top, left: tip.left }}
                >
                    {tip.label}
                </span>
            )}
        </aside>
    );
};
