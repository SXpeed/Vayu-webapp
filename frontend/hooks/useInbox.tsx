// The signed-in person's bell and unread inquiries (server: inbox.ts), plus
// unread chat counted from the messages already synced. One copy for the
// whole app, shared through InboxContext: sidebar, dock, bell, inquiry list.
//
// The server is the source of truth: it is asked again on start, whenever
// the hub signals this person's inbox or an inquiry change, when the socket
// reconnects and when the tab comes back. Local changes are applied at once
// and then confirmed by that refetch. Switching organisation reloads the page,
// so one organisation's counts never carry into another's.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { apiCall } from '../services/apiClient';
import { realtimeService } from '../services/realtimeService';
import type { Conversation, Message } from '../types';

export interface BellNotification {
    id: string;
    groupKey: string;
    title: string;
    body: string;
    link: Record<string, unknown>;
    createdAt: number;
}

interface InboxState {
    notifications: BellNotification[];
    unreadInquiryIds: ReadonlySet<string>;
    /** Unread chat messages, per conversation. */
    unreadChats: ReadonlyMap<string, number>;
    unreadChatTotal: number;
    /** Tapped or dismissed: gone from the bell, nothing else changes. */
    setNotificationsState: (ids: string[], state: 'opened' | 'dismissed') => void;
    /** Details opened (read), or "Mark unread". */
    setInquiryRead: (inquiryId: string, read: boolean) => void;
    /** Goes where a notification leads (the same as tapping its push). */
    openLink: (link: Record<string, unknown>) => void;
}

const EMPTY: InboxState = {
    notifications: [], unreadInquiryIds: new Set(), unreadChats: new Map(), unreadChatTotal: 0,
    setNotificationsState: () => { }, setInquiryRead: () => { }, openLink: () => { },
};

export const InboxContext = createContext<InboxState>(EMPTY);
export const useInbox = () => useContext(InboxContext);

/** Events that can change this person's inbox. */
const INBOX_ENTITIES = new Set(['inbox', 'inquiry']);

/** Unread chat: others' messages I haven't read, in conversations I'm in (admins see others' chats too). */
export function countUnreadChats(conversations: Conversation[], messages: Message[], me: string): Map<string, number> {
    const mine = new Set(conversations.filter(c => c.participantIds.includes(me)).map(c => c.id));
    const counts = new Map<string, number>();
    for (const m of messages) {
        // `status: read` covers messages from before per-person receipts.
        if (m.senderId === me || !mine.has(m.conversationId) || m.readBy?.[me] || m.status === 'read') continue;
        counts.set(m.conversationId, (counts.get(m.conversationId) ?? 0) + 1);
    }
    return counts;
}

export function useInboxState(
    userId: string | undefined, conversations: Conversation[], messages: Message[], openLink: InboxState['openLink'],
): InboxState {
    const [notifications, setNotifications] = useState<BellNotification[]>([]);
    const [unreadInquiryIds, setUnreadInquiryIds] = useState<ReadonlySet<string>>(new Set());
    // Only the newest answer counts: a slow, older reply never overwrites a newer one.
    const generation = useRef(0);

    const refresh = useCallback(async () => {
        if (!userId) return;
        const mine = ++generation.current;
        try {
            const box = await apiCall<{ notifications: BellNotification[]; unreadInquiryIds: string[] }>('/inbox');
            if (mine !== generation.current) return;
            setNotifications(box.notifications);
            setUnreadInquiryIds(new Set(box.unreadInquiryIds));
        } catch {
            /* offline: keep what is shown; the next signal or focus asks again */
        }
    }, [userId]);

    useEffect(() => {
        if (!userId) {
            setNotifications([]);
            setUnreadInquiryIds(new Set());
            return;
        }
        void refresh();
        const unsubscribe = realtimeService.subscribe(event => {
            // An empty list means "reconnected": things may have been missed.
            if (event.type === 'invalidate' && (event.events.length === 0 || event.events.some(e => INBOX_ENTITIES.has(e.entity)))) void refresh();
        });
        const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            generation.current++; // drop any reply still on its way
            unsubscribe();
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [userId, refresh]);

    const setNotificationsState = useCallback((ids: string[], state: 'opened' | 'dismissed') => {
        if (ids.length === 0) return;
        const gone = new Set(ids);
        generation.current++; // a reply already on its way would bring them back
        setNotifications(prev => prev.filter(n => !gone.has(n.id)));
        apiCall('/inbox/notifications', { method: 'POST', body: JSON.stringify({ ids, state }) })
            .catch(() => undefined)
            .finally(() => void refresh());
    }, [refresh]);

    const setInquiryRead = useCallback((inquiryId: string, read: boolean) => {
        generation.current++;
        setUnreadInquiryIds(prev => {
            if (prev.has(inquiryId) !== read) return prev;
            const next = new Set(prev);
            if (read) next.delete(inquiryId); else next.add(inquiryId);
            return next;
        });
        apiCall('/inbox/read', { method: 'POST', body: JSON.stringify({ inquiryId, unread: !read }) })
            .catch(() => undefined)
            .finally(() => void refresh());
    }, [refresh]);

    const unreadChats = useMemo(() => (userId ? countUnreadChats(conversations, messages, userId) : new Map<string, number>()), [conversations, messages, userId]);
    const unreadChatTotal = useMemo(() => [...unreadChats.values()].reduce((a, b) => a + b, 0), [unreadChats]);

    return useMemo(() => ({
        notifications, unreadInquiryIds, unreadChats, unreadChatTotal, setNotificationsState, setInquiryRead, openLink,
    }), [notifications, unreadInquiryIds, unreadChats, unreadChatTotal, setNotificationsState, setInquiryRead, openLink]);
}

/** 0 hides; above 99 reads 99+. */
export const badgeText = (count: number): string | null => (count <= 0 ? null : count > 99 ? '99+' : String(count));

/** A small count on a nav item; takes no room when there is nothing to count. */
export const CountBadge: React.FC<{ count: number; className?: string }> = ({ count, className = '' }) => {
    const text = badgeText(count);
    if (!text) return null;
    return (
        <span
            aria-label={`${count} unread`}
            className={`min-w-[1.125rem] h-[1.125rem] px-1 rounded-full bg-gold-600 text-white dark:bg-gold-400 dark:text-gray-900 text-[10px] font-semibold leading-none tabular-nums flex items-center justify-center ${className}`}
        >
            {text}
        </span>
    );
};
