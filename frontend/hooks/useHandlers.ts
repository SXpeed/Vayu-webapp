import { useCallback } from 'react';
import {
    Artwork, Catalog, Invoice, Collection, Inquiry, Conversation,
    ConversationDetails, Message, MessageTag, MessageReplyTo, MessageAttachment,
    InquiryMessage, UserProfile, MessageStatus
} from '../types';
import { AuthUser } from '../services/authService';
import { db } from '../services/db';
import { messagingService } from '../services/messagingService';
import { artworkService } from '../services/artworkService';
import { collectionService } from '../services/collectionService';
import { catalogService } from '../services/catalogService';
import { inquiryService } from '../services/inquiryService';

interface HandlerArgs {
    authUser: AuthUser | null;
    userProfile: UserProfile | null;
    artworks: Artwork[];
    conversations: Conversation[];
    teamMembers: UserProfile[];
    setArtworks: React.Dispatch<React.SetStateAction<Artwork[]>>;
    setCatalogs: React.Dispatch<React.SetStateAction<Catalog[]>>;
    setCollections: React.Dispatch<React.SetStateAction<Collection[]>>;
    setInvoices: React.Dispatch<React.SetStateAction<Invoice[]>>;
    setInquiries: React.Dispatch<React.SetStateAction<Inquiry[]>>;
    setConversations: React.Dispatch<React.SetStateAction<Conversation[]>>;
    setAllMessages: React.Dispatch<React.SetStateAction<Message[]>>;
    setInquiryMessages: React.Dispatch<React.SetStateAction<InquiryMessage[]>>;
    setSelectedArtwork: React.Dispatch<React.SetStateAction<Artwork | null>>;
}

/**
 * Centralised CRUD + messaging handlers that previously lived inline in App.tsx.
 */

/**
 * Returns a state updater that marks a single message by id with the given
 * status. Extracted to module scope to avoid deeply nested function
 * definitions inside the handlers below.
 */
function makeMessageStatusUpdater<T extends { id: string; status?: MessageStatus }>(
    msgId: string,
    status: MessageStatus,
) {
    return (prev: T[]) => prev.map(m => (m.id === msgId ? { ...m, status } : m));
}

