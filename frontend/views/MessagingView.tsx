import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Search, Send, ArrowLeft, Tag, User, Users, MessageCircle, Plus, X, Edit2, Check, CheckCheck, Pin, Archive, MoreVertical, Paperclip, Reply, Loader2, Trash2, Camera, AlertCircle, Lock } from 'lucide-react';
import { SearchBar } from '../components/SearchBar';
import { useIsDesktop } from '../hooks/useMediaQuery';
import { PageRoot, PageHeader, PageBody, PrimaryIconButton, ToggleRow } from '../components/ui';
import { Conversation, ConversationDetails, Message, MessageTag, MessageReplyTo, MessageAttachment, UserProfile } from '../types';
import { FullScreenPortal } from '../components/FullScreenPortal';
import { TypeDeleteDialog } from '../components/TypeDeleteDialog';
import storageService, { getThumbUrl } from '../services/storageService';
import { useMemberNames } from '../hooks/useMemberNames';
import { usePhotoCapture } from '../hooks/usePhotoCapture';
import { useStickToBottom } from '../hooks/useStickToBottom';
import toast from 'react-hot-toast';
import { IfCan } from '../components/Layout';

interface MessagingViewProps {
    conversations: Conversation[];
    messages: Message[];
    teamMembers: UserProfile[];
    currentUserId: string;
    currentUserName: string;
    /** Admins can create private rooms (closed groups only their members see). */
    isAdmin?: boolean;
    onSendMessage: (conversationId: string, text: string, tags: MessageTag[], replyTo?: MessageReplyTo, attachment?: MessageAttachment) => void;
    /** Resend a message the server never accepted. */
    onRetryMessage?: (messageId: string) => void;
    onCreateConversation: (participantId: string, details?: ConversationDetails) => Promise<Conversation>;
    onCreateGroup: (participantIds: string[], groupName: string, details?: ConversationDetails, isPrivate?: boolean) => Promise<Conversation>;
    onUpdateConversationDetails: (conversationId: string, details: ConversationDetails) => void;
    onUpdateGroup?: (conversationId: string, groupName: string, participantIds: string[], details?: ConversationDetails) => void;
    onTogglePinConversation: (conversationId: string) => void;
    onToggleArchiveConversation: (conversationId: string) => void;
    onDeleteConversation?: (conversationId: string) => void;
}

export const TAG_COLORS: Record<MessageTag, string> = {
    'General': 'neu-inset text-gray-600 dark:text-gray-400',
    'Urgent': 'neu-inset text-red-600 dark:text-red-400',
    'Follow-up': 'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
    'Artwork': 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400',
    'Inquiry': 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-600 dark:text-yellow-400',
    'Invoice': 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400',
};

export const ALL_TAGS: MessageTag[] = ['General', 'Urgent', 'Follow-up', 'Artwork', 'Inquiry', 'Invoice'];

