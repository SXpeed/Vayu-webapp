import React from 'react';
import { BottomNav } from '../components/BottomNav';
import { User } from 'lucide-react';

/**
 * Layout component that provides a consistent header, main container, and bottom navigation
 * for all pages. It includes the brand title, a profile button, and renders children
 * as the page content.
 */
const Layout: React.FC<{ currentView: string; onNavigate: (view: any) => void; children?: React.ReactNode }> = ({ currentView, onNavigate, children }) => {
  return (
    <div className="min-h-screen bg-gray-200 dark:bg-gray-950 flex items-center justify-center md:p-4 transition-colors duration-500">
      <div id="app-shell" className="w-full h-[100dvh] md:h-[90vh] md:max-w-md lg:max-w-lg bg-[#faf9f6] dark:bg-[#121212] md:rounded-[7px] md:shadow-2xl relative overflow-hidden flex flex-col md:border-[6px] border-gray-800 dark:border-gray-900 transition-all duration-500">
        {/* Header - Only on Home */}
        {currentView === 'home' && (
          <header className="bg-white dark:bg-[#1a1a1a] px-4 pb-3 shadow-sm border-b border-gray-100 dark:border-gray-800 animate-fade-in-up" style={{ paddingTop: 'calc(2rem + env(safe-area-inset-top, 0px))' }}>
            <div className="flex justify-between items-start">
              <div>
                <h1 className="text-xl font-serif mb-0 tracking-wide text-gold-600 dark:text-gold-400">Vayu</h1>
                <p className="text-gray-500 dark:text-gray-400 text-xs font-serif uppercase tracking-widest">Design for living</p>
              </div>
              <button
                onClick={() => onNavigate('profile')}
                className="w-9 h-9 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center border border-gray-200 dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors active-scale shrink-0 mt-1"
              >
                <User size={18} className="text-brand-900 dark:text-gold-400" />
              </button>
            </div>
          </header>
        )}
        {/* Main Content */}
        <main className="flex-1 overflow-y-auto no-scrollbar pb-16 transition-colors duration-500 animate-fade-in">
          {children}
        </main>
        {/* Bottom Navigation */}
        {currentView !== 'login' && <BottomNav currentView={currentView} onChangeView={onNavigate} />}
      </div>
    </div>
  );
};

export default Layout;
