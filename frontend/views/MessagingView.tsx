import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Search, Send, ArrowLeft, Tag, User, Users, MessageCircle, Plus, X, Edit2, Check, CheckCheck, Pin, Archive, MoreVertical, Paperclip, Reply, Loader2, Eye, Trash2 } from 'lucide-react';
import { Conversation, ConversationDetails, Message, MessageTag, MessageReplyTo, MessageAttachment, UserProfile } from '../types';
import { FullScreenPortal } from '../components/FullScreenPortal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import storageService from '../services/storageService';

interface MessagingViewProps {
    conversations: Conversation[];
    messages: Message[];
    teamMembers: UserProfile[];
    currentUserId: string;
    currentUserName: string;
    isAdmin?: boolean;
    onSendMessage: (conversationId: string, text: string, tags: MessageTag[], replyTo?: MessageReplyTo, attachment?: MessageAttachment) => void;
    onCreateConversation: (participantId: string, details?: ConversationDetails) => Promise<Conversation>;
    onCreateGroup: (participantIds: string[], groupName: string, details?: ConversationDetails) => Promise<Conversation>;
    onUpdateConversationDetails: (conversationId: string, details: ConversationDetails) => void;
    onUpdateGroup?: (conversationId: string, groupName: string, participantIds: string[], details?: ConversationDetails) => void;
    onTogglePinConversation: (conversationId: string) => void;
    onToggleArchiveConversation: (conversationId: string) => void;
    onDeleteConversation?: (conversationId: string) => void;
    onAdminAdvanceViewChange?: (enabled: boolean) => void;
}

export const TAG_COLORS: Record<MessageTag, string> = {
    'General': 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400',
    'Urgent': 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400',
    'Follow-up': 'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
    'Artwork': 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400',
    'Inquiry': 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-600 dark:text-yellow-400',
    'Invoice': 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400',
};

export const ALL_TAGS: MessageTag[] = ['General', 'Urgent', 'Follow-up', 'Artwork', 'Inquiry', 'Invoice'];

