import React, { useState, useEffect, useRef } from 'react';
import Lenis from 'lenis';
import { BottomNav } from '../components/BottomNav';
import { User, Users, Activity } from 'lucide-react';
import { AuthUser } from '../services/authService';
import { ViewState } from '../types';
import UserManagementPanel from './UserManagementPanel';

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

const Layout: React.FC<{
  currentView: ViewState;
  onNavigate: (view: ViewState) => void;
  userProfile?: AuthUser | null;
  onShowActivity?: () => void;
  children?: React.ReactNode;
}> = ({ currentView, onNavigate, userProfile, onShowActivity, children }) => {
  const [showUserMgmt, setShowUserMgmt] = useState(false);
  const isAdmin = userProfile?.role === 'admin';
  const mainRef = useRef<HTMLElement>(null);
  useSmoothScroll(mainRef);

  return (
    <div className="min-h-app bg-white dark:bg-[#1a1a1a] md:bg-gray-200 md:dark:bg-gray-950 flex items-start md:items-center justify-center md:p-[6px] transition-colors duration-500">
      <div
        id="app-shell"
        className="w-full h-app md:max-w-md lg:max-w-lg bg-[#faf9f6] dark:bg-[#121212] md:rounded-[6px] md:shadow-2xl relative overflow-hidden flex flex-col md:border-[6px] border-gray-800 dark:border-gray-900 transition-colors duration-500"
      >
        {/* Header — only on Home */}
        {currentView === 'home' && (
          <header className="bg-white dark:bg-[#1a1a1a] px-[6px] pb-3 shadow-sm border-b border-gray-100 dark:border-gray-800 animate-fade-in-up" style={{ paddingTop: 'calc(2rem + env(safe-area-inset-top, 0px))' }}>
            <div className="flex justify-between items-start">
              <div>
                <h1 className="text-xl font-serif mb-0 tracking-wide text-gold-600 dark:text-gold-400">Vayu</h1>
                <p className="text-gray-500 dark:text-gray-400 text-xs font-serif uppercase tracking-widest">Design for living</p>
              </div>
              <div className="flex items-center gap-2 mt-1">
                {isAdmin && (
                  <button onClick={() => setShowUserMgmt(true)} className="w-9 h-9 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center border border-gray-200 dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors active-scale shrink-0" title="Manage users">
                    <Users size={16} className="text-brand-900 dark:text-gold-400" />
                  </button>
                )}
                {isAdmin && onShowActivity && (
                  <button onClick={onShowActivity} className="w-9 h-9 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center border border-gray-200 dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors active-scale shrink-0" title="Activity logs">
                    <Activity size={16} className="text-brand-900 dark:text-gold-400" />
                  </button>
                )}
                <button onClick={() => onNavigate('profile')} className="w-9 h-9 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center border border-gray-200 dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors active-scale shrink-0">
                  <User size={18} className="text-brand-900 dark:text-gold-400" />
                </button>
              </div>
            </div>
          </header>
        )}

        {/* Main Content */}
        <main ref={mainRef} className="flex-1 overflow-y-auto no-scrollbar transition-colors duration-500 animate-fade-in overscroll-contain" style={{ WebkitOverflowScrolling: 'touch' }}>
          {children}
        </main>

        {/* Bottom Navigation */}
        {currentView !== 'login' && <BottomNav currentView={currentView} onChangeView={onNavigate} />}

        {/* User Management Panel (full-screen overlay) */}
        {showUserMgmt && userProfile && (
          <UserManagementPanel
            currentUserId={userProfile.id}
            onClose={() => setShowUserMgmt(false)}
          />
        )}
      </div>
    </div>
  );
};

export default Layout;