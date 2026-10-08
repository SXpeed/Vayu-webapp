import { getThumbUrl } from '../services/storageService';
import React, { useState, useMemo, useRef, useEffect } from 'react';
import toast from 'react-hot-toast';
import { Plus, X, MessageCircle, Search, ArrowLeft, Edit2, Trash2, Phone, Mail, Image as ImageIcon, User, Clock, Tag, BookOpen, CheckCircle2, XCircle, Check, CheckCheck, Reply, Camera, MapPin, FileText, MailWarning } from 'lucide-react';
import { SearchBar } from '../components/SearchBar';
import { ArtworkPicker } from '../components/ArtworkPicker';
import { PageRoot, PageHeader, PageBody, PrimaryIconButton } from '../components/ui';
import { Inquiry, Artwork, InquiryMessage, MessageReplyTo, MessageAttachment, MessageTag, UserProfile, Invoice, Contact } from '../types';
import { contactWithKey, emailKey, phoneKey } from '../contactKeys';
import { inquiryService } from '../services/inquiryService';
import { FullScreenPortal } from '../components/FullScreenPortal';
import { TypeDeleteDialog } from '../components/TypeDeleteDialog';
import { useStickToBottom } from '../hooks/useStickToBottom';
import { useMemberNames } from '../hooks/useMemberNames';
import { PhotoAttachments } from '../components/PhotoAttachments';
import { makeDocumentNumber } from '../services/documentNumber';
import { exportProformaPdf } from '../services/proformaPdf';
import { InvoiceFormModal, ProformaPdfActions, type NewInvoice } from './InvoiceView';
import { IfCan } from '../components/Layout';
import { useInbox } from '../hooks/useInbox';
import { chatDayLabel, withDayDividers } from './chat/DayDivider';
import { ImageViewer, type ViewedImage } from './chat/ImageViewer';
import { ChatComposer, MessageBubble, messageTime } from './chat/MessageParts';

const renderArtworkStatusColor = (status: string) => {
    if (status === 'Available') return 'bg-green-500';
    if (status === 'Sold') return 'bg-red-500';
    return 'bg-yellow-500';
};

// lucide has no WhatsApp brand icon — inline glyph, colored via currentColor.
const WhatsAppIcon: React.FC<{ size?: number; className?: string }> = ({ size = 14, className }) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" className={className} aria-hidden="true">
        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
    </svg>
);

/** tel: link — keeps digits and a leading +. */
const telHref = (phone: string) => `tel:${phone.replaceAll(/[^\d+]/g, '')}`;
/** WhatsApp deep link — wa.me wants digits only (country code included). */
const waHref = (phone: string) => `https://wa.me/${phone.replaceAll(/\D/g, '')}`;

interface InquiryViewProps {
    inquiries: Inquiry[];
    artworks: Artwork[];
    onAddInquiry: (inquiry: Omit<Inquiry, 'id' | 'date'>) => void;
    onUpdateInquiry: (inquiry: Inquiry) => void;
    onDeleteInquiry: (id: string) => void;
    onArtworkClick: (artwork: Artwork) => void;
    inquiryMessages: InquiryMessage[];
    invoices: Invoice[];
    onAddInvoice: (invoice: NewInvoice) => Promise<Invoice>;
    teamMembers: UserProfile[];
    currentUserId: string;

    onSendInquiryMessage: (inquiryId: string, text: string, tags: MessageTag[], replyTo?: MessageReplyTo, attachment?: MessageAttachment) => void;
    /** An inquiry to open (a notification was tapped): its chat, or its details. */
    openInquiry?: { id: string; chat: boolean };
    onOpenedInquiry?: () => void;
    /** Saved contacts: the form suggests one as a phone or email is typed. */
    contacts: Contact[];
}

const STATUS_COLORS: Record<Inquiry['status'], string> = {
    'New': 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
    'Contacted': 'bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400',
    'Interested': 'neu-status text-yellow-700 dark:text-yellow-400',
    'Converted': 'neu-status text-green-700 dark:text-green-400',
    'Closed': 'neu-status text-gray-700 dark:text-gray-400',
};

const SOURCE_COLORS: Record<Inquiry['source'], string> = {
    'Walk-in': 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400',
    'Phone': 'bg-sky-50 dark:bg-sky-900/20 text-sky-700 dark:text-sky-400',
    'Email': 'bg-indigo-50 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-400',
    'Social Media': 'bg-pink-50 dark:bg-pink-900/20 text-pink-700 dark:text-pink-400',
    'Referral': 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
    'Private room': 'bg-gold-500/10 dark:bg-gold-900/20 text-gold-700 dark:text-gold-300',
    'Other': 'neu-status text-gray-700 dark:text-gray-400',
};

const ARTWORK_STATUS_BADGE: Record<Artwork['status'], string> = {
    'Available': 'neu-status text-green-700 dark:text-green-400',
    'Sold': 'neu-status text-red-700 dark:text-red-400',
    'Reserved': 'neu-status text-yellow-700 dark:text-yellow-400',
};

