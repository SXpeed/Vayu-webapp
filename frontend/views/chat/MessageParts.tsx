import React, { useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Camera, Loader2, Paperclip, Send, Tag, X } from 'lucide-react';
import storageService, { getThumbUrl } from '../../services/storageService';
import { usePhotoCapture } from '../../hooks/usePhotoCapture';
import type { Message, MessageAttachment, MessageReplyTo, MessageTag } from '../../types';

/** The message bubble and the message bar every chat uses: team chats
 *  (group and one-to-one) and inquiry chats look and type the same. */

export const TAG_COLORS: Record<MessageTag, string> = {
    'General': 'neu-inset text-gray-600 dark:text-gray-400',
    'Urgent': 'neu-inset text-red-600 dark:text-red-400',
    'Follow-up': 'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
    'Artwork': 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400',
    'Inquiry': 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-600 dark:text-yellow-400',
    'Invoice': 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400',
};

export const ALL_TAGS: MessageTag[] = ['General', 'Urgent', 'Follow-up', 'Artwork', 'Inquiry', 'Invoice'];

export const messageTime = (timestamp: number) => new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

type ChatMessage = Pick<Message, 'senderId' | 'text' | 'tags' | 'replyTo' | 'attachment'>;

export const MessageBubble: React.FC<{
    msg: ChatMessage;
    isMe: boolean;
    senderName: string;
    replySenderName: string;
    onOpenImage: () => void;
    /** Bottom-right corner: the time and ticks, or a retry button. */
    meta: React.ReactNode;
}> = ({ msg, isMe, senderName, replySenderName, onOpenImage, meta }) => (
    <div className={`px-3.5 py-2.5 ${isMe ? 'neu-bubble-out' : 'neu-bubble-in'}`}>
        {!isMe && (
            <p className="text-[11px] font-bold uppercase tracking-widest mb-1 text-gold-700 dark:text-gold-300">{senderName}</p>
        )}
        {msg.replyTo && (
            <div className="mb-2 pl-2.5 pr-2 py-1.5 neu-inset rounded-xl border-l-2 border-gold-500">
                <p className="text-[11px] font-bold text-gold-700 dark:text-gold-300">{replySenderName}</p>
                <p className="text-[11px] line-clamp-1 text-[var(--neu-text-dim)]">{msg.replyTo.text}</p>
            </div>
        )}
        {msg.attachment && (
            msg.attachment.type === 'image' ? (
                <button
                    type="button"
                    onClick={onOpenImage}
                    aria-label={`Open photo ${msg.attachment.name}`}
                    className="block mb-2 rounded-xl overflow-hidden active-scale cursor-zoom-in"
                >
                    <img loading="lazy" decoding="async" src={getThumbUrl(msg.attachment.url)} alt={msg.attachment.name} className="rounded-xl max-w-full max-h-48 object-cover" />
                </button>
            ) : (
                <div className="flex items-center gap-2 mb-2 p-2 neu-inset rounded-xl">
                    <Paperclip size={14} className="text-gold-700 dark:text-gold-300" />
                    <span className="text-[11px] truncate">{msg.attachment.name}</span>
                </div>
            )
        )}
        {msg.text && <p className="text-[13px] leading-relaxed">{msg.text}</p>}
        <div className="flex items-center justify-between mt-1.5 gap-2">
            {msg.tags.length > 0 && (
                <div className="flex gap-1 flex-wrap">
                    {msg.tags.map(tag => (
                        <span key={tag} className={`text-[7px] px-1.5 py-0.5 rounded-[3px] font-bold uppercase tracking-wider ${TAG_COLORS[tag]}`}>{tag}</span>
                    ))}
                </div>
            )}
            {meta}
        </div>
    </div>
);

/** The bar under a chat: tags, reply preview, photos/files and the text box.
 *  Give it `key={chat id}` so switching chats starts with an empty bar. */
