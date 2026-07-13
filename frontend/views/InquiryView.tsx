import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Plus, X, MessageSquare, MessageCircle, Send, Search, ArrowLeft, Edit2, Trash2, Phone, Mail, Image as ImageIcon, User, Clock, Tag, BookOpen, CheckCircle2, XCircle, Check, CheckCheck, Paperclip, Reply } from 'lucide-react';
import { Inquiry, Artwork, InquiryMessage, MessageReplyTo, MessageAttachment, MessageTag } from '../types';
import { FullScreenPortal } from '../components/FullScreenPortal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { TAG_COLORS, ALL_TAGS } from './MessagingView';

const renderArtworkStatusColor = (status: string) => {
    if (status === 'Available') return 'bg-green-500';
    if (status === 'Sold') return 'bg-red-500';
    return 'bg-yellow-500';
};

interface InquiryViewProps {
    inquiries: Inquiry[];
    artworks: Artwork[];
    onAddInquiry: (inquiry: Omit<Inquiry, 'id' | 'date'>) => void;
    onUpdateInquiry: (inquiry: Inquiry) => void;
    onDeleteInquiry: (id: string) => void;
    onArtworkClick: (artwork: Artwork) => void;
    inquiryMessages: InquiryMessage[];
    currentUserId: string;

    onSendInquiryMessage: (inquiryId: string, text: string, tags: MessageTag[], replyTo?: MessageReplyTo, attachment?: MessageAttachment) => void;
}

const STATUS_COLORS: Record<Inquiry['status'], string> = {
    'New': 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
    'Contacted': 'bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400',
    'Interested': 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400',
    'Converted': 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400',
    'Closed': 'bg-gray-50 dark:bg-gray-900/20 text-gray-700 dark:text-gray-400',
};

const SOURCE_COLORS: Record<Inquiry['source'], string> = {
    'Walk-in': 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400',
    'Phone': 'bg-sky-50 dark:bg-sky-900/20 text-sky-700 dark:text-sky-400',
    'Email': 'bg-indigo-50 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-400',
    'Social Media': 'bg-pink-50 dark:bg-pink-900/20 text-pink-700 dark:text-pink-400',
    'Referral': 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
    'Other': 'bg-gray-50 dark:bg-gray-900/20 text-gray-700 dark:text-gray-400',
};