export const InquiryView: React.FC<InquiryViewProps> = ({ inquiries, artworks, onAddInquiry, onUpdateInquiry, onDeleteInquiry, onArtworkClick, inquiryMessages, invoices, onAddInvoice, teamMembers, currentUserId, onSendInquiryMessage, openInquiry, onOpenedInquiry, contacts }) => {
    const resolveName = useMemberNames(teamMembers);
    // Inquiries added before creator tracking have no creator recorded.
    const addedBy = (inquiry: Inquiry) =>
        inquiry.createdBy || inquiry.createdByName ? resolveName(inquiry.createdBy, inquiry.createdByName) : null;
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

    // A tapped notification's inquiry opens as soon as it is here.
    useEffect(() => {
        if (!openInquiry) return;
        const inquiry = inquiries.find(i => i.id === openInquiry.id);
        if (!inquiry) return;
        if (openInquiry.chat) setChatInquiry(inquiry);
        else handleInquiryClick(inquiry);
        onOpenedInquiry?.();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [openInquiry, inquiries]);

    // Read only once its details or chat are actually on screen, never by
    // opening the list. While it stays open (and the tab is in view), a new
    // message on it is read at once, as in a chat app.
    const { unreadInquiryIds, setInquiryRead } = useInbox();
    const onScreenId = selectedInquiry?.id ?? chatInquiry?.id;
    useEffect(() => {
        if (onScreenId && unreadInquiryIds.has(onScreenId) && document.visibilityState === 'visible') setInquiryRead(onScreenId, true);
    }, [onScreenId, unreadInquiryIds, setInquiryRead]);

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

    return (
        <PageRoot>
            <PageHeader
                title="Inquiry"
                actions={<IfCan section="inquiries"><PrimaryIconButton onClick={() => setIsAdding(true)} label="New inquiry" icon={<Plus size={16} />} /></IfCan>}
            >
                <SearchBar value={searchQuery} onChange={setSearchQuery} placeholder="Search inquiries..." />
            </PageHeader>

            <PageBody space="md">
                {/* Filter Buttons */}
                <div className="flex gap-2 lg:w-fit animate-fade-in-up" style={{ animationDelay: '50ms' }}>
                    <button
                        onClick={() => setFilterTab('active')}
                        className={`flex-1 lg:flex-none lg:px-6 py-2 rounded-full text-[11px] font-bold uppercase tracking-widest transition-colors active-scale ${filterTab === 'active'
                            ? 'neu-inset text-gold-700 dark:text-gold-300'
                            : 'neu-raised-sm neu-btn text-gray-700 dark:text-gray-300'
                            }`}
                    >
                        Active ({activeCount})
                    </button>
                    <button
                        onClick={() => setFilterTab('closed')}
                        className={`flex-1 lg:flex-none lg:px-6 py-2 rounded-full text-[11px] font-bold uppercase tracking-widest transition-colors active-scale ${filterTab === 'closed'
                            ? 'neu-inset text-gold-700 dark:text-gold-300'
                            : 'neu-raised-sm neu-btn text-gray-700 dark:text-gray-300'
                            }`}
                    >
                        Closed ({closedCount})
                    </button>
                    <button
                        onClick={() => setFilterTab('shared')}
                        className={`flex-1 lg:flex-none lg:px-6 py-2 rounded-full text-[11px] font-bold uppercase tracking-widest transition-colors active-scale ${filterTab === 'shared'
                            ? 'neu-inset text-gold-700 dark:text-gold-300'
                            : 'neu-raised-sm neu-btn text-gray-700 dark:text-gray-300'
                            }`}
                    >
                        Shared ({sharedCount})
                    </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2 md:space-y-0">
                    {filteredInquiries.map((inquiry, index) => {
                        const coverArtwork = inquiry.artworkIds
                            .map(id => artworks.find(a => a.id === id))
                            .find((a): a is Artwork => !!a);
                        const coverImage = coverArtwork?.imageUrls?.[0] ?? inquiry.imageUrls?.[0];
                        const photoCount = inquiry.imageUrls?.length ?? 0;
                        const unread = unreadInquiryIds.has(inquiry.id);
                        return (
                            <div
                                key={inquiry.id}
                                className={`relative w-full text-left neu-raised rounded-2xl p-3 border animate-fade-in-up active-scale ${inquiry.status === 'Closed' ? 'border-gray-200 dark:border-gray-800 opacity-70' : 'border-gray-100 dark:border-gray-800'
                                    }`}
                                style={{ animationDelay: `${250 + index * 50}ms` }}
                            >
                                {/* Whole-card tap target behind the content. The content ignores
                                    pointer events except the chat button and contact links, so
                                    no interactive element is nested inside another. */}
                                <button
                                    type="button"
                                    onClick={() => handleInquiryClick(inquiry)}
                                    className="absolute inset-0 w-full h-full rounded-lg cursor-pointer"
                                    aria-label={`Open ${unread ? 'unread ' : ''}inquiry ${inquiry.inquiryNumber} for ${inquiry.customerName}`}
                                />
                                <div className="relative pointer-events-none">
                                {/* Top Row: Avatar + Name + Status */}
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        {coverImage ? (
                                            <img loading="lazy" decoding="async" src={getThumbUrl(coverImage)} alt={inquiry.customerName} className="w-10 h-10 rounded-full object-cover" />
                                        ) : (
                                            <div className="neu-inset p-2.5 rounded-full text-brand-900 dark:text-gold-400">
                                                <User size={18} strokeWidth={1.5} />
                                            </div>
                                        )}
                                        <div>
                                            <h3 className={`font-serif text-gray-900 dark:text-gray-100 text-sm flex items-center gap-1.5 ${unread ? 'font-semibold' : ''}`}>
                                                {unread && <span aria-hidden="true" className="w-2 h-2 rounded-full bg-gold-600 dark:bg-gold-400 shrink-0" />}
                                                {inquiry.customerName}
                                            </h3>
                                            <p className="text-[11px] text-gray-700 dark:text-gray-300 uppercase tracking-wider mt-0.5">
                                                {inquiry.inquiryNumber} • {new Date(inquiry.date).toLocaleDateString()}
                                            </p>
                                            {addedBy(inquiry) && (
                                                <p className="text-[11px] text-gray-700 dark:text-gray-300 mt-0.5">
                                                    Added by <span className="font-medium text-gray-700 dark:text-gray-300">{addedBy(inquiry)}</span>
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1.5 shrink-0">
                                        <span className={`text-[10px] px-1.5 py-0.5 rounded-[3px] font-medium uppercase tracking-wider inline-block ${STATUS_COLORS[inquiry.status]}`}>
                                            {inquiry.status}
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => setChatInquiry(inquiry)}
                                            aria-label={`Open chat for ${inquiry.customerName}`}
                                            className="pointer-events-auto neu-icon-btn text-gray-600 dark:text-gray-300 active-scale"
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
                                            <span className="text-[11px] text-gray-700 dark:text-gray-300 flex items-center gap-1">
                                                <a
                                                    href={telHref(inquiry.customerPhone)}
                                                    className="pointer-events-auto flex items-center gap-1 hover:text-gold-600 dark:hover:text-gold-400 active-scale"
                                                    aria-label={`Call ${inquiry.customerPhone}`}
                                                >
                                                    <Phone size={10} /> {inquiry.customerPhone}
                                                </a>
                                                <a
                                                    href={waHref(inquiry.customerPhone)}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="pointer-events-auto text-green-600 dark:text-green-400 active-scale"
                                                    aria-label="Chat on WhatsApp"
                                                >
                                                    <WhatsAppIcon size={11} />
                                                </a>
                                            </span>
                                        )}
                                        <span className={`text-[10px] px-1.5 py-0.5 rounded-[3px] font-medium uppercase tracking-wider ${SOURCE_COLORS[inquiry.source]}`}>
                                            {inquiry.source}
                                        </span>
                                        {inquiry.catalogShared && (
                                            <span className="text-[10px] px-1.5 py-0.5 rounded-[3px] font-medium uppercase tracking-wider bg-gold-500/10 dark:bg-gold-900/20 text-gold-700 dark:text-gold-400 flex items-center gap-1">
                                                <BookOpen size={9} /> Catalog Sent
                                            </span>
                                        )}
                                        {photoCount > 0 && (
                                            <span className="text-[10px] px-1.5 py-0.5 rounded-[3px] font-medium uppercase tracking-wider neu-inset text-gray-600 dark:text-gray-300 flex items-center gap-1">
                                                <Camera size={9} /> {photoCount}
                                            </span>
                                        )}
                                    </div>
                                    {/* Notes Preview */}
                                    {inquiry.notes && (
                                        <p className="text-[11px] text-gray-700 dark:text-gray-300 line-clamp-2 leading-relaxed font-light">
                                            {inquiry.notes}
                                        </p>
                                    )}
                                </div>
                                </div>
                            </div>
                        );
                    })}
                    {filteredInquiries.length === 0 && (
                        <div className="text-center text-gray-600 dark:text-gray-300 mt-10 font-light text-sm">
                            {filterTab === 'active' ? 'No active inquiries.' : 'No closed inquiries.'}
                        </div>
                    )}
                </div>

            {isAdding && (
                <FullScreenPortal>
                    <InquiryFormModal
                        artworks={artworks}
                        contacts={contacts}
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
                        contacts={contacts}
                        addedBy={addedBy(selectedInquiry)}
                        artworks={artworks}
                        proformas={invoices.filter(inv => inv.inquiryId === selectedInquiry.id)}
                        onAddInvoice={onAddInvoice}
                        onClose={handleCloseModal}
                        onMarkUnread={() => {
                            // Off screen in the same render, or it would be read again at once.
                            const id = selectedInquiry.id;
                            setSelectedInquiry(null);
                            if (globalThis.history.state?.modal === 'inquiry') globalThis.history.back();
                            setInquiryRead(id, false);
                        }}
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
                        resolveName={resolveName}
                        currentUserId={currentUserId}

                        onClose={() => setChatInquiry(null)}
                        onSendMessage={(text, tags, replyTo, attachment) => onSendInquiryMessage(chatInquiry.id, text, tags, replyTo, attachment)}
                    />
                </FullScreenPortal>
            )}
        </PageBody>
        </PageRoot>
    );
};