export function useHandlers(args: HandlerArgs) {
    const {
        authUser, userProfile, artworks, conversations, teamMembers,
        setArtworks, setCatalogs, setCollections, setInvoices, setInquiries,
        setConversations, setAllMessages, setInquiryMessages, setSelectedArtwork,
    } = args;

    // ── Artworks ──────────────────────────────────────────────────────────
    const handleAddArtwork = useCallback(async (newArt: Omit<Artwork, 'id' | 'createdAt'>) => {
        const artwork: Artwork = { ...newArt, id: `art_${Date.now()}`, createdAt: Date.now() };
        try { await artworkService.saveArtwork(artwork); } catch (e) { console.error('D1 sync failed (add artwork):', e); }
        await db.saveArtwork(artwork);
        setArtworks((prev: Artwork[]) => [artwork, ...prev]);
        return artwork;
    }, [setArtworks]);

    const handleUpdateArtwork = useCallback(async (updatedArt: Artwork) => {
        try { await artworkService.updateArtwork(updatedArt); } catch (e) { console.error('D1 sync failed (update artwork):', e); }
        await db.saveArtwork(updatedArt);
        setArtworks((prev: Artwork[]) => prev.map((a: Artwork) => a.id === updatedArt.id ? updatedArt : a));
        setSelectedArtwork(prev => prev?.id === updatedArt.id ? updatedArt : prev);
    }, [setArtworks, setSelectedArtwork]);

    const handleDeleteArtwork = useCallback(async (id: string) => {
        try { await artworkService.deleteArtwork(id); } catch (e) { console.error('D1 sync failed (delete artwork):', e); }
        await db.deleteArtwork(id);
        setArtworks((prev: Artwork[]) => prev.filter((a: Artwork) => a.id !== id));
        setSelectedArtwork(prev => prev?.id === id ? null : prev);
    }, [setArtworks, setSelectedArtwork]);

    // ── Catalogs ──────────────────────────────────────────────────────────
    const handleAddCatalog = useCallback(async (newCat: Omit<Catalog, 'id' | 'createdAt'>) => {
        const catalog: Catalog = { ...newCat, id: `cat_${Date.now()}`, createdAt: Date.now() };
        try { await catalogService.saveCatalog(catalog); } catch (e) { console.error('D1 sync failed (add catalog):', e); }
        await db.saveCatalog(catalog);
        setCatalogs((prev: Catalog[]) => [catalog, ...prev]);
    }, [setCatalogs]);

    const handleUpdateCatalog = useCallback(async (updatedCat: Catalog) => {
        try { await catalogService.updateCatalog(updatedCat); } catch (e) { console.error('D1 sync failed (update catalog):', e); }
        await db.saveCatalog(updatedCat);
        setCatalogs((prev: Catalog[]) => prev.map((c: Catalog) => c.id === updatedCat.id ? updatedCat : c));
    }, [setCatalogs]);

    const handleDeleteCatalog = useCallback(async (id: string) => {
        try { await catalogService.deleteCatalog(id); } catch (e) { console.error('D1 sync failed (delete catalog):', e); }
        await db.deleteCatalog(id);
        setCatalogs((prev: Catalog[]) => prev.filter((c: Catalog) => c.id !== id));
    }, [setCatalogs]);

    // ── Collections ───────────────────────────────────────────────────────
    const handleAddCollection = useCallback(async (newCol: Omit<Collection, 'id'>) => {
        const collection: Collection = { ...newCol, id: `col_${Date.now()}` };
        try { await collectionService.saveCollection(collection); } catch (e) { console.error('D1 sync failed (add collection):', e); }
        await db.saveCollection(collection);
        setCollections((prev: Collection[]) => [collection, ...prev]);
    }, [setCollections]);

    const handleUpdateCollection = useCallback(async (updatedCol: Collection) => {
        try { await collectionService.updateCollection(updatedCol); } catch (e) { console.error('D1 sync failed (update collection):', e); }
        await db.saveCollection(updatedCol);
        setCollections((prev: Collection[]) => prev.map((c: Collection) => c.id === updatedCol.id ? updatedCol : c));
    }, [setCollections]);

    const handleDeleteCollection = useCallback(async (id: string) => {
        try { await collectionService.deleteCollection(id); } catch (e) { console.error('D1 sync failed (delete collection):', e); }
        await db.deleteCollection(id);
        setCollections((prev: Collection[]) => prev.filter((c: Collection) => c.id !== id));
    }, [setCollections]);

    // ── Invoices ──────────────────────────────────────────────────────────
    const handleAddInvoice = useCallback(async (newInv: Omit<Invoice, 'id' | 'date'>) => {
        const invoice: Invoice = { ...newInv, id: `inv_${Date.now()}`, date: Date.now() };
        await db.saveInvoice(invoice);
        setInvoices((prev: Invoice[]) => [invoice, ...prev]);

        const invoicedArtIds = new Set(invoice.items.map(item => item.artworkId));
        const updatedArtworks = artworks.map(art => {
            if (invoicedArtIds.has(art.id)) {
                const updatedArt = { ...art, status: 'Sold' as const };
                artworkService.updateArtwork(updatedArt).catch(e => console.error('D1 sync failed (invoice artwork status):', e));
                db.saveArtwork(updatedArt);
                return updatedArt;
            }
            return art;
        });
        setArtworks(updatedArtworks);
    }, [artworks, setInvoices, setArtworks]);

    const handleUpdateInvoice = useCallback(async (updatedInv: Invoice) => {
        await db.saveInvoice(updatedInv);
        setInvoices((prev: Invoice[]) => prev.map((i: Invoice) => i.id === updatedInv.id ? updatedInv : i));
    }, [setInvoices]);

    const handleDeleteInvoice = useCallback(async (id: string) => {
        await db.deleteInvoice(id);
        setInvoices((prev: Invoice[]) => prev.filter((i: Invoice) => i.id !== id));
    }, [setInvoices]);

    // ── Inquiries ─────────────────────────────────────────────────────────
    const handleAddInquiry = useCallback(async (newInq: Omit<Inquiry, 'id' | 'date'>) => {
        const inquiry: Inquiry = { ...newInq, id: `inq_${Date.now()}`, date: Date.now() };
        try { await inquiryService.saveInquiry(inquiry); } catch (e) { console.error('D1 sync failed (add inquiry):', e); }
        await db.saveInquiry(inquiry);
        setInquiries((prev: Inquiry[]) => [inquiry, ...prev]);
    }, [setInquiries]);

    const handleUpdateInquiry = useCallback(async (updatedInq: Inquiry) => {
        try { await inquiryService.updateInquiry(updatedInq); } catch (e) { console.error('D1 sync failed (update inquiry):', e); }
        await db.saveInquiry(updatedInq);
        setInquiries((prev: Inquiry[]) => prev.map((i: Inquiry) => i.id === updatedInq.id ? updatedInq : i));
    }, [setInquiries]);

    const handleDeleteInquiry = useCallback(async (id: string) => {
        try { await inquiryService.deleteInquiry(id); } catch (e) { console.error('D1 sync failed (delete inquiry):', e); }
        await db.deleteInquiry(id);
        setInquiries((prev: Inquiry[]) => prev.filter((i: Inquiry) => i.id !== id));
    }, [setInquiries]);

    // ── Inquiry Messages ──────────────────────────────────────────────────
    const handleSendInquiryMessage = useCallback(async (
        inquiryId: string, text: string, tags: MessageTag[],
        replyTo?: MessageReplyTo, attachment?: MessageAttachment
    ) => {
        const msg: InquiryMessage = {
            id: `inqmsg_${Date.now()}`,
            inquiryId,
            senderId: userProfile?.id || authUser?.id || '',
            senderName: userProfile?.name || authUser?.name || 'You',
            text, tags, timestamp: Date.now(), status: 'sent', replyTo, attachment,
        };
        try { await inquiryService.saveInquiryMessage(msg); } catch (e) { console.error('D1 sync failed (inquiry message):', e); }
        await db.saveInquiryMessage(msg);
        setInquiryMessages((prev: InquiryMessage[]) => [...prev, msg]);
        setTimeout(
            () => setInquiryMessages(makeMessageStatusUpdater<InquiryMessage>(msg.id, 'delivered')),
            700,
        );
        setTimeout(
            () => setInquiryMessages(makeMessageStatusUpdater<InquiryMessage>(msg.id, 'read')),
            2200,
        );
    }, [userProfile, authUser, setInquiryMessages]);

    // ── Messaging: Send Message ──────────────────────────────────────────
    const handleSendMessage = useCallback(async (
        conversationId: string, text: string, tags: MessageTag[],
        replyTo?: MessageReplyTo, attachment?: MessageAttachment
    ) => {
        const msg: Message = {
            id: `msg_${Date.now()}`,
            conversationId,
            senderId: userProfile?.id || authUser?.id || '',
            senderName: userProfile?.name || authUser?.name || 'You',
            text, tags, timestamp: Date.now(), status: 'sent', replyTo, attachment,
        };
        try { await messagingService.sendMessage(msg); } catch (err) { console.error('Failed to send message to D1:', err); }
        await db.saveMessage(msg);
        setAllMessages((prev: Message[]) => [...prev, msg]);
        setTimeout(
            () => setAllMessages(makeMessageStatusUpdater<Message>(msg.id, 'delivered')),
            700,
        );
        setTimeout(
            () => setAllMessages(makeMessageStatusUpdater<Message>(msg.id, 'read')),
            2200,
        );

        const conv = conversations.find(c => c.id === conversationId);
        if (conv) {
            const attachPreview = attachment?.type === 'image' ? '📷 Photo' : `📎 ${attachment?.name}`;
            const lastMessagePreview = attachment ? attachPreview : text;
            const updatedConv = { ...conv, lastMessage: lastMessagePreview, lastMessageTime: Date.now(), unreadCount: 0 };
            await db.saveConversation(updatedConv);
            setConversations((prev: Conversation[]) => prev.map(c => c.id === conversationId ? updatedConv : c).sort((a, b) => b.lastMessageTime - a.lastMessageTime));
        }
    }, [userProfile, authUser, conversations, setAllMessages, setConversations]);

    // ── Messaging: Pin/Archive ────────────────────────────────────────────
    const handleTogglePinConversation = useCallback(async (conversationId: string) => {
        const conv = conversations.find(c => c.id === conversationId);
        if (!conv) return;
        const updatedConv = { ...conv, isPinned: !conv.isPinned };
        try { await messagingService.updateConversation(updatedConv); } catch (e) { console.error('D1 sync failed (pin):', e); }
        await db.saveConversation(updatedConv);
        setConversations((prev: Conversation[]) => prev.map(c => c.id === conversationId ? updatedConv : c));
    }, [conversations, setConversations]);

    const handleToggleArchiveConversation = useCallback(async (conversationId: string) => {
        const conv = conversations.find(c => c.id === conversationId);
        if (!conv) return;
        const updatedConv = { ...conv, isArchived: !conv.isArchived };
        try { await messagingService.updateConversation(updatedConv); } catch (e) { console.error('D1 sync failed (archive):', e); }
        await db.saveConversation(updatedConv);
        setConversations((prev: Conversation[]) => prev.map(c => c.id === conversationId ? updatedConv : c));
    }, [conversations, setConversations]);

    const handleDeleteConversation = useCallback(async (conversationId: string) => {
        try { await messagingService.deleteConversation(conversationId); } catch (e) { console.error('D1 sync failed (delete conv):', e); }
        await db.deleteConversation(conversationId);
        setConversations((prev: Conversation[]) => prev.filter(c => c.id !== conversationId));
    }, [setConversations]);

    // ── Messaging: Create Conversation / Group ────────────────────────────
    const handleCreateConversation = useCallback(async (participantId: string, details?: ConversationDetails): Promise<Conversation> => {
        const selfId = userProfile?.id || authUser?.id || '';
        const existing = conversations.find(c => c.participantIds.includes(participantId) && c.participantIds.includes(selfId));
        if (existing) return existing;

        const otherMember = teamMembers.find(m => m.id === participantId);
        const conv: Conversation = {
            id: `conv_${Date.now()}`,
            participantIds: [selfId, participantId],
            participantNames: [userProfile?.name || authUser?.name || 'You', otherMember?.name || 'Team Member'],
            lastMessage: '', lastMessageTime: Date.now(), unreadCount: 0,
            title: details?.title, reason: details?.reason, note: details?.note,
        };
        try { await messagingService.createConversation(conv); } catch (e) { console.error('D1 sync failed (create conversation):', e); }
        await db.saveConversation(conv);
        setConversations((prev: Conversation[]) => [conv, ...prev]);
        return conv;
    }, [userProfile, authUser, conversations, teamMembers, setConversations]);

    const handleCreateGroup = useCallback(async (participantIds: string[], groupName: string, details?: ConversationDetails): Promise<Conversation> => {
        const selfId = userProfile?.id || authUser?.id || '';
        const allParticipantIds = Array.from(new Set([selfId, ...participantIds]));
        const allParticipantNames = allParticipantIds.map(id =>
            id === selfId ? (userProfile?.name || authUser?.name || 'You') : (teamMembers.find(m => m.id === id)?.name || 'Team Member')
        );
        const conv: Conversation = {
            id: `conv_${Date.now()}`,
            participantIds: allParticipantIds,
            participantNames: allParticipantNames,
            lastMessage: '', lastMessageTime: Date.now(), unreadCount: 0,
            isGroup: true, groupName,
            title: details?.title, reason: details?.reason, note: details?.note,
        };
        try { await messagingService.createConversation(conv); } catch (e) { console.error('D1 sync failed (create group):', e); }
        await db.saveConversation(conv);
        setConversations((prev: Conversation[]) => [conv, ...prev]);
        return conv;
    }, [userProfile, authUser, conversations, teamMembers, setConversations]);

    const handleUpdateConversationDetails = useCallback(async (conversationId: string, details: ConversationDetails) => {
        const conv = conversations.find(c => c.id === conversationId);
        if (!conv) return;
        const updatedConv = { ...conv, ...details };
        try { await messagingService.updateConversation(updatedConv); } catch (e) { console.error('D1 sync failed (update details):', e); }
        await db.saveConversation(updatedConv);
        setConversations((prev: Conversation[]) => prev.map(c => c.id === conversationId ? updatedConv : c));
    }, [conversations, setConversations]);

    const handleUpdateGroup = useCallback(async (conversationId: string, groupName: string, participantIds: string[], details?: ConversationDetails) => {
        const conv = conversations.find(c => c.id === conversationId);
        if (!conv) return;
        const selfId = userProfile?.id || authUser?.id || '';
        const allIds = Array.from(new Set([selfId, ...participantIds]));
        const allNames = allIds.map(id =>
            id === selfId ? (userProfile?.name || authUser?.name || 'You') : (teamMembers.find(m => m.id === id)?.name || 'Team Member')
        );
        const updatedConv: Conversation = { ...conv, groupName, participantIds: allIds, participantNames: allNames, isGroup: true, title: details?.title, reason: details?.reason, note: details?.note };
        try { await messagingService.updateConversation(updatedConv); } catch (e) { console.error('D1 sync failed (update group):', e); }
        await db.saveConversation(updatedConv);
        setConversations((prev: Conversation[]) => prev.map(c => c.id === conversationId ? updatedConv : c));
    }, [conversations, userProfile, authUser, teamMembers, setConversations]);

    return {
        // Artworks
        handleAddArtwork, handleUpdateArtwork, handleDeleteArtwork,
        // Catalogs
        handleAddCatalog, handleUpdateCatalog, handleDeleteCatalog,
        // Collections
        handleAddCollection, handleUpdateCollection, handleDeleteCollection,
        // Invoices
        handleAddInvoice, handleUpdateInvoice, handleDeleteInvoice,
        // Inquiries
        handleAddInquiry, handleUpdateInquiry, handleDeleteInquiry,
        // Inquiry messages
        handleSendInquiryMessage,
        // Messaging
        handleSendMessage, handleTogglePinConversation, handleToggleArchiveConversation, handleDeleteConversation,
        handleCreateConversation, handleCreateGroup, handleUpdateConversationDetails,
        handleUpdateGroup,
    };
}