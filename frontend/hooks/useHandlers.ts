import { useCallback } from 'react';
import toast from 'react-hot-toast';
import {
    Artwork, CalendarEvent, Catalog, Invoice, Collection, Contact, Inquiry, Conversation,
    ConversationDetails, Message, MessageTag, MessageReplyTo, MessageAttachment,
    InquiryMessage, NewContact, UserProfile, MessageStatus
} from '../types';
import { AuthUser } from '../services/authService';
import { db } from '../services/db';
import { messagingService } from '../services/messagingService';
import { artworkService } from '../services/artworkService';
import { collectionService } from '../services/collectionService';
import { catalogService } from '../services/catalogService';
import { inquiryService } from '../services/inquiryService';
import { eventService } from '../services/eventService';
import { contactService } from '../services/contactService';

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
    setEvents: React.Dispatch<React.SetStateAction<CalendarEvent[]>>;
    setContacts: React.Dispatch<React.SetStateAction<Contact[]>>;
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
        setConversations, setAllMessages, setInquiryMessages, setEvents, setContacts, setSelectedArtwork,
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
    const handleAddCatalog = useCallback(async (newCat: Omit<Catalog, 'id' | 'createdAt'> & { id?: string }) => {
        const catalog: Catalog = { ...newCat, id: newCat.id || `cat_${Date.now()}`, createdAt: Date.now() };
        try { await catalogService.saveCatalog(catalog); } catch (e) { console.error('D1 sync failed (add catalog):', e); }
        await db.saveCatalog(catalog);
        setCatalogs((prev: Catalog[]) => [catalog, ...prev]);
        return catalog;
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

    // ── Proforma invoices ─────────────────────────────────────────────────
    // A proforma is a quotation: its artworks only become Sold once it's Paid.
    const markPaidInvoiceArtworksSold = useCallback((invoice: Invoice) => {
        if (invoice.status !== 'Paid') return;
        const invoicedArtIds = new Set(invoice.items.map(item => item.artworkId));
        const toMark = artworks.filter(art => invoicedArtIds.has(art.id) && art.status !== 'Sold');
        if (toMark.length === 0) return;
        const soldIds = new Set(toMark.map(art => art.id));
        for (const art of toMark) {
            const updatedArt = { ...art, status: 'Sold' as const };
            artworkService.updateArtwork(updatedArt).catch(e => console.error('D1 sync failed (proforma artwork status):', e));
            db.saveArtwork(updatedArt);
        }
        setArtworks(prev => prev.map(art => (soldIds.has(art.id) ? { ...art, status: 'Sold' as const } : art)));
    }, [artworks, setArtworks]);

    const handleAddInvoice = useCallback(async (newInv: Omit<Invoice, 'id' | 'date'>): Promise<Invoice> => {
        const invoice: Invoice = { ...newInv, id: `inv_${Date.now()}`, date: Date.now() };
        await db.saveInvoice(invoice);
        setInvoices((prev: Invoice[]) => [invoice, ...prev]);
        markPaidInvoiceArtworksSold(invoice);
        return invoice;
    }, [setInvoices, markPaidInvoiceArtworksSold]);

    const handleUpdateInvoice = useCallback(async (updatedInv: Invoice) => {
        await db.saveInvoice(updatedInv);
        setInvoices((prev: Invoice[]) => prev.map((i: Invoice) => i.id === updatedInv.id ? updatedInv : i));
        markPaidInvoiceArtworksSold(updatedInv);
    }, [setInvoices, markPaidInvoiceArtworksSold]);

    const handleDeleteInvoice = useCallback(async (id: string) => {
        await db.deleteInvoice(id);
        setInvoices((prev: Invoice[]) => prev.filter((i: Invoice) => i.id !== id));
    }, [setInvoices]);

    // ── Inquiries ─────────────────────────────────────────────────────────
    const handleAddInquiry = useCallback(async (newInq: Omit<Inquiry, 'id' | 'date'>) => {
        // The server records the creator from the session; mirror it locally
        // so "Added by" shows before the next sync.
        const inquiry: Inquiry = {
            ...newInq, id: `inq_${Date.now()}`, date: Date.now(),
            createdBy: userProfile?.id || authUser?.id,
            createdByName: userProfile?.name || authUser?.name,
        };
        try { await inquiryService.saveInquiry(inquiry); } catch (e) { console.error('D1 sync failed (add inquiry):', e); }
        await db.saveInquiry(inquiry);
        setInquiries((prev: Inquiry[]) => [inquiry, ...prev]);
    }, [userProfile, authUser, setInquiries]);

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

    // ── Calendar Events ───────────────────────────────────────────────────
    const handleAddEvent = useCallback(async (newEvent: Omit<CalendarEvent, 'id' | 'createdAt' | 'createdBy' | 'createdByName'>) => {
        // The server records the creator from the session; mirror it locally
        // so "Added by" shows before the next sync.
        const event: CalendarEvent = {
            ...newEvent,
            id: `evt_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
            createdAt: Date.now(),
            createdBy: userProfile?.id || authUser?.id,
            createdByName: userProfile?.name || authUser?.name,
        };
        try { await eventService.saveEvent(event); } catch (e) { console.error('D1 sync failed (add event):', e); }
        await db.saveEvent(event);
        setEvents((prev: CalendarEvent[]) => [...prev, event].sort((a, b) => a.date - b.date));
    }, [userProfile, authUser, setEvents]);

    const handleDeleteEvent = useCallback(async (id: string) => {
        try { await eventService.deleteEvent(id); } catch (e) { console.error('D1 sync failed (delete event):', e); }
        await db.deleteEvent(id);
        setEvents((prev: CalendarEvent[]) => prev.filter((ev: CalendarEvent) => ev.id !== id));
    }, [setEvents]);

    const handleUpdateEvent = useCallback(async (updated: CalendarEvent) => {
        try { await eventService.updateEvent(updated); } catch (e) { console.error('D1 sync failed (update event):', e); }
        await db.saveEvent(updated);
        setEvents((prev: CalendarEvent[]) => prev
            .map((ev: CalendarEvent) => ev.id === updated.id ? updated : ev)
            .sort((a, b) => a.date - b.date));
    }, [setEvents]);

    // ── Contacts ──────────────────────────────────────────────────────────
    const handleAddContact = useCallback(async (newContact: NewContact) => {
        const contact: Contact = {
            ...newContact,
            id: `cont_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
            createdAt: Date.now(),
            createdBy: userProfile?.id || authUser?.id,
            createdByName: userProfile?.name || authUser?.name,
        };
        try { await contactService.saveContact(contact); } catch (e) { console.error('D1 sync failed (add contact):', e); }
        await db.saveContact(contact);
        setContacts((prev: Contact[]) => [contact, ...prev]);
    }, [userProfile, authUser, setContacts]);

    const handleUpdateContact = useCallback(async (updated: Contact) => {
        try { await contactService.updateContact(updated); } catch (e) { console.error('D1 sync failed (update contact):', e); }
        await db.saveContact(updated);
        setContacts((prev: Contact[]) => prev.map((c: Contact) => (c.id === updated.id ? updated : c)));
    }, [setContacts]);

    const handleImportContacts = useCallback(async (list: NewContact[]) => {
        const stamped: Contact[] = list.map(c => ({
            ...c,
            id: `cont_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
            createdAt: Date.now(),
            createdBy: userProfile?.id || authUser?.id,
            createdByName: userProfile?.name || authUser?.name,
        }));
        let imported = stamped.length;
        try { imported = await contactService.importContacts(stamped); } catch (e) { console.error('D1 sync failed (import contacts):', e); }
        await Promise.all(stamped.map(c => db.saveContact(c)));
        setContacts((prev: Contact[]) => {
            const seen = new Set(prev.map(c => c.id));
            const fresh = stamped.filter(c => !seen.has(c.id));
            return [...fresh, ...prev].sort((a, b) => b.createdAt - a.createdAt);
        });
        return imported;
    }, [userProfile, authUser, setContacts]);

    const handleDeleteContact = useCallback(async (id: string) => {
        try { await contactService.deleteContact(id); } catch (e) { console.error('D1 sync failed (delete contact):', e); }
        await db.deleteContact(id);
        setContacts((prev: Contact[]) => prev.filter((c: Contact) => c.id !== id));
    }, [setContacts]);

    // ── Inquiry Messages ──────────────────────────────────────────────────
    const handleSendInquiryMessage = useCallback(async (
        inquiryId: string, text: string, tags: MessageTag[],
        replyTo?: MessageReplyTo, attachment?: MessageAttachment
    ) => {
        const msg: InquiryMessage = {
            id: `inqmsg_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
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
            id: `msg_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
            conversationId,
            senderId: userProfile?.id || authUser?.id || '',
            senderName: userProfile?.name || authUser?.name || 'You',
            text, tags, timestamp: Date.now(), status: 'sent', replyTo, attachment,
        };
        // Show it straight away, then confirm with the server. A failure used
        // to be swallowed while fake "delivered"/"read" ticks appeared, and the
        // next refresh silently removed the message. Now it stays, marked
        // "Not sent", with the reason and a retry.
        setAllMessages((prev: Message[]) => [...prev, msg]);
        try {
            await messagingService.sendMessage(msg);
        } catch (err) {
            setAllMessages(makeMessageStatusUpdater<Message>(msg.id, 'failed'));
            toast.error(`Message not sent: ${(err as Error).message || 'check your connection'}`);
            return;
        }
        await db.saveMessage(msg);

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
        // Only match direct (1-on-1) conversations — a group that happens to
        // contain both users must NOT be treated as an existing 1-on-1 chat.
        const existing = conversations.find(c => !c.isGroup && c.participantIds.includes(participantId) && c.participantIds.includes(selfId));
        if (existing) return existing;

        const otherMember = teamMembers.find(m => m.id === participantId);
        const conv: Conversation = {
            id: `conv_${Date.now()}`,
            participantIds: [selfId, participantId],
            participantNames: [userProfile?.name || authUser?.name || 'You', otherMember?.name || 'Team Member'],
            lastMessage: '', lastMessageTime: Date.now(), unreadCount: 0,
            title: details?.title, reason: details?.reason, note: details?.note,
        };
        // A chat that only exists on this phone can't be used: messages sent
        // into it are never returned by the server. So fail loudly instead.
        try {
            await messagingService.createConversation(conv);
        } catch (e) {
            toast.error(`Couldn't start the chat: ${(e as Error).message || 'check your connection'}`);
            throw e;
        }
        await db.saveConversation(conv);
        setConversations((prev: Conversation[]) => [conv, ...prev]);
        return conv;
    }, [userProfile, authUser, conversations, teamMembers, setConversations]);

    /** Send a message that failed again. */
    const handleRetryMessage = useCallback(async (messageId: string) => {
        let target: Message | undefined;
        setAllMessages((prev: Message[]) => {
            target = prev.find(m => m.id === messageId);
            return prev.map(m => (m.id === messageId ? { ...m, status: 'sent' as const } : m));
        });
        if (!target) return;
        try {
            await messagingService.sendMessage({ ...target, status: 'sent' });
            await db.saveMessage({ ...target, status: 'sent' });
            toast.success('Message sent');
        } catch (err) {
            setAllMessages(makeMessageStatusUpdater<Message>(messageId, 'failed'));
            toast.error(`Still not sent: ${(err as Error).message || 'check your connection'}`);
        }
    }, [setAllMessages]);

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
        try {
            await messagingService.createConversation(conv);
        } catch (e) {
            toast.error(`Couldn't create the group: ${(e as Error).message || 'check your connection'}`);
            throw e;
        }
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
        // Calendar events
        handleAddEvent, handleUpdateEvent, handleDeleteEvent,
        // Contacts
        handleAddContact, handleUpdateContact, handleImportContacts, handleDeleteContact,
        // Inquiry messages
        handleSendInquiryMessage,
        // Messaging
        handleSendMessage, handleRetryMessage, handleTogglePinConversation, handleToggleArchiveConversation, handleDeleteConversation,
        handleCreateConversation, handleCreateGroup, handleUpdateConversationDetails,
        handleUpdateGroup,
    };
}