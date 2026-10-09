// Reactions and read receipts on chat messages, WhatsApp style: hold a
// message (or right-click it on a computer) for a row of emoji and a few
// actions; reactions sit under the bubble and open a list of who reacted;
// "Info" on your own message lists who has read it and who hasn't yet.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, CheckCheck, Copy, Info, Plus, Reply, X } from 'lucide-react';
import type { Message } from '../../types';
import { MORE_REACTIONS, QUICK_REACTIONS } from '../../chatReactions';

const HOLD_MS = 450;
const MOVE_TOLERANCE_PX = 10;

/**
 * Press-and-hold on touch screens, right-click with a mouse. A finger that
 * moves (scrolling the chat) cancels the hold. The tap that lifting the
 * finger after a hold produces is swallowed, so holding a photo opens the
 * menu without also opening the photo.
 */
export function useLongPress(onLongPress: (target: HTMLElement) => void) {
    const timer = useRef<number | null>(null);
    const start = useRef<{ x: number; y: number } | null>(null);
    const held = useRef(false);
    const cancel = () => {
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = null;
        start.current = null;
    };
    useEffect(() => cancel, []);
    return {
        onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
            held.current = false;
            if (e.pointerType === 'mouse') return; // a mouse uses right-click
            const target = e.currentTarget;
            start.current = { x: e.clientX, y: e.clientY };
            timer.current = window.setTimeout(() => {
                timer.current = null;
                held.current = true;
                navigator.vibrate?.(10);
                onLongPress(target);
            }, HOLD_MS);
        },
        onClickCapture: (e: React.MouseEvent<HTMLElement>) => {
            if (!held.current) return;
            held.current = false;
            e.preventDefault();
            e.stopPropagation();
        },
        onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
            if (!start.current) return;
            if (Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > MOVE_TOLERANCE_PX) cancel();
        },
        onPointerUp: cancel,
        onPointerCancel: cancel,
        onPointerLeave: cancel,
        onContextMenu: (e: React.MouseEvent<HTMLElement>) => {
            e.preventDefault();
            cancel();
            onLongPress(e.currentTarget);
        },
    };
}

/**
 * A message that opens its menu when held. The phone's own text-selection
 * callout is turned off here; "Copy text" in the menu replaces it.
 */
export const Holdable: React.FC<{ onHold: (target: HTMLElement) => void; className?: string; children: React.ReactNode }> = ({ onHold, className = '', children }) => (
    <div {...useLongPress(onHold)} className={`select-none ${className}`} style={{ WebkitTouchCallout: 'none' }}>
        {children}
    </div>
);

/** Everyone in the conversation except the sender. */
const othersOf = (participantIds: string[], senderId: string) => participantIds.filter(id => id !== senderId);

/**
 * How far one of your messages has got: 'all' when everyone else has read
 * it, 'some' when part of a group has, otherwise its delivery status.
 */
export function readState(msg: Message, participantIds: string[]): 'all' | 'some' | 'delivered' | 'sent' {
    const others = othersOf(participantIds, msg.senderId);
    const readers = others.filter(id => msg.readBy?.[id]).length;
    if (others.length > 0 && readers === others.length) return 'all';
    if (readers > 0) return 'some';
    // Before per-person receipts, a 1:1 read was only the message's status.
    if (others.length === 1 && msg.status === 'read') return 'all';
    return msg.status === 'delivered' || msg.status === 'read' ? 'delivered' : 'sent';
}

export const ReadTicks: React.FC<{ msg: Message; participantIds: string[] }> = ({ msg, participantIds }) => {
    const state = readState(msg, participantIds);
    if (state === 'all') return <CheckCheck size={12} className="text-sky-500 dark:text-sky-400" aria-label="Read" />;
    if (state === 'some' || state === 'delivered') return <CheckCheck size={12} aria-label={state === 'some' ? 'Read by some' : 'Delivered'} />;
    return <Check size={12} aria-label="Sent" />;
};

/** Emoji with their counts, most used first. */
function grouped(reactions: Record<string, string>): { emoji: string; userIds: string[] }[] {
    const by = new Map<string, string[]>();
    for (const [userId, emoji] of Object.entries(reactions)) by.set(emoji, [...(by.get(emoji) ?? []), userId]);
    return [...by.entries()].map(([emoji, userIds]) => ({ emoji, userIds })).sort((a, b) => b.userIds.length - a.userIds.length);
}