// ─── Inquiry Chat Modal (separate from the team Messaging chat) ────────────────────────────────────────

interface InquiryChatModalProps {
    inquiry: Inquiry;
    messages: InquiryMessage[];
    resolveName: (id: string | undefined, storedName?: string) => string;
    currentUserId: string;

    onClose: () => void;
    onSendMessage: (text: string, tags: MessageTag[], replyTo?: MessageReplyTo, attachment?: MessageAttachment) => void | Promise<void>;
}

const InquiryChatModal: React.FC<InquiryChatModalProps> = ({ inquiry, messages, resolveName, currentUserId, onClose, onSendMessage }) => {
    // Quoted replies store the sender's name at reply time; resolve it through
    // the original message so placeholders and renames show correctly.
    const replySenderName = (replyTo: MessageReplyTo) => {
        const original = messages.find(m => m.id === replyTo.id);
        return original ? resolveName(original.senderId, original.senderName) : resolveName(undefined, replyTo.senderName);
    };
    const [replyingTo, setReplyingTo] = useState<MessageReplyTo | null>(null);
    const [showSearch, setShowSearch] = useState(false);
    const [chatSearchQuery, setChatSearchQuery] = useState('');
    /** A photo opened full screen from a message. */
    const [viewing, setViewing] = useState<ViewedImage | null>(null);
    // Opens on the latest message and stays there through late photos, syncing
    // messages and the keyboard — unless the reader scrolls up into history.
    const { scrollerRef, contentRef, scrollToLatest } = useStickToBottom(inquiry.id);

    const handleSend = (text: string, tags: MessageTag[], attachments: MessageAttachment[]) => {
        const [first, ...rest] = attachments;
        const replyTo = replyingTo ?? undefined;
        scrollToLatest();
        setReplyingTo(null);
        // The text (and first attachment) goes as one message; each extra photo
        // follows as its own message, sent in order.
        void (async () => {
            await onSendMessage(text, tags, replyTo, first);
            for (const attachment of rest) {
                await onSendMessage('', tags, undefined, attachment);
            }
        })();
    };

    const statusIcon = (status?: string) => {
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
        <div className="neu-sheet z-50 animate-fade-in-up">
            <div className="flex items-center gap-3 p-3 pt-[calc(1.75rem+var(--safe-top))] z-10">
                <button onClick={onClose} className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale" aria-label="Back">
                    <ArrowLeft size={20} />
                </button>
                <div className="w-9 h-9 rounded-full neu-inset flex items-center justify-center text-brand-900 dark:text-gold-400 shrink-0">
                    <User size={16} strokeWidth={1.5} />
                </div>
                <div className="flex-1 min-w-0">
                    <h2 className="text-sm font-serif text-gray-900 dark:text-white truncate">{inquiry.customerName}</h2>
                    <p className="text-[11px] uppercase tracking-widest font-medium text-gray-600 dark:text-gray-300">{inquiry.inquiryNumber} • Inquiry Chat</p>
                </div>
                <button
                    onClick={() => { setShowSearch(s => !s); setChatSearchQuery(''); }}
                    aria-label="Search in this chat"
                    className={`p-2 rounded-full transition-colors active-scale shrink-0 ${showSearch ? 'neu-raised-sm neu-btn text-gold-700 dark:text-gold-300' : 'text-gray-700 dark:text-gray-300'}`}
                >
                    <Search size={18} />
                </button>
            </div>

            {showSearch && (
                <div className="px-3 py-2 animate-fade-in">
                    <SearchBar value={chatSearchQuery} onChange={setChatSearchQuery} placeholder="Search in this chat..." />
                </div>
            )}

            <div ref={scrollerRef} className="flex-1 overflow-y-auto overscroll-contain p-4 md:p-6 no-scrollbar neu-scroll-fade w-full lg:max-w-5xl lg:mx-auto">
                <div ref={contentRef} className="space-y-3.5">
                    {messages.length === 0 && (
                        <div className="text-center text-gray-600 dark:text-gray-300 mt-10 font-light text-sm">
                            No messages yet for this inquiry.
                        </div>
                    )}
                    {displayedMessages.length === 0 && chatSearchQuery.trim() && (
                        <div className="text-center text-gray-600 dark:text-gray-300 mt-10 font-light text-sm">
                            No messages match "{chatSearchQuery}".
                        </div>
                    )}
                    {withDayDividers(displayedMessages, (msg) => {
                        const isMe = msg.senderId === currentUserId;
                        const senderName = resolveName(msg.senderId, msg.senderName);
                        const replyButton = (
                            <button
                                onClick={() => setReplyingTo({ id: msg.id, senderName, text: msg.text || (msg.attachment ? msg.attachment.name : '') })}
                                aria-label="Reply"
                                className="p-1.5 mb-1 text-[var(--neu-text-dim)] hover:text-gold-600 dark:hover:text-gold-400 transition-colors shrink-0 active-scale"
                            >
                                <Reply size={14} />
                            </button>
                        );
                        return (
                            <div key={msg.id} className={`flex items-end gap-1.5 ${isMe ? 'justify-end' : 'justify-start'}`}>
                                {!isMe && replyButton}
                                <div className="max-w-[80%] min-w-0">
                                    <MessageBubble
                                        msg={msg}
                                        isMe={isMe}
                                        senderName={senderName}
                                        replySenderName={msg.replyTo ? replySenderName(msg.replyTo) : ''}
                                        onOpenImage={() => msg.attachment && setViewing({ url: msg.attachment.url, name: msg.attachment.name, caption: `${isMe ? 'You' : senderName} · ${chatDayLabel(msg.timestamp)}, ${messageTime(msg.timestamp)}` })}
                                        meta={(
                                            <span className="flex items-center gap-1 text-[11px] shrink-0 ml-auto text-[var(--neu-text-dim)]">
                                                {messageTime(msg.timestamp)}
                                                {isMe && statusIcon(msg.status)}
                                            </span>
                                        )}
                                    />
                                </div>
                                {isMe && replyButton}
                            </div>
                        );
                    })}
                </div>
            </div>

            <ChatComposer key={inquiry.id} multiple replyingTo={replyingTo} onCancelReply={() => setReplyingTo(null)} onSend={handleSend} />

            {viewing && <ImageViewer image={viewing} onClose={() => setViewing(null)} />}
        </div>
    );
};

