import React, { useState, useEffect, useRef, useMemo, createContext, useContext } from 'react';
import Lenis from 'lenis';
import { BottomNav } from '../components/BottomNav';
import { Sidebar } from '../components/Sidebar';
import { AdminPanel } from '../components/AdminPanel';
import { AuthUser } from '../services/authService';
import { ViewState } from '../types';
import { CanFn, makeCan, permissionsOf } from '../access';
import type { AccessLevel, SectionId } from '../permissions';

/** Smooth (Lenis) scrolling on the main content scroller. Wheel/desktop only —
 * touch stays native so iOS momentum scrolling is untouched. Nested scrollable
 * elements (chat lists, modals) keep native behavior via the prevent check. */
const useSmoothScroll = (ref: React.RefObject<HTMLElement | null>) => {
    useEffect(() => {
        const wrapper = ref.current;
        if (!wrapper) return;
        if (globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

        const lenis = new Lenis({
            wrapper,
            content: wrapper,
            autoRaf: true,
            duration: 0.9,
            prevent: (node) =>
                node !== wrapper &&
                node instanceof HTMLElement &&
                node.scrollHeight > node.clientHeight &&
                /(auto|scroll)/.test(getComputedStyle(node).overflowY),
        });

        return () => lenis.destroy();
    }, [ref]);
};

/* ------------------------------------------------------------------ */
/*  App chrome context                                                 */
/*                                                                     */
/*  The admin panel and the current user live in the shell, but the    */
/*  buttons that open them belong in each view's own PageHeader (on    */
/*  phones — on desktop the sidebar owns them). Sharing them through   */
/*  context keeps App.tsx from having to thread the props through      */
/*  every view.                                                        */
/* ------------------------------------------------------------------ */

interface AppChrome {
    isAdmin: boolean;
    /** What the signed-in person's role allows: can('inventory', 'edit'). */
    can: CanFn;
    openAdmin: () => void;
    navigate: (view: ViewState) => void;
}

const AppChromeContext = createContext<AppChrome>({
    isAdmin: false,
    can: () => false,
    openAdmin: () => { },
    navigate: () => { },
});

export const useAppChrome = () => useContext(AppChromeContext);

/**
 * Renders its children only when the signed-in person's role allows it —
 * by default, edit access to the section. For hiding add / edit / import
 * buttons from view-only roles; the server enforces the same rule.
 */
export const IfCan: React.FC<{ section: SectionId; level?: AccessLevel; children?: React.ReactNode }> = ({ section, level = 'edit', children }) =>
    useAppChrome().can(section, level) ? <>{children}</> : null;

const SIDEBAR_KEY = 'vayu.sidebar.collapsed';

const Layout: React.FC<{
  currentView: ViewState;
  onNavigate: (view: ViewState) => void;
  userProfile?: AuthUser | null;
  children?: React.ReactNode;
}> = ({ currentView, onNavigate, userProfile, children }) => {
  const [showAdmin, setShowAdmin] = useState(false);
  const isAdmin = userProfile?.role === 'admin';
  const can = useMemo(() => makeCan(permissionsOf(userProfile)), [userProfile]);
  const mainRef = useRef<HTMLElement>(null);
  useSmoothScroll(mainRef);

  // Rail vs. full sidebar — remembered per browser, like a desktop app.
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(SIDEBAR_KEY) === '1'; } catch { return false; }
  });

  const toggleCollapsed = () => {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0'); } catch { /* private mode */ }
      return next;
    });
  };

  const chrome = useMemo<AppChrome>(
    () => ({ isAdmin, can, openAdmin: () => setShowAdmin(true), navigate: onNavigate }),
    [isAdmin, can, onNavigate],
  );

  const isLogin = currentView === 'login';

  return (
    <AppChromeContext.Provider value={chrome}>
      <div className="h-app min-h-app bg-[var(--neu-bg)] flex items-stretch justify-center p-0 lg:p-3 xl:p-4 transition-colors duration-500">
        <div
          id="app-shell"
          className="w-full h-full bg-[var(--neu-bg)] relative overflow-hidden flex flex-col lg:flex-row transition-colors duration-500 lg:rounded-[1.5rem] lg:ring-1 lg:ring-gray-900/5 dark:lg:ring-white/5"
          style={{ boxShadow: '0 30px 70px -24px var(--neu-shadow-dark), 0 4px 14px var(--neu-shadow-light)' }}
        >
          {/* Desktop sidebar navigation (hidden below lg). Sole owner of the
              brand mark, primary nav, admin entry and the profile link. */}
          {!isLogin && (
            <Sidebar
              currentView={currentView}
              onNavigate={onNavigate}
              isAdmin={isAdmin}
              can={can}
              onOpenAdmin={() => setShowAdmin(true)}
              collapsed={collapsed}
              onToggleCollapsed={toggleCollapsed}
              userName={userProfile?.name}
            />
          )}

          {/* Content column — page header (from the view), scroll area, phone dock.
              Deliberately no second title bar: each view's PageHeader is the
              only place its title and actions appear. `min-h-0` lets the
              column shrink to the shell instead of growing to the page's
              content height — without it the dock ends up below the clip. */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0 relative">
            <main
              ref={mainRef}
              className="flex-1 overflow-y-auto no-scrollbar transition-colors duration-500 animate-fade-in overscroll-contain"
              style={{ WebkitOverflowScrolling: 'touch' }}
            >
              {children}
            </main>

            {/* Bottom Navigation (phone only) */}
            {!isLogin && <div className="lg:hidden"><BottomNav currentView={currentView} onChangeView={onNavigate} can={can} /></div>}
          </div>

          {/* Admin Panel (full-screen overlay — admins only) */}
          {showAdmin && userProfile && (
            <AdminPanel
              currentUserId={userProfile.id}
              onClose={() => setShowAdmin(false)}
            />
          )}
        </div>
      </div>
    </AppChromeContext.Provider>
  );
};

export default Layout;