/** The pill under a bubble: up to three emoji and the total; opens who reacted. */
export const ReactionChips: React.FC<{ reactions?: Record<string, string>; currentUserId: string; isMe: boolean; onOpen: () => void }> = ({ reactions, currentUserId, isMe, onOpen }) => {
    if (!reactions || Object.keys(reactions).length === 0) return null;
    const groups = grouped(reactions);
    const total = Object.keys(reactions).length;
    const mine = !!reactions[currentUserId];
    return (
        <button
            type="button"
            onClick={onOpen}
            aria-label={`${total} reaction${total === 1 ? '' : 's'}, see who reacted`}
            className={`-mt-2 relative z-[1] flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[13px] leading-none neu-raised-sm active-scale ${isMe ? 'mr-3 self-end' : 'ml-3 self-start'} ${mine ? 'ring-1 ring-gold-500/60' : ''}`}
        >
            {groups.slice(0, 3).map(g => <span key={g.emoji}>{g.emoji}</span>)}
            {total > 1 && <span className="ml-0.5 text-[11px] font-medium text-[var(--neu-text-dim)] tabular-nums">{total}</span>}
        </button>
    );
};

/** A layer over the whole window, outside any transformed parent. */
const Layer: React.FC<{ onClose: () => void; children: React.ReactNode; label: string }> = ({ onClose, children, label }) => {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);
    // Lifting the finger that held a message open lands on this backdrop as
    // a tap and would close the menu at once. Only a tap that also started
    // here (or the keyboard) closes it.
    const pressedHere = useRef(false);
    return createPortal(
        <dialog open className="fixed inset-0 z-[95]" aria-modal="true" aria-label={label}>
            <button type="button" aria-label="Close"
                onPointerDown={() => { pressedHere.current = true; }}
                onClick={e => { if (pressedHere.current || e.detail === 0) onClose(); }}
                className="absolute inset-0 w-full h-full neu-scrim border-none p-0 cursor-default" />
            {children}
        </dialog>,
        document.body,
    );
};

interface MenuProps {
    anchor: DOMRect;
    isMe: boolean;
    myReaction?: string;
    canReact: boolean;
    hasText: boolean;
    /** The held message's words, so it is clear which one the menu is for. */
    preview: string;
    onReact: (emoji: string | null) => void;
    onReply: () => void;
    onCopy: () => void;
    /** Your own messages: who has read it. */
    onInfo?: () => void;
    onClose: () => void;
}

/**
 * The hold menu: the emoji row (tap yours again to take it back; "+" for
 * more) and the actions, placed above the message when there is room,
 * otherwise below it, and always inside the window.
 */
