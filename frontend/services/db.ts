import localforage from 'localforage';
import { Artwork, Catalog, Collection, Invoice, Inquiry, Conversation, Message, InquiryMessage, UserProfile } from '../types';
import { MOCK_ARTWORKS, MOCK_CATALOGS, MOCK_COLLECTIONS, MOCK_INVOICES, MOCK_INQUIRIES, MOCK_CONVERSATIONS, MOCK_MESSAGES, MOCK_TEAM_MEMBERS } from '../constants';

// Initialize stores
const usersStore = localforage.createInstance({ name: 'vayu', storeName: 'users' });
const artworksStore = localforage.createInstance({ name: 'vayu', storeName: 'artworks' });
const catalogsStore = localforage.createInstance({ name: 'vayu', storeName: 'catalogs' });
const collectionsStore = localforage.createInstance({ name: 'vayu', storeName: 'collections' });
const invoicesStore = localforage.createInstance({ name: 'vayu', storeName: 'invoices' });
const inquiriesStore = localforage.createInstance({ name: 'vayu', storeName: 'inquiries' });
const conversationsStore = localforage.createInstance({ name: 'vayu', storeName: 'conversations' });
const messagesStore = localforage.createInstance({ name: 'vayu', storeName: 'messages' });
// Separate store for per-inquiry chats, kept independent from the general team conversations/messages above
const inquiryMessagesStore = localforage.createInstance({ name: 'vayu', storeName: 'inquiryMessages' });
const teamStore = localforage.createInstance({ name: 'vayu', storeName: 'team' });

// Simulate Cloud Sync across devices using BroadcastChannel
const syncChannel = new BroadcastChannel('vayu_cloud_sync');

const notifySync = () => {
    syncChannel.postMessage({ type: 'SYNC_REQUIRED', timestamp: Date.now() });
};