export const InquiryView: React.FC<InquiryViewProps> = ({ inquiries, artworks, onAddInquiry, onUpdateInquiry, onDeleteInquiry, onArtworkClick, inquiryMessages, currentUserId, onSendInquiryMessage }) => {
    const [isAdding, setIsAdding] = useState(false);
    const [selectedInquiry, setSelectedInquiry] = useState<Inquiry | null>(null);
    const [chatInquiry, setChatInquiry] = useState<Inquiry | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [filterTab, setFilterTab] = useState<'active' | 'closed' | 'shared'>('active');

    useEffect(() => {
        const handlePopState = (e: PopStateEvent) => {
            if (e.state?.modal !== 'inquiry') {
                setSelectedInquiry(null);
            }
        };
        globalThis.addEventListener('popstate', handlePopState);
        return () => globalThis.removeEventListener('popstate', handlePopState);
    }, []);

    const handleInquiryClick = (inquiry: Inquiry) => {
        setSelectedInquiry(inquiry);
        globalThis.history.pushState({ view: 'inquiry', modal: 'inquiry' }, '');
    };

    const handleCloseModal = () => {
        if (globalThis.history.state?.modal === 'inquiry') {
            globalThis.history.back();
        } else {
            setSelectedInquiry(null);
        }
    };

    const filteredInquiries = useMemo(() => {
        let list = inquiries;

        // Filter by tab
        if (filterTab === 'active') {
            list = list.filter(i => i.status !== 'Closed');
        } else if (filterTab === 'closed') {
            list = list.filter(i => i.status === 'Closed');
        } else {
            list = list.filter(i => i.catalogShared);
        }

        // Filter by search query
        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase();
            list = list.filter(inquiry =>
                inquiry.customerName.toLowerCase().includes(q) ||
                inquiry.inquiryNumber.toLowerCase().includes(q) ||
                inquiry.customerPhone.toLowerCase().includes(q)
            );
        }

        return list;
    }, [inquiries, filterTab, searchQuery]);

    const activeCount = useMemo(() => inquiries.filter(i => i.status !== 'Closed').length, [inquiries]);
    const closedCount = useMemo(() => inquiries.filter(i => i.status === 'Closed').length, [inquiries]);
    const sharedCount = useMemo(() => inquiries.filter(i => i.catalogShared).length, [inquiries]);

    const getFilterTabLabel = () => {
        if (filterTab === 'active') return 'Active';
        if (filterTab === 'closed') return 'Closed';
        return 'Catalog Shared';
    };

    return (
        <div className="h-full flex flex-col bg-[#faf9f6] dark:bg-[#121212] transition-colors duration-500 animate-fade-in">
            <div className="bg-white dark:bg-[#1a1a1a] px-[6px] pt-[calc(1.75rem+env(safe-area-inset-top,0px))] pb-[6px] shadow-sm z-10 border-b border-gray-100 dark:border-gray-800">
                <div className="flex justify-between items-center mb-[6px]">
                    <h1 className="text-xl font-serif text-gray-900 dark:text-white">Inquiry</h1>
                    <button
                        onClick={() => setIsAdding(true)}
                        className="bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 p-1.5 rounded-full shadow-md hover:bg-brand-800 dark:hover:bg-gold-400 transition-colors active-scale"
                    >
                        <Plus size={20} />
                    </button>
                </div>
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 dark:text-gray-500" size={16} />
                    <input
                        type="text"
                        placeholder="Search inquiries..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2 pl-9 pr-4 text-xs text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                    />
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-[6px] space-y-4 no-scrollbar pb-20">
                {/* Filter Buttons */}
                <div className="flex gap-2 animate-fade-in-up" style={{ animationDelay: '50ms' }}>
                    <button
                        onClick={() => setFilterTab('active')}
                        className={`flex-1 py-2.5 rounded-[6px] text-[10px] font-bold uppercase tracking-widest transition-all duration-300 active-scale ${filterTab === 'active'
                            ? 'bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 shadow-sm'
                            : 'bg-white dark:bg-[#1e1e1e] text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'
                            }`}
                    >
                        Active ({activeCount})
                    </button>
                    <button
                        onClick={() => setFilterTab('closed')}
                        className={`flex-1 py-2.5 rounded-[6px] text-[10px] font-bold uppercase tracking-widest transition-all duration-300 active-scale ${filterTab === 'closed'
                            ? 'bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 shadow-sm'
                            : 'bg-white dark:bg-[#1e1e1e] text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'
                            }`}
                    >
                        Closed ({closedCount})
                    </button>
                    <button
                        onClick={() => setFilterTab('shared')}
                        className={`flex-1 py-2.5 rounded-[6px] text-[10px] font-bold uppercase tracking-widest transition-all duration-300 active-scale ${filterTab === 'shared'
                            ? 'bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 shadow-sm'
                            : 'bg-white dark:bg-[#1e1e1e] text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'
                            }`}
                    >
                        Shared ({sharedCount})
                    </button>
                </div>

                <h2 className="text-[10px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest mb-[6px] px-1 animate-fade-in-up" style={{ animationDelay: '100ms' }}>
                    {getFilterTabLabel()} Inquiries
                </h2>

                <div className="space-y-2">
                    {filteredInquiries.map((inquiry, index) => {
                        const coverArtwork = inquiry.artworkIds
                            .map(id => artworks.find(a => a.id === id))
                            .find((a): a is Artwork => !!a);
                        const coverImage = coverArtwork?.imageUrls?.[0];
                        return (
                            <button
                                key={inquiry.id}
                                type="button"
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleInquiryClick(inquiry); }}
                                onClick={() => handleInquiryClick(inquiry)}
                                className={`w-full text-left bg-white dark:bg-[#1e1e1e] rounded-[6px] shadow-sm p-[6px] border animate-fade-in-up cursor-pointer active-scale ${inquiry.status === 'Closed' ? 'border-gray-200 dark:border-gray-800 opacity-70' : 'border-gray-100 dark:border-gray-800'
                                    }`}
                                style={{ animationDelay: `${250 + index * 50}ms` }}
                            >
                                {/* Top Row: Avatar + Name + Status */}
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-[6px]">
                                        {coverImage ? (
                                            <img src={coverImage} alt={inquiry.customerName} className="w-10 h-10 rounded-full object-cover" />
                                        ) : (
                                            <div className="bg-gray-50 dark:bg-gray-800 p-2.5 rounded-full text-brand-900 dark:text-gold-400">
                                                <User size={18} strokeWidth={1.5} />
                                            </div>
                                        )}
                                        <div>
                                            <h3 className="font-serif text-gray-900 dark:text-gray-100 text-sm">{inquiry.customerName}</h3>
                                            <p className="text-[9px] text-gray-500 dark:text-gray-400 uppercase tracking-wider mt-0.5">
                                                {inquiry.inquiryNumber} • {new Date(inquiry.date).toLocaleDateString()}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1.5 shrink-0">
                                        <span className={`text-[8px] px-1.5 py-0.5 rounded-[3px] font-medium uppercase tracking-wider inline-block ${STATUS_COLORS[inquiry.status]}`}>
                                            {inquiry.status}
                                        </span>
                                        <button
                                            type="button"
                                            onClick={(e) => { e.stopPropagation(); setChatInquiry(inquiry); }}
                                            className="p-2 text-gray-400 dark:text-gray-500 hover:text-gold-600 dark:hover:text-gold-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale"
                                        >
                                            <MessageCircle size={18} />
                                        </button>
                                    </div>
                                </div>

                                {/* Details Row */}
                                <div className="mt-2 pt-2 border-t border-gray-50 dark:border-gray-800 space-y-1.5">
                                    {/* Phone & Source & Catalog */}
                                    <div className="flex items-center gap-2 flex-wrap">
                                        {inquiry.customerPhone && (
                                            <span className="text-[9px] text-gray-500 dark:text-gray-400 flex items-center gap-1">
                                                <Phone size={10} /> {inquiry.customerPhone}
                                            </span>
                                        )}
                                        <span className={`text-[8px] px-1.5 py-0.5 rounded-[3px] font-medium uppercase tracking-wider ${SOURCE_COLORS[inquiry.source]}`}>
                                            {inquiry.source}
                                        </span>
                                        {inquiry.catalogShared && (
                                            <span className="text-[8px] px-1.5 py-0.5 rounded-[3px] font-medium uppercase tracking-wider bg-gold-500/10 dark:bg-gold-900/20 text-gold-700 dark:text-gold-400 flex items-center gap-1">
                                                <BookOpen size={9} /> Catalog Sent
                                            </span>
                                        )}
                                    </div>
                                    {/* Notes Preview */}
                                    {inquiry.notes && (
                                        <p className="text-[11px] text-gray-500 dark:text-gray-400 line-clamp-2 leading-relaxed font-light">
                                            {inquiry.notes}
                                        </p>
                                    )}
                                </div>
                            </button>
                        );
                    })}
                    {filteredInquiries.length === 0 && (
                        <div className="text-center text-gray-400 dark:text-gray-500 mt-10 font-light text-sm">
                            {filterTab === 'active' ? 'No active inquiries.' : 'No closed inquiries.'}
                        </div>
                    )}
                </div>
            </div>

            {isAdding && (
                <FullScreenPortal>
                    <InquiryFormModal
                        artworks={artworks}
                        onClose={() => setIsAdding(false)}
                        onSave={(newInq) => {
                            onAddInquiry(newInq);
                            setIsAdding(false);
                        }}
                        onArtworkClick={onArtworkClick}
                    />
                </FullScreenPortal>
            )}

            {selectedInquiry && (
                <FullScreenPortal>
                    <InquiryDetailModal
                        inquiry={selectedInquiry}
                        artworks={artworks}
                        onClose={handleCloseModal}
                        onUpdateInquiry={(updated) => {
                            onUpdateInquiry(updated);
                            setSelectedInquiry(updated);
                        }}
                        onDeleteInquiry={() => {
                            onDeleteInquiry(selectedInquiry.id);
                            setSelectedInquiry(null);
                        }}
                        onArtworkClick={onArtworkClick}
                    />
                </FullScreenPortal>
            )}

            {chatInquiry && (
                <FullScreenPortal>
                    <InquiryChatModal
                        inquiry={chatInquiry}
                        messages={inquiryMessages.filter(m => m.inquiryId === chatInquiry.id)}
                        currentUserId={currentUserId}

                        onClose={() => setChatInquiry(null)}
                        onSendMessage={(text, tags, replyTo, attachment) => onSendInquiryMessage(chatInquiry.id, text, tags, replyTo, attachment)}
                    />
                </FullScreenPortal>
            )}
        </div>
    );
};