export const ChatComposer: React.FC<{
    replyingTo: MessageReplyTo | null;
    onCancelReply: () => void;
    /** Several attachments per send (each extra one becomes its own message). */
    multiple?: boolean;
    onSend: (text: string, tags: MessageTag[], attachments: MessageAttachment[]) => void;
}> = ({ replyingTo, onCancelReply, multiple = false, onSend }) => {
    const [text, setText] = useState('');
    const [selectedTags, setSelectedTags] = useState<Set<MessageTag>>(new Set());
    const [showTagPicker, setShowTagPicker] = useState(false);
    const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
    const [uploadingCount, setUploadingCount] = useState(0);
    const isUploading = uploadingCount > 0;
    const fileInputRef = useRef<HTMLInputElement>(null);

    const toggleTag = (tag: MessageTag) => {
        const next = new Set(selectedTags);
        if (next.has(tag)) next.delete(tag);
        else next.add(tag);
        setSelectedTags(next);
    };

    // Files upload to R2: inline data URLs of phone photos exceed D1's row size limit.
    const upload = async (picked: File[]) => {
        const files = multiple ? picked : picked.slice(0, 1);
        setUploadingCount(count => count + files.length);
        const results = await Promise.allSettled(files.map(file => storageService.upload(file)));
        const uploaded: MessageAttachment[] = [];
        results.forEach((result, i) => {
            if (result.status === 'fulfilled') {
                uploaded.push({ type: files[i].type.startsWith('image/') ? 'image' : 'file', url: result.value.url, name: files[i].name });
            } else {
                console.error('Upload failed:', result.reason);
            }
        });
        if (uploaded.length < files.length) toast.error('Upload failed. Please try again.');
        setAttachments(prev => {
            if (multiple) return [...prev, ...uploaded];
            return uploaded.length ? uploaded : prev;
        });
        setUploadingCount(count => count - files.length);
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files ?? []);
        e.target.value = '';
        if (files.length > 0) void upload(files);
    };

    // Camera button: snap a photo and attach it straight away.
    const camera = usePhotoCapture(photos => { void upload(photos); });

    const canSend = !!text.trim() || attachments.length > 0;
    const handleSend = () => {
        if (!canSend) return;
        onSend(text.trim(), Array.from(selectedTags), attachments);
        setText('');
        setSelectedTags(new Set());
        setShowTagPicker(false);
        setAttachments([]);
    };

    return (
        <>
            {showTagPicker && (
                <div className="px-3 py-2 animate-fade-in">
                    <div className="flex gap-1.5 flex-wrap">
                        {ALL_TAGS.map(tag => (
                            <button
                                key={tag}
                                onClick={() => toggleTag(tag)}
                                className={`text-[11px] px-2.5 py-1 rounded-full font-bold uppercase tracking-wider transition-all active-scale ${selectedTags.has(tag)
                                    ? 'neu-raised-sm neu-btn text-gold-700 dark:text-gold-300'
                                    : TAG_COLORS[tag]
                                    }`}
                            >
                                {tag}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* Bottom padding follows the iPhone home indicator so the bar is
                never cropped, even with reply/tag previews stacked */}
            <div className="px-3 pt-[9px] transition-colors" style={{ paddingBottom: 'calc(9px + var(--safe-bottom-tucked))' }}>
                {replyingTo && (
                    <div className="flex items-center justify-between gap-2 mb-2 pl-3 pr-2 py-1.5 neu-raised-sm neu-btn rounded-lg border-l-2 border-gold-500 animate-fade-in">
                        <div className="min-w-0">
                            <p className="text-[11px] font-bold text-gold-700 dark:text-gold-300">Replying to {replyingTo.senderName}</p>
                            <p className="text-[11px] text-gray-700 dark:text-gray-300 truncate">{replyingTo.text}</p>
                        </div>
                        <button onClick={onCancelReply} aria-label="Cancel reply" className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 shrink-0 active-scale">
                            <X size={14} />
                        </button>
                    </div>
                )}
                {(attachments.length > 0 || isUploading) && (
                    <div className="flex items-center gap-2 mb-2 p-2 neu-raised-sm neu-btn rounded-lg animate-fade-in overflow-x-auto no-scrollbar">
                        {attachments.map(attachment => (
                            <div key={attachment.url} className="relative shrink-0">
                                {attachment.type === 'image' ? (
                                    <img loading="lazy" decoding="async" src={getThumbUrl(attachment.url)} alt={attachment.name} className="w-12 h-12 rounded-[4px] object-cover" />
                                ) : (
                                    <div className="w-12 h-12 rounded-[4px] neu-inset flex flex-col items-center justify-center text-gray-700 dark:text-gray-300 px-1">
                                        <Paperclip size={14} />
                                        <span className="text-[7px] truncate w-full text-center mt-0.5">{attachment.name}</span>
                                    </div>
                                )}
                                <button
                                    type="button"
                                    onClick={() => setAttachments(prev => prev.filter(a => a.url !== attachment.url))}
                                    aria-label={`Remove ${attachment.name}`}
                                    className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-black/70 text-white flex items-center justify-center active-scale"
                                >
                                    <X size={9} />
                                </button>
                            </div>
                        ))}
                        {Array.from({ length: uploadingCount }, (_, i) => (
                            <div key={`uploading-${i}`} className="w-12 h-12 rounded-[4px] neu-inset flex items-center justify-center text-gray-400 shrink-0">
                                <Loader2 size={14} className="animate-spin" />
                            </div>
                        ))}
                    </div>
                )}
                {selectedTags.size > 0 && (
                    <div className="flex gap-1 mb-2 flex-wrap">
                        {Array.from(selectedTags).map(tag => (
                            <span key={tag} className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider flex items-center gap-1 ${TAG_COLORS[tag]}`}>
                                {tag}
                                <button onClick={() => toggleTag(tag)} aria-label={`Remove tag ${tag}`} className="hover:opacity-70"><X size={8} /></button>
                            </span>
                        ))}
                    </div>
                )}
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setShowTagPicker(!showTagPicker)}
                        aria-label="Tags"
                        className={`p-2.5 rounded-full transition-colors active-scale shrink-0 ${showTagPicker ? 'neu-raised-sm neu-btn text-gold-700 dark:text-gold-300' : 'text-gray-600 dark:text-gray-300'}`}
                    >
                        <Tag size={18} />
                    </button>
                    <button
                        type="button"
                        onClick={camera.openCamera}
                        disabled={isUploading}
                        aria-label="Take photo"
                        className="neu-icon-btn-lg text-gray-600 dark:text-gray-300 active-scale disabled:opacity-60"
                    >
                        <Camera size={18} />
                    </button>
                    <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isUploading}
                        aria-label="Attach file"
                        className="neu-icon-btn-lg text-gray-600 dark:text-gray-300 active-scale disabled:opacity-60"
                    >
                        {isUploading ? <Loader2 size={18} className="animate-spin" /> : <Paperclip size={18} />}
                    </button>
                    <input type="file" multiple={multiple} accept="image/*,.pdf,.doc,.docx,.txt" ref={fileInputRef} className="hidden" onChange={handleFileChange} />
                    {camera.inputs}
                    {/* A one-line textarea, not an input: Chrome on Android never puts
                        its autofill bar (passwords, cards, addresses) over a textarea. */}
                    <textarea
                        rows={1}
                        value={text}
                        onChange={e => setText(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                        placeholder="Type a message..."
                        enterKeyHint="send"
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        data-form-type="other"
                        data-1p-ignore
                        className="neu-field flex-1 min-w-0 text-xs [field-sizing:content] max-h-28 overflow-y-auto no-scrollbar"
                    />
                    <button
                        onClick={handleSend}
                        disabled={!canSend}
                        aria-label="Send"
                        className={`p-2.5 rounded-full transition-all active-scale shrink-0 ${canSend ? 'neu-accent' : 'bg-gray-200 dark:bg-gray-800 text-gray-600 dark:text-gray-300'}`}
                    >
                        <Send size={18} />
                    </button>
                </div>
            </div>
        </>
    );
};