export const db = {
    async init() {
        // Seed data if empty
        const artsCount = await artworksStore.length();
        if (artsCount === 0) {
            for (const art of MOCK_ARTWORKS) await artworksStore.setItem(art.id, art);
            for (const cat of MOCK_CATALOGS) await catalogsStore.setItem(cat.id, cat);
            for (const col of MOCK_COLLECTIONS) await collectionsStore.setItem(col.id, col);
            for (const inv of MOCK_INVOICES) await invoicesStore.setItem(inv.id, inv);
            for (const inq of MOCK_INQUIRIES) await inquiriesStore.setItem(inq.id, inq);
        }
        // Seed conversations & messages if empty
        const convCount = await conversationsStore.length();
        if (convCount === 0) {
            for (const conv of MOCK_CONVERSATIONS) await conversationsStore.setItem(conv.id, conv);
            for (const msg of MOCK_MESSAGES) await messagesStore.setItem(msg.id, msg);
            for (const member of MOCK_TEAM_MEMBERS) await teamStore.setItem(member.id, member);
        }
    },

    // Users (Using phone as primary key)
    async saveUser(user: UserProfile): Promise<void> {
        await usersStore.setItem(user.phone, user);
        // Also update team store if exists
        if (user.id) await teamStore.setItem(user.id, user);
        notifySync();
    },
    async getUser(phone: string): Promise<UserProfile | null> {
        return await usersStore.getItem<UserProfile>(phone);
    },

    // Artworks
    async getArtworks(): Promise<Artwork[]> {
        const artworks: Artwork[] = [];
        await artworksStore.iterate((value: Artwork) => {
            artworks.push(value);
        });
        return artworks.sort((a, b) => b.createdAt - a.createdAt);
    },
    async saveArtwork(artwork: Artwork): Promise<void> {
        await artworksStore.setItem(artwork.id, artwork);
        notifySync();
    },
    async deleteArtwork(id: string): Promise<void> {
        await artworksStore.removeItem(id);
        notifySync();
    },

    // Catalogs
    async getCatalogs(): Promise<Catalog[]> {
        const catalogs: Catalog[] = [];
        await catalogsStore.iterate((value: Catalog) => {
            catalogs.push(value);
        });
        return catalogs.sort((a, b) => b.createdAt - a.createdAt);
    },
    async saveCatalog(catalog: Catalog): Promise<void> {
        await catalogsStore.setItem(catalog.id, catalog);
        notifySync();
    },
    async deleteCatalog(id: string): Promise<void> {
        await catalogsStore.removeItem(id);
        notifySync();
    },

    // Collections
    async getCollections(): Promise<Collection[]> {
        const collections: Collection[] = [];
        await collectionsStore.iterate((value: Collection) => {
            collections.push(value);
        });
        return collections;
    },
    async saveCollection(collection: Collection): Promise<void> {
        await collectionsStore.setItem(collection.id, collection);
        notifySync();
    },
    async deleteCollection(id: string): Promise<void> {
        await collectionsStore.removeItem(id);
        notifySync();
    },

    // Invoices
    async getInvoices(): Promise<Invoice[]> {
        const invoices: Invoice[] = [];
        await invoicesStore.iterate((value: Invoice) => {
            invoices.push(value);
        });
        return invoices.sort((a, b) => b.date - a.date);
    },
    async saveInvoice(invoice: Invoice): Promise<void> {
        await invoicesStore.setItem(invoice.id, invoice);
        notifySync();
    },
    async deleteInvoice(id: string): Promise<void> {
        await invoicesStore.removeItem(id);
        notifySync();
    },

    // Inquiries
    async getInquiries(): Promise<Inquiry[]> {
        const inquiries: Inquiry[] = [];
        await inquiriesStore.iterate((value: Inquiry) => {
            inquiries.push(value);
        });
        return inquiries.sort((a, b) => b.date - a.date);
    },
    async saveInquiry(inquiry: Inquiry): Promise<void> {
        await inquiriesStore.setItem(inquiry.id, inquiry);
        notifySync();
    },
    async deleteInquiry(id: string): Promise<void> {
        await inquiriesStore.removeItem(id);
        notifySync();
    },

    // Conversations
    async getConversations(): Promise<Conversation[]> {
        const conversations: Conversation[] = [];
        await conversationsStore.iterate((value: Conversation) => {
            conversations.push(value);
        });
        return conversations.sort((a, b) => b.lastMessageTime - a.lastMessageTime);
    },
    async saveConversation(conv: Conversation): Promise<void> {
        await conversationsStore.setItem(conv.id, conv);
        notifySync();
    },
    async deleteConversation(id: string): Promise<void> {
        await conversationsStore.removeItem(id);
        notifySync();
    },

    // Messages
    async getMessages(): Promise<Message[]> {
        const messages: Message[] = [];
        await messagesStore.iterate((value: Message) => {
            messages.push(value);
        });
        return messages.sort((a, b) => a.timestamp - b.timestamp);
    },
    async getMessagesByConversation(conversationId: string): Promise<Message[]> {
        const messages: Message[] = [];
        await messagesStore.iterate((value: Message) => {
            if (value.conversationId === conversationId) messages.push(value);
        });
        return messages.sort((a, b) => a.timestamp - b.timestamp);
    },
    async saveMessage(msg: Message): Promise<void> {
        await messagesStore.setItem(msg.id, msg);
        notifySync();
    },

    // Inquiry Chats (separate from team conversations/messages)
    async getInquiryMessages(): Promise<InquiryMessage[]> {
        const messages: InquiryMessage[] = [];
        await inquiryMessagesStore.iterate((value: InquiryMessage) => {
            messages.push(value);
        });
        return messages.sort((a, b) => a.timestamp - b.timestamp);
    },
    async saveInquiryMessage(msg: InquiryMessage): Promise<void> {
        await inquiryMessagesStore.setItem(msg.id, msg);
        notifySync();
    },

    // Team Members
    async getTeamMembers(): Promise<UserProfile[]> {
        const members: UserProfile[] = [];
        await teamStore.iterate((value: UserProfile) => {
            members.push(value);
        });
        return members;
    },
    async saveTeamMember(member: UserProfile): Promise<void> {
        await teamStore.setItem(member.id, member);
        notifySync();
    },
};