// ─── Detail Modal ────────────────────────────────────────

interface InquiryDetailModalProps {
    inquiry: Inquiry;
    addedBy: string | null;
    artworks: Artwork[];
    /** Proforma invoices generated from this inquiry. */
    proformas: Invoice[];
    onAddInvoice: (invoice: NewInvoice) => Promise<Invoice>;
    contacts: Contact[];
    onClose: () => void;
    onMarkUnread: () => void;
    onUpdateInquiry: (inquiry: Inquiry) => void;
    onDeleteInquiry: () => void;
    onArtworkClick: (artwork: Artwork) => void;
}

const InquiryDetailModal: React.FC<InquiryDetailModalProps> = ({ inquiry, contacts, addedBy, artworks, proformas, onAddInvoice, onClose, onMarkUnread, onUpdateInquiry, onDeleteInquiry, onArtworkClick }) => {
    const [isEditing, setIsEditing] = useState(false);
    const [isCreatingProforma, setIsCreatingProforma] = useState(false);
    const [selectedArtworkForPopup, setSelectedArtworkForPopup] = useState<Artwork | null>(null);

    const linkedArtworks = inquiry.artworkIds.map(id => artworks.find(a => a.id === id)).filter((a): a is Artwork => !!a);

    const handleSaveEdit = (updatedData: any) => {
        onUpdateInquiry({
            ...updatedData,
            id: inquiry.id,
            date: inquiry.date,
            createdBy: inquiry.createdBy,
            createdByName: inquiry.createdByName,
        });
        setIsEditing(false);
    };

    const handleToggleStatus = () => {
        const newStatus = inquiry.status === 'Closed' ? 'New' : 'Closed';
        onUpdateInquiry({ ...inquiry, status: newStatus });
    };

    const handleToggleCatalogShared = () => {
        onUpdateInquiry({ ...inquiry, catalogShared: !inquiry.catalogShared });
    };

    // Save the proforma, then hand over the PDF (with artwork images) right away.
    const handleCreateProforma = async (data: NewInvoice) => {
        const created = await onAddInvoice(data);
        setIsCreatingProforma(false);
        toast.success(`Proforma ${created.invoiceNumber} created`);
        try {
            await exportProformaPdf(created, artworks);
        } catch (e) {
            console.error('Proforma PDF failed:', e);
            toast.error('Saved, but the PDF could not be created. Use the PDF button to retry.');
        }
    };

    // Uploads can finish after other edits (or each other), so append to the
    // latest inquiry rather than the one captured when the upload started.
    const latestInquiryRef = useRef(inquiry);
    latestInquiryRef.current = inquiry;
    const handleAddPhotos = (urls: string[]) => {
        const latest = latestInquiryRef.current;
        const updated = { ...latest, imageUrls: [...(latest.imageUrls ?? []), ...urls] };
        latestInquiryRef.current = updated;
        onUpdateInquiry(updated);
    };

    return (
        <div className="neu-sheet z-50 animate-fade-in-up">
            <div className="flex justify-between items-center p-3 pt-[calc(1.75rem+var(--safe-top))] z-10">
                <button onClick={onClose} className="neu-icon-btn w-auto px-3 gap-2 text-gray-700 dark:text-gray-300 active-scale">
                    <ArrowLeft size={20} />
                </button>
                <h2 className="text-base font-serif text-gray-900 dark:text-white truncate px-3">{inquiry.inquiryNumber}</h2>
                <div className="flex items-center gap-2">
                    <button onClick={onMarkUnread} aria-label="Mark unread" title="Mark unread" className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale">
                        <MailWarning size={18} />
                    </button>
                    <IfCan section="inquiries">
                        <button onClick={() => setIsEditing(true)} className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale">
                            <Edit2 size={18} />
                        </button>
                    </IfCan>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 lg:p-6 no-scrollbar pb-20 lg:pb-8">
                {/* Action row — Close / Share / Proforma (catalog pill style, single line) */}
                <div className="flex gap-1.5 mb-4 animate-fade-in-up" style={{ animationDelay: '50ms' }}>
                    <button
                        onClick={handleToggleStatus}
                        className={`flex-1 min-w-0 flex items-center justify-center gap-1 py-2 rounded-full text-[11px] font-bold uppercase tracking-widest transition-colors active-scale whitespace-nowrap ${inquiry.status === 'Closed'
                            ? 'neu-inset text-gold-700 dark:text-gold-300'
                            : 'neu-raised-sm neu-btn text-gray-700 dark:text-gray-300 hover:text-red-600 dark:hover:text-red-400'
                            }`}
                    >
                        {inquiry.status === 'Closed' ? (
                            <>
                                <CheckCircle2 size={12} strokeWidth={2.5} />
                                Reopen
                            </>
                        ) : (
                            <>
                                <XCircle size={12} strokeWidth={2.5} />
                                Close
                            </>
                        )}
                    </button>

                    <button
                        onClick={handleToggleCatalogShared}
                        className={`flex-1 min-w-0 flex items-center justify-center gap-1 py-2 rounded-full text-[11px] font-bold uppercase tracking-widest transition-colors active-scale whitespace-nowrap ${inquiry.catalogShared
                            ? 'neu-inset text-gold-700 dark:text-gold-300'
                            : 'neu-raised-sm neu-btn text-gray-700 dark:text-gray-300 hover:text-gold-600 dark:hover:text-gold-400'
                            }`}
                    >
                        <BookOpen size={12} strokeWidth={2.5} />
                        {inquiry.catalogShared ? 'Sent' : 'Share'}
                    </button>

                    <button
                        type="button"
                        onClick={() => setIsCreatingProforma(true)}
                        className="flex-1 min-w-0 flex items-center justify-center gap-1 py-2 rounded-full text-[11px] font-bold uppercase tracking-widest active-scale shadow-sm whitespace-nowrap neu-raised-sm neu-btn text-gold-700 dark:text-gold-300"
                    >
                        <FileText size={12} strokeWidth={2.5} />
                        Proforma
                    </button>
                </div>

                {/* Customer Info Card */}
                <div className="neu-raised p-6 rounded-lg shadow-sm mb-4 animate-fade-in-up" style={{ animationDelay: '100ms' }}>
                    <div className="flex justify-between items-start mb-6">
                        <div>
                            <h3 className="text-[11px] font-bold text-gray-700 dark:text-gray-300 uppercase tracking-widest mb-1">Customer</h3>
                            <p className="font-serif text-lg text-gray-900 dark:text-white">{inquiry.customerName}</p>
                        </div>
                        <div className="text-right">
                            <h3 className="text-[11px] font-bold text-gray-700 dark:text-gray-300 uppercase tracking-widest mb-1">Status</h3>
                            <span className={`text-[11px] px-2 py-1 rounded-[3px] font-medium uppercase tracking-wider inline-block ${STATUS_COLORS[inquiry.status]}`}>
                                {inquiry.status}
                            </span>
                        </div>
                    </div>

                    <div className="space-y-3 mb-6">
                        <ContactLink inquiry={inquiry} contacts={contacts} />
                        {inquiry.customerPhone && (
                            <div className="flex items-center gap-3 text-sm text-gray-600 dark:text-gray-400">
                                <a
                                    href={telHref(inquiry.customerPhone)}
                                    className="flex items-center gap-3 hover:text-gold-600 dark:hover:text-gold-400 active-scale"
                                    aria-label={`Call ${inquiry.customerPhone}`}
                                >
                                    <Phone size={14} className="text-gold-500" />
                                    <span>{inquiry.customerPhone}</span>
                                </a>
                                <a
                                    href={waHref(inquiry.customerPhone)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    aria-label="Chat on WhatsApp"
                                    className="ml-auto w-7 h-7 rounded-full bg-green-500/10 text-green-600 dark:text-green-400 flex items-center justify-center active-scale"
                                >
                                    <WhatsAppIcon size={15} />
                                </a>
                            </div>
                        )}
                        {inquiry.customerEmail && (
                            <div className="flex items-center gap-3 text-sm text-gray-600 dark:text-gray-400">
                                <a
                                    href={`mailto:${inquiry.customerEmail}`}
                                    className="flex items-center gap-3 hover:text-gold-600 dark:hover:text-gold-400 active-scale"
                                    aria-label={`Email ${inquiry.customerEmail}`}
                                >
                                    <Mail size={14} className="text-gold-500" />
                                    <span>{inquiry.customerEmail}</span>
                                </a>
                            </div>
                        )}
                        {inquiry.customerAddress && (
                            <div className="flex items-start gap-3 text-sm text-gray-600 dark:text-gray-400">
                                <MapPin size={14} className="text-gold-500 shrink-0 mt-0.5" />
                                <span className="whitespace-pre-line">{inquiry.customerAddress}</span>
                            </div>
                        )}
                        <div className="flex items-center gap-3 text-sm text-gray-600 dark:text-gray-400">
                            <Tag size={14} className="text-gold-500" />
                            <span className={`text-[11px] px-2 py-0.5 rounded-[3px] font-medium uppercase tracking-wider ${SOURCE_COLORS[inquiry.source]}`}>{inquiry.source}</span>
                        </div>
                        <div className="flex items-center gap-3 text-sm text-gray-600 dark:text-gray-400">
                            <Clock size={14} className="text-gold-500" />
                            <span>{new Date(inquiry.date).toLocaleDateString()} at {new Date(inquiry.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                        {addedBy && (
                            <div className="flex items-center gap-3 text-sm text-gray-600 dark:text-gray-400">
                                <User size={14} className="text-gold-500" />
                                <span>Added by <span className="font-medium text-gray-900 dark:text-gray-200">{addedBy}</span></span>
                            </div>
                        )}
                        <div className="flex items-center gap-3 text-sm text-gray-600 dark:text-gray-400">
                            <BookOpen size={14} className="text-gold-500" />
                            <span className={`text-[11px] px-2 py-0.5 rounded-[3px] font-medium uppercase tracking-wider ${inquiry.catalogShared
                                ? 'bg-gold-500/10 dark:bg-gold-900/20 text-gold-700 dark:text-gold-400'
                                : 'neu-inset text-gray-700 dark:text-gray-300'
                                }`}>
                                {inquiry.catalogShared ? 'Catalog Shared' : 'Not Shared'}
                            </span>
                        </div>
                    </div>

                    {inquiry.notes && (
                        <>
                            <div className="neu-divider w-full mb-4"></div>
                            <h3 className="text-[11px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest mb-2">Notes</h3>
                            <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">{inquiry.notes}</p>
                        </>
                    )}
                </div>

                {/* Proforma invoices from this inquiry */}
                {proformas.length > 0 && (
                    <div className="neu-raised p-6 rounded-lg shadow-sm mb-4 animate-fade-in-up" style={{ animationDelay: '115ms' }}>
                        <h3 className="text-[11px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest mb-4">Proforma Invoices ({proformas.length})</h3>
                        <div className="space-y-3">
                            {proformas.map(proforma => (
                                <div key={proforma.id} className="flex items-center justify-between gap-2">
                                    <div className="min-w-0">
                                        <p className="text-sm font-serif text-gray-900 dark:text-white truncate">{proforma.invoiceNumber}</p>
                                        <p className="text-[11px] text-gray-700 dark:text-gray-300 uppercase tracking-wider">
                                            ₹{proforma.total.toLocaleString('en-IN')} • {proforma.items.length} {proforma.items.length === 1 ? 'artwork' : 'artworks'} • {proforma.status}
                                        </p>
                                    </div>
                                    <ProformaPdfActions invoice={proforma} artworks={artworks} compact />
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Photos */}
                <div className="neu-raised p-6 rounded-lg shadow-sm mb-4 animate-fade-in-up" style={{ animationDelay: '125ms' }}>
                    <h3 className="text-[11px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest mb-4">
                        Photos{inquiry.imageUrls?.length ? ` (${inquiry.imageUrls.length})` : ''}
                    </h3>
                    <PhotoAttachments urls={inquiry.imageUrls ?? []} onAdd={handleAddPhotos} />
                </div>

                {/* Interested Artworks */}
                {linkedArtworks.length > 0 && (
                    <div className="neu-raised p-6 rounded-lg shadow-sm animate-fade-in-up" style={{ animationDelay: '150ms' }}>
                        <h3 className="text-[11px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest mb-4">Interested In ({linkedArtworks.length})</h3>
                        <div className="space-y-3">
                            {linkedArtworks.map((art) => (
                                <div key={art.id} className="flex justify-between items-center">
                                    <div className="flex items-center gap-3">
                                        {art.imageUrls && art.imageUrls.length > 0 ? (
                                            <img loading="lazy" decoding="async" src={getThumbUrl(art.imageUrls[0])} alt={art.title} className="w-10 h-10 rounded-[3px] object-contain p-0.5 tile-backdrop" />
                                        ) : (
                                            <div className="w-10 h-10 rounded-[3px] neu-inset flex items-center justify-center text-gray-400">
                                                <ImageIcon size={14} />
                                            </div>
                                        )}
                                        <div>
                                            <p className="font-serif text-sm text-gray-900 dark:text-white">{art.title}</p>
                                            <button onClick={() => setSelectedArtworkForPopup(art)} className="text-[11px] text-gold-700 dark:text-gold-300 uppercase tracking-wider hover:underline">
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

                {isCreatingProforma && (
                    <InvoiceFormModal
                        prefill={{
                            customerName: inquiry.customerName,
                            customerPhone: inquiry.customerPhone,
                            customerEmail: inquiry.customerEmail,
                            customerAddress: inquiry.customerAddress,
                            inquiryId: inquiry.id,
                            items: linkedArtworks.map(art => ({ artworkId: art.id, title: art.title, price: art.price })),
                        }}
                        artworks={artworks}
                        saveLabel="Save & PDF"
                        onClose={() => setIsCreatingProforma(false)}
                        onSave={handleCreateProforma}
                        onArtworkClick={onArtworkClick}
                    />
                )}
                {isEditing && (
                    <InquiryFormModal
                        initialData={inquiry}
                        artworks={artworks}
                        contacts={contacts}
                        onClose={() => setIsEditing(false)}
                        onSave={handleSaveEdit}
                        onArtworkClick={onArtworkClick}
                        onDelete={onDeleteInquiry}
                    />
                )}
            </div>
            {selectedArtworkForPopup && (
                <div className="absolute inset-0 z-[80] flex items-center justify-center p-4 animate-fade-in">
                    <button
                        type="button"
                        aria-label="Close artwork details"
                        onClick={() => setSelectedArtworkForPopup(null)}
                        className="absolute inset-0 w-full h-full neu-scrim cursor-default"
                    />
                    <div className="relative neu-raised rounded-[12px] w-full max-w-sm overflow-hidden shadow-2xl animate-scale-in">
                        <div className="relative h-48 tile-backdrop">
                            {selectedArtworkForPopup.imageUrls && selectedArtworkForPopup.imageUrls.length > 0 ? (
                                <img loading="lazy" decoding="async" src={selectedArtworkForPopup.imageUrls[0]} alt={selectedArtworkForPopup.title} className="w-full h-full object-contain p-3" />
                            ) : (
                                <div className="w-full h-full flex items-center justify-center text-gray-400">
                                    <ImageIcon size={32} />
                                </div>
                            )}
                            <button 
                                onClick={() => setSelectedArtworkForPopup(null)} 
                                className="absolute top-2 right-2 w-8 h-8 bg-black/50 hover:bg-black/70 text-white rounded-full flex items-center justify-center transition-colors backdrop-blur-sm active-scale"
                            >
                                <X size={16} />
                            </button>
                        </div>
                        <div className="p-5 space-y-4">
                            <div>
                                <h3 className="font-serif text-xl text-gray-900 dark:text-white leading-tight">{selectedArtworkForPopup.title}</h3>
                                <p className="text-[11px] text-gray-700 dark:text-gray-300 uppercase tracking-widest mt-1">
                                    {selectedArtworkForPopup.artist && `${selectedArtworkForPopup.artist} • `}{selectedArtworkForPopup.customId}
                                </p>
                            </div>
                            <div className="flex justify-between items-center pb-4">
                                <span className="font-semibold text-gold-700 dark:text-gold-300">₹{selectedArtworkForPopup.price.toLocaleString('en-IN')}{selectedArtworkForPopup.plusGst ? ' + GST' : ''}</span>
                                <span className={`text-[11px] px-2 py-1 rounded-[3px] font-medium uppercase tracking-wider ${ARTWORK_STATUS_BADGE[selectedArtworkForPopup.status]}`}>
                                    {selectedArtworkForPopup.status}
                                </span>
                            </div>
                            <div className="grid grid-cols-2 gap-3 text-xs">
                                <div>
                                    <span className="block text-[11px] text-gray-400 uppercase tracking-widest mb-0.5">Medium</span>
                                    <span className="text-gray-800 dark:text-gray-200">{selectedArtworkForPopup.medium || '-'}</span>
                                </div>
                                <div>
                                    <span className="block text-[11px] text-gray-400 uppercase tracking-widest mb-0.5">Dimensions</span>
                                    <span className="text-gray-800 dark:text-gray-200">{selectedArtworkForPopup.dimensions || '-'}</span>
                                </div>
                                <div>
                                    <span className="block text-[11px] text-gray-400 uppercase tracking-widest mb-0.5">Location</span>
                                    <span className="text-gray-800 dark:text-gray-200">{selectedArtworkForPopup.location || '-'}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

/**
 * Which saved contact this inquiry belongs to. When its phone and email are
 * two different contacts' the server didn't guess: someone picks one here.
 */
const ContactLink: React.FC<{ inquiry: Inquiry; contacts: Contact[] }> = ({ inquiry, contacts }) => {
    const linked = contacts.find(c => c.id === inquiry.contactId);
    if (linked) {
        return (
            <p className="flex items-center gap-3 text-sm text-gray-600 dark:text-gray-400">
                <User size={14} className="text-gold-500" /> Saved contact: <span className="font-medium text-gray-800 dark:text-gray-200">{linked.name || linked.phone || linked.email}</span>
            </p>
        );
    }
    const matches = (inquiry.contactMatches ?? []).map(id => contacts.find(c => c.id === id)).filter((c): c is Contact => !!c);
    if (matches.length < 2) return null;
    const choose = (contact: Contact) => {
        inquiryService.updateInquiry({ ...inquiry, chooseContactId: contact.id } as Inquiry)
            .then(() => toast.success(`Linked to ${contact.name || 'that contact'}`))
            .catch(e => toast.error(`Not linked: ${(e as Error).message}`));
    };
    return (
        <div className="rounded-xl neu-inset p-3 text-[12px] text-gray-700 dark:text-gray-300">
            <p>This phone and email belong to two different saved contacts. Which one is it?</p>
            <div className="mt-2 flex flex-wrap gap-2">
                {matches.map(c => (
                    <IfCan key={c.id} section="inquiries">
                        <button type="button" onClick={() => choose(c)} className="neu-raised-sm neu-btn rounded-full px-3 py-1.5 text-[12px] active-scale">
                            {c.name || c.phone || c.email}
                        </button>
                    </IfCan>
                ))}
            </div>
        </div>
    );
};

// ─── Form Modal ────────────────────────────────────────

interface InquiryFormModalProps {
    initialData?: Inquiry;
    artworks: Artwork[];
    contacts: Contact[];
    onClose: () => void;
    onSave: (inquiry: any) => void;
    onArtworkClick: (artwork: Artwork) => void;
    /** Shown only when editing — delete lives inside the edit form. */
    onDelete?: () => void;
}

const InquiryFormModal: React.FC<InquiryFormModalProps> = ({ initialData, artworks, contacts, onClose, onSave, onArtworkClick, onDelete }) => {
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [customerName, setCustomerName] = useState(initialData?.customerName || '');
    const [customerPhone, setCustomerPhone] = useState(initialData?.customerPhone || '');
    const [customerEmail, setCustomerEmail] = useState(initialData?.customerEmail || '');
    const [customerAddress, setCustomerAddress] = useState(initialData?.customerAddress ?? '');
    const [notes, setNotes] = useState(initialData?.notes || '');
    const [source, setSource] = useState<Inquiry['source']>(initialData?.source || 'Walk-in');
    const [status, setStatus] = useState<Inquiry['status']>(initialData?.status || 'New');
    const catalogShared = initialData?.catalogShared ?? false;
    const [selectedArtworkIds, setSelectedArtworkIds] = useState<Set<string>>(new Set(initialData?.artworkIds ?? []));
    const [imageUrls, setImageUrls] = useState<string[]>(initialData?.imageUrls ?? []);
    const [isUploadingPhotos, setIsUploadingPhotos] = useState(false);
    // Typed a number or email already saved: offer that contact's name.
    const saved = useMemo(
        () => contactWithKey(contacts, phoneKey(customerPhone)) ?? contactWithKey(contacts, emailKey(customerEmail)),
        [contacts, customerPhone, customerEmail],
    );
    const useSaved = () => {
        if (!saved) return;
        setCustomerName(saved.name);
        if (!customerPhone.trim() && saved.phone) setCustomerPhone(saved.phone);
        if (!customerEmail.trim() && saved.email) setCustomerEmail(saved.email);
    };

    const toggleArtwork = (id: string) => {
        const newSet = new Set(selectedArtworkIds);
        if (newSet.has(id)) newSet.delete(id);
        else newSet.add(id);
        setSelectedArtworkIds(newSet);
    };

    const handleSubmit = () => {
        if (!customerName.trim()) { toast.error('Customer name is required'); return; }
        if (isUploadingPhotos) return toast('Photos are still uploading — save again in a moment.');

        onSave({
            inquiryNumber: initialData?.inquiryNumber || makeDocumentNumber('INQ'),
            customerName,
            customerPhone,
            customerEmail,
            customerAddress: customerAddress.trim(),
            artworkIds: Array.from(selectedArtworkIds),
            notes,
            source,
            status,
            catalogShared,
            imageUrls,
        });
    };

    return (
        <div className="neu-sheet z-[70] animate-fade-in-up">
            <div className="flex justify-between items-center p-3 pt-[calc(1.75rem+var(--safe-top))] z-10">
                <button onClick={onClose} className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale">
                    <X size={20} />
                </button>
                <h2 className="text-base font-serif text-gray-900 dark:text-white">{initialData ? 'Edit Inquiry' : 'New Inquiry'}</h2>
                <button onClick={handleSubmit} className="text-gold-700 dark:text-gold-300 font-medium px-2 py-2 uppercase tracking-wider text-xs active-scale">
                    Save
                </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 no-scrollbar flex flex-col gap-6">
                {/* Customer Info */}
                <div className="neu-card p-5 space-y-5 animate-fade-in-up" style={{ animationDelay: '50ms' }}>
                    <h3 className="font-bold text-gray-900 dark:text-gray-100 text-[11px] uppercase tracking-widest">Customer Details</h3>
                    <div>
                        <label htmlFor="customerName" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Name *</label>
                        <input
                            id="customerName"
                            value={customerName}
                            onChange={e => setCustomerName(e.target.value)}
                            className="neu-field"
                            placeholder="Customer Name"
                        />
                    </div>
                    <div>
                        <label htmlFor="customerPhone" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Phone</label>
                        <input
                            id="customerPhone"
                            type="tel"
                            value={customerPhone}
                            onChange={e => setCustomerPhone(e.target.value)}
                            className="neu-field"
                            placeholder="+91 98765 43210"
                        />
                        {saved?.name && saved.name !== customerName.trim() && (
                            <button
                                type="button"
                                onClick={useSaved}
                                className="mt-2 w-full flex items-center gap-2 rounded-xl neu-raised-sm neu-btn px-3 py-2 text-left text-[12px] text-gray-700 dark:text-gray-200 active-scale"
                            >
                                <User size={13} className="shrink-0 text-gold-600 dark:text-gold-400" />
                                <span className="flex-1 min-w-0 truncate">Saved contact: <span className="font-medium">{saved.name}</span></span>
                                <span className="shrink-0 text-[11px] uppercase tracking-wider text-gold-700 dark:text-gold-300">Use</span>
                            </button>
                        )}
                    </div>
                    <div>
                        <label htmlFor="customerEmail" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Email</label>
                        <input
                            id="customerEmail"
                            type="email"
                            value={customerEmail}
                            onChange={e => setCustomerEmail(e.target.value)}
                            className="neu-field"
                            placeholder="customer@example.com"
                        />
                    </div>
                    <div>
                        <label htmlFor="customerAddress" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Address</label>
                        <textarea
                            id="customerAddress"
                            value={customerAddress}
                            onChange={e => setCustomerAddress(e.target.value)}
                            rows={2}
                            className="neu-field"
                            placeholder="House / street, area, city, PIN"
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label htmlFor="inquirySource" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Source</label>
                            <select
                                id="inquirySource"
                                value={source}
                                onChange={e => setSource(e.target.value as Inquiry['source'])}
                                className="neu-field"
                            >
                                <option value="Walk-in" className="dark:bg-gray-800">Walk-in</option>
                                <option value="Phone" className="dark:bg-gray-800">Phone</option>
                                <option value="Email" className="dark:bg-gray-800">Email</option>
                                <option value="Social Media" className="dark:bg-gray-800">Social Media</option>
                                <option value="Referral" className="dark:bg-gray-800">Referral</option>
                                <option value="Private room" className="dark:bg-gray-800">Private room</option>
                                <option value="Other" className="dark:bg-gray-800">Other</option>
                            </select>
                        </div>
                        <div>
                            <label htmlFor="inquiryStatus" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Status</label>
                            <select
                                id="inquiryStatus"
                                value={status}
                                onChange={e => setStatus(e.target.value as Inquiry['status'])}
                                className="neu-field"
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
                <div className="neu-card p-5 animate-fade-in-up" style={{ animationDelay: '100ms' }}>
                    <h3 className="font-bold text-gray-900 dark:text-gray-100 text-[11px] uppercase tracking-widest mb-3">Notes</h3>
                    <textarea
                        value={notes}
                        onChange={e => setNotes(e.target.value)}
                        rows={3}
                        className="w-full bg-transparent rounded-lg p-3 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-[var(--ink-focus)] transition-colors resize-none"
                        placeholder="Add any notes about this inquiry..."
                    />
                </div>

                {/* Photos */}
                <div className="neu-card p-5 animate-fade-in-up" style={{ animationDelay: '125ms' }}>
                    <h3 className="font-bold text-gray-900 dark:text-gray-100 text-[11px] uppercase tracking-widest mb-3">Photos</h3>
                    <PhotoAttachments
                        urls={imageUrls}
                        onAdd={(urls) => setImageUrls(prev => [...prev, ...urls])}
                        onRemove={(url) => setImageUrls(prev => prev.filter(u => u !== url))}
                        onUploadingChange={setIsUploadingPhotos}
                    />
                </div>

                {/* Select Artworks: search, filters and a tall grid (ArtworkPicker) */}
                <div className="neu-card p-4 lg:p-5 animate-fade-in-up" style={{ animationDelay: '150ms' }}>
                    <div className="flex justify-between items-center mb-4">
                        <h3 className="font-bold text-gray-900 dark:text-gray-100 text-[11px] uppercase tracking-widest">Interested Artworks</h3>
                        <span className="text-[11px] neu-inset px-2 py-0.5 rounded-[3px] text-gray-600 dark:text-gray-300 uppercase tracking-wider">{selectedArtworkIds.size} selected</span>
                    </div>

                    <ArtworkPicker artworks={artworks} selected={selectedArtworkIds} onToggle={toggleArtwork} onInfo={onArtworkClick} scroll />
                </div>

                <div className="h-10"></div>

                {initialData && onDelete && (
                    <button
                        type="button"
                        onClick={() => setConfirmDelete(true)}
                        className="neu-button neu-button-danger w-full mb-4"
                    >
                        <Trash2 size={14} /> Delete Inquiry
                    </button>
                )}
            </div>

            <TypeDeleteDialog
                isOpen={confirmDelete}
                title="Delete inquiry"
                itemName={initialData ? `${initialData.inquiryNumber} — ${initialData.customerName}` : ''}
                message="its messages and photos are archived for admin review"
                onClose={() => setConfirmDelete(false)}
                onConfirm={() => {
                    setConfirmDelete(false);
                    onDelete?.();
                }}
            />
        </div>
    );
};