export const MessagingView: React.FC<MessagingViewProps> = ({ conversations, messages, teamMembers, currentUserId, currentUserName, isAdmin, onSendMessage, onCreateConversation, onCreateGroup, onUpdateConversationDetails, onUpdateGroup, onTogglePinConversation, onToggleArchiveConversation, onDeleteConversation, onAdminAdvanceViewChange }) => {
    const [selectedConv, setSelectedConv] = useState<Conversation | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [showNewChat, setShowNewChat] = useState(false);
    const [showArchived, setShowArchived] = useState(false);
    const [openMenuId, setOpenMenuId] = useState<string | null>(null);
    const [adminAdvanceView, setAdminAdvanceView] = useState(false);
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

    const toggleAdvanceView = () => {
        const next = !adminAdvanceView;
        setAdminAdvanceView(next);
        onAdminAdvanceViewChange?.(next);
    };

    const onlineMembers = useMemo(() => teamMembers.filter(m => m.isOnline && m.id !== currentUserId), [teamMembers, currentUserId]);

    const groupConversations = useMemo(() => conversations.filter(c => c.isGroup), [conversations]);

    const matchesSearch = (c: Conversation) => {
        if (!searchQuery.trim()) return true;
        const q = searchQuery.toLowerCase();
        return c.participantNames.some(n => n.toLowerCase().includes(q)) || c.lastMessage.toLowerCase().includes(q);
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
        // In admin advance view, the current user may not be a participant.
        // Show the first participant that isn't the current user, or just the first.
        if (idx === -1) {
            return {
                name: conv.participantNames[0] || 'Unknown',
                id: conv.participantIds[0] || conv.id,
            };
        }
        const otherIdx = idx === 0 ? 1 : 0;
        return {
            name: conv.participantNames[otherIdx] || conv.participantNames[0],
            id: conv.participantIds[otherIdx] || conv.participantIds[0],
        };
    };

    // In admin advance view, show a descriptive label for conversations the
    // admin is not part of (e.g. "A ↔ B" for 1-to-1 chats between other users)
    const getConvDisplayName = (conv: Conversation) => {
        if (conv.isGroup) return conv.groupName || 'Group';
        if (adminAdvanceView && !conv.participantIds.includes(currentUserId)) {
            return conv.participantNames.join(' ↔ ');
        }
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
        const isForeign = adminAdvanceView && !conv.participantIds.includes(currentUserId);
        return (
            <div key={conv.id} className="relative">
                <button
                    type="button"
                    onClick={() => { setOpenMenuId(null); handleConvClick(conv); }}
                    className="w-full text-left bg-white dark:bg-[#1e1e1e] rounded-[6px] shadow-sm p-[6px] flex items-center gap-2 border border-gray-100 dark:border-gray-800 animate-fade-in-up cursor-pointer active-scale"
                    style={{ animationDelay: `${150 + index * 50}ms` }}
                >
                    <div className="relative shrink-0">
                        <div className="w-11 h-11 rounded-full bg-gray-50 dark:bg-gray-800 flex items-center justify-center text-brand-900 dark:text-gold-400">
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
                                    <p className="text-[8px] font-bold text-gold-600 dark:text-gold-400 uppercase tracking-widest truncate">{conv.title}</p>
                                )}
                            </div>
                        )}
                        <div className="flex justify-between items-baseline">
                            <h3 className="font-serif text-gray-900 dark:text-gray-100 text-sm truncate">{displayName}</h3>
                            <span className="text-[9px] text-gray-400 dark:text-gray-500 shrink-0 ml-2">{formatTime(conv.lastMessageTime)}</span>
                        </div>
                        <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-1 font-light">{conv.lastMessage}</p>
                    </div>
                    {conv.unreadCount > 0 && (
                        <div className="w-5 h-5 rounded-full bg-gold-500 text-white text-[9px] font-bold flex items-center justify-center shrink-0">
                            {conv.unreadCount}
                        </div>
                    )}
                    <button
                        onClick={(e) => { e.stopPropagation(); setOpenMenuId(isMenuOpen ? null : conv.id); }}
                        className="p-1.5 text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale shrink-0"
                    >
                        <MoreVertical size={16} />
                    </button>
                </button>
                {isMenuOpen && (
                    <div className="absolute right-2 top-full mt-1 z-20 bg-white dark:bg-[#262626] rounded-[6px] shadow-lg border border-gray-100 dark:border-gray-700 overflow-hidden animate-scale-in">
                        {conv.isGroup && onUpdateGroup && (
                            <button
                                onClick={(e) => { e.stopPropagation(); setOpenMenuId(null); setEditingGroup(conv); }}
                                className="w-full flex items-center gap-2 px-[6px] py-2.5 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors whitespace-nowrap"
                            >
                                <Edit2 size={14} /> Edit Group
                            </button>
                        )}
                        {!isForeign && (
                            <>
                                <button
                                    onClick={(e) => { e.stopPropagation(); onTogglePinConversation(conv.id); setOpenMenuId(null); }}
                                    className="w-full flex items-center gap-2 px-[6px] py-2.5 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors whitespace-nowrap"
                                >
                                    <Pin size={14} /> {conv.isPinned ? 'Unpin' : 'Pin'}
                                </button>
                                <button
                                    onClick={(e) => { e.stopPropagation(); onToggleArchiveConversation(conv.id); setOpenMenuId(null); }}
                                    className="w-full flex items-center gap-2 px-[6px] py-2.5 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors border-t border-gray-100 dark:border-gray-700 whitespace-nowrap"
                                >
                                    <Archive size={14} /> {conv.isArchived ? 'Unarchive' : 'Archive'}
                                </button>
                                {conv.isArchived && onDeleteConversation && (
                                    <button
                                        onClick={(e) => { e.stopPropagation(); setDeleteConvId(conv.id); setOpenMenuId(null); }}
                                        className="w-full flex items-center gap-2 px-[6px] py-2.5 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors border-t border-gray-100 dark:border-gray-700 whitespace-nowrap"
                                    >
                                        <Trash2 size={14} /> Delete
                                    </button>
                                )}
                            </>
                        )}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="h-full flex flex-col bg-[#faf9f6] dark:bg-[#121212] transition-colors duration-500 animate-fade-in">
            {/* Header */}
            <div className="bg-white dark:bg-[#1a1a1a] px-[6px] pt-[calc(1.75rem+env(safe-area-inset-top,0px))] pb-[6px] shadow-sm z-10 border-b border-gray-100 dark:border-gray-800">
                <div className="flex justify-between items-center mb-[6px]">
                    <h1 className="text-xl font-serif text-gray-900 dark:text-white">Messages</h1>
                    <div className="flex items-center gap-2">
                        {isAdmin && (
                            <button
                                onClick={toggleAdvanceView}
                                className={`flex items-center gap-1.5 px-[6px] py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all active-scale ${adminAdvanceView
                                    ? 'bg-gold-500 text-white dark:text-brand-950 shadow-md'
                                    : 'bg-gray-100 dark:bg-[#2a2a2a] text-gray-500 dark:text-gray-400'
                                    }`}
                                title="Show all conversations across the team"
                            >
                                <Eye size={14} /> Advance
                            </button>
                        )}
                        <button
                            onClick={() => setShowNewChat(true)}
                            className="bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 p-1.5 rounded-full shadow-md hover:bg-brand-800 dark:hover:bg-gold-400 transition-colors active-scale"
                        >
                            <Plus size={20} />
                        </button>
                    </div>
                </div>
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 dark:text-gray-500" size={16} />
                    <input
                        type="text"
                        placeholder="Search conversations..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2 pl-9 pr-4 text-xs text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                    />
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-[6px] space-y-4 no-scrollbar pb-8">
                {/* Group Chats */}
                {groupConversations.length > 0 && (
                    <div className="space-y-2 animate-fade-in-up">
                        {groupConversations.map((group) => (
                            <div key={group.id} className="relative">
                                <button
                                    type="button"
                                    onClick={() => { setOpenMenuId(null); handleConvClick(group); }}
                                    className="w-full bg-white dark:bg-[#1e1e1e] rounded-[6px] shadow-sm p-[6px] flex items-center gap-[6px] border border-gold-300 dark:border-gold-700 text-left cursor-pointer"
                                >
                                    <div className="w-11 h-11 rounded-full bg-gold-500/10 dark:bg-gold-900/20 flex items-center justify-center text-gold-600 dark:text-gold-400 shrink-0">
                                        <Users size={20} strokeWidth={1.5} />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <h3 className="font-serif text-gray-900 dark:text-gray-100 text-sm">{group.groupName || 'Group'}</h3>
                                        <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-1 font-light">
                                            {group.participantIds.length} members • {group.lastMessage || 'No messages yet'}
                                        </p>
                                    </div>
                                    <button
                                        onClick={(e) => { e.stopPropagation(); setOpenMenuId(openMenuId === group.id ? null : group.id); }}
                                        className="p-1.5 text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale shrink-0"
                                    >
                                        <MoreVertical size={16} />
                                    </button>
                                </button>
                                {openMenuId === group.id && (
                                    <div className="absolute right-2 top-full mt-1 z-20 bg-white dark:bg-[#262626] rounded-[6px] shadow-lg border border-gray-100 dark:border-gray-700 overflow-hidden animate-scale-in">
                                        {onUpdateGroup && (
                                            <button
                                                onClick={(e) => { e.stopPropagation(); setOpenMenuId(null); setEditingGroup(group); }}
                                                className="w-full flex items-center gap-2 px-[6px] py-2.5 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors whitespace-nowrap"
                                            >
                                                <Edit2 size={14} /> Edit Group
                                            </button>
                                        )}
                                        {onDeleteConversation && (
                                            <button
                                                onClick={(e) => { e.stopPropagation(); setDeleteConvId(group.id); setOpenMenuId(null); }}
                                                className="w-full flex items-center gap-2 px-[6px] py-2.5 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors border-t border-gray-100 dark:border-gray-700 whitespace-nowrap"
                                            >
                                                <Trash2 size={14} /> Delete
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
                        <h2 className="text-[10px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest mb-[6px] px-1">Online Now</h2>
                        <div className="flex gap-[6px] overflow-x-auto no-scrollbar pb-1">
                            {onlineMembers.map((member) => (
                                <div key={member.id} className="flex flex-col items-center gap-1.5 shrink-0">
                                    <div className="relative">
                                        <div className="w-12 h-12 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-brand-900 dark:text-gold-400 border-2 border-green-400 dark:border-green-500">
                                            <User size={20} strokeWidth={1.5} />
                                        </div>
                                        <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 rounded-full border-2 border-white dark:border-[#121212]"></div>
                                    </div>
                                    <span className="text-[9px] text-gray-600 dark:text-gray-400 font-medium text-center w-14 truncate">{member.name.split(' ')[0]}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Pinned Conversations */}
                {pinnedConversations.length > 0 && (
                    <div className="animate-fade-in-up" style={{ animationDelay: '80ms' }}>
                        <h2 className="text-[10px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest mb-[6px] px-1 flex items-center gap-1">
                            <Pin size={10} /> Pinned
                        </h2>
                        <div className="space-y-2">
                            {pinnedConversations.map((conv, index) => renderConversationRow(conv, index))}
                        </div>
                    </div>
                )}

                {/* Conversations List */}
                <div>
                    <h2 className="text-[10px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest mb-[6px] px-1 animate-fade-in-up" style={{ animationDelay: '100ms' }}>Conversations</h2>
                    <div className="space-y-2">
                        {filteredConversations.map((conv, index) => renderConversationRow(conv, index))}
                        {filteredConversations.length === 0 && pinnedConversations.length === 0 && (
                            <div className="text-center text-gray-400 dark:text-gray-500 mt-10 font-light text-sm">
                                No conversations found.
                            </div>
                        )}
                    </div>
                </div>

                {/* Archived Link */}
                {archivedConversations.length > 0 && (
                    <button
                        onClick={() => setShowArchived(true)}
                        className="w-full text-center text-[10px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider py-2 flex items-center justify-center gap-1.5 active-scale"
                    >
                        <Archive size={12} /> Archived ({archivedConversations.length})
                    </button>
                )}
            </div>

            {/* Archived Conversations */}
            {showArchived && (
                <FullScreenPortal>
                    <div className="absolute inset-0 bg-[#faf9f6] dark:bg-[#121212] z-50 flex flex-col animate-fade-in-up">
                        <div className="bg-white dark:bg-[#1a1a1a] flex items-center gap-[6px] p-[6px] border-b border-gray-100 dark:border-gray-800 pt-[calc(1.75rem+env(safe-area-inset-top,0px))] shadow-sm z-10">
                            <button onClick={() => setShowArchived(false)} className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale">
                                <ArrowLeft size={20} />
                            </button>
                            <h2 className="text-base font-serif text-gray-900 dark:text-white">Archived</h2>
                        </div>
                        <div className="flex-1 overflow-y-auto p-[6px] space-y-2 no-scrollbar">
                            {archivedConversations.map((conv, index) => renderConversationRow(conv, index))}
                            {archivedConversations.length === 0 && (
                                <div className="text-center text-gray-400 dark:text-gray-500 mt-10 font-light text-sm">
                                    No archived conversations.
                                </div>
                            )}
                        </div>
                    </div>
                </FullScreenPortal>
            )}

            {/* Chat Detail Modal */}
            {selectedConv && (() => {
                const liveConv = conversations.find(c => c.id === selectedConv.id) || selectedConv;
                return (
                    <FullScreenPortal>
                        <ChatDetailModal
                            conversation={liveConv}
                            messages={messages.filter(m => m.conversationId === liveConv.id)}
                            currentUserId={currentUserId}
                            currentUserName={currentUserName}
                            otherParticipant={getOtherParticipant(liveConv)}
                            isOnline={getMemberOnlineStatus(getOtherParticipant(liveConv).id)}
                            onClose={handleCloseModal}
                            onSendMessage={onSendMessage}
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
                            const conv = await onCreateConversation(memberId, details);
                            setShowNewChat(false);
                            handleConvClick(conv);
                        }}
                        onCreateGroup={async (participantIds, groupName, details) => {
                            const conv = await onCreateGroup(participantIds, groupName, details);
                            setShowNewChat(false);
                            handleConvClick(conv);
                        }}
                    />
                </FullScreenPortal>
            )}

            {deleteConvId && (
                <FullScreenPortal>
                    <ConfirmDialog
                        isOpen={!!deleteConvId}
                        title="Delete Conversation"
                        message="Are you sure you want to delete this conversation? This action cannot be undone."
                        onClose={() => setDeleteConvId(null)}
                        onConfirm={() => {
                            if (onDeleteConversation) onDeleteConversation(deleteConvId);
                            setDeleteConvId(null);
                        }}
                    />
                </FullScreenPortal>
            )}
        </div>
    );
};

// ─── Chat Detail ────────────────────────────────────────

interface ChatDetailModalProps {
    conversation: Conversation;
    messages: Message[];
    currentUserId: string;
    currentUserName: string;
    otherParticipant: { name: string; id: string };
    isOnline: boolean;
    onClose: () => void;
    onSendMessage: (conversationId: string, text: string, tags: MessageTag[], replyTo?: MessageReplyTo, attachment?: MessageAttachment) => void;
    onUpdateConversationDetails: (conversationId: string, details: ConversationDetails) => void;
}

const ChatDetailModal: React.FC<ChatDetailModalProps> = ({ conversation, messages, currentUserId, currentUserName, otherParticipant, isOnline, onClose, onSendMessage, onUpdateConversationDetails }) => {
    const [newMessage, setNewMessage] = useState('');
    const [selectedTags, setSelectedTags] = useState<Set<MessageTag>>(new Set());
    const [showTagPicker, setShowTagPicker] = useState(false);
    const [isOtherTyping, setIsOtherTyping] = useState(false);
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
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        const scrollToBottom = () => {
            setTimeout(() => {
                if (messagesEndRef.current) {
                    const container = messagesEndRef.current.parentElement;
                    if (container) {
                        container.scrollTop = container.scrollHeight;
                    }
                }
            }, 100);
        };
        scrollToBottom();

        window.visualViewport?.addEventListener('resize', scrollToBottom);
        return () => window.visualViewport?.removeEventListener('resize', scrollToBottom);
    }, [messages, isOtherTyping]);

    useEffect(() => {
        return () => {
            if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        };
    }, []);

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

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
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
                alert('Failed to upload file. Please try again.');
            } finally {
                setIsUploading(false);
            }
        }
        e.target.value = '';
    };

    const handleSend = () => {
        if (!newMessage.trim() && !pendingAttachment) return;
        onSendMessage(conversation.id, newMessage.trim(), Array.from(selectedTags), replyingTo || undefined, pendingAttachment || undefined);
        setNewMessage('');
        setSelectedTags(new Set());
        setShowTagPicker(false);
        setReplyingTo(null);
        setPendingAttachment(null);

        if (!conversation.isGroup) {
            if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
            setIsOtherTyping(true);
            typingTimeoutRef.current = setTimeout(() => setIsOtherTyping(false), 2200);
        }
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

    let statusTextColor = 'text-gray-400 dark:text-gray-500';
    if (isOtherTyping) statusTextColor = 'text-gold-600 dark:text-gold-400';
    else if (isOnline) statusTextColor = 'text-green-500';

    let statusText = 'Offline';
    if (conversation.isGroup) statusText = `${conversation.participantIds.length} members`;
    else if (isOtherTyping) statusText = 'Typing...';
    else if (isOnline) statusText = 'Online';

    const renderMessageStatusIcon = (status?: string) => {
        if (status === 'read') return <CheckCheck size={12} className="text-sky-500 dark:text-sky-400" />;
        if (status === 'delivered') return <CheckCheck size={12} />;
        return <Check size={12} />;
    };

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
                        className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2 px-[6px] text-xs text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                    />
                    <input
                        value={detailsForm.reason}
                        onChange={(e) => setDetailsForm(prev => ({ ...prev, reason: e.target.value }))}
                        placeholder="Why are we starting this?"
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2 px-[6px] text-xs text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                    />
                    <textarea
                        value={detailsForm.note}
                        onChange={(e) => setDetailsForm(prev => ({ ...prev, note: e.target.value }))}
                        placeholder="Note"
                        rows={2}
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2 px-[6px] text-xs text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors resize-none"
                    />
                    <div className="flex justify-end gap-2 pt-1">
                        <button
                            onClick={() => setIsEditingDetails(false)}
                            className="text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 px-[6px] py-1.5 rounded-[6px] hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors active-scale"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleSaveDetails}
                            className="text-[10px] font-medium uppercase tracking-wider text-white dark:text-brand-950 bg-brand-900 dark:bg-gold-500 px-[6px] py-1.5 rounded-[6px] flex items-center gap-1 hover:bg-brand-800 dark:hover:bg-gold-400 transition-colors active-scale"
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
                            <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">{conversation.reason}</p>
                        )}
                        {conversation.note && (
                            <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5 italic">{conversation.note}</p>
                        )}
                    </div>
                    <button
                        onClick={() => setIsEditingDetails(true)}
                        className="p-1.5 text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale shrink-0"
                    >
                        <Edit2 size={14} />
                    </button>
                </div>
            );
        }
        
        return (
            <button
                onClick={() => setIsEditingDetails(true)}
                className="py-2.5 w-full text-left text-[10px] font-medium text-gold-600 dark:text-gold-400 uppercase tracking-wider flex items-center gap-1.5 active-scale"
            >
                <Plus size={12} /> Add title, reason &amp; note
            </button>
        );
    };

    return (
        <div className="absolute inset-0 bg-[#faf9f6] dark:bg-[#121212] z-50 flex flex-col animate-fade-in-up">
            {/* Chat Header */}
            <div className="bg-white dark:bg-[#1a1a1a] flex items-center gap-[6px] p-[6px] border-b border-gray-100 dark:border-gray-800 pt-[calc(1.75rem+env(safe-area-inset-top,0px))] shadow-sm z-10">
                <button onClick={onClose} className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale">
                    <ArrowLeft size={20} />
                </button>
                <div className="relative">
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center ${conversation.isGroup ? 'bg-gold-500/10 dark:bg-gold-900/20 text-gold-600 dark:text-gold-400' : 'bg-gray-50 dark:bg-gray-800 text-brand-900 dark:text-gold-400'
                        }`}>
                        {conversation.isGroup ? <Users size={16} strokeWidth={1.5} /> : <User size={16} strokeWidth={1.5} />}
                    </div>
                    {!conversation.isGroup && isOnline && (
                        <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-white dark:border-[#1a1a1a]"></div>
                    )}
                </div>
                <div className="flex-1">
                    <h2 className="text-sm font-serif text-gray-900 dark:text-white">{otherParticipant.name}</h2>
                    <p className={`text-[9px] uppercase tracking-widest font-medium ${statusTextColor}`}>
                        {statusText}
                    </p>
                </div>
                <button
                    onClick={() => { setShowSearch(s => !s); setChatSearchQuery(''); }}
                    className={`p-2 rounded-full transition-colors active-scale shrink-0 ${showSearch ? 'bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
                >
                    <Search size={18} />
                </button>
            </div>

            {/* In-chat Search */}
            {showSearch && (
                <div className="bg-white dark:bg-[#1a1a1a] border-b border-gray-100 dark:border-gray-800 px-[6px] py-2 animate-fade-in">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500" size={14} />
                        <input
                            value={chatSearchQuery}
                            onChange={(e) => setChatSearchQuery(e.target.value)}
                            placeholder="Search in this chat..."
                            autoFocus
                            autoComplete="off"
                            autoCorrect="off"
                            spellCheck={false}
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

            {/* Conversation Details (title / reason / note) */}
            <div className="bg-white dark:bg-[#1a1a1a] border-b border-gray-100 dark:border-gray-800 px-[6px]">
                {renderConversationDetails()}
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-[6px] space-y-3 no-scrollbar pb-20">
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
                {isOtherTyping && (
                    <div className="flex justify-start">
                        <div className="bg-white dark:bg-[#1e1e1e] border border-gray-100 dark:border-gray-800 rounded-[12px] rounded-bl-[4px] px-[6px] py-3 shadow-sm flex items-center gap-1">
                            <span className="w-1.5 h-1.5 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></span>
                            <span className="w-1.5 h-1.5 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></span>
                            <span className="w-1.5 h-1.5 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></span>
                        </div>
                    </div>
                )}
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

            {/* Message Input */}
            <div className="bg-white dark:bg-[#1a1a1a] px-[6px] py-[9px] border-t border-gray-100 dark:border-gray-800 transition-colors">
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
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setShowTagPicker(!showTagPicker)}
                        className={`p-2.5 rounded-full transition-colors active-scale shrink-0 ${showTagPicker ? 'bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950' : 'text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'
                            }`}
                    >
                        <Tag size={18} />
                    </button>
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isUploading}
                        className="p-2.5 rounded-full text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors active-scale shrink-0 disabled:opacity-60"
                    >
                        {isUploading ? <Loader2 size={18} className="animate-spin" /> : <Paperclip size={18} />}
                    </button>
                    <input type="file" accept="image/*,.pdf,.doc,.docx,.txt" ref={fileInputRef} className="hidden" onChange={handleFileChange} />
                    <input
                        value={newMessage}
                        onChange={(e) => setNewMessage(e.target.value)}
                        onKeyDown={handleKeyDown}
                        onFocus={() => {
                            setTimeout(() => {
                                window.scrollTo(0, 0);
                                document.body.scrollTop = 0;
                            }, 50);
                        }}
                        placeholder="Type a message..."
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        data-form-type="other"
                        data-1p-ignore
                        className="flex-1 bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2.5 px-3 text-xs text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                    />
                    <button
                        onClick={handleSend}
                        disabled={!newMessage.trim() && !pendingAttachment}
                        className={`p-2.5 rounded-full transition-all active-scale shrink-0 ${newMessage.trim() || pendingAttachment
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
        <div className="absolute inset-0 bg-[#faf9f6] dark:bg-[#121212] z-[60] flex flex-col animate-fade-in-up">
            <div className="bg-white dark:bg-[#1a1a1a] flex justify-between items-center p-[6px] border-b border-gray-100 dark:border-gray-800 pt-[calc(1.75rem+env(safe-area-inset-top,0px))] shadow-sm z-10">
                <button onClick={onClose} className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale">
                    <X size={20} />
                </button>
                <h2 className="text-base font-serif text-gray-900 dark:text-white">Edit Group</h2>
                <div className="w-9"></div>
            </div>
            <div className="flex-1 overflow-y-auto p-[6px] space-y-5 no-scrollbar">
                <div>
                    <label htmlFor="edit-group-name" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wider">Group Name</label>
                    <input
                        id="edit-group-name"
                        value={groupName}
                        onChange={(e) => setGroupName(e.target.value)}
                        placeholder="e.g. Sales Team"
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2.5 px-3.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                    />
                </div>
                <div>
                    <div className="flex items-center justify-between mb-[6px] px-1">
                        <h3 className="text-[10px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest">Members</h3>
                        <span className="text-[9px] bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-[3px] text-gray-600 dark:text-gray-300 uppercase tracking-wider">{selectedIds.size} selected</span>
                    </div>
                    <div className="space-y-2">
                        {teamMembers.map((member, index) => {
                            const isSelected = selectedIds.has(member.id);
                            return (
                                <button
                                    type="button"
                                    key={member.id}
                                    onClick={() => toggleMember(member.id)}
                                    className={`w-full text-left rounded-[6px] shadow-sm p-[6px] flex items-center gap-[6px] border animate-fade-in-up cursor-pointer active-scale ${isSelected ? "border-gold-500 bg-gold-50/50 dark:bg-gold-900/10" : "bg-white dark:bg-[#1e1e1e] border-gray-100 dark:border-gray-800"}`}
                                    style={{ animationDelay: `${index * 50}ms` }}
                                >
                                    <div className="relative">
                                        <div className="w-11 h-11 rounded-full bg-gray-50 dark:bg-gray-800 flex items-center justify-center text-brand-900 dark:text-gold-400">
                                            <User size={20} strokeWidth={1.5} />
                                        </div>
                                        {member.isOnline && (
                                            <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-white dark:border-[#1e1e1e]"></div>
                                        )}
                                    </div>
                                    <div className="flex-1">
                                        <h3 className="font-serif text-gray-900 dark:text-gray-100 text-sm">{member.name}</h3>
                                        <p className={"text-[9px] uppercase tracking-widest font-medium " + (member.isOnline ? "text-green-500" : "text-gray-400 dark:text-gray-500")}>
                                            {member.isOnline ? "Online" : "Offline"}
                                        </p>
                                    </div>
                                    <div className={"w-5 h-5 rounded-full border flex items-center justify-center transition-colors shrink-0 " + (isSelected ? "bg-gold-500 border-gold-500 text-white" : "border-gray-300 dark:border-gray-600")}>
                                        {isSelected && <Check size={12} />}
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </div>

                <div>
                    <label htmlFor="create-announcement-title" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wider">Title</label>
                    <input
                        id="create-announcement-title"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="e.g. End of Month Sales"
                        autoComplete="off"
                        className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2.5 px-3.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                    />
                </div>
                <div>
                    <label htmlFor="create-announcement-reason" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wider">Why are we starting this?</label>
                    <input
                        id="create-announcement-reason"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="e.g. To hit our targets"
                        autoComplete="off"
                        className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2.5 px-3.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                    />
                </div>
                <div>
                    <label htmlFor="create-announcement-note" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wider">Note</label>
                    <textarea
                        id="create-announcement-note"
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder="Any additional details..."
                        rows={3}
                        className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2.5 px-3.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors resize-none"
                    />
                </div>

                <button
                    onClick={() => canSave && onSave(groupName.trim(), Array.from(selectedIds), { title: title.trim() || undefined, reason: reason.trim() || undefined, note: note.trim() || undefined })}
                    disabled={!canSave}
                    className={"w-full rounded-[6px] py-3 text-sm font-medium tracking-wide transition-colors shadow-md active-scale " + (canSave ? "bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 hover:bg-brand-800 dark:hover:bg-gold-400" : "bg-gray-200 dark:bg-gray-800 text-gray-400 dark:text-gray-600")}
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
    onSelectMember: (memberId: string, details: ConversationDetails) => void;
    onCreateGroup: (participantIds: string[], groupName: string, details: ConversationDetails) => void;
}

const NewChatModal: React.FC<NewChatModalProps> = ({ teamMembers, existingConvIds, onClose, onSelectMember, onCreateGroup }) => {
    const [mode, setMode] = useState<'direct' | 'group'>('direct');
    const [selectedMember, setSelectedMember] = useState<UserProfile | null>(null);
    const [formData, setFormData] = useState<ConversationDetails>({ title: '', reason: '', note: '' });
    const [groupName, setGroupName] = useState('');
    const [selectedGroupMemberIds, setSelectedGroupMemberIds] = useState<Set<string>>(new Set());

    const handleStart = () => {
        if (!selectedMember) return;
        onSelectMember(selectedMember.id, {
            title: formData.title?.trim() || undefined,
            reason: formData.reason?.trim() || undefined,
            note: formData.note?.trim() || undefined,
        });
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
        });
    };

    let headerTitle = 'New Message';
    if (selectedMember) headerTitle = 'Start Conversation';
    else if (mode === 'group') headerTitle = 'New Group';

    return (
        <div className="absolute inset-0 bg-[#faf9f6] dark:bg-[#121212] z-[60] flex flex-col animate-fade-in-up">
            <div className="bg-white dark:bg-[#1a1a1a] flex justify-between items-center p-[6px] border-b border-gray-100 dark:border-gray-800 pt-[calc(1.75rem+env(safe-area-inset-top,0px))] shadow-sm z-10">
                <button
                    onClick={() => selectedMember ? setSelectedMember(null) : onClose()}
                    className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale"
                >
                    {selectedMember ? <ArrowLeft size={20} /> : <X size={20} />}
                </button>
                <h2 className="text-base font-serif text-gray-900 dark:text-white">
                    {headerTitle}
                </h2>
                <div className="w-9"></div>
            </div>

            {!selectedMember && (
                <div className="bg-white dark:bg-[#1a1a1a] border-b border-gray-100 dark:border-gray-800 px-[6px] pb-[6px] flex gap-2">
                    <button
                        onClick={() => setMode('direct')}
                        className={`flex-1 py-2 rounded-[6px] text-[10px] font-bold uppercase tracking-widest transition-all active-scale ${mode === 'direct'
                            ? 'bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 shadow-sm'
                            : 'bg-gray-100 dark:bg-[#2a2a2a] text-gray-500 dark:text-gray-400'
                            }`}
                    >
                        Direct Message
                    </button>
                    <button
                        onClick={() => setMode('group')}
                        className={`flex-1 py-2 rounded-[6px] text-[10px] font-bold uppercase tracking-widest transition-all active-scale ${mode === 'group'
                            ? 'bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 shadow-sm'
                            : 'bg-gray-100 dark:bg-[#2a2a2a] text-gray-500 dark:text-gray-400'
                            }`}
                    >
                        New Group
                    </button>
                </div>
            )}

            {!selectedMember && mode === 'direct' && (
                <div className="flex-1 overflow-y-auto p-[6px] space-y-2 no-scrollbar">
                    <h3 className="text-[10px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest mb-[6px] px-1">Team Members</h3>
                    {teamMembers.length === 0 ? (
                        <div className="text-center py-16 px-6 animate-fade-in">
                            <div className="w-16 h-16 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center mx-auto mb-4 text-gray-400 dark:text-gray-500">
                                <Users size={28} strokeWidth={1.5} />
                            </div>
                            <p className="text-sm font-serif text-gray-700 dark:text-gray-200 mb-1.5">No team members yet</p>
                            <p className="text-xs text-gray-400 dark:text-gray-500 font-light leading-relaxed">
                                Ask an admin to add team members from the User Management screen so you can start messaging.
                            </p>
                        </div>
                    ) : teamMembers.map((member, index) => (
                        <button
                            type="button"
                            key={member.id}
                            onClick={() => setSelectedMember(member)}
                            className="w-full text-left bg-white dark:bg-[#1e1e1e] rounded-[6px] shadow-sm p-[6px] flex items-center gap-[6px] border border-gray-100 dark:border-gray-800 animate-fade-in-up cursor-pointer active-scale"
                            style={{ animationDelay: `${index * 50}ms` }}
                        >
                            <div className="relative">
                                <div className="w-11 h-11 rounded-full bg-gray-50 dark:bg-gray-800 flex items-center justify-center text-brand-900 dark:text-gold-400">
                                    <User size={20} strokeWidth={1.5} />
                                </div>
                                {member.isOnline && (
                                    <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-white dark:border-[#1e1e1e]"></div>
                                )}
                            </div>
                            <div className="flex-1">
                                <h3 className="font-serif text-gray-900 dark:text-gray-100 text-sm">{member.name}</h3>
                                <p className={`text-[9px] uppercase tracking-widest font-medium ${member.isOnline ? 'text-green-500' : 'text-gray-400 dark:text-gray-500'}`}>
                                    {member.isOnline ? 'Online' : 'Offline'}
                                </p>
                            </div>
                            <MessageCircle size={18} className="text-gray-400 dark:text-gray-500" />
                        </button>
                    ))}
                </div>
            )}

            {!selectedMember && mode === 'group' && (
                <div className="flex-1 overflow-y-auto p-[6px] space-y-5 no-scrollbar">
                    <div>
                        <label htmlFor="create-group-name" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wider">Group Name</label>
                        <input
                            id="create-group-name"
                            value={groupName}
                            onChange={(e) => setGroupName(e.target.value)}
                            placeholder="e.g. Sales Team"
                            className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2.5 px-3.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                        />
                    </div>

                    <div>
                        <div className="flex items-center justify-between mb-[6px] px-1">
                            <h3 className="text-[10px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest">Add Members</h3>
                            <span className="text-[9px] bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-[3px] text-gray-600 dark:text-gray-300 uppercase tracking-wider">{selectedGroupMemberIds.size} selected</span>
                        </div>
                        <div className="space-y-2">
                            {teamMembers.length === 0 ? (
                                <div className="text-center py-12 px-6 animate-fade-in">
                                    <p className="text-sm font-serif text-gray-700 dark:text-gray-200 mb-1.5">No team members to add</p>
                                    <p className="text-xs text-gray-400 dark:text-gray-500 font-light leading-relaxed">
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
                                        className={`w-full text-left rounded-[6px] shadow-sm p-[6px] flex items-center gap-[6px] border animate-fade-in-up cursor-pointer active-scale ${isSelected ? 'border-gold-500 bg-gold-50/50 dark:bg-gold-900/10' : 'bg-white dark:bg-[#1e1e1e] border-gray-100 dark:border-gray-800'
                                            }`}
                                        style={{ animationDelay: `${index * 50}ms` }}
                                    >
                                        <div className="relative">
                                            <div className="w-11 h-11 rounded-full bg-gray-50 dark:bg-gray-800 flex items-center justify-center text-brand-900 dark:text-gold-400">
                                                <User size={20} strokeWidth={1.5} />
                                            </div>
                                            {member.isOnline && (
                                                <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-white dark:border-[#1e1e1e]"></div>
                                            )}
                                        </div>
                                        <div className="flex-1">
                                            <h3 className="font-serif text-gray-900 dark:text-gray-100 text-sm">{member.name}</h3>
                                            <p className={`text-[9px] uppercase tracking-widest font-medium ${member.isOnline ? 'text-green-500' : 'text-gray-400 dark:text-gray-500'}`}>
                                                {member.isOnline ? 'Online' : 'Offline'}
                                            </p>
                                        </div>
                                        <div className={`w-5 h-5 rounded-full border flex items-center justify-center transition-colors shrink-0 ${isSelected ? 'bg-gold-500 border-gold-500 text-white' : 'border-gray-300 dark:border-gray-600'
                                            }`}>
                                            {isSelected && <Check size={12} />}
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    <div>
                        <label htmlFor="create-group-title" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wider">Title</label>
                        <input
                            id="create-group-title"
                            value={formData.title}
                            onChange={(e) => setFormData(prev => ({ ...prev, title: e.target.value }))}
                            placeholder="What's this conversation about?"
                            className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2.5 px-3.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                        />
                    </div>
                    <div>
                        <label htmlFor="create-group-reason" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wider">Why are we starting this?</label>
                        <input
                            id="create-group-reason"
                            value={formData.reason}
                            onChange={(e) => setFormData(prev => ({ ...prev, reason: e.target.value }))}
                            placeholder="Reason for reaching out"
                            className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2.5 px-3.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                        />
                    </div>
                    <div>
                        <label htmlFor="create-group-note" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wider">Note</label>
                        <textarea
                            id="create-group-note"
                            value={formData.note}
                            onChange={(e) => setFormData(prev => ({ ...prev, note: e.target.value }))}
                            placeholder="Any extra context (optional)"
                            rows={3}
                            className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2.5 px-3.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors resize-none"
                        />
                    </div>

                    <button
                        onClick={handleCreateGroup}
                        disabled={!canCreateGroup}
                        className={`w-full rounded-[6px] py-3 text-sm font-medium tracking-wide transition-colors shadow-md active-scale ${canCreateGroup
                            ? 'bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 hover:bg-brand-800 dark:hover:bg-gold-400'
                            : 'bg-gray-200 dark:bg-gray-800 text-gray-400 dark:text-gray-600'
                            }`}
                    >
                        Create Group
                    </button>
                </div>
            )}

            {selectedMember && (
                <div className="flex-1 overflow-y-auto p-[6px] space-y-5 no-scrollbar">
                    <div className="flex items-center gap-[6px] bg-white dark:bg-[#1e1e1e] rounded-[6px] p-[6px] border border-gray-100 dark:border-gray-800">
                        <div className="w-11 h-11 rounded-full bg-gray-50 dark:bg-gray-800 flex items-center justify-center text-brand-900 dark:text-gold-400 shrink-0">
                            <User size={20} strokeWidth={1.5} />
                        </div>
                        <div>
                            <h3 className="font-serif text-gray-900 dark:text-gray-100 text-sm">{selectedMember.name}</h3>
                            <p className={`text-[9px] uppercase tracking-widest font-medium ${selectedMember.isOnline ? 'text-green-500' : 'text-gray-400 dark:text-gray-500'}`}>
                                {selectedMember.isOnline ? 'Online' : 'Offline'}
                            </p>
                        </div>
                    </div>

                    <div>
                        <label htmlFor="create-dm-title" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wider">Title</label>
                        <input
                            id="create-dm-title"
                            value={formData.title}
                            onChange={(e) => setFormData(prev => ({ ...prev, title: e.target.value }))}
                            placeholder="What's this conversation about?"
                            className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2.5 px-3.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                        />
                    </div>

                    <div>
                        <label htmlFor="create-dm-reason" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wider">Why are we starting this?</label>
                        <input
                            id="create-dm-reason"
                            value={formData.reason}
                            onChange={(e) => setFormData(prev => ({ ...prev, reason: e.target.value }))}
                            placeholder="Reason for reaching out"
                            className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2.5 px-3.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                        />
                    </div>

                    <div>
                        <label htmlFor="create-dm-note" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wider">Note</label>
                        <textarea
                            id="create-dm-note"
                            value={formData.note}
                            onChange={(e) => setFormData(prev => ({ ...prev, note: e.target.value }))}
                            placeholder="Any extra context (optional)"
                            rows={3}
                            className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2.5 px-3.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors resize-none"
                        />
                    </div>

                    <button
                        onClick={handleStart}
                        className="w-full bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 rounded-[6px] py-3 text-sm font-medium tracking-wide hover:bg-brand-800 dark:hover:bg-gold-400 transition-colors shadow-md active-scale"
                    >
                        Start Conversation
                    </button>
                </div>
            )}
        </div>
    );
};
