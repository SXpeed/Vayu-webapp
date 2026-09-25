import React, { useState } from 'react';
import { Home, Image, Library, BookOpen, MessageCircle, Search } from 'lucide-react';
import { ViewState } from '../types';
import { CanFn, canOpenView } from '../access';

interface BottomNavProps {
    currentView: ViewState;
    onChangeView: (view: ViewState) => void;
    /** Tabs the person's role can't open are left out. */
    can: CanFn;
}

const NAV_ITEMS: { id: ViewState; label: string; icon: React.ElementType }[] = [
    { id: 'home', label: 'Home', icon: Home },
    { id: 'artworks', label: 'Inventory', icon: Image },
    { id: 'collections', label: 'Collections', icon: Library },
    { id: 'catalogs', label: 'Catalogs', icon: BookOpen },
    { id: 'messaging', label: 'Messages', icon: MessageCircle },
    { id: 'inquiry', label: 'Inquiry', icon: Search },
];

/** Neumorphic phone dock: an extruded bar whose single concave well glides to
 *  the active tab (styles: `.neu-dock*` in index.css). Pages clear it via
 *  PageBody's bottom padding. It sits just clear of the iPhone home indicator
 *  (inset − 18px + 6px ≈ 22pt), not a full inset + 10px above it: the 34pt
 *  inset is generous and the extra float read as dead space. */
export const BottomNav: React.FC<BottomNavProps> = ({ currentView, onChangeView, can }) => {
    const items = NAV_ITEMS.filter(item => canOpenView(can, item.id));
    const activeIndex = items.findIndex((item) => item.id === currentView);

    // Where the well sits. Off-dock views (Profile, Calendar…) fade it out in
    // place, so coming back it reappears there instead of sweeping from tab 0.
    const [wellIndex, setWellIndex] = useState(Math.max(activeIndex, 0));
    if (activeIndex >= 0 && activeIndex !== wellIndex) setWellIndex(activeIndex);

    return (
        <nav
            aria-label="Primary"
            className="neu-dock-scrim absolute bottom-0 inset-x-0 z-40 px-3 pt-5 pb-[calc(max(var(--safe-bottom-ui)-18px,0px)+6px)] pointer-events-none"
        >
            <div
                className="neu-dock pointer-events-auto mx-auto max-w-md flex p-[5px]"
                style={{ '--dock-count': items.length, '--dock-index': wellIndex } as React.CSSProperties}
            >
                <span aria-hidden="true" className="neu-dock-well" style={{ opacity: activeIndex >= 0 ? 1 : 0 }} />
                {items.map((item) => {
                    const Icon = item.icon;
                    const isActive = currentView === item.id;
                    return (
                        <button
                            key={item.id}
                            onClick={() => onChangeView(item.id)}
                            aria-current={isActive ? 'page' : undefined}
                            className="neu-dock-item relative flex-1 min-w-0 h-[52px] flex flex-col items-center justify-center gap-[5px]"
                        >
                            <Icon size={19} strokeWidth={isActive ? 2.2 : 1.8} className="neu-dock-icon" />
                            <span className={`max-w-full truncate text-[9.5px] leading-[1.35] -my-[0.175em] ${isActive ? 'font-semibold' : 'font-medium'}`}>
                                {item.label}
                            </span>
                        </button>
                    );
                })}
            </div>
        </nav>
    );
};
