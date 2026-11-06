// Every photo and file sent in a chat, as on WhatsApp's contact/group info:
// tap the chat's name to open it. Photos open in the full-screen viewer,
// files open the way they do from the bubble.

import React, { useMemo, useState } from 'react';
import { FileText } from 'lucide-react';
import { getThumbUrl } from '../../services/storageService';
import { safeExtension } from '../../fileTypes';
import type { MessageAttachment } from '../../types';
import { Sheet } from './MessageReactions';
import { useOpenFile, messageTime } from './MessageParts';
import { chatDayLabel } from './DayDivider';
import type { ViewedImage } from './ImageViewer';

type WithAttachment = { id: string; senderId: string; senderName: string; timestamp: number; attachment?: MessageAttachment; status?: string };

export const MediaSheet: React.FC<{
    messages: readonly WithAttachment[];
    currentUserId: string;
    resolveName: (id: string | undefined, storedName?: string) => string;
    onOpenImage: (image: ViewedImage) => void;
    onClose: () => void;
}> = ({ messages, currentUserId, resolveName, onOpenImage, onClose }) => {
    const [tab, setTab] = useState<'image' | 'file'>('image');
    const file = useOpenFile();
    // Newest first; a failed send never reached anyone.
    const items = useMemo(() => messages.filter(m => m.attachment && m.status !== 'failed').sort((a, b) => b.timestamp - a.timestamp), [messages]);
    const shown = items.filter(m => m.attachment!.type === tab);
    const caption = (m: WithAttachment) => `${m.senderId === currentUserId ? 'You' : resolveName(m.senderId, m.senderName)} · ${chatDayLabel(m.timestamp)}, ${messageTime(m.timestamp)}`;
    const tabClass = (on: boolean) => `flex-1 py-2 rounded-xl text-[12px] font-semibold uppercase tracking-wider ${on ? 'neu-raised-sm text-gold-700 dark:text-gold-300' : 'text-[var(--neu-text-dim)]'}`;

    return (
        <Sheet title="Media & docs" onClose={onClose}>
            {file.viewer}
            <div className="flex gap-2 mb-4" role="tablist" aria-label="Media or docs">
                <button type="button" role="tab" aria-selected={tab === 'image'} onClick={() => setTab('image')} className={tabClass(tab === 'image')}>
                    Media · {items.filter(m => m.attachment!.type === 'image').length}
                </button>
                <button type="button" role="tab" aria-selected={tab === 'file'} onClick={() => setTab('file')} className={tabClass(tab === 'file')}>
                    Docs · {items.filter(m => m.attachment!.type === 'file').length}
                </button>
            </div>
            {shown.length === 0 && <p className="text-[13px] text-center text-[var(--neu-text-dim)] py-8">{tab === 'image' ? 'No photos in this chat yet.' : 'No files in this chat yet.'}</p>}
            {tab === 'image' ? (
                <div className="grid grid-cols-3 gap-1.5">
                    {shown.map(m => (
                        <button key={m.id} type="button" aria-label={`Open photo ${m.attachment!.name}`}
                            onClick={() => onOpenImage({ url: m.attachment!.url, name: m.attachment!.name, caption: caption(m) })}
                            className="aspect-square rounded-lg overflow-hidden neu-inset active-scale">
                            <img loading="lazy" decoding="async" src={getThumbUrl(m.attachment!.url)} alt={m.attachment!.name} className="w-full h-full object-cover" />
                        </button>
                    ))}
                </div>
            ) : (
                <ul className="space-y-1.5">
                    {shown.map(m => (
                        <li key={m.id}>
                            <button type="button" onClick={() => file.open(m.attachment!)} aria-label={`Open ${m.attachment!.name}`}
                                className="w-full neu-raised-sm neu-btn rounded-xl px-3 py-2.5 flex items-center gap-3 text-left">
                                <FileText size={18} className="shrink-0 text-gold-600 dark:text-gold-400" />
                                <span className="min-w-0 flex-1">
                                    <span className="block text-[13px] text-[var(--neu-text)] truncate">{m.attachment!.name}</span>
                                    <span className="block text-[11px] text-[var(--neu-text-dim)] truncate">{safeExtension(m.attachment!.name).toUpperCase() || 'File'} · {caption(m)}</span>
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </Sheet>
    );
};
