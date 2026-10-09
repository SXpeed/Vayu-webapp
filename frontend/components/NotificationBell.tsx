import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Bell, X } from 'lucide-react';
import { FullScreenPortal } from './FullScreenPortal';
import { CountBadge, useInbox, type BellNotification } from '../hooks/useInbox';

/** Notifications about one source (one inquiry, one chat) shown as one row. */
interface Group { key: string; newest: BellNotification; ids: string[] }

function groupNotifications(list: BellNotification[]): Group[] {
    const groups = new Map<string, Group>();
    for (const n of list) { // newest first, as the server sends them
        const key = n.groupKey || n.id;
        const group = groups.get(key);
        if (group) group.ids.push(n.id);
        else groups.set(key, { key, newest: n, ids: [n.id] });
    }
    return [...groups.values()];
}

function timeAgo(at: number): string {
    const minutes = Math.round((Date.now() - at) / 60_000);
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h`;
    return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** The bell's list. Tapping a row opens what it is about; × only clears it from here. */
export const NotificationSheet: React.FC<{ onClose: () => void }> = ({ onClose }) => {
    const { notifications, setNotificationsState, openLink } = useInbox();
    const groups = useMemo(() => groupNotifications(notifications), [notifications]);
    const closeRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        closeRef.current?.focus();
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    return (
        <FullScreenPortal>
            <dialog open aria-modal="true" aria-label="Notifications" className="neu-sheet lg:w-[min(440px,94%)]! z-50 animate-fade-in-up">
                <div className="flex justify-between items-center p-3 pt-[calc(1.75rem+var(--safe-top))] lg:pt-4">
                    <button ref={closeRef} onClick={onClose} className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale" aria-label="Close">
                        <X size={20} />
                    </button>
                    <h2 className="text-base font-serif text-gray-900 dark:text-white">Notifications</h2>
                    <button
                        type="button"
                        onClick={() => setNotificationsState(notifications.map(n => n.id), 'dismissed')}
                        disabled={groups.length === 0}
                        className="text-[11px] uppercase tracking-wider text-gray-600 dark:text-gray-300 disabled:opacity-0 px-2 py-1"
                    >
                        Clear all
                    </button>
                </div>
                <ul className="flex-1 overflow-y-auto no-scrollbar px-3 pb-[calc(1rem+var(--safe-bottom-ui,0px))] space-y-2">
                    {groups.map(({ key, newest, ids }) => (
                        <li key={key} className="neu-card flex items-start gap-2 p-3">
                            <button
                                type="button"
                                className="flex-1 min-w-0 text-left"
                                onClick={() => {
                                    setNotificationsState(ids, 'opened');
                                    onClose();
                                    openLink(newest.link);
                                }}
                            >
                                <span className="flex items-baseline gap-2">
                                    <span className="flex-1 min-w-0 truncate text-[13.5px] font-medium text-[var(--neu-text)]">{newest.title}</span>
                                    <span className="shrink-0 text-[10.5px] text-[var(--neu-text-dim)] tabular-nums">{timeAgo(newest.createdAt)}</span>
                                </span>
                                <span className="mt-0.5 flex items-center gap-2">
                                    <span className="flex-1 min-w-0 truncate text-[12px] text-[var(--neu-text-dim)]">{newest.body}</span>
                                    {ids.length > 1 && <span className="shrink-0 text-[10.5px] text-gold-700 dark:text-gold-300">{ids.length} new</span>}
                                </span>
                            </button>
                            <button
                                type="button"
                                onClick={() => setNotificationsState(ids, 'dismissed')}
                                aria-label={`Dismiss: ${newest.title}`}
                                className="shrink-0 -mr-1 -mt-1 w-8 h-8 rounded-full flex items-center justify-center text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
                            >
                                <X size={14} />
                            </button>
                        </li>
                    ))}
                    {groups.length === 0 && (
                        <li className="py-16 text-center text-sm text-[var(--neu-text-dim)]">You're all caught up.</li>
                    )}
                </ul>
            </dialog>
        </FullScreenPortal>
    );
};

/** A round bell button with its count, for page headers on phones. */
export const BellButton: React.FC = () => {
    const { notifications } = useInbox();
    const [open, setOpen] = useState(false);
    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                aria-label={notifications.length ? `Notifications, ${notifications.length} new` : 'Notifications'}
                className="relative w-9 h-9 rounded-full neu-raised-sm neu-btn text-brand-900 dark:text-gold-400 flex items-center justify-center active-scale"
            >
                <Bell size={17} />
                <CountBadge count={notifications.length} className="absolute -top-1 -right-1" />
            </button>
            {open && <NotificationSheet onClose={() => setOpen(false)} />}
        </>
    );
};