export const MessageActionMenu: React.FC<MenuProps> = ({ anchor, isMe, myReaction, canReact, hasText, preview, onReact, onReply, onCopy, onInfo, onClose }) => {
    const [more, setMore] = useState(false);
    const card = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

    useLayoutEffect(() => {
        const el = card.current;
        if (!el) return;
        const { width, height } = el.getBoundingClientRect();
        const margin = 12;
        const vw = window.innerWidth;
        const vh = window.visualViewport?.height ?? window.innerHeight;
        const above = anchor.top - height - 8;
        const below = anchor.bottom + 8;
        let top = above >= margin ? above : below;
        top = Math.min(Math.max(top, margin), vh - height - margin);
        let left = isMe ? anchor.right - width : anchor.left;
        left = Math.min(Math.max(left, margin), vw - width - margin);
        setPos({ top, left });
    }, [anchor, isMe, more]);

    const pick = (emoji: string) => { onReact(emoji === myReaction ? null : emoji); onClose(); };
    const action = 'w-full flex items-center gap-3 px-4 py-2.5 text-[13px] text-[var(--neu-text)] hover:bg-black/5 dark:hover:bg-white/5 active-scale';

    return (
        <Layer onClose={onClose} label="Message actions">
            <div ref={card} className="absolute neu-modal rounded-2xl overflow-hidden animate-scale-in w-[min(20rem,calc(100vw-24px))]"
                style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }}>
                {preview && (
                    <p className={`mx-3 mt-3 px-3 py-2 rounded-xl text-[12px] leading-snug line-clamp-2 text-[var(--neu-text)] ${isMe ? 'neu-bubble-out' : 'neu-bubble-in'}`}>{preview}</p>
                )}
                {canReact && (
                    <div className="p-2 border-b border-[var(--neu-line)]">
                        <div className="flex items-center justify-between gap-1">
                            {QUICK_REACTIONS.map(emoji => (
                                <button key={emoji} type="button" onClick={() => pick(emoji)} aria-label={`React ${emoji}`} aria-pressed={myReaction === emoji}
                                    className={`w-10 h-10 shrink-0 rounded-full text-[22px] leading-none flex items-center justify-center active-scale transition-transform hover:scale-110 ${myReaction === emoji ? 'neu-inset' : ''}`}>
                                    {emoji}
                                </button>
                            ))}
                            <button type="button" onClick={() => setMore(m => !m)} aria-label={more ? 'Fewer emoji' : 'More emoji'} aria-expanded={more}
                                className="w-9 h-9 shrink-0 rounded-full neu-raised-sm flex items-center justify-center text-[var(--neu-text-dim)] active-scale">
                                {more ? <X size={16} /> : <Plus size={16} />}
                            </button>
                        </div>
                        {more && (
                            <div className="grid grid-cols-6 gap-1 pt-2 mt-2 border-t border-[var(--neu-line)]">
                                {MORE_REACTIONS.map(emoji => (
                                    <button key={emoji} type="button" onClick={() => pick(emoji)} aria-label={`React ${emoji}`} aria-pressed={myReaction === emoji}
                                        className={`h-10 rounded-xl text-[22px] leading-none flex items-center justify-center active-scale ${myReaction === emoji ? 'neu-inset' : ''}`}>
                                        {emoji}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                )}
                <div className="py-1">
                    <button type="button" className={action} onClick={() => { onReply(); onClose(); }}><Reply size={16} className="text-gold-700 dark:text-gold-300" /> Reply</button>
                    {hasText && <button type="button" className={action} onClick={() => { onCopy(); onClose(); }}><Copy size={16} className="text-gold-700 dark:text-gold-300" /> Copy text</button>}
                    {onInfo && <button type="button" className={action} onClick={() => { onInfo(); onClose(); }}><Info size={16} className="text-gold-700 dark:text-gold-300" /> Info · who read it</button>}
                </div>
            </div>
        </Layer>
    );
};

/** A sheet from the bottom on phones, a small centred dialog on a computer. */
const Sheet: React.FC<{ title: string; onClose: () => void; children: React.ReactNode }> = ({ title, onClose, children }) => (
    <Layer onClose={onClose} label={title}>
        <div className="absolute inset-x-0 bottom-0 lg:inset-auto lg:top-1/2 lg:left-1/2 lg:-translate-x-1/2 lg:-translate-y-1/2 lg:w-[26rem]
                        neu-modal rounded-t-3xl lg:rounded-3xl max-h-[75dvh] flex flex-col animate-fade-in-up pb-[var(--safe-bottom,0px)]">
            <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-2">
                <h3 className="text-base font-serif text-[var(--neu-text)]">{title}</h3>
                <button type="button" onClick={onClose} aria-label="Close" className="neu-icon-btn-sm text-[var(--neu-text-dim)] active-scale"><X size={16} /></button>
            </div>
            <div className="overflow-y-auto px-5 pb-5">{children}</div>
        </div>
    </Layer>
);

const Avatar: React.FC<{ name: string }> = ({ name }) => (
    <span className="w-9 h-9 shrink-0 rounded-full neu-inset flex items-center justify-center text-[13px] font-semibold text-gold-700 dark:text-gold-300">
        {name.trim().slice(0, 1).toUpperCase() || '?'}
    </span>
);

/** Who reacted with what; filter by emoji; your own row takes yours back. */
export const ReactionsSheet: React.FC<{
    reactions: Record<string, string>; currentUserId: string;
    resolveName: (id: string | undefined, storedName?: string) => string;
    onRemoveMine: () => void; onClose: () => void;
}> = ({ reactions, currentUserId, resolveName, onRemoveMine, onClose }) => {
    const [filter, setFilter] = useState<string | null>(null);
    const groups = grouped(reactions);
    const rows = Object.entries(reactions)
        .filter(([, emoji]) => !filter || emoji === filter)
        .sort(([a], [b]) => Number(b === currentUserId) - Number(a === currentUserId));
    const tab = (active: boolean) => `shrink-0 rounded-full px-3 py-1.5 text-[13px] ${active ? 'neu-inset text-gold-700 dark:text-gold-300 font-semibold' : 'text-[var(--neu-text-dim)]'}`;
    return (
        <Sheet title="Reactions" onClose={onClose}>
            <div className="flex gap-1 overflow-x-auto pb-3 -mx-1 px-1">
                <button type="button" className={tab(filter === null)} onClick={() => setFilter(null)}>All {Object.keys(reactions).length}</button>
                {groups.map(g => (
                    <button key={g.emoji} type="button" className={tab(filter === g.emoji)} onClick={() => setFilter(g.emoji)}>{g.emoji} {g.userIds.length}</button>
                ))}
            </div>
            <ul className="space-y-1">
                {rows.map(([userId, emoji]) => {
                    const mine = userId === currentUserId;
                    const name = mine ? 'You' : resolveName(userId);
                    const inner = (
                        <>
                            <Avatar name={resolveName(userId)} />
                            <span className="min-w-0 flex-1 text-left">
                                <span className="block text-[14px] text-[var(--neu-text)] truncate">{name}</span>
                                {mine && <span className="block text-[11px] text-[var(--neu-text-dim)]">Tap to remove</span>}
                            </span>
                            <span className="text-[22px] leading-none">{emoji}</span>
                        </>
                    );
                    return (
                        <li key={userId}>
                            {mine
                                ? <button type="button" onClick={() => { onRemoveMine(); onClose(); }} className="w-full flex items-center gap-3 py-2 active-scale">{inner}</button>
                                : <div className="flex items-center gap-3 py-2">{inner}</div>}
                        </li>
                    );
                })}
            </ul>
        </Sheet>
    );
};

const when = (ms: number): string => {
    const d = new Date(ms);
    const today = new Date();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === today.toDateString()) return `Today, ${time}`;
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
    return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
};

/** Your own message: who has read it (latest first) and who hasn't yet. */
export const MessageInfoSheet: React.FC<{
    msg: Message; participantIds: string[];
    resolveName: (id: string | undefined, storedName?: string) => string;
    onClose: () => void;
}> = ({ msg, participantIds, resolveName, onClose }) => {
    const others = othersOf(participantIds, msg.senderId);
    const read = others.filter(id => msg.readBy?.[id]).sort((a, b) => (msg.readBy![b] ?? 0) - (msg.readBy![a] ?? 0));
    const waiting = others.filter(id => !msg.readBy?.[id]);
    const heading = 'text-[11px] font-semibold uppercase tracking-widest text-[var(--neu-text-dim)] mb-2';
    return (
        <Sheet title="Message info" onClose={onClose}>
            <p className="text-[13px] text-[var(--neu-text)] neu-inset rounded-2xl px-3.5 py-2.5 mb-4 line-clamp-3">{msg.text || msg.attachment?.name || ''}</p>
            <h4 className={`${heading} flex items-center gap-1.5`}><CheckCheck size={14} className="text-sky-500 dark:text-sky-400" /> Read by {read.length > 0 && `· ${read.length}`}</h4>
            {read.length === 0
                ? <p className="text-[13px] text-[var(--neu-text-dim)] mb-4">No one yet.</p>
                : (
                    <ul className="space-y-1 mb-4">
                        {read.map(id => (
                            <li key={id} className="flex items-center gap-3 py-1.5">
                                <Avatar name={resolveName(id)} />
                                <span className="min-w-0 flex-1 text-[14px] text-[var(--neu-text)] truncate">{resolveName(id)}</span>
                                <span className="shrink-0 text-[12px] text-[var(--neu-text-dim)]">{when(msg.readBy![id])}</span>
                            </li>
                        ))}
                    </ul>
                )}
            {waiting.length > 0 && (
                <>
                    <h4 className={heading}>Not read yet · {waiting.length}</h4>
                    <ul className="space-y-1">
                        {waiting.map(id => (
                            <li key={id} className="flex items-center gap-3 py-1.5">
                                <Avatar name={resolveName(id)} />
                                <span className="min-w-0 flex-1 text-[14px] text-[var(--neu-text-dim)] truncate">{resolveName(id)}</span>
                            </li>
                        ))}
                    </ul>
                </>
            )}
        </Sheet>
    );
};
