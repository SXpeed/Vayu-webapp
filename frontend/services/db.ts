import { Artwork, Catalog, Collection, Invoice, Inquiry, Conversation, Message, InquiryMessage, UserProfile } from '../types';
import { MOCK_ARTWORKS, MOCK_CATALOGS, MOCK_COLLECTIONS, MOCK_INVOICES, MOCK_INQUIRIES, MOCK_CONVERSATIONS, MOCK_MESSAGES, MOCK_TEAM_MEMBERS, MOCK_USERS } from '../constants';

/**
 * Simple localStorage based data service.
 * Each entity is stored under its own key as a JSON array.
 */
const STORAGE_KEYS = {
  users: 'vayu_users',
  artworks: 'vayu_artworks',
  catalogs: 'vayu_catalogs',
  collections: 'vayu_collections',
  invoices: 'vayu_invoices',
  inquiries: 'vayu_inquiries',
  conversations: 'vayu_conversations',
  messages: 'vayu_messages',
  inquiryMessages: 'vayu_inquiry_messages',
  team: 'vayu_team',
};

function getArray<T>(key: string): T[] {
  const raw = localStorage.getItem(key);
  return raw ? JSON.parse(raw) : [];
}

function setArray<T>(key: string, data: T[]): void {
  localStorage.setItem(key, JSON.stringify(data));
}

