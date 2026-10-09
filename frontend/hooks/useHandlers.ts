import { useCallback, useMemo } from 'react';
import toast from 'react-hot-toast';
import {
    Artwork, CalendarEvent, Catalog, Invoice, Collection, Contact, Inquiry, Conversation,
    ConversationDetails, Message, MessageTag, MessageReplyTo, MessageAttachment,
    InquiryMessage, NewContact, UserProfile, MessageStatus
} from '../types';
import { AuthUser } from '../services/authService';
import { db } from '../services/db';
import { messagingService } from '../services/messagingService';
import { invoiceService, isSyncUnavailable } from '../services/invoiceService';
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
 *
 * Changes show at once: on screen and in the device's saved copy first, then
 * sent to the server in the background (sendInBackground). They used to wait
 * for the server round trip, and a failed save was only logged: the change
 * stayed on this phone until a later reload quietly dropped it.
 */

/**
 * Sends a change the screen already shows. If the server refuses it or can't
 * be reached, `undo` puts the screen and the saved copy back as they were and
 * a message says what wasn't saved.
 */
function sendInBackground(failure: string, send: () => Promise<unknown>, undo: () => unknown): void {
    send().catch(async (err: unknown) => {
        try { await undo(); } catch { /* the next sync settles it */ }
        toast.error(`${failure}: ${(err as Error)?.message || 'check your connection'}`);
    });
}

type Order<T> = (a: T, b: T) => number;

/** One list's screen state and saved copy, changed together. */
function listStore<T extends { id: string }>(
    setter: React.Dispatch<React.SetStateAction<T[]>>,
    saved: { all(): Promise<T[]>; save(item: T): Promise<void>; remove(id: string): Promise<void> },
    order?: Order<T>,
) {
    return {
        /** Adds (at the top, or in order) or replaces in place. */
        async put(item: T): Promise<void> {
            await saved.save(item);
            setter(prev => {
                const next = prev.some(x => x.id === item.id) ? prev.map(x => (x.id === item.id ? item : x)) : [item, ...prev];
                return order ? [...next].sort(order) : next;
            });
        },
        async drop(id: string): Promise<void> {
            await saved.remove(id);
            setter(prev => prev.filter(x => x.id !== id));
        },
        /** As saved on the device: what an undo puts back. */
        async find(id: string): Promise<T | undefined> {
            return (await saved.all()).find(x => x.id === id);
        },
    };
}