export const MessagingView: React.FC<MessagingViewProps> = ({ conversations, messages, teamMembers, currentUserId, currentUserName, isAdmin = false, onSendMessage, onRetryMessage, onCreateConversation, onCreateGroup, onUpdateConversationDetails, onUpdateGroup, onTogglePinConversation, onToggleArchiveConversation, onDeleteConversation }) => {
    // Desktop shows the thread inline beside the list; phones open it as a
    // full-screen overlay. That's a choice of component, not just of styling.
    const isDesktop = useIsDesktop();
    const [selectedConv, setSelectedConv] = useState<Conversation | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [showNewChat, setShowNewChat] = useState(false);
    const [showArchived, setShowArchived] = useState(false);
    const [openMenuId, setOpenMenuId] = useState<string | null>(null);
    const [editingGroup, setEditingGroup] = useState<Conversation | null>(null);
    const [deleteConvId, setDeleteConvId] = useState<string | null>(null);

    React.useEffect(() => {
        const handlePopState = (e: PopStateEvent) => {
            if (e.state?.modal !== 'message') {
                setSelectedConv(null);
            }
        };
        globalThis.addEventListener('popstate', handlePopState);
        return () => globalThis.removeEventListener('popstate', handlePopState);
    }, []);

    const handleConvClick = (conv: Conversation) => {
        setSelectedConv(conv);
        globalThis.history.pushState({ view: 'messaging', modal: 'message' }, '');
    };

    const handleCloseModal = () => {
        if (globalThis.history.state?.modal === 'message') {
            globalThis.history.back();
        } else {
            setSelectedConv(null);
        }
    };

    const onlineMembers = useMemo(() => teamMembers.filter(m => m.isOnline && m.id !== currentUserId), [teamMembers, currentUserId]);

    // Private rooms first, then ordinary groups.
    const groupConversations = useMemo(
        () => conversations.filter(c => c.isGroup).sort((a, b) => Number(!!b.isPrivate) - Number(!!a.isPrivate)),
        [conversations],
    );
    /** Rename, change members, delete: for a private room only its creator or an admin in it (the server enforces this too). */
    const canManage = (conv: Conversation) =>
        !conv.isPrivate || conv.createdBy === currentUserId || (isAdmin && conv.participantIds.includes(currentUserId));
    const deletingPrivate = !!deleteConvId && !!conversations.find(c => c.id === deleteConvId)?.isPrivate;

    const resolveName = useMemberNames(teamMembers);
    const participantName = (conv: Conversation, idx: number) =>
        resolveName(conv.participantIds[idx], conv.participantNames[idx]);

    const matchesSearch = (c: Conversation) => {
        if (!searchQuery.trim()) return true;
        const q = searchQuery.toLowerCase();
        return c.participantIds.some((_, i) => participantName(c, i).toLowerCase().includes(q)) || c.lastMessage.toLowerCase().includes(q);
    };

    const pinnedConversations = useMemo(
        () => conversations.filter(c => !c.isGroup && !c.isArchived && c.isPinned && matchesSearch(c)),
        [conversations, searchQuery]
    );
    const filteredConversations = useMemo(
        () => conversations.filter(c => !c.isGroup && !c.isArchived && !c.isPinned && matchesSearch(c)),
        [conversations, searchQuery]
    );
    const archivedConversations = useMemo(
        () => conversations.filter(c => !c.isGroup && c.isArchived),
        [conversations]
    );

    const getOtherParticipant = (conv: Conversation) => {
        if (conv.isGroup) {
            return { name: conv.groupName || 'Group', id: conv.id };
        }
        const idx = conv.participantIds.indexOf(currentUserId);
        const otherIdx = idx === 0 ? 1 : 0;
        const hasOther = otherIdx < conv.participantIds.length;
        return {
            name: participantName(conv, hasOther ? otherIdx : 0),
            id: conv.participantIds[otherIdx] || conv.participantIds[0],
        };
    };

    const getConvDisplayName = (conv: Conversation) => {
        if (conv.isGroup) return conv.groupName || 'Group';
        return getOtherParticipant(conv).name;
    };

    const getMemberOnlineStatus = (memberId: string) => {
        const member = teamMembers.find(m => m.id === memberId);
        return member?.isOnline || false;
    };

    const formatTime = (timestamp: number) => {
        const diff = Date.now() - timestamp;
        if (diff < 60000) return 'Just now';
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        if (diff < 86400000) return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return new Date(timestamp).toLocaleDateString();
    };

    const renderConversationRow = (conv: Conversation, index: number) => {
        const other = getOtherParticipant(conv);
        const isOnline = getMemberOnlineStatus(other.id);
        const isMenuOpen = openMenuId === conv.id;
        const displayName = getConvDisplayName(conv);
        // On desktop the thread sits beside the list, so the open conversation
        // has to read as selected — pressed in, with a gold edge marker.
        const isSelected = isDesktop && selectedConv?.id === conv.id;
        return (
            <div key={conv.id} className="relative">
                <div
                    className={`relative w-full text-left rounded-2xl p-3 flex items-center gap-2 animate-fade-in-up cursor-pointer active-scale ${isSelected ? 'neu-inset' : 'neu-raised'}`}
                    style={{ animationDelay: `${index * 45}ms` }}
                >
                    {isSelected && (
                        <span className="absolute left-0 top-1/2 -translate-y-1/2 h-8 w-[3px] rounded-r-full bg-gold-500 z-[2]" />
                    )}
                    {/* Row tap target; inner action buttons sit above it (z-[2]). */}
                    <button
                        type="button"
                        onClick={() => { setOpenMenuId(null); handleConvClick(conv); }}
                        aria-label={`Open conversation with ${displayName}`}
                        className="absolute inset-0 z-[1] w-full h-full rounded-lg cursor-pointer"
                    />
                    <div className="relative shrink-0">
                        <div className="w-11 h-11 rounded-full neu-inset flex items-center justify-center text-brand-900 dark:text-gold-400">
                            <User size={20} strokeWidth={1.5} />
                        </div>
                        {isOnline && (
                            <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-white dark:border-[#1e1e1e]"></div>
                        )}
                    </div>
                    <div className="flex-1 min-w-0">
                        {(conv.isPinned || conv.title) && (
                            <div className="flex items-center gap-1">
                                {conv.isPinned && <Pin size={9} className="text-gold-500 shrink-0" />}
                                {conv.title && (
                                    <p className="text-[10px] font-bold text-gold-700 dark:text-gold-300 uppercase tracking-widest truncate">{conv.title}</p>
                                )}
                            </div>
                        )}
                        <div className="flex justify-between items-baseline">
                            <h3 className="font-serif text-gray-900 dark:text-gray-100 text-sm truncate">{displayName}</h3>
                            <span className="text-[11px] text-gray-600 dark:text-gray-300 shrink-0 ml-2">{formatTime(conv.lastMessageTime)}</span>
                        </div>
                        <p className="text-[11px] text-gray-700 dark:text-gray-300 mt-0.5 line-clamp-1 font-light">{conv.lastMessage}</p>
                    </div>
                    {conv.unreadCount > 0 && (
                        <div className="w-5 h-5 rounded-full bg-gold-500 text-white text-[11px] font-bold flex items-center justify-center shrink-0">
                            {conv.unreadCount}
                        </div>
                    )}
                    <button type="button" aria-label="Conversation options"
                        onClick={(e) => { e.stopPropagation(); setOpenMenuId(isMenuOpen ? null : conv.id); }}
                        className="relative z-[2] neu-icon-btn-sm text-gray-600 dark:text-gray-300 active-scale"
                    >
                        <MoreVertical size={16} />
                    </button>
                </div>
                {isMenuOpen && (
                    <div className="absolute right-10 top-1/2 -translate-y-1/2 z-20 neu-raised-sm overflow-hidden animate-scale-in flex flex-col min-w-[110px]">
                        {conv.isGroup && onUpdateGroup && (
                            <button
                                onClick={(e) => { e.stopPropagation(); setOpenMenuId(null); setEditingGroup(conv); }}
                                className="w-full flex items-center gap-2 px-2 py-1.5 text-[11px] text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors whitespace-nowrap"
                            >
                                <Edit2 size={12} /> Edit Group
                            </button>
                        )}
                        <button
                            onClick={(e) => { e.stopPropagation(); onTogglePinConversation(conv.id); setOpenMenuId(null); }}
                            className="w-full flex items-center gap-2 px-2 py-1.5 text-[11px] text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors whitespace-nowrap"
                        >
                            <Pin size={12} /> {conv.isPinned ? 'Unpin' : 'Pin'}
                        </button>
                        <button
                            onClick={(e) => { e.stopPropagation(); onToggleArchiveConversation(conv.id); setOpenMenuId(null); }}
                            className="w-full flex items-center gap-2 px-2 py-1.5 text-[11px] text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors whitespace-nowrap"
                        >
                            <Archive size={12} /> {conv.isArchived ? 'Unarchive' : 'Archive'}
                        </button>
                        {conv.isArchived && onDeleteConversation && (
                            <button
                                onClick={(e) => { e.stopPropagation(); setDeleteConvId(conv.id); setOpenMenuId(null); }}
                                className="w-full flex items-center gap-2 px-2 py-1.5 text-[11px] text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors whitespace-nowrap"
                            >
                                <Trash2 size={12} /> Delete
                            </button>
                        )}
                    </div>
                )}
            </div>
        );
    };

    return (
        <PageRoot width="full">
            {/* Desktop is master-detail: the conversation list keeps a fixed
                column on the left and the open thread renders beside it, so a
                wide screen isn't three-quarters empty. Phones keep the list →
                full-screen-thread flow. */}
            <div className="flex-1 min-h-0 flex">
            <div className="flex flex-col min-h-0 w-full lg:w-[26rem] lg:shrink-0 lg:border-r lg:border-gray-200/70 dark:lg:border-white/5">
            {/* Header */}
            <PageHeader
                className="lg:px-5 lg:pt-5"
                title="Messages"
                actions={(
                    <IfCan section="messages"><PrimaryIconButton onClick={() => setShowNewChat(true)} label="New chat" icon={<Plus size={16} />} /></IfCan>
                )}
            >
                <SearchBar value={searchQuery} onChange={setSearchQuery} placeholder="Search messages..." />
            </PageHeader>

            <PageBody space="md" scrollClassName="lg:px-5">
                {/* Group Chats */}
                {groupConversations.length > 0 && (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-1 gap-2 md:space-y-0 animate-fade-in-up">
                        {groupConversations.map((group) => (
                            <div key={group.id} className="relative">
                                <div
                                    className="relative w-full neu-raised rounded-2xl p-3 flex items-center gap-3 border border-gold-300 dark:border-gold-700 text-left cursor-pointer"
                                >
                                    {/* Row tap target; inner action buttons sit above it (z-[2]). */}
                                    <button
                                        type="button"
                                        onClick={() => { setOpenMenuId(null); handleConvClick(group); }}
                                        aria-label={`Open ${group.isPrivate ? 'private room' : 'group'} ${group.groupName || 'Group'}`}
                                        className="absolute inset-0 z-[1] w-full h-full rounded-lg cursor-pointer"
                                    />
                                    <div className="w-11 h-11 rounded-full bg-gold-500/10 dark:bg-gold-900/20 flex items-center justify-center text-gold-700 dark:text-gold-300 shrink-0">
                                        {group.isPrivate ? <Lock size={18} strokeWidth={1.7} /> : <Users size={20} strokeWidth={1.5} />}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        {group.isPrivate && (
                                            <p className="text-[10px] font-bold text-gold-700 dark:text-gold-300 uppercase tracking-widest">Private room</p>
                                        )}
                                        <h3 className="font-serif text-gray-900 dark:text-gray-100 text-sm">{group.groupName || 'Group'}</h3>
                                        <p className="text-[11px] text-gray-700 dark:text-gray-300 mt-0.5 line-clamp-1 font-light">
                                            {group.participantIds.length} members • {group.lastMessage || 'No messages yet'}
                                        </p>
                                    </div>
                                    {canManage(group) && (
                                        <button type="button" aria-label={group.isPrivate ? 'Private room options' : 'Group options'}
                                            onClick={(e) => { e.stopPropagation(); setOpenMenuId(openMenuId === group.id ? null : group.id); }}
                                            className="relative z-[2] neu-icon-btn-sm text-gray-600 dark:text-gray-300 active-scale"
                                        >
                                            <MoreVertical size={16} />
                                        </button>
                                    )}
                                </div>
                                {openMenuId === group.id && canManage(group) && (
                                    <div className="absolute right-10 top-1/2 -translate-y-1/2 z-20 neu-raised-sm overflow-hidden animate-scale-in flex flex-col min-w-[110px]">
                                        {onUpdateGroup && (
                                            <button
                                                onClick={(e) => { e.stopPropagation(); setOpenMenuId(null); setEditingGroup(group); }}
                                                className="w-full flex items-center gap-2 px-2 py-1.5 text-[11px] text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors whitespace-nowrap"
                                            >
                                                <Edit2 size={12} /> {group.isPrivate ? 'Edit Room' : 'Edit Group'}
                                            </button>
                                        )}
                                        {onDeleteConversation && (
                                            <button
                                                onClick={(e) => { e.stopPropagation(); setDeleteConvId(group.id); setOpenMenuId(null); }}
                                                className="w-full flex items-center gap-2 px-2 py-1.5 text-[11px] text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors whitespace-nowrap"
                                            >
                                                <Trash2 size={12} /> Delete
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}

                {/* Online Members */}
                {onlineMembers.length > 0 && (
                    <div className="animate-fade-in-up" style={{ animationDelay: '50ms' }}>
                        <h2 className="text-[11px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest mb-3 px-1">Online Now</h2>
                        <div className="flex gap-3 overflow-x-auto no-scrollbar pb-1">
                            {onlineMembers.map((member) => (
                                <div key={member.id} className="flex flex-col items-center gap-1.5 shrink-0">
                                    <div className="relative">
                                        <div className="w-12 h-12 rounded-full neu-inset flex items-center justify-center text-brand-900 dark:text-gold-400 border-2 border-green-400 dark:border-green-500">
                                            <User size={20} strokeWidth={1.5} />
                                        </div>
                                        <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 rounded-full border-2 border-white dark:border-[#121212]"></div>
                                    </div>
                                    <span className="text-[11px] text-gray-600 dark:text-gray-400 font-medium text-center w-14 truncate">{member.name.split(' ')[0]}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Pinned Conversations */}
                {pinnedConversations.length > 0 && (
                    <div className="animate-fade-in-up" style={{ animationDelay: '80ms' }}>
                        <h2 className="text-[11px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest mb-3 px-1 flex items-center gap-1">
                            <Pin size={10} /> Pinned
                        </h2>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-1 gap-2 md:space-y-0">
                            {pinnedConversations.map((conv, index) => renderConversationRow(conv, index))}
                        </div>
                    </div>
                )}

                {/* Conversations List */}
                <div>
                    <h2 className="text-[11px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest mb-3 px-1 animate-fade-in-up" style={{ animationDelay: '100ms' }}>Conversations</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-1 gap-2 md:space-y-0">
                        {filteredConversations.map((conv, index) => renderConversationRow(conv, index))}
                        {filteredConversations.length === 0 && pinnedConversations.length === 0 && (
                            <div className="text-center text-gray-600 dark:text-gray-300 mt-10 font-light text-sm">
                                No conversations found.
                            </div>
                        )}
                    </div>
                </div>

                {/* Archived Link */}
                {archivedConversations.length > 0 && (
                    <button
                        onClick={() => setShowArchived(true)}
                        className="w-full text-center text-[11px] font-medium text-gray-600 dark:text-gray-300 uppercase tracking-wider py-2 flex items-center justify-center gap-1.5 active-scale"
                    >
                        <Archive size={12} /> Archived ({archivedConversations.length})
                    </button>
                )}
            </PageBody>
            </div>

            {/* Detail pane (desktop only) */}
            <div className="hidden lg:flex flex-1 min-w-0">
                {selectedConv ? (() => {
                    const liveConv = conversations.find(c => c.id === selectedConv.id) ?? selectedConv;
                    return (
                        <ChatDetailModal
                            inline
                            key={liveConv.id}
                            conversation={liveConv}
                            messages={messages.filter(m => m.conversationId === liveConv.id)}
                            resolveName={resolveName}
                            currentUserId={currentUserId}
                            currentUserName={currentUserName}
                            otherParticipant={getOtherParticipant(liveConv)}
                            isOnline={getMemberOnlineStatus(getOtherParticipant(liveConv).id)}
                            onClose={handleCloseModal}
                            onSendMessage={onSendMessage}
                            onRetryMessage={onRetryMessage}
                            onUpdateConversationDetails={onUpdateConversationDetails}
                        />
                    );
                })() : (
                    <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
                        <div className="w-14 h-14 rounded-full neu-inset flex items-center justify-center text-gray-500 dark:text-gray-400 mb-4">
                            <MessageCircle size={24} strokeWidth={1.5} />
                        </div>
                        <p className="font-serif text-base text-gray-700 dark:text-gray-200">Select a conversation</p>
                        <p className="text-xs text-gray-600 dark:text-gray-400 font-light mt-1 max-w-xs">
                            Pick a chat on the left, or start a new one with the + button.
                        </p>
                    </div>
                )}
            </div>
            </div>

            {/* Archived Conversations */}
            {showArchived && (
                <FullScreenPortal>
                    <div className="neu-sheet z-50 animate-fade-in-up">
                        <div className="flex items-center gap-3 p-3 pt-[calc(1.75rem+var(--safe-top))] z-10">
                            <button onClick={() => setShowArchived(false)} className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale">
                                <ArrowLeft size={20} />
                            </button>
                            <h2 className="text-base font-serif text-gray-900 dark:text-white">Archived</h2>
                        </div>
                        <div className="flex-1 overflow-y-auto p-3 grid grid-cols-1 md:grid-cols-2 gap-2 md:space-y-0 no-scrollbar">
                            {archivedConversations.map((conv, index) => renderConversationRow(conv, index))}
                            {archivedConversations.length === 0 && (
                                <div className="text-center text-gray-600 dark:text-gray-300 mt-10 font-light text-sm">
                                    No archived conversations.
                                </div>
                            )}
                        </div>
                    </div>
                </FullScreenPortal>
            )}

            {/* Chat Detail overlay — phones only (desktop renders it inline) */}
            {selectedConv && !isDesktop && (() => {
                const liveConv = conversations.find(c => c.id === selectedConv.id) ?? selectedConv;
                return (
                    <FullScreenPortal>
                        <ChatDetailModal
                            conversation={liveConv}
                            messages={messages.filter(m => m.conversationId === liveConv.id)}
                            resolveName={resolveName}
                            currentUserId={currentUserId}
                            currentUserName={currentUserName}
                            otherParticipant={getOtherParticipant(liveConv)}
                            isOnline={getMemberOnlineStatus(getOtherParticipant(liveConv).id)}
                            onClose={handleCloseModal}
                            onSendMessage={onSendMessage}
                            onRetryMessage={onRetryMessage}
                            onUpdateConversationDetails={onUpdateConversationDetails}
                        />
                    </FullScreenPortal>
                );
            })()}

            {/* Edit Group Modal */}
            {editingGroup && onUpdateGroup && (
                <FullScreenPortal>
                    <EditGroupModal
                        conversation={editingGroup}
                        teamMembers={teamMembers.filter(m => m.id !== currentUserId)}
                        onClose={() => setEditingGroup(null)}
                        onSave={(groupName, participantIds, details) => {
                            onUpdateGroup(editingGroup.id, groupName, participantIds, details);
                            setEditingGroup(null);
                        }}
                    />
                </FullScreenPortal>
            )}

            {/* New Chat Modal */}
            {showNewChat && (
                <FullScreenPortal>
                    <NewChatModal
                        teamMembers={teamMembers.filter(m => m.id !== currentUserId)}
                        existingConvIds={conversations.flatMap(c => c.participantIds)}
                        onClose={() => setShowNewChat(false)}
                        onSelectMember={async (memberId, details) => {
                            try {
                                const conv = await onCreateConversation(memberId, details);
                                setShowNewChat(false);
                                handleConvClick(conv);
                            } catch { /* the reason is already shown; keep the picker open */ }
                        }}
                        canCreatePrivate={isAdmin}
                        onCreateGroup={async (participantIds, groupName, details, isPrivate) => {
                            try {
                                const conv = await onCreateGroup(participantIds, groupName, details, isPrivate);
                                setShowNewChat(false);
                                handleConvClick(conv);
                            } catch { /* the reason is already shown; keep the picker open */ }
                        }}
                    />
                </FullScreenPortal>
            )}

            <TypeDeleteDialog
                isOpen={!!deleteConvId}
                title={deletingPrivate ? 'Delete private room' : 'Delete conversation'}
                itemName={deletingPrivate ? 'this private room' : 'this conversation'}
                message={deletingPrivate ? 'its messages are deleted for everyone and not kept anywhere' : 'all of its messages are archived for admin review'}
                onClose={() => setDeleteConvId(null)}
                onConfirm={() => {
                    if (deleteConvId && onDeleteConversation) onDeleteConversation(deleteConvId);
                    setDeleteConvId(null);
                }}
            />
        </PageRoot>
    );
};

// ─── Chat Detail ────────────────────────────────────────

interface ChatDetailModalProps {
    conversation: Conversation;
    messages: Message[];
    resolveName: (id: string | undefined, storedName?: string) => string;
    currentUserId: string;
    currentUserName: string;
    otherParticipant: { name: string; id: string };
    isOnline: boolean;
    onClose: () => void;
    onSendMessage: (conversationId: string, text: string, tags: MessageTag[], replyTo?: MessageReplyTo, attachment?: MessageAttachment) => void;
    /** Resend a message the server never accepted. */
    onRetryMessage?: (messageId: string) => void;
    onUpdateConversationDetails: (conversationId: string, details: ConversationDetails) => void;
    /** Rendered as the right-hand pane of the desktop master-detail layout
     *  rather than as an overlay sheet over the whole app. */
    inline?: boolean;
}

const ChatDetailModal: React.FC<ChatDetailModalProps> = ({ conversation, messages, resolveName, currentUserId, otherParticipant, isOnline, onClose, onSendMessage, onRetryMessage, onUpdateConversationDetails, inline = false }) => {
    // Quoted replies store the sender's name at reply time; resolve it through
    // the original message so placeholders and renames show correctly.
    const replySenderName = (replyTo: MessageReplyTo) => {
        const original = messages.find(m => m.id === replyTo.id);
        return original ? resolveName(original.senderId, original.senderName) : resolveName(undefined, replyTo.senderName);
    };
    const [newMessage, setNewMessage] = useState('');
    const [selectedTags, setSelectedTags] = useState<Set<MessageTag>>(new Set());
    const [showTagPicker, setShowTagPicker] = useState(false);
    const [isEditingDetails, setIsEditingDetails] = useState(false);
    const [replyingTo, setReplyingTo] = useState<MessageReplyTo | null>(null);
    const [pendingAttachment, setPendingAttachment] = useState<MessageAttachment | null>(null);
    const [isUploading, setIsUploading] = useState(false);
    const [showSearch, setShowSearch] = useState(false);
    const [chatSearchQuery, setChatSearchQuery] = useState('');
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [detailsForm, setDetailsForm] = useState<ConversationDetails>({
        title: conversation.title || '',
        reason: conversation.reason || '',
        note: conversation.note || '',
    });
    // Opens on the latest message and stays there through late photos, syncing
    // messages and the keyboard — unless the reader scrolls up into history.
    const { scrollerRef, contentRef, scrollToLatest } = useStickToBottom(conversation.id);

    useEffect(() => {
        setDetailsForm({
            title: conversation.title || '',
            reason: conversation.reason || '',
            note: conversation.note || '',
        });
        setReplyingTo(null);
        setPendingAttachment(null);
        setShowSearch(false);
        setChatSearchQuery('');
    }, [conversation.id]);

    const handleSaveDetails = () => {
        onUpdateConversationDetails(conversation.id, {
            title: detailsForm.title?.trim() || undefined,
            reason: detailsForm.reason?.trim() || undefined,
            note: detailsForm.note?.trim() || undefined,
        });
        setIsEditingDetails(false);
    };

    const toggleTag = (tag: MessageTag) => {
        const newSet = new Set(selectedTags);
        if (newSet.has(tag)) newSet.delete(tag);
        else newSet.add(tag);
        setSelectedTags(newSet);
    };

    const uploadAttachment = async (file: File) => {
        setIsUploading(true);
        try {
            const result = await storageService.upload(file);
            setPendingAttachment({
                type: file.type.startsWith('image/') ? 'image' : 'file',
                url: result.url,
                name: file.name,
            });
        } catch (error) {
            console.error('Upload failed:', error);
            toast.error('Failed to upload file. Please try again.');
        } finally {
            setIsUploading(false);
        }
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file) void uploadAttachment(file);
    };

    // Camera button: snap a photo and attach it straight away.
    const camera = usePhotoCapture(([photo]) => { void uploadAttachment(photo); });

    const handleSend = () => {
        if (!newMessage.trim() && !pendingAttachment) return;
        scrollToLatest();
        onSendMessage(conversation.id, newMessage.trim(), Array.from(selectedTags), replyingTo ?? undefined, pendingAttachment ?? undefined);
        setNewMessage('');
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

    const formatMessageTime = (timestamp: number) => {
        return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    const displayedMessages = useMemo(() => {
        if (!chatSearchQuery.trim()) return messages;
        const q = chatSearchQuery.toLowerCase();
        return messages.filter(m => m.text.toLowerCase().includes(q));
    }, [messages, chatSearchQuery]);

    let statusTextColor = 'text-gray-600 dark:text-gray-300';
    if (isOnline) statusTextColor = 'text-green-500';

    let statusText = 'Offline';
    if (conversation.isGroup) statusText = `${conversation.participantIds.length} members`;
    else if (isOnline) statusText = 'Online';

    const renderMessageStatusIcon = (status?: string) => {
        if (status === 'read') return <CheckCheck size={12} className="text-sky-500 dark:text-sky-400" />;
        if (status === 'delivered') return <CheckCheck size={12} />;
        return <Check size={12} />;
    };

    // Rows are memoised so typing in the message box (state on this
    // component) doesn't rebuild every bubble of a long thread per keystroke.
    const messageRows = useMemo(() => displayedMessages.map((msg) => {
        const isMe = msg.senderId === currentUserId;
        const bubble = (
            <div className={`max-w-[80%] px-3.5 py-2.5 ${isMe ? 'neu-bubble-out' : 'neu-bubble-in'}`}>
                {!isMe && (
                    <p className="text-[11px] font-bold uppercase tracking-widest mb-1 text-gold-700 dark:text-gold-300">{resolveName(msg.senderId, msg.senderName)}</p>
                )}
                {msg.replyTo && (
                    <div className="mb-2 pl-2.5 pr-2 py-1.5 neu-inset rounded-xl border-l-2 border-gold-500">
                        <p className="text-[11px] font-bold text-gold-700 dark:text-gold-300">{replySenderName(msg.replyTo)}</p>
                        <p className="text-[11px] line-clamp-1 text-[var(--neu-text-dim)]">{msg.replyTo.text}</p>
                    </div>
                )}
                {msg.attachment && (
                    msg.attachment.type === 'image' ? (
                        <img loading="lazy" decoding="async" src={getThumbUrl(msg.attachment.url)} alt={msg.attachment.name} className="rounded-xl max-w-full max-h-48 object-cover mb-2" />
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
                    {isMe && msg.status === 'failed' ? (
                        <button
                            type="button"
                            onClick={() => onRetryMessage?.(msg.id)}
                            className="flex items-center gap-1 text-[11px] font-semibold shrink-0 ml-auto text-red-600 dark:text-red-400 active-scale"
                        >
                            <AlertCircle size={12} /> Not sent · Tap to retry
                        </button>
                    ) : (
                        <span className="flex items-center gap-1 text-[11px] shrink-0 ml-auto text-[var(--neu-text-dim)]">
                            {formatMessageTime(msg.timestamp)}
                            {isMe && renderMessageStatusIcon(msg.status)}
                        </span>
                    )}
                </div>
            </div>
        );
        const replyButton = (
            <button
                onClick={() => setReplyingTo({ id: msg.id, senderName: resolveName(msg.senderId, msg.senderName), text: msg.text || (msg.attachment ? msg.attachment.name : '') })}
                aria-label="Reply"
                className="p-1.5 mb-1 text-[var(--neu-text-dim)] hover:text-gold-600 dark:hover:text-gold-400 transition-colors shrink-0 active-scale"
            >
                <Reply size={14} />
            </button>
        );
        return (
            <div key={msg.id} className={`flex items-end gap-1.5 ${isMe ? 'justify-end' : 'justify-start'}`}>
                {!isMe && replyButton}
                {bubble}
                {isMe && replyButton}
            </div>
        );
    }), [displayedMessages, messages, currentUserId, resolveName, onRetryMessage]);

    const renderConversationDetails = () => {
        if (isEditingDetails) {
            return (
                <div className="py-3 space-y-2 animate-fade-in">
                    <input
                        value={detailsForm.title}
                        onChange={(e) => setDetailsForm(prev => ({ ...prev, title: e.target.value }))}
                        placeholder="Title"
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        className="neu-field text-xs"
                    />
                    <input
                        value={detailsForm.reason}
                        onChange={(e) => setDetailsForm(prev => ({ ...prev, reason: e.target.value }))}
                        placeholder="Why are we starting this?"
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        className="neu-field text-xs"
                    />
                    <textarea
                        value={detailsForm.note}
                        onChange={(e) => setDetailsForm(prev => ({ ...prev, note: e.target.value }))}
                        placeholder="Note"
                        rows={2}
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        className="neu-field text-xs"
                    />
                    <div className="flex justify-end gap-2 pt-1">
                        <button
                            onClick={() => setIsEditingDetails(false)}
                            className="neu-button text-[11px] uppercase tracking-wider px-3 py-1.5"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleSaveDetails}
                            className="text-[11px] font-medium uppercase tracking-wider text-gold-700 dark:text-gold-300 neu-inset px-3 py-1.5 rounded-lg flex items-center gap-1 transition-colors active-scale"
                        >
                            <Check size={12} /> Save
                        </button>
                    </div>
                </div>
            );
        }
        
        if (conversation.title || conversation.reason || conversation.note) {
            return (
                <div className="py-2.5 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                        {conversation.title && (
                            <p className="text-xs font-serif text-gray-900 dark:text-white truncate">{conversation.title}</p>
                        )}
                        {conversation.reason && (
                            <p className="text-[11px] text-gray-700 dark:text-gray-300 mt-0.5">{conversation.reason}</p>
                        )}
                        {conversation.note && (
                            <p className="text-[11px] text-gray-600 dark:text-gray-300 mt-0.5 italic">{conversation.note}</p>
                        )}
                    </div>
                    <button
                        onClick={() => setIsEditingDetails(true)}
                        className="neu-icon-btn-sm text-gray-600 dark:text-gray-300 active-scale"
                    >
                        <Edit2 size={14} />
                    </button>
                </div>
            );
        }
        
        return (
            <button
                onClick={() => setIsEditingDetails(true)}
                className="py-2.5 w-full text-left text-[11px] font-medium text-gold-700 dark:text-gold-300 uppercase tracking-wider flex items-center gap-1.5 active-scale"
            >
                <Plus size={12} /> Add title, reason &amp; note
            </button>
        );
    };

    return (
        <div className={inline
            ? 'flex-1 min-w-0 h-full flex flex-col bg-[var(--neu-bg)]'
            : 'neu-sheet z-50 animate-fade-in-up'}>
            {/* Chat Header */}
            <div className={`flex items-center gap-3 p-3 z-10 ${inline ? 'lg:px-5 lg:pt-5' : 'pt-[calc(1.75rem+var(--safe-top))]'}`}>
                {/* The list stays on screen beside this pane on desktop, so
                    there is nothing to go "back" to. */}
                {!inline && (
                    <button onClick={onClose} className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale" aria-label="Back to conversations">
                        <ArrowLeft size={20} />
                    </button>
                )}
                <div className="relative">
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center ${conversation.isGroup ? 'bg-gold-500/10 dark:bg-gold-900/20 text-gold-700 dark:text-gold-300' : 'neu-inset text-brand-900 dark:text-gold-400'
                        }`}>
                        {conversation.isGroup ? <Users size={16} strokeWidth={1.5} /> : <User size={16} strokeWidth={1.5} />}
                    </div>
                    {!conversation.isGroup && isOnline && (
                        <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-white dark:border-[#1a1a1a]"></div>
                    )}
                </div>
                <div className="flex-1">
                    <h2 className="text-sm font-serif text-gray-900 dark:text-white">{otherParticipant.name}</h2>
                    <p className={`text-[11px] uppercase tracking-widest font-medium ${statusTextColor}`}>
                        {statusText}
                    </p>
                </div>
                <button
                    onClick={() => { setShowSearch(s => !s); setChatSearchQuery(''); }}
                    className={`p-2 rounded-full transition-colors active-scale shrink-0 ${showSearch ? 'neu-raised-sm neu-btn text-gold-700 dark:text-gold-300' : 'text-gray-700 dark:text-gray-300'}`}
                >
                    <Search size={18} />
                </button>
            </div>

            {/* In-chat Search */}
            {showSearch && (
                <div className="px-3 py-2 animate-fade-in">
                    <SearchBar value={chatSearchQuery} onChange={setChatSearchQuery} placeholder="Search in this chat..." />
                </div>
            )}

            {/* Conversation Details (title / reason / note) */}
            <div className="px-3">
                {renderConversationDetails()}
            </div>

            {/* Messages — the message bar is in flow right below, and this
                sheet covers the dock, so there's nothing at the bottom to clear
                (it used to reserve the dock's 6rem: a blank band above the bar). */}
            <div
                ref={scrollerRef}
                className={`flex-1 overflow-y-auto overscroll-contain p-4 md:p-6 no-scrollbar neu-scroll-fade w-full ${inline ? '' : 'lg:max-w-5xl lg:mx-auto'}`}
            >
                <div ref={contentRef} className="space-y-3.5">
                    {displayedMessages.length === 0 && chatSearchQuery.trim() && (
                        <div className="text-center text-gray-600 dark:text-gray-300 mt-10 font-light text-sm">
                            No messages match "{chatSearchQuery}".
                        </div>
                    )}
                    {messageRows}
                </div>
            </div>

            {/* Tag Picker */}
            {showTagPicker && (
                <div className="px-3 py-2 animate-fade-in">
                    <div className="flex gap-1.5 flex-wrap">
                        {ALL_TAGS.map(tag => (
                            <button
                                key={tag}
                                onClick={() => toggleTag(tag)}
                                className={`text-[11px] px-2.5 py-1 rounded-full font-bold uppercase tracking-wider transition-all active-scale ${selectedTags.has(tag)
                                    ? 'neu-raised-sm neu-btn text-gold-700 dark:text-gold-300'
                                    : TAG_COLORS[tag] + ''
                                    }`}
                            >
                                {tag}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* Message Input — bottom padding follows the iPhone home indicator
                so the bar is never cropped, even with reply/tag previews stacked */}
            <div
                className="px-3 pt-[9px] transition-colors"
                style={{ paddingBottom: 'calc(9px + var(--safe-bottom-tucked))' }}
            >
                {replyingTo && (
                    <div className="flex items-center justify-between gap-2 mb-2 pl-3 pr-2 py-1.5 neu-raised-sm neu-btn rounded-lg border-l-2 border-gold-500 animate-fade-in">
                        <div className="min-w-0">
                            <p className="text-[11px] font-bold text-gold-700 dark:text-gold-300">Replying to {replyingTo.senderName}</p>
                            <p className="text-[11px] text-gray-700 dark:text-gray-300 truncate">{replyingTo.text}</p>
                        </div>
                        <button onClick={() => setReplyingTo(null)} className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 shrink-0 active-scale">
                            <X size={14} />
                        </button>
                    </div>
                )}
                {pendingAttachment && (
                    <div className="flex items-center justify-between gap-2 mb-2 p-2 neu-raised-sm neu-btn rounded-lg animate-fade-in">
                        <div className="flex items-center gap-2 min-w-0">
                            {pendingAttachment.type === 'image' ? (
                                <img loading="lazy" decoding="async" src={getThumbUrl(pendingAttachment.url)} alt={pendingAttachment.name} className="w-10 h-10 rounded-[4px] object-cover shrink-0" />
                            ) : (
                                <div className="w-10 h-10 rounded-[4px] neu-inset flex items-center justify-center text-gray-700 dark:text-gray-300 shrink-0">
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
                {selectedTags.size > 0 && (
                    <div className="flex gap-1 mb-2 flex-wrap">
                        {Array.from(selectedTags).map(tag => (
                            <span key={tag} className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider flex items-center gap-1 ${TAG_COLORS[tag]}`}>
                                {tag}
                                <button onClick={() => toggleTag(tag)} className="hover:opacity-70"><X size={8} /></button>
                            </span>
                        ))}
                    </div>
                )}
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setShowTagPicker(!showTagPicker)}
                        className={`p-2.5 rounded-full transition-colors active-scale shrink-0 ${showTagPicker ? 'neu-raised-sm neu-btn text-gold-700 dark:text-gold-300' : 'text-gray-600 dark:text-gray-300'
                            }`}
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
                    <input type="file" accept="image/*,.pdf,.doc,.docx,.txt" ref={fileInputRef} className="hidden" onChange={handleFileChange} />
                    {camera.inputs}
                    {/* A one-line textarea, not an input: Chrome on Android never puts
                        its autofill bar (passwords, cards, addresses) over a textarea. */}
                    <textarea
                        rows={1}
                        value={newMessage}
                        onChange={(e) => setNewMessage(e.target.value)}
                        onKeyDown={handleKeyDown}
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
                        disabled={!newMessage.trim() && !pendingAttachment}
                        className={`p-2.5 rounded-full transition-all active-scale shrink-0 ${newMessage.trim() || pendingAttachment
                            ? 'neu-accent'
                            : 'bg-gray-200 dark:bg-gray-800 text-gray-600 dark:text-gray-300'
                            }`}
                    >
                        <Send size={18} />
                    </button>
                </div>
            </div>
        </div>
    );
};

// ─── New Chat Modal ────────────────────────────────────────

interface EditGroupModalProps {
    conversation: Conversation;
    teamMembers: UserProfile[];
    onClose: () => void;
    onSave: (groupName: string, participantIds: string[], details: ConversationDetails) => void;
}

const EditGroupModal: React.FC<EditGroupModalProps> = ({ conversation, teamMembers, onClose, onSave }) => {
    const [groupName, setGroupName] = useState(conversation.groupName || '');
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set(conversation.participantIds));
    const [title, setTitle] = useState(conversation.title || '');
    const [reason, setReason] = useState(conversation.reason || '');
    const [note, setNote] = useState(conversation.note || '');

    useEffect(() => {
        setGroupName(conversation.groupName || '');
        setSelectedIds(new Set(conversation.participantIds));
        setTitle(conversation.title || '');
        setReason(conversation.reason || '');
        setNote(conversation.note || '');
    }, [conversation.id]);

    const toggleMember = (id: string) => {
        const next = new Set(selectedIds);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setSelectedIds(next);
    };

    const canSave = groupName.trim().length > 0 && selectedIds.size >= 2;

    return (
        <div className="neu-sheet z-[60] animate-fade-in-up">
            <div className="flex justify-between items-center p-3 pt-[calc(1.75rem+var(--safe-top))] z-10">
                <button onClick={onClose} className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale">
                    <X size={20} />
                </button>
                <h2 className="text-base font-serif text-gray-900 dark:text-white">Edit Group</h2>
                <div className="w-9"></div>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-5 no-scrollbar">
                <div>
                    <label htmlFor="edit-group-name" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1.5 uppercase tracking-wider">Group Name</label>
                    <input
                        id="edit-group-name"
                        value={groupName}
                        onChange={(e) => setGroupName(e.target.value)}
                        placeholder="e.g. Sales Team"
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        className="neu-field"
                    />
                </div>
                <div>
                    <div className="flex items-center justify-between mb-3 px-1">
                        <h3 className="text-[11px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest">Members</h3>
                        <span className="text-[11px] neu-inset px-2 py-0.5 rounded-[3px] text-gray-600 dark:text-gray-300 uppercase tracking-wider">{selectedIds.size} selected</span>
                    </div>
                    <div className="space-y-2">
                        {teamMembers.map((member, index) => {
                            const isSelected = selectedIds.has(member.id);
                            return (
                                <button
                                    type="button"
                                    key={member.id}
                                    onClick={() => toggleMember(member.id)}
                                    className={`w-full text-left rounded-lg shadow-sm p-3 flex items-center gap-3 border animate-fade-in-up cursor-pointer active-scale ${isSelected ? "border-gold-500 bg-gold-50/50 dark:bg-gold-900/10" : "neu-raised border-gray-100 dark:border-gray-800"}`}
                                    style={{ animationDelay: `${index * 45}ms` }}
                                >
                                    <div className="relative">
                                        <div className="w-11 h-11 rounded-full neu-inset flex items-center justify-center text-brand-900 dark:text-gold-400">
                                            <User size={20} strokeWidth={1.5} />
                                        </div>
                                        {member.isOnline && (
                                            <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-white dark:border-[#1e1e1e]"></div>
                                        )}
                                    </div>
                                    <div className="flex-1">
                                        <h3 className="font-serif text-gray-900 dark:text-gray-100 text-sm">{member.name}</h3>
                                        <p className={"text-[11px] uppercase tracking-widest font-medium " + (member.isOnline ? "text-green-500" : "text-gray-600 dark:text-gray-300")}>
                                            {member.isOnline ? "Online" : "Offline"}
                                        </p>
                                    </div>
                                    <div className={"w-5 h-5 rounded-full flex items-center justify-center transition-colors shrink-0 " + (isSelected ? "neu-check-on" : "neu-check")}>
                                        {isSelected && <Check size={12} />}
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </div>

                <div>
                    <label htmlFor="create-announcement-title" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1.5 uppercase tracking-wider">Title</label>
                    <input
                        id="create-announcement-title"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="e.g. End of Month Sales"
                        autoComplete="off"
                        className="neu-field"
                    />
                </div>
                <div>
                    <label htmlFor="create-announcement-reason" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1.5 uppercase tracking-wider">Why are we starting this?</label>
                    <input
                        id="create-announcement-reason"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="e.g. To hit our targets"
                        autoComplete="off"
                        className="neu-field"
                    />
                </div>
                <div>
                    <label htmlFor="create-announcement-note" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1.5 uppercase tracking-wider">Note</label>
                    <textarea
                        id="create-announcement-note"
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder="Any additional details..."
                        rows={3}
                        className="neu-field"
                    />
                </div>

                <button
                    onClick={() => canSave && onSave(groupName.trim(), Array.from(selectedIds), { title: title.trim() || undefined, reason: reason.trim() || undefined, note: note.trim() || undefined })}
                    disabled={!canSave}
                    className={"w-full rounded-lg py-3 text-sm font-medium tracking-wide transition-colors shadow-md active-scale " + (canSave ? "neu-raised-sm neu-btn text-gold-700 dark:text-gold-300" : "bg-gray-200 dark:bg-gray-800 text-gray-600 dark:text-gray-300")}
                >
                    Save Changes
                </button>
            </div>
        </div>
    );
};
interface NewChatModalProps {
    teamMembers: UserProfile[];
    existingConvIds: string[];
    onClose: () => void;
    onSelectMember: (memberId: string, details?: ConversationDetails) => void;
    onCreateGroup: (participantIds: string[], groupName: string, details: ConversationDetails, isPrivate: boolean) => void;
    /** Admins may make the group a private room. */
    canCreatePrivate?: boolean;
}

const NewChatModal: React.FC<NewChatModalProps> = ({ teamMembers, onClose, onSelectMember, onCreateGroup, canCreatePrivate = false }) => {
    const [mode, setMode] = useState<'direct' | 'group'>('direct');
    const [startingId, setStartingId] = useState<string | null>(null);
    const [formData, setFormData] = useState<ConversationDetails>({ title: '', reason: '', note: '' });
    const [groupName, setGroupName] = useState('');
    const [selectedGroupMemberIds, setSelectedGroupMemberIds] = useState<Set<string>>(new Set());
    const [isPrivate, setIsPrivate] = useState(false);

    // 1-on-1 chats start immediately on member tap — no title/reason form beforehand.
    const handleSelectMember = (member: UserProfile) => {
        if (startingId) return; // guard against double-tap while the conversation is created
        setStartingId(member.id);
        onSelectMember(member.id);
    };

    const toggleGroupMember = (memberId: string) => {
        const newSet = new Set(selectedGroupMemberIds);
        if (newSet.has(memberId)) newSet.delete(memberId);
        else newSet.add(memberId);
        setSelectedGroupMemberIds(newSet);
    };

    const canCreateGroup = groupName.trim().length > 0 && selectedGroupMemberIds.size > 0;

    const handleCreateGroup = () => {
        if (!canCreateGroup) return;
        onCreateGroup(Array.from(selectedGroupMemberIds), groupName.trim(), {
            title: formData.title?.trim() || undefined,
            reason: formData.reason?.trim() || undefined,
            note: formData.note?.trim() || undefined,
        }, canCreatePrivate && isPrivate);
    };

    const groupTitle = isPrivate ? 'New Private Room' : 'New Group';
    const headerTitle = mode === 'group' ? groupTitle : 'New Message';

    return (
        <div className="neu-sheet z-[60] animate-fade-in-up">
            <div className="flex justify-between items-center p-3 pt-[calc(1.75rem+var(--safe-top))] z-10">
                <button
                    onClick={onClose}
                    className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale"
                >
                    <X size={20} />
                </button>
                <h2 className="text-base font-serif text-gray-900 dark:text-white">
                    {headerTitle}
                </h2>
                <div className="w-9"></div>
            </div>

            <div className="px-3 pb-2.5 flex gap-2">
                    <button
                        onClick={() => setMode('direct')}
                        className={`flex-1 py-2 rounded-lg text-[11px] font-bold uppercase tracking-widest transition-all active-scale ${mode === 'direct'
                            ? 'neu-inset text-gold-700 dark:text-gold-300'
                            : 'neu-raised-sm neu-btn text-gray-700 dark:text-gray-300'
                            }`}
                    >
                        Direct Message
                    </button>
                    <button
                        onClick={() => setMode('group')}
                        className={`flex-1 py-2 rounded-lg text-[11px] font-bold uppercase tracking-widest transition-all active-scale ${mode === 'group'
                            ? 'neu-inset text-gold-700 dark:text-gold-300'
                            : 'neu-raised-sm neu-btn text-gray-700 dark:text-gray-300'
                            }`}
                    >
                        New Group
                    </button>
                </div>

            {mode === 'direct' && (
                <div className="flex-1 overflow-y-auto p-3 space-y-2 no-scrollbar">
                    <h3 className="text-[11px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest mb-3 px-1">Team Members</h3>
                    {teamMembers.length === 0 ? (
                        <div className="text-center py-16 px-6 animate-fade-in">
                            <div className="w-16 h-16 rounded-full neu-inset flex items-center justify-center mx-auto mb-4 text-gray-600 dark:text-gray-300">
                                <Users size={28} strokeWidth={1.5} />
                            </div>
                            <p className="text-sm font-serif text-gray-700 dark:text-gray-200 mb-1.5">No team members yet</p>
                            <p className="text-xs text-gray-600 dark:text-gray-300 font-light leading-relaxed">
                                Ask an admin to add team members from the User Management screen so you can start messaging.
                            </p>
                        </div>
                    ) : teamMembers.map((member, index) => (
                        <button
                            type="button"
                            key={member.id}
                            onClick={() => handleSelectMember(member)}
                            className="w-full text-left neu-raised rounded-2xl p-3 flex items-center gap-3 animate-fade-in-up cursor-pointer active-scale"
                            style={{ animationDelay: `${index * 45}ms` }}
                        >
                            <div className="relative">
                                <div className="w-11 h-11 rounded-full neu-inset flex items-center justify-center text-brand-900 dark:text-gold-400">
                                    <User size={20} strokeWidth={1.5} />
                                </div>
                                {member.isOnline && (
                                    <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-white dark:border-[#1e1e1e]"></div>
                                )}
                            </div>
                            <div className="flex-1">
                                <h3 className="font-serif text-gray-900 dark:text-gray-100 text-sm">{member.name}</h3>
                                <p className={`text-[11px] uppercase tracking-widest font-medium ${member.isOnline ? 'text-green-500' : 'text-gray-600 dark:text-gray-300'}`}>
                                    {member.isOnline ? 'Online' : 'Offline'}
                                </p>
                            </div>
                            {startingId === member.id
                                ? <Loader2 size={18} className="text-gray-600 dark:text-gray-300 animate-spin" />
                                : <MessageCircle size={18} className="text-gray-600 dark:text-gray-300" />}
                        </button>
                    ))}
                </div>
            )}

            {mode === 'group' && (
                <div className="flex-1 overflow-y-auto p-3 space-y-5 no-scrollbar">
                    <div>
                        <label htmlFor="create-group-name" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1.5 uppercase tracking-wider">Group Name</label>
                        <input
                            id="create-group-name"
                            value={groupName}
                            onChange={(e) => setGroupName(e.target.value)}
                            placeholder="e.g. Sales Team"
                            className="neu-field"
                        />
                    </div>

                    {canCreatePrivate && (
                        <ToggleRow
                            icon={<Lock size={16} />}
                            title="Private room"
                            description="Only the people you add can see it, including other admins. Only you, or an admin you add, can change or delete it."
                            checked={isPrivate}
                            onChange={() => setIsPrivate(v => !v)}
                        />
                    )}

                    <div>
                        <div className="flex items-center justify-between mb-3 px-1">
                            <h3 className="text-[11px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest">Add Members</h3>
                            <span className="text-[11px] neu-inset px-2 py-0.5 rounded-[3px] text-gray-600 dark:text-gray-300 uppercase tracking-wider">{selectedGroupMemberIds.size} selected</span>
                        </div>
                        <div className="space-y-2">
                            {teamMembers.length === 0 ? (
                                <div className="text-center py-12 px-6 animate-fade-in">
                                    <p className="text-sm font-serif text-gray-700 dark:text-gray-200 mb-1.5">No team members to add</p>
                                    <p className="text-xs text-gray-600 dark:text-gray-300 font-light leading-relaxed">
                                        Ask an admin to add team members first.
                                    </p>
                                </div>
                            ) : teamMembers.map((member, index) => {
                                const isSelected = selectedGroupMemberIds.has(member.id);
                                return (
                                    <button
                                        type="button"
                                        key={member.id}
                                        onClick={() => toggleGroupMember(member.id)}
                                        className={`w-full text-left rounded-lg shadow-sm p-3 flex items-center gap-3 border animate-fade-in-up cursor-pointer active-scale ${isSelected ? 'border-gold-500 bg-gold-50/50 dark:bg-gold-900/10' : 'neu-raised border-gray-100 dark:border-gray-800'
                                            }`}
                                        style={{ animationDelay: `${index * 45}ms` }}
                                    >
                                        <div className="relative">
                                            <div className="w-11 h-11 rounded-full neu-inset flex items-center justify-center text-brand-900 dark:text-gold-400">
                                                <User size={20} strokeWidth={1.5} />
                                            </div>
                                            {member.isOnline && (
                                                <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-white dark:border-[#1e1e1e]"></div>
                                            )}
                                        </div>
                                        <div className="flex-1">
                                            <h3 className="font-serif text-gray-900 dark:text-gray-100 text-sm">{member.name}</h3>
                                            <p className={`text-[11px] uppercase tracking-widest font-medium ${member.isOnline ? 'text-green-500' : 'text-gray-600 dark:text-gray-300'}`}>
                                                {member.isOnline ? 'Online' : 'Offline'}
                                            </p>
                                        </div>
                                        <div className={`w-5 h-5 rounded-full flex items-center justify-center transition-colors shrink-0 ${isSelected ? 'neu-check-on' : 'neu-check'
                                            }`}>
                                            {isSelected && <Check size={12} />}
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    <div>
                        <label htmlFor="create-group-title" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1.5 uppercase tracking-wider">Title</label>
                        <input
                            id="create-group-title"
                            value={formData.title}
                            onChange={(e) => setFormData(prev => ({ ...prev, title: e.target.value }))}
                            placeholder="What's this conversation about?"
                            className="neu-field"
                        />
                    </div>
                    <div>
                        <label htmlFor="create-group-reason" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1.5 uppercase tracking-wider">Why are we starting this?</label>
                        <input
                            id="create-group-reason"
                            value={formData.reason}
                            onChange={(e) => setFormData(prev => ({ ...prev, reason: e.target.value }))}
                            placeholder="Reason for reaching out"
                            className="neu-field"
                        />
                    </div>
                    <div>
                        <label htmlFor="create-group-note" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1.5 uppercase tracking-wider">Note</label>
                        <textarea
                            id="create-group-note"
                            value={formData.note}
                            onChange={(e) => setFormData(prev => ({ ...prev, note: e.target.value }))}
                            placeholder="Any extra context (optional)"
                            rows={3}
                            className="neu-field"
                        />
                    </div>

                    <button
                        onClick={handleCreateGroup}
                        disabled={!canCreateGroup}
                        className={`w-full rounded-lg py-3 text-sm font-medium tracking-wide transition-colors shadow-md active-scale ${canCreateGroup
                            ? 'neu-raised-sm neu-btn text-gold-700 dark:text-gold-300'
                            : 'bg-gray-200 dark:bg-gray-800 text-gray-600 dark:text-gray-300'
                            }`}
                    >
                        Create Group
                    </button>
                </div>
            )}
        </div>
    );
};