export const db = {
  async init() {
    // Seed mock data if storage is empty
    if (getArray<Artwork>(STORAGE_KEYS.artworks).length === 0) {
      setArray(STORAGE_KEYS.artworks, MOCK_ARTWORKS);
      setArray(STORAGE_KEYS.catalogs, MOCK_CATALOGS);
      setArray(STORAGE_KEYS.collections, MOCK_COLLECTIONS);
      setArray(STORAGE_KEYS.invoices, MOCK_INVOICES);
      setArray(STORAGE_KEYS.inquiries, MOCK_INQUIRIES);
      setArray(STORAGE_KEYS.conversations, MOCK_CONVERSATIONS);
      setArray(STORAGE_KEYS.messages, MOCK_MESSAGES);
      setArray(STORAGE_KEYS.team, MOCK_TEAM_MEMBERS);
    }
    if (getArray<UserProfile>(STORAGE_KEYS.users).length === 0) {
      setArray(STORAGE_KEYS.users, MOCK_USERS || []);
    }
  },

  // Users
  async saveUser(user: UserProfile): Promise<void> {
    const users = getArray<UserProfile>(STORAGE_KEYS.users);
    users.push(user);
    setArray(STORAGE_KEYS.users, users);
  },
  async getUser(phone: string): Promise<UserProfile | null> {
    const users = getArray<UserProfile>(STORAGE_KEYS.users);
    return users.find(u => u.phone === phone) || null;
  },

  // Artworks
  async getArtworks(): Promise<Artwork[]> {
    return getArray<Artwork>(STORAGE_KEYS.artworks);
  },
  async saveArtwork(artwork: Artwork): Promise<void> {
    const arts = getArray<Artwork>(STORAGE_KEYS.artworks);
    arts.push(artwork);
    setArray(STORAGE_KEYS.artworks, arts);
  },
  async deleteArtwork(id: string): Promise<void> {
    const arts = getArray<Artwork>(STORAGE_KEYS.artworks).filter(a => a.id !== id);
    setArray(STORAGE_KEYS.artworks, arts);
  },

  // Catalogs
  async getCatalogs(): Promise<Catalog[]> {
    return getArray<Catalog>(STORAGE_KEYS.catalogs);
  },
  async saveCatalog(catalog: Catalog): Promise<void> {
    const cats = getArray<Catalog>(STORAGE_KEYS.catalogs);
    cats.push(catalog);
    setArray(STORAGE_KEYS.catalogs, cats);
  },
  async deleteCatalog(id: string): Promise<void> {
    const cats = getArray<Catalog>(STORAGE_KEYS.catalogs).filter(c => c.id !== id);
    setArray(STORAGE_KEYS.catalogs, cats);
  },

  // Collections
  async getCollections(): Promise<Collection[]> {
    return getArray<Collection>(STORAGE_KEYS.collections);
  },
  async saveCollection(collection: Collection): Promise<void> {
    const colls = getArray<Collection>(STORAGE_KEYS.collections);
    colls.push(collection);
    setArray(STORAGE_KEYS.collections, colls);
  },
  async deleteCollection(id: string): Promise<void> {
    const colls = getArray<Collection>(STORAGE_KEYS.collections).filter(c => c.id !== id);
    setArray(STORAGE_KEYS.collections, colls);
  },

  // Invoices
  async getInvoices(): Promise<Invoice[]> {
    return getArray<Invoice>(STORAGE_KEYS.invoices);
  },
  async saveInvoice(invoice: Invoice): Promise<void> {
    const invs = getArray<Invoice>(STORAGE_KEYS.invoices);
    invs.push(invoice);
    setArray(STORAGE_KEYS.invoices, invs);
  },
  async deleteInvoice(id: string): Promise<void> {
    const invs = getArray<Invoice>(STORAGE_KEYS.invoices).filter(i => i.id !== id);
    setArray(STORAGE_KEYS.invoices, invs);
  },

  // Inquiries
  async getInquiries(): Promise<Inquiry[]> {
    return getArray<Inquiry>(STORAGE_KEYS.inquiries);
  },
  async saveInquiry(inquiry: Inquiry): Promise<void> {
    const inqs = getArray<Inquiry>(STORAGE_KEYS.inquiries);
    inqs.push(inquiry);
    setArray(STORAGE_KEYS.inquiries, inqs);
  },
  async deleteInquiry(id: string): Promise<void> {
    const inqs = getArray<Inquiry>(STORAGE_KEYS.inquiries).filter(i => i.id !== id);
    setArray(STORAGE_KEYS.inquiries, inqs);
  },

  // Conversations
  async getConversations(): Promise<Conversation[]> {
    return getArray<Conversation>(STORAGE_KEYS.conversations);
  },
  async saveConversation(conv: Conversation): Promise<void> {
    const convs = getArray<Conversation>(STORAGE_KEYS.conversations);
    convs.push(conv);
    setArray(STORAGE_KEYS.conversations, convs);
  },
  async deleteConversation(id: string): Promise<void> {
    const convs = getArray<Conversation>(STORAGE_KEYS.conversations).filter(c => c.id !== id);
    setArray(STORAGE_KEYS.conversations, convs);
  },

  // Messages
  async getMessages(): Promise<Message[]> {
    return getArray<Message>(STORAGE_KEYS.messages);
  },
  async getMessagesByConversation(conversationId: string): Promise<Message[]> {
    return getArray<Message>(STORAGE_KEYS.messages).filter(m => m.conversationId === conversationId);
  },
  async saveMessage(msg: Message): Promise<void> {
    const msgs = getArray<Message>(STORAGE_KEYS.messages);
    msgs.push(msg);
    setArray(STORAGE_KEYS.messages, msgs);
  },

  // Inquiry Messages
  async getInquiryMessages(): Promise<InquiryMessage[]> {
    return getArray<InquiryMessage>(STORAGE_KEYS.inquiryMessages);
  },
  async saveInquiryMessage(msg: InquiryMessage): Promise<void> {
    const msgs = getArray<InquiryMessage>(STORAGE_KEYS.inquiryMessages);
    msgs.push(msg);
    setArray(STORAGE_KEYS.inquiryMessages, msgs);
  },

  // Team Members
  async getTeamMembers(): Promise<UserProfile[]> {
    return getArray<UserProfile>(STORAGE_KEYS.team);
  },
  async saveTeamMember(member: UserProfile): Promise<void> {
    const team = getArray<UserProfile>(STORAGE_KEYS.team);
    team.push(member);
    setArray(STORAGE_KEYS.team, team);
  },
};