const newestFirst = <T extends { createdAt?: number }>(a: T, b: T) => (b.createdAt ?? 0) - (a.createdAt ?? 0);

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

    const stores = useMemo(() => ({
        artworks: listStore<Artwork>(setArtworks, { all: db.getArtworks, save: db.saveArtwork, remove: db.deleteArtwork }, newestFirst),
        catalogs: listStore<Catalog>(setCatalogs, { all: db.getCatalogs, save: db.saveCatalog, remove: db.deleteCatalog }, newestFirst),
        collections: listStore<Collection>(setCollections, { all: db.getCollections, save: db.saveCollection, remove: db.deleteCollection }),
        inquiries: listStore<Inquiry>(setInquiries, { all: db.getInquiries, save: db.saveInquiry, remove: db.deleteInquiry }, (a, b) => b.date - a.date),
        events: listStore<CalendarEvent>(setEvents, { all: db.getEvents, save: db.saveEvent, remove: db.deleteEvent }, (a, b) => a.date - b.date),
        contacts: listStore<Contact>(setContacts, { all: db.getContacts, save: db.saveContact, remove: db.deleteContact }, newestFirst),
        invoices: listStore<Invoice>(setInvoices, { all: db.getInvoices, save: db.saveInvoice, remove: db.deleteInvoice }, (a, b) => b.date - a.date),
        conversations: listStore<Conversation>(setConversations, { all: db.getConversations, save: db.saveConversation, remove: db.deleteConversation }),
    }), [setArtworks, setCatalogs, setCollections, setInquiries, setEvents, setContacts, setInvoices, setConversations]);

    // ── Artworks ──────────────────────────────────────────────────────────
    const handleAddArtwork = useCallback(async (newArt: Omit<Artwork, 'id' | 'createdAt'>) => {
        const artwork: Artwork = { ...newArt, id: `art_${Date.now()}`, createdAt: Date.now() };
        await stores.artworks.put(artwork);
        sendInBackground('Artwork not saved', () => artworkService.saveArtwork(artwork), () => stores.artworks.drop(artwork.id));
        return artwork;
    }, [stores]);

    const handleUpdateArtwork = useCallback(async (updatedArt: Artwork) => {
        const before = artworks.find(a => a.id === updatedArt.id) ?? await stores.artworks.find(updatedArt.id);
        await stores.artworks.put(updatedArt);
        setSelectedArtwork(prev => prev?.id === updatedArt.id ? updatedArt : prev);
        sendInBackground('Artwork changes not saved', () => artworkService.updateArtwork(updatedArt), async () => {
            if (!before) return;
            await stores.artworks.put(before);
            setSelectedArtwork(prev => prev?.id === before.id ? before : prev);
        });
    }, [artworks, stores, setSelectedArtwork]);

    const handleDeleteArtwork = useCallback(async (id: string) => {
        const before = artworks.find(a => a.id === id) ?? await stores.artworks.find(id);
        await stores.artworks.drop(id);
        setSelectedArtwork(prev => prev?.id === id ? null : prev);
        sendInBackground("Couldn't delete the artwork", () => artworkService.deleteArtwork(id), () => before && stores.artworks.put(before));
    }, [artworks, stores, setSelectedArtwork]);

    // ── Catalogs ──────────────────────────────────────────────────────────
    const handleAddCatalog = useCallback(async (newCat: Omit<Catalog, 'id' | 'createdAt'> & { id?: string }) => {
        const catalog: Catalog = { ...newCat, id: newCat.id || `cat_${Date.now()}`, createdAt: Date.now() };
        await stores.catalogs.put(catalog);
        sendInBackground('Catalog not saved', () => catalogService.saveCatalog(catalog), () => stores.catalogs.drop(catalog.id));
        return catalog;
    }, [stores]);

    const handleUpdateCatalog = useCallback(async (updatedCat: Catalog) => {
        const before = await stores.catalogs.find(updatedCat.id);
        await stores.catalogs.put(updatedCat);
        sendInBackground('Catalog changes not saved', () => catalogService.updateCatalog(updatedCat), () => before && stores.catalogs.put(before));
    }, [stores]);

    const handleDeleteCatalog = useCallback(async (id: string) => {
        const before = await stores.catalogs.find(id);
        await stores.catalogs.drop(id);
        sendInBackground("Couldn't delete the catalog", () => catalogService.deleteCatalog(id), () => before && stores.catalogs.put(before));
    }, [stores]);

    // ── Collections ───────────────────────────────────────────────────────
    const handleAddCollection = useCallback(async (newCol: Omit<Collection, 'id'>) => {
        const collection: Collection = { ...newCol, id: `col_${Date.now()}` };
        await stores.collections.put(collection);
        sendInBackground('Collection not saved', () => collectionService.saveCollection(collection), () => stores.collections.drop(collection.id));
    }, [stores]);

    const handleUpdateCollection = useCallback(async (updatedCol: Collection) => {
        const before = await stores.collections.find(updatedCol.id);
        await stores.collections.put(updatedCol);
        sendInBackground('Collection changes not saved', () => collectionService.updateCollection(updatedCol), () => before && stores.collections.put(before));
    }, [stores]);

    const handleDeleteCollection = useCallback(async (id: string) => {
        const before = await stores.collections.find(id);
        await stores.collections.drop(id);
        sendInBackground("Couldn't delete the collection", () => collectionService.deleteCollection(id), () => before && stores.collections.put(before));
    }, [stores]);

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
            db.saveArtwork(updatedArt).catch(e => console.error('Local save failed (proforma artwork status):', e));
        }
        setArtworks(prev => prev.map(art => (soldIds.has(art.id) ? { ...art, status: 'Sold' as const } : art)));
    }, [artworks, setArtworks]);

    /**
     * Shown and kept on the device at once; then the server, so every device
     * sees it. A proforma stays on the device if the server can't take it
     * (it could always be made offline), with a message saying so.
     */
    const syncInvoice = useCallback(async (invoice: Invoice) => {
        await stores.invoices.put(invoice);
        invoiceService.saveInvoice(invoice).catch((err: unknown) => {
            if (!isSyncUnavailable(err)) {
                toast.error(`Saved on this device only — ${(err as Error).message || 'the server could not be reached'}`);
            }
        });
    }, [stores]);

    const handleAddInvoice = useCallback(async (newInv: Omit<Invoice, 'id' | 'date'>): Promise<Invoice> => {
        const invoice: Invoice = { ...newInv, id: `inv_${Date.now()}`, date: Date.now() };
        await syncInvoice(invoice);
        markPaidInvoiceArtworksSold(invoice);
        return invoice;
    }, [markPaidInvoiceArtworksSold, syncInvoice]);

    const handleUpdateInvoice = useCallback(async (updatedInv: Invoice) => {
        await syncInvoice(updatedInv);
        markPaidInvoiceArtworksSold(updatedInv);
    }, [markPaidInvoiceArtworksSold, syncInvoice]);

    const handleDeleteInvoice = useCallback(async (id: string) => {
        const before = await stores.invoices.find(id);
        await stores.invoices.drop(id);
        sendInBackground("Couldn't delete it on the server", async () => {
            try {
                await invoiceService.deleteInvoice(id);
            } catch (err) {
                // No server sync for invoices: deleting it here is enough.
                if (!isSyncUnavailable(err)) throw err;
            }
        }, () => before && stores.invoices.put(before));
    }, [stores]);

    // ── Inquiries ─────────────────────────────────────────────────────────
    const handleAddInquiry = useCallback(async (newInq: Omit<Inquiry, 'id' | 'date'>) => {
        // The server records the creator from the session; mirror it locally
        // so "Added by" shows before the next sync.
        const inquiry: Inquiry = {
            ...newInq, id: `inq_${Date.now()}`, date: Date.now(),
            createdBy: userProfile?.id || authUser?.id,
            createdByName: userProfile?.name || authUser?.name,
        };
        await stores.inquiries.put(inquiry);
        sendInBackground('Inquiry not saved', () => inquiryService.saveInquiry(inquiry), () => stores.inquiries.drop(inquiry.id));
    }, [userProfile, authUser, stores]);

    const handleUpdateInquiry = useCallback(async (updatedInq: Inquiry) => {
        const before = await stores.inquiries.find(updatedInq.id);
        await stores.inquiries.put(updatedInq);
        sendInBackground('Inquiry changes not saved', () => inquiryService.updateInquiry(updatedInq), () => before && stores.inquiries.put(before));
    }, [stores]);

    const handleDeleteInquiry = useCallback(async (id: string) => {
        const before = await stores.inquiries.find(id);
        await stores.inquiries.drop(id);
        sendInBackground("Couldn't delete the inquiry", () => inquiryService.deleteInquiry(id), () => before && stores.inquiries.put(before));
    }, [stores]);

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
        await stores.events.put(event);
        sendInBackground('Not saved to the calendar', () => eventService.saveEvent(event), () => stores.events.drop(event.id));
    }, [userProfile, authUser, stores]);

    const handleDeleteEvent = useCallback(async (id: string) => {
        const before = await stores.events.find(id);
        await stores.events.drop(id);
        sendInBackground("Couldn't delete it from the calendar", () => eventService.deleteEvent(id), () => before && stores.events.put(before));
    }, [stores]);

    // Ticking a task shows at once; a refused save puts it back.
    const handleUpdateEvent = useCallback(async (updated: CalendarEvent) => {
        const before = await stores.events.find(updated.id);
        await stores.events.put(updated);
        sendInBackground('Calendar change not saved', () => eventService.updateEvent(updated), () => before && stores.events.put(before));
    }, [stores]);

    // ── Contacts ──────────────────────────────────────────────────────────
    const handleAddContact = useCallback(async (newContact: NewContact) => {
        const contact: Contact = {
            ...newContact,
            id: `cont_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
            createdAt: Date.now(),
            createdBy: userProfile?.id || authUser?.id,
            createdByName: userProfile?.name || authUser?.name,
        };
        await stores.contacts.put(contact);
        sendInBackground('Contact not saved', () => contactService.saveContact(contact).then(saved => stores.contacts.put(saved)), () => stores.contacts.drop(contact.id));
    }, [userProfile, authUser, stores]);

    const handleUpdateContact = useCallback(async (updated: Contact) => {
        const before = await stores.contacts.find(updated.id);
        await stores.contacts.put(updated);
        sendInBackground('Contact changes not saved', () => contactService.updateContact(updated).then(saved => stores.contacts.put(saved)), () => before && stores.contacts.put(before));
    }, [stores]);

    // A bulk import waits for the server: it says how many it took.
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
        const before = await stores.contacts.find(id);
        await stores.contacts.drop(id);
        sendInBackground("Couldn't delete the contact", () => contactService.deleteContact(id), () => before && stores.contacts.put(before));
    }, [stores]);

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
        // On screen at once; a message the server refuses is taken back, with the reason.
        await db.saveInquiryMessage(msg);
        setInquiryMessages((prev: InquiryMessage[]) => [...prev, msg]);
        try {
            await inquiryService.saveInquiryMessage(msg);
        } catch (err) {
            setInquiryMessages((prev: InquiryMessage[]) => prev.filter(m => m.id !== msg.id));
            toast.error(`Message not sent: ${(err as Error).message || 'check your connection'}`);
            return;
        }
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
        // The chat list moves it to the top at once too, not after the server answers.
        const conv = conversations.find(c => c.id === conversationId);
        if (conv) {
            const attachPreview = attachment?.type === 'image' ? '📷 Photo' : `📎 ${attachment?.name}`;
            const lastMessagePreview = attachment ? attachPreview : text;
            const updatedConv = { ...conv, lastMessage: lastMessagePreview, lastMessageTime: Date.now(), unreadCount: 0 };
            await db.saveConversation(updatedConv);
            setConversations((prev: Conversation[]) => prev.map(c => c.id === conversationId ? updatedConv : c).sort((a, b) => b.lastMessageTime - a.lastMessageTime));
        }
        try {
            await messagingService.sendMessage(msg);
        } catch (err) {
            setAllMessages(makeMessageStatusUpdater<Message>(msg.id, 'failed'));
            toast.error(`Message not sent: ${(err as Error).message || 'check your connection'}`);
            return;
        }
        await db.saveMessage(msg);
    }, [userProfile, authUser, conversations, setAllMessages, setConversations]);

    // ── Messaging: Pin/Archive ────────────────────────────────────────────
    const handleTogglePinConversation = useCallback(async (conversationId: string) => {
        const conv = conversations.find(c => c.id === conversationId);
        if (!conv) return;
        const updatedConv = { ...conv, isPinned: !conv.isPinned };
        await stores.conversations.put(updatedConv);
        sendInBackground(updatedConv.isPinned ? "Couldn't pin the chat" : "Couldn't unpin the chat",
            () => messagingService.updateConversation(updatedConv), () => stores.conversations.put(conv));
    }, [conversations, stores]);

    const handleToggleArchiveConversation = useCallback(async (conversationId: string) => {
        const conv = conversations.find(c => c.id === conversationId);
        if (!conv) return;
        const updatedConv = { ...conv, isArchived: !conv.isArchived };
        await stores.conversations.put(updatedConv);
        sendInBackground(updatedConv.isArchived ? "Couldn't archive the chat" : "Couldn't unarchive the chat",
            () => messagingService.updateConversation(updatedConv), () => stores.conversations.put(conv));
    }, [conversations, stores]);

    const handleDeleteConversation = useCallback(async (conversationId: string) => {
        const before = conversations.find(c => c.id === conversationId);
        await stores.conversations.drop(conversationId);
        sendInBackground("Couldn't delete the chat", () => messagingService.deleteConversation(conversationId),
            () => before && stores.conversations.put(before));
    }, [conversations, stores]);

    // ── Messaging: Create Conversation / Group ────────────────────────────
    const handleCreateConversation = useCallback(async (participantId: string, details?: ConversationDetails): Promise<Conversation> => {
        const selfId = userProfile?.id || authUser?.id || '';
        // Only match direct (1-on-1) conversations — a group that happens to
        // contain both users must NOT be treated as an existing 1-on-1 chat.
        const existing = conversations.find(c => !c.isGroup && c.participantIds.includes(participantId) && c.participantIds.includes(selfId));
        if (existing) return existing;

        const otherMember = teamMembers.find(m => m.id === participantId);
        const conv: Conversation = {
            id: `conv_${Date.now()}_${crypto.randomUUID()}`,
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

    /**
     * Sets (or with null, takes back) your reaction to a message. Shown at
     * once; the server's answer then replaces it, and a refusal puts the
     * message back as it was.
     */
    const handleReactToMessage = useCallback(async (messageId: string, emoji: string | null) => {
        const me = userProfile?.id || authUser?.id || '';
        if (!me) return;
        let before: Message | undefined;
        setAllMessages((prev: Message[]) => prev.map(m => {
            if (m.id !== messageId) return m;
            before = m;
            const reactions = { ...m.reactions };
            if (emoji === null) delete reactions[me]; else reactions[me] = emoji;
            return { ...m, reactions: Object.keys(reactions).length ? reactions : undefined };
        }));
        try {
            const updated = await messagingService.react(messageId, emoji);
            if (updated) {
                setAllMessages((prev: Message[]) => prev.map(m => (m.id === messageId ? { ...m, ...updated } : m)));
                await db.saveMessage(updated);
            }
        } catch (err) {
            if (before) { const original = before; setAllMessages((prev: Message[]) => prev.map(m => (m.id === messageId ? original : m))); }
            toast.error(`Reaction not saved: ${(err as Error).message || 'check your connection'}`);
        }
    }, [userProfile, authUser, setAllMessages]);

    /** The same on an inquiry's chat. */
    const handleReactToInquiryMessage = useCallback(async (messageId: string, emoji: string | null) => {
        const me = userProfile?.id || authUser?.id || '';
        if (!me) return;
        let before: InquiryMessage | undefined;
        setInquiryMessages((prev: InquiryMessage[]) => prev.map(m => {
            if (m.id !== messageId) return m;
            before = m;
            const reactions = { ...m.reactions };
            if (emoji === null) delete reactions[me]; else reactions[me] = emoji;
            return { ...m, reactions: Object.keys(reactions).length ? reactions : undefined };
        }));
        try {
            const updated = await inquiryService.react(messageId, emoji);
            if (updated) {
                setInquiryMessages((prev: InquiryMessage[]) => prev.map(m => (m.id === messageId ? { ...m, ...updated } : m)));
                await db.saveInquiryMessage(updated);
            }
        } catch (err) {
            if (before) { const original = before; setInquiryMessages((prev: InquiryMessage[]) => prev.map(m => (m.id === messageId ? original : m))); }
            toast.error(`Reaction not saved: ${(err as Error).message || 'check your connection'}`);
        }
    }, [userProfile, authUser, setInquiryMessages]);

    /**
     * Tells the server you have seen these messages (the chat is open on
     * screen), so their senders can see who read them. Best effort: a
     * failure is simply tried again the next time the chat is opened.
     */
    const handleMarkMessagesRead = useCallback(async (messageIds: string[]) => {
        for (let i = 0; i < messageIds.length; i += 100) {
            try {
                await messagingService.batchUpdateStatus(messageIds.slice(i, i + 100), 'read');
            } catch {
                return;
            }
        }
    }, []);

    const handleCreateGroup = useCallback(async (participantIds: string[], groupName: string, details?: ConversationDetails, isPrivate = false): Promise<Conversation> => {
        const selfId = userProfile?.id || authUser?.id || '';
        const allParticipantIds = Array.from(new Set([selfId, ...participantIds]));
        const allParticipantNames = allParticipantIds.map(id =>
            id === selfId ? (userProfile?.name || authUser?.name || 'You') : (teamMembers.find(m => m.id === id)?.name || 'Team Member')
        );
        const conv: Conversation = {
            id: `conv_${Date.now()}_${crypto.randomUUID()}`,
            participantIds: allParticipantIds,
            participantNames: allParticipantNames,
            lastMessage: '', lastMessageTime: Date.now(), unreadCount: 0,
            isGroup: true, groupName,
            title: details?.title, reason: details?.reason, note: details?.note,
            ...(isPrivate ? { isPrivate: true, createdBy: selfId } : {}),
        };
        try {
            await messagingService.createConversation(conv);
        } catch (e) {
            toast.error(`Couldn't create the ${isPrivate ? 'private room' : 'group'}: ${(e as Error).message || 'check your connection'}`);
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
        await stores.conversations.put(updatedConv);
        sendInBackground('Chat details not saved', () => messagingService.updateConversation(updatedConv), () => stores.conversations.put(conv));
    }, [conversations, stores]);

    const handleUpdateGroup = useCallback(async (conversationId: string, groupName: string, participantIds: string[], details?: ConversationDetails) => {
        const conv = conversations.find(c => c.id === conversationId);
        if (!conv) return;
        const selfId = userProfile?.id || authUser?.id || '';
        const allIds = Array.from(new Set([selfId, ...participantIds]));
        const allNames = allIds.map(id =>
            id === selfId ? (userProfile?.name || authUser?.name || 'You') : (teamMembers.find(m => m.id === id)?.name || 'Team Member')
        );
        const updatedConv: Conversation = { ...conv, groupName, participantIds: allIds, participantNames: allNames, isGroup: true, title: details?.title, reason: details?.reason, note: details?.note };
        await stores.conversations.put(updatedConv);
        sendInBackground('Group changes not saved', () => messagingService.updateConversation(updatedConv), () => stores.conversations.put(conv));
    }, [conversations, userProfile, authUser, teamMembers, stores]);

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
        handleSendMessage, handleRetryMessage, handleReactToMessage, handleReactToInquiryMessage, handleMarkMessagesRead, handleTogglePinConversation, handleToggleArchiveConversation, handleDeleteConversation,
        handleCreateConversation, handleCreateGroup, handleUpdateConversationDetails,
        handleUpdateGroup,
    };
}