// ─── Inquiry Chat Modal (separate from the team Messaging chat) ────────────────────────────────────────

interface InquiryChatModalProps {
    inquiry: Inquiry;
    messages: InquiryMessage[];
    currentUserId: string;

    onClose: () => void;
    onSendMessage: (text: string, tags: MessageTag[], replyTo?: MessageReplyTo, attachment?: MessageAttachment) => void;
}

const InquiryChatModal: React.FC<InquiryChatModalProps> = ({ inquiry, messages, currentUserId, onClose, onSendMessage }) => {
    const [text, setText] = useState('');
    const [selectedTags, setSelectedTags] = useState<Set<MessageTag>>(new Set());
    const [showTagPicker, setShowTagPicker] = useState(false);
    const [replyingTo, setReplyingTo] = useState<MessageReplyTo | null>(null);
    const [pendingAttachment, setPendingAttachment] = useState<MessageAttachment | null>(null);
    const [showSearch, setShowSearch] = useState(false);
    const [chatSearchQuery, setChatSearchQuery] = useState('');
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        setTimeout(() => {
            if (messagesEndRef.current) {
                const container = messagesEndRef.current.parentElement;
                if (container) {
                    container.scrollTop = container.scrollHeight;
                }
            }
        }, 50);
    }, [messages]);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            const reader = new FileReader();
            reader.onloadend = () => {
                if (typeof reader.result === 'string') {
                    setPendingAttachment({
                        type: file.type.startsWith('image/') ? 'image' : 'file',
                        url: reader.result,
                        name: file.name,
                    });
                }
            };
            reader.readAsDataURL(file);
        }
        e.target.value = '';
    };

    const toggleTag = (tag: MessageTag) => {
        const newSet = new Set(selectedTags);
        if (newSet.has(tag)) newSet.delete(tag);
        else newSet.add(tag);
        setSelectedTags(newSet);
    };

    const handleSend = () => {
        if (!text.trim() && !pendingAttachment) return;
        onSendMessage(text.trim(), Array.from(selectedTags), replyingTo || undefined, pendingAttachment || undefined);
        setText('');
        setSelectedTags(new Set());
        setShowTagPicker(false);
        setReplyingTo(null);
        setPendingAttachment(null);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const formatMessageTime = (timestamp: number) => new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const renderMessageStatusIcon = (status?: string) => {
        if (status === 'read') return <CheckCheck size={12} className="text-sky-500 dark:text-sky-400" />;
        if (status === 'delivered') return <CheckCheck size={12} />;
        return <Check size={12} />;
    };

    const displayedMessages = useMemo(() => {
        if (!chatSearchQuery.trim()) return messages;
        const q = chatSearchQuery.toLowerCase();
        return messages.filter(m => m.text.toLowerCase().includes(q));
    }, [messages, chatSearchQuery]);

    return (
        <div className="absolute inset-0 bg-[#faf9f6] dark:bg-[#121212] z-50 flex flex-col animate-fade-in-up">
            <div className="bg-white dark:bg-[#1a1a1a] flex items-center gap-[6px] p-[6px] border-b border-gray-100 dark:border-gray-800 pt-[calc(1.75rem+env(safe-area-inset-top,0px))] shadow-sm z-10">
                <button onClick={onClose} className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale">
                    <ArrowLeft size={20} />
                </button>
                <div className="w-9 h-9 rounded-full bg-gray-50 dark:bg-gray-800 flex items-center justify-center text-brand-900 dark:text-gold-400 shrink-0">
                    <User size={16} strokeWidth={1.5} />
                </div>
                <div className="flex-1 min-w-0">
                    <h2 className="text-sm font-serif text-gray-900 dark:text-white truncate">{inquiry.customerName}</h2>
                    <p className="text-[9px] uppercase tracking-widest font-medium text-gray-400 dark:text-gray-500">{inquiry.inquiryNumber} • Inquiry Chat</p>
                </div>
                <button
                    onClick={() => { setShowSearch(s => !s); setChatSearchQuery(''); }}
                    className={`p-2 rounded-full transition-colors active-scale shrink-0 ${showSearch ? 'bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
                >
                    <Search size={18} />
                </button>
            </div>

            {showSearch && (
                <div className="bg-white dark:bg-[#1a1a1a] border-b border-gray-100 dark:border-gray-800 px-[6px] py-2 animate-fade-in">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500" size={14} />
                        <input
                            value={chatSearchQuery}
                            onChange={(e) => setChatSearchQuery(e.target.value)}
                            placeholder="Search in this chat..."
                            autoFocus
                            className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2 pl-8 pr-8 text-xs text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors"
                        />
                        {chatSearchQuery && (
                            <button onClick={() => setChatSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
                                <X size={14} />
                            </button>
                        )}
                    </div>
                </div>
            )}

            <div className="flex-1 overflow-y-auto p-[6px] space-y-3 no-scrollbar">
                {messages.length === 0 && (
                    <div className="text-center text-gray-400 dark:text-gray-500 mt-10 font-light text-sm">
                        No messages yet for this inquiry.
                    </div>
                )}
                {displayedMessages.length === 0 && chatSearchQuery.trim() && (
                    <div className="text-center text-gray-400 dark:text-gray-500 mt-10 font-light text-sm">
                        No messages match "{chatSearchQuery}".
                    </div>
                )}
                {displayedMessages.map((msg) => {
                    const isMe = msg.senderId === currentUserId;
                    const bubble = (
                        <div className={`max-w-[80%] rounded-[12px] px-3.5 py-2.5 shadow-sm ${isMe
                            ? 'bg-[#FEFFF7] dark:bg-[#2a2a2a] text-gray-900 dark:text-gray-100 border border-[#d2d2d2] dark:border-gray-700 rounded-br-[4px]'
                            : 'bg-white dark:bg-[#1e1e1e] text-gray-900 dark:text-gray-100 border border-[#d2d2d2] dark:border-gray-800 rounded-bl-[4px]'
                            }`}>
                            {!isMe && (
                                <p className="text-[9px] font-bold uppercase tracking-widest mb-1 text-gold-600 dark:text-gold-400">{msg.senderName}</p>
                            )}
                            {msg.replyTo && (
                                <div className={`mb-1.5 pl-2 py-1 border-l-2 rounded-[4px] ${isMe ? 'border-gold-500/50 bg-gold-500/10 dark:border-gray-500/50 dark:bg-gray-700/50' : 'border-gold-400 bg-gray-50 dark:bg-gray-800/50'}`}>
                                    <p className={`text-[9px] font-bold ${isMe ? 'text-gold-700 dark:text-gold-400' : 'text-gold-600 dark:text-gold-400'}`}>{msg.replyTo.senderName}</p>
                                    <p className={`text-[10px] line-clamp-1 ${isMe ? 'text-gray-600 dark:text-gray-400' : 'text-gray-500 dark:text-gray-400'}`}>{msg.replyTo.text}</p>
                                </div>
                            )}
                            {msg.attachment && (
                                msg.attachment.type === 'image' ? (
                                    <img src={msg.attachment.url} alt={msg.attachment.name} className="rounded-[8px] max-w-full max-h-48 object-cover mb-1.5" />
                                ) : (
                                    <div className={`flex items-center gap-2 mb-1.5 p-2 rounded-[6px] ${isMe ? 'bg-gold-500/10 dark:bg-gray-700/50' : 'bg-gray-50 dark:bg-gray-800'}`}>
                                        <Paperclip size={14} className="text-gold-600 dark:text-gold-400" />
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
                                <span className={`flex items-center gap-1 text-[9px] shrink-0 ml-auto ${isMe ? 'text-gray-500 dark:text-gray-500' : 'text-gray-400 dark:text-gray-500'}`}>
                                    {formatMessageTime(msg.timestamp)}
                                    {isMe && renderMessageStatusIcon(msg.status)}
                                </span>
                            </div>
                        </div>
                    );
                    const replyButton = (
                        <button
                            onClick={() => setReplyingTo({ id: msg.id, senderName: msg.senderName, text: msg.text || (msg.attachment ? msg.attachment.name : '') })}
                            className="p-1 mb-1 text-gray-300 dark:text-gray-600 hover:text-gold-500 dark:hover:text-gold-400 transition-colors shrink-0 active-scale"
                        >
                            <Reply size={14} />
                        </button>
                    );
                    return (
                        <div key={msg.id} className={`flex items-end gap-1 ${isMe ? 'justify-end' : 'justify-start'}`}>
                            {!isMe && replyButton}
                            {bubble}
                            {isMe && replyButton}
                        </div>
                    );
                })}
                <div ref={messagesEndRef} />
            </div>

            {/* Tag Picker */}
            {showTagPicker && (
                <div className="px-[6px] py-2 bg-white dark:bg-[#1a1a1a] border-t border-gray-100 dark:border-gray-800 animate-fade-in">
                    <div className="flex gap-1.5 flex-wrap">
                        {ALL_TAGS.map(tag => (
                            <button
                                key={tag}
                                onClick={() => toggleTag(tag)}
                                className={`text-[9px] px-2.5 py-1 rounded-full font-bold uppercase tracking-wider transition-all active-scale ${selectedTags.has(tag)
                                    ? 'bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950'
                                    : TAG_COLORS[tag] + ' border border-gray-200 dark:border-gray-700'
                                    }`}
                            >
                                {tag}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            <div className="bg-white dark:bg-[#1a1a1a] px-[6px] py-[9px] border-t border-gray-100 dark:border-gray-800 transition-colors">
                {selectedTags.size > 0 && (
                    <div className="flex gap-1 mb-2 flex-wrap">
                        {Array.from(selectedTags).map(tag => (
                            <span key={tag} className={`text-[8px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider flex items-center gap-1 ${TAG_COLORS[tag]}`}>
                                {tag}
                                <button onClick={() => toggleTag(tag)} className="hover:opacity-70"><X size={8} /></button>
                            </span>
                        ))}
                    </div>
                )}
                {replyingTo && (
                    <div className="flex items-center justify-between gap-2 mb-2 pl-3 pr-2 py-1.5 bg-gray-100 dark:bg-[#2a2a2a] rounded-[6px] border-l-2 border-gold-500 animate-fade-in">
                        <div className="min-w-0">
                            <p className="text-[9px] font-bold text-gold-600 dark:text-gold-400">Replying to {replyingTo.senderName}</p>
                            <p className="text-[11px] text-gray-500 dark:text-gray-400 truncate">{replyingTo.text}</p>
                        </div>
                        <button onClick={() => setReplyingTo(null)} className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 shrink-0 active-scale">
                            <X size={14} />
                        </button>
                    </div>
                )}
                {pendingAttachment && (
                    <div className="flex items-center justify-between gap-2 mb-2 p-2 bg-gray-100 dark:bg-[#2a2a2a] rounded-[6px] animate-fade-in">
                        <div className="flex items-center gap-2 min-w-0">
                            {pendingAttachment.type === 'image' ? (
                                <img src={pendingAttachment.url} alt={pendingAttachment.name} className="w-10 h-10 rounded-[4px] object-cover shrink-0" />
                            ) : (
                                <div className="w-10 h-10 rounded-[4px] bg-gray-200 dark:bg-gray-700 flex items-center justify-center text-gray-500 dark:text-gray-400 shrink-0">
                                    <Paperclip size={16} />
                                </div>
                            )}
                            <p className="text-[11px] text-gray-600 dark:text-gray-300 truncate">{pendingAttachment.name}</p>
                        </div>
                        <button onClick={() => setPendingAttachment(null)} className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 shrink-0 active-scale">
                            <X size={14} />
                        </button>
                    </div>
                )}
                <div className="flex items-end gap-2">
                    <button
                        onClick={() => setShowTagPicker(!showTagPicker)}
                        className={`p-2.5 rounded-full transition-colors active-scale shrink-0 ${showTagPicker ? 'bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950' : 'text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'
                            }`}
                    >
                        <Tag size={18} />
                    </button>
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        className="p-2.5 rounded-full text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors active-scale shrink-0"
                    >
                        <Paperclip size={18} />
                    </button>
                    <input type="file" accept="image/*,.pdf,.doc,.docx,.txt" ref={fileInputRef} className="hidden" onChange={handleFileChange} />
                    <input
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={handleKeyDown}
                        onFocus={() => {
                            setTimeout(() => {
                                window.scrollTo(0, 0);
                                document.body.scrollTop = 0;
                            }, 50);
                        }}
                        placeholder="Type a message..."
                        className="flex-1 bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-full py-2.5 px-[6px] text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                    />
                    <button
                        onClick={handleSend}
                        disabled={!text.trim() && !pendingAttachment}
                        className={`p-2.5 rounded-full transition-all active-scale shrink-0 ${text.trim() || pendingAttachment
                            ? 'bg-gold-500 dark:bg-gold-500 text-white dark:text-brand-950 shadow-md'
                            : 'bg-gray-200 dark:bg-gray-800 text-gray-400 dark:text-gray-600'
                            }`}
                    >
                        <Send size={18} />
                    </button>
                </div>
            </div>
        </div>
    );
};

// ─── Detail Modal ────────────────────────────────────────

interface InquiryDetailModalProps {
    inquiry: Inquiry;
    artworks: Artwork[];
    onClose: () => void;
    onUpdateInquiry: (inquiry: Inquiry) => void;
    onDeleteInquiry: () => void;
    onArtworkClick: (artwork: Artwork) => void;
}

const InquiryDetailModal: React.FC<InquiryDetailModalProps> = ({ inquiry, artworks, onClose, onUpdateInquiry, onDeleteInquiry, onArtworkClick }) => {
    const [isEditing, setIsEditing] = useState(false);

    const linkedArtworks = inquiry.artworkIds.map(id => artworks.find(a => a.id === id)).filter((a): a is Artwork => !!a);

    const handleSaveEdit = (updatedData: any) => {
        onUpdateInquiry({
            ...updatedData,
            id: inquiry.id,
            date: inquiry.date
        });
        setIsEditing(false);
    };

    const [confirmOpen, setConfirmOpen] = useState(false);

    const handleDelete = () => {
        setConfirmOpen(true);
    };

    const handleToggleStatus = () => {
        const newStatus = inquiry.status === 'Closed' ? 'New' : 'Closed';
        onUpdateInquiry({ ...inquiry, status: newStatus });
    };

    const handleToggleCatalogShared = () => {
        onUpdateInquiry({ ...inquiry, catalogShared: !inquiry.catalogShared });
    };

    return (
        <div className="absolute inset-0 bg-[#faf9f6] dark:bg-[#121212] z-50 flex flex-col animate-fade-in-up">
            <div className="bg-white dark:bg-[#1a1a1a] flex justify-between items-center p-[6px] border-b border-gray-100 dark:border-gray-800 pt-[calc(1.75rem+env(safe-area-inset-top,0px))] shadow-sm z-10">
                <button onClick={onClose} className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full flex items-center gap-2 transition-colors active-scale">
                    <ArrowLeft size={20} />
                </button>
                <h2 className="text-base font-serif text-gray-900 dark:text-white truncate px-[6px]">{inquiry.inquiryNumber}</h2>
                <div className="flex items-center gap-2">
                    <button onClick={() => setIsEditing(true)} className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale">
                        <Edit2 size={18} />
                    </button>
                    <button onClick={handleDelete} className="p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-full transition-colors active-scale">
                        <Trash2 size={18} />
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-[6px] no-scrollbar pb-20">
                {/* Action Buttons - Active/Close & Catalog Shared */}
                <div className="flex gap-[6px] mb-4 animate-fade-in-up" style={{ animationDelay: '50ms' }}>
                    <button
                        onClick={handleToggleStatus}
                        className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-[6px] text-[10px] font-bold uppercase tracking-widest transition-all duration-300 active-scale shadow-sm ${inquiry.status === 'Closed'
                            ? 'bg-green-500 dark:bg-green-600 text-white hover:bg-green-600 dark:hover:bg-green-500'
                            : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-700 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 dark:hover:text-red-400 hover:border-red-300 dark:hover:border-red-700'
                            }`}
                    >
                        {inquiry.status === 'Closed' ? (
                            <>
                                <CheckCircle2 size={16} strokeWidth={2.5} />
                                Reopen Inquiry
                            </>
                        ) : (
                            <>
                                <XCircle size={16} strokeWidth={2.5} />
                                Close Inquiry
                            </>
                        )}
                    </button>

                    <button
                        onClick={handleToggleCatalogShared}
                        className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-[6px] text-[10px] font-bold uppercase tracking-widest transition-all duration-300 active-scale shadow-sm ${inquiry.catalogShared
                            ? 'bg-gold-500 text-white hover:bg-gold-600'
                            : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-700 hover:bg-gold-50 dark:hover:bg-gold-900/15 hover:text-gold-600 dark:hover:text-gold-400 hover:border-gold-300 dark:hover:border-gold-700'
                            }`}
                    >
                        <BookOpen size={16} strokeWidth={2.5} />
                        {inquiry.catalogShared ? 'Catalog Sent ✓' : 'Share Catalog'}
                    </button>
                </div>

                {/* Customer Info Card */}
                <div className="bg-white dark:bg-[#1e1e1e] p-6 rounded-[6px] shadow-sm border border-gray-100 dark:border-gray-800 mb-4 animate-fade-in-up" style={{ animationDelay: '100ms' }}>
                    <div className="flex justify-between items-start mb-6">
                        <div>
                            <h3 className="text-[9px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-widest mb-1">Customer</h3>
                            <p className="font-serif text-lg text-gray-900 dark:text-white">{inquiry.customerName}</p>
                        </div>
                        <div className="text-right">
                            <h3 className="text-[9px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-widest mb-1">Status</h3>
                            <span className={`text-[10px] px-2 py-1 rounded-[3px] font-medium uppercase tracking-wider inline-block ${STATUS_COLORS[inquiry.status]}`}>
                                {inquiry.status}
                            </span>
                        </div>
                    </div>

                    <div className="space-y-3 mb-6">
                        {inquiry.customerPhone && (
                            <div className="flex items-center gap-[6px] text-sm text-gray-600 dark:text-gray-400">
                                <Phone size={14} className="text-gold-500" />
                                <span>{inquiry.customerPhone}</span>
                            </div>
                        )}
                        {inquiry.customerEmail && (
                            <div className="flex items-center gap-[6px] text-sm text-gray-600 dark:text-gray-400">
                                <Mail size={14} className="text-gold-500" />
                                <span>{inquiry.customerEmail}</span>
                            </div>
                        )}
                        <div className="flex items-center gap-[6px] text-sm text-gray-600 dark:text-gray-400">
                            <Tag size={14} className="text-gold-500" />
                            <span className={`text-[10px] px-2 py-0.5 rounded-[3px] font-medium uppercase tracking-wider ${SOURCE_COLORS[inquiry.source]}`}>{inquiry.source}</span>
                        </div>
                        <div className="flex items-center gap-[6px] text-sm text-gray-600 dark:text-gray-400">
                            <Clock size={14} className="text-gold-500" />
                            <span>{new Date(inquiry.date).toLocaleDateString()} at {new Date(inquiry.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                        <div className="flex items-center gap-[6px] text-sm text-gray-600 dark:text-gray-400">
                            <BookOpen size={14} className="text-gold-500" />
                            <span className={`text-[10px] px-2 py-0.5 rounded-[3px] font-medium uppercase tracking-wider ${inquiry.catalogShared
                                ? 'bg-gold-500/10 dark:bg-gold-900/20 text-gold-700 dark:text-gold-400'
                                : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400'
                                }`}>
                                {inquiry.catalogShared ? 'Catalog Shared' : 'Not Shared'}
                            </span>
                        </div>
                    </div>

                    {inquiry.notes && (
                        <>
                            <div className="w-full h-px bg-gray-100 dark:bg-gray-800 mb-4"></div>
                            <h3 className="text-[10px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest mb-2">Notes</h3>
                            <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">{inquiry.notes}</p>
                        </>
                    )}
                </div>

                {/* Interested Artworks */}
                {linkedArtworks.length > 0 && (
                    <div className="bg-white dark:bg-[#1e1e1e] p-6 rounded-[6px] shadow-sm border border-gray-100 dark:border-gray-800 animate-fade-in-up" style={{ animationDelay: '150ms' }}>
                        <h3 className="text-[10px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest mb-4">Interested In ({linkedArtworks.length})</h3>
                        <div className="space-y-3">
                            {linkedArtworks.map((art) => (
                                <div key={art.id} className="flex justify-between items-center">
                                    <div className="flex items-center gap-[6px]">
                                        {art.imageUrls && art.imageUrls.length > 0 ? (
                                            <img src={art.imageUrls[0]} alt={art.title} className="w-10 h-10 rounded-[3px] object-cover" />
                                        ) : (
                                            <div className="w-10 h-10 rounded-[3px] bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-gray-400">
                                                <ImageIcon size={14} />
                                            </div>
                                        )}
                                        <div>
                                            <p className="font-serif text-sm text-gray-900 dark:text-white">{art.title}</p>
                                            <button onClick={() => onArtworkClick(art)} className="text-[9px] text-gold-600 dark:text-gold-400 uppercase tracking-wider hover:underline">
                                                View Details
                                            </button>
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <p className="font-medium text-sm text-gray-900 dark:text-white">₹{art.price.toLocaleString('en-IN')}</p>
                                        <div className={`w-1.5 h-1.5 rounded-full ml-auto mt-1 ${renderArtworkStatusColor(art.status)}`}></div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {isEditing && (
                    <InquiryFormModal
                        initialData={inquiry}
                        artworks={artworks}
                        onClose={() => setIsEditing(false)}
                        onSave={handleSaveEdit}
                        onArtworkClick={onArtworkClick}
                    />
                )}
            </div>

            <ConfirmDialog
                isOpen={confirmOpen}
                title="Delete Inquiry"
                message={`Are you sure you want to delete inquiry "${inquiry.inquiryNumber}"?`}
                onClose={() => setConfirmOpen(false)}
                onConfirm={() => {
                    onDeleteInquiry();
                    setConfirmOpen(false);
                }}
            />
        </div>
    );
};

// ─── Form Modal ────────────────────────────────────────

interface InquiryFormModalProps {
    initialData?: Inquiry;
    artworks: Artwork[];
    onClose: () => void;
    onSave: (inquiry: any) => void;
    onArtworkClick: (artwork: Artwork) => void;
}

const InquiryFormModal: React.FC<InquiryFormModalProps> = ({ initialData, artworks, onClose, onSave, onArtworkClick }) => {
    const [customerName, setCustomerName] = useState(initialData?.customerName || '');
    const [customerPhone, setCustomerPhone] = useState(initialData?.customerPhone || '');
    const [customerEmail, setCustomerEmail] = useState(initialData?.customerEmail || '');
    const [notes, setNotes] = useState(initialData?.notes || '');
    const [source, setSource] = useState<Inquiry['source']>(initialData?.source || 'Walk-in');
    const [status, setStatus] = useState<Inquiry['status']>(initialData?.status || 'New');
    const [catalogShared] = useState(initialData?.catalogShared ?? false);
    const [selectedArtworkIds, setSelectedArtworkIds] = useState<Set<string>>(new Set(initialData?.artworkIds || []));

    const toggleArtwork = (id: string) => {
        const newSet = new Set(selectedArtworkIds);
        if (newSet.has(id)) newSet.delete(id);
        else newSet.add(id);
        setSelectedArtworkIds(newSet);
    };

    const handleSubmit = () => {
        if (!customerName.trim()) return alert('Customer name is required');

        onSave({
            inquiryNumber: initialData?.inquiryNumber || `INQ-${new Date().getFullYear()}-${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`,
            customerName,
            customerPhone,
            customerEmail,
            artworkIds: Array.from(selectedArtworkIds),
            notes,
            source,
            status,
            catalogShared
        });
    };

    return (
        <div className="absolute inset-0 bg-[#faf9f6] dark:bg-[#121212] z-[70] flex flex-col animate-fade-in-up">
            <div className="bg-white dark:bg-[#1a1a1a] flex justify-between items-center p-[6px] border-b border-gray-100 dark:border-gray-800 pt-[calc(1.75rem+env(safe-area-inset-top,0px))] shadow-sm z-10">
                <button onClick={onClose} className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale">
                    <X size={20} />
                </button>
                <h2 className="text-base font-serif text-gray-900 dark:text-white">{initialData ? 'Edit Inquiry' : 'New Inquiry'}</h2>
                <button onClick={handleSubmit} className="text-gold-600 dark:text-gold-400 font-medium px-2 py-2 uppercase tracking-wider text-xs active-scale">
                    Save
                </button>
            </div>

            <div className="flex-1 overflow-y-auto p-[6px] no-scrollbar flex flex-col gap-6">
                {/* Customer Info */}
                <div className="bg-white dark:bg-[#1e1e1e] p-5 rounded-[6px] shadow-sm border border-gray-100 dark:border-gray-800 space-y-5 animate-fade-in-up" style={{ animationDelay: '50ms' }}>
                    <h3 className="font-bold text-gray-900 dark:text-gray-100 text-[10px] uppercase tracking-widest">Customer Details</h3>
                    <div>
                        <label htmlFor="customerName" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Name *</label>
                        <input
                            id="customerName"
                            value={customerName}
                            onChange={e => setCustomerName(e.target.value)}
                            className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors"
                            placeholder="Customer Name"
                        />
                    </div>
                    <div>
                        <label htmlFor="customerPhone" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Phone</label>
                        <input
                            id="customerPhone"
                            type="tel"
                            value={customerPhone}
                            onChange={e => setCustomerPhone(e.target.value)}
                            className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors"
                            placeholder="+91 98765 43210"
                        />
                    </div>
                    <div>
                        <label htmlFor="customerEmail" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Email</label>
                        <input
                            id="customerEmail"
                            type="email"
                            value={customerEmail}
                            onChange={e => setCustomerEmail(e.target.value)}
                            className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors"
                            placeholder="customer@example.com"
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-[6px]">
                        <div>
                            <label htmlFor="inquirySource" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Source</label>
                            <select
                                id="inquirySource"
                                value={source}
                                onChange={e => setSource(e.target.value as Inquiry['source'])}
                                className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors"
                            >
                                <option value="Walk-in" className="dark:bg-gray-800">Walk-in</option>
                                <option value="Phone" className="dark:bg-gray-800">Phone</option>
                                <option value="Email" className="dark:bg-gray-800">Email</option>
                                <option value="Social Media" className="dark:bg-gray-800">Social Media</option>
                                <option value="Referral" className="dark:bg-gray-800">Referral</option>
                                <option value="Other" className="dark:bg-gray-800">Other</option>
                            </select>
                        </div>
                        <div>
                            <label htmlFor="inquiryStatus" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Status</label>
                            <select
                                id="inquiryStatus"
                                value={status}
                                onChange={e => setStatus(e.target.value as Inquiry['status'])}
                                className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors"
                            >
                                <option value="New" className="dark:bg-gray-800">New</option>
                                <option value="Contacted" className="dark:bg-gray-800">Contacted</option>
                                <option value="Interested" className="dark:bg-gray-800">Interested</option>
                                <option value="Converted" className="dark:bg-gray-800">Converted</option>
                                <option value="Closed" className="dark:bg-gray-800">Closed</option>
                            </select>
                        </div>
                    </div>
                </div>

                {/* Notes */}
                <div className="bg-white dark:bg-[#1e1e1e] p-5 rounded-[6px] shadow-sm border border-gray-100 dark:border-gray-800 animate-fade-in-up" style={{ animationDelay: '100ms' }}>
                    <h3 className="font-bold text-gray-900 dark:text-gray-100 text-[10px] uppercase tracking-widest mb-[6px]">Notes</h3>
                    <textarea
                        value={notes}
                        onChange={e => setNotes(e.target.value)}
                        rows={3}
                        className="w-full bg-transparent border border-gray-200 dark:border-gray-700 rounded-[6px] p-[6px] text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors resize-none"
                        placeholder="Add any notes about this inquiry..."
                    />
                </div>

                {/* Select Artworks */}
                <div className="bg-white dark:bg-[#1e1e1e] p-5 rounded-[6px] shadow-sm border border-gray-100 dark:border-gray-800 animate-fade-in-up" style={{ animationDelay: '150ms' }}>
                    <div className="flex justify-between items-center mb-4">
                        <h3 className="font-bold text-gray-900 dark:text-gray-100 text-[10px] uppercase tracking-widest">Interested Artworks</h3>
                        <span className="text-[9px] bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-[3px] text-gray-600 dark:text-gray-300 uppercase tracking-wider">{selectedArtworkIds.size} selected</span>
                    </div>

                    <div className="space-y-2 max-h-60 overflow-y-auto pr-1 no-scrollbar">
                        {artworks.length === 0 && (
                            <p className="text-xs text-gray-400 dark:text-gray-500 font-light">No artworks available.</p>
                        )}
                        {artworks.map((art, index) => {
                            const isSelected = selectedArtworkIds.has(art.id);
                            const coverImage = art.imageUrls?.[0];
                            return (
                                <button
                                    key={art.id}
                                    type="button"
                                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleArtwork(art.id); }}
                                    onClick={() => toggleArtwork(art.id)}
                                    className={`w-full text-left flex items-center p-2 rounded-[6px] border transition-colors cursor-pointer active-scale animate-scale-in ${isSelected ? 'border-gold-500 bg-gold-50/50 dark:bg-gold-900/10' : 'border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50'
                                        }`}
                                    style={{ animationDelay: `${200 + index * 30}ms` }}
                                >
                                    {coverImage ? (
                                        <img src={coverImage} alt={art.title} className="w-10 h-10 rounded-[3px] object-cover mr-3" />
                                    ) : (
                                        <div className="w-10 h-10 rounded-[3px] bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-gray-400 mr-3">
                                            <ImageIcon size={14} />
                                        </div>
                                    )}
                                    <div className="flex-1">
                                        <p className="font-serif text-xs text-gray-900 dark:text-gray-100 line-clamp-1">{art.title}</p>
                                        <p className="text-[9px] text-gray-500 dark:text-gray-400 uppercase tracking-wider mt-0.5">{art.medium} • ₹{art.price.toLocaleString('en-IN')}</p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={(e) => { e.stopPropagation(); onArtworkClick(art); }}
                                            className="p-1 text-gray-400 hover:text-gold-500 transition-colors"
                                        >
                                            <MessageSquare size={14} />
                                        </button>
                                        <div className={`w-4 h-4 rounded-full border flex items-center justify-center transition-colors ${isSelected ? 'bg-gold-500 border-gold-500 text-white' : 'border-gray-300 dark:border-gray-600'
                                            }`}>
                                            {isSelected && <span className="text-[8px] font-bold">✓</span>}
                                        </div>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </div>

                <div className="h-10"></div>
            </div>
        </div>
    );
};
