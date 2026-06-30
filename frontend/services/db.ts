import { Artwork, Catalog, Collection, Invoice, Inquiry, Conversation, Message, InquiryMessage, UserProfile } from '../types';
import { MOCK_ARTWORKS, MOCK_CATALOGS, MOCK_COLLECTIONS, MOCK_INVOICES, MOCK_INQUIRIES, MOCK_CONVERSATIONS, MOCK_MESSAGES, MOCK_TEAM_MEMBERS, MOCK_USERS } from '../constants';

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

function upsertById<T extends { id: string }>(arr: T[], item: T): T[] {
  const idx = arr.findIndex(x => x.id === item.id);
  if (idx >= 0) arr[idx] = item;
  else arr.push(item);
  return arr;
}

export const db = {
  async init() {
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
      setArray(STORAGE_KEYS.users, MOCK_USERS);
    }
  },

  // Users (keyed by phone)
  async saveUser(user: UserProfile): Promise<void> {
    const users = getArray<UserProfile>(STORAGE_KEYS.users);
    const idx = users.findIndex(u => u.phone === user.phone);
    if (idx >= 0) users[idx] = user;
    else users.push(user);
    setArray(STORAGE_KEYS.users, users);
  },
  async getUser(phone: string): Promise<UserProfile | null> {
    return getArray<UserProfile>(STORAGE_KEYS.users).find(u => u.phone === phone) || null;
  },

  // Artworks
  async getArtworks(): Promise<Artwork[]> {
    return getArray<Artwork>(STORAGE_KEYS.artworks).sort((a, b) => b.createdAt - a.createdAt);
  },
  async saveArtwork(artwork: Artwork): Promise<void> {
    setArray(STORAGE_KEYS.artworks, upsertById(getArray<Artwork>(STORAGE_KEYS.artworks), artwork));
  },
  async deleteArtwork(id: string): Promise<void> {
    setArray(STORAGE_KEYS.artworks, getArray<Artwork>(STORAGE_KEYS.artworks).filter(a => a.id !== id));
  },

  // Catalogs
  async getCatalogs(): Promise<Catalog[]> {
    return getArray<Catalog>(STORAGE_KEYS.catalogs).sort((a, b) => b.createdAt - a.createdAt);
  },
  async saveCatalog(catalog: Catalog): Promise<void> {
    setArray(STORAGE_KEYS.catalogs, upsertById(getArray<Catalog>(STORAGE_KEYS.catalogs), catalog));
  },
  async deleteCatalog(id: string): Promise<void> {
    setArray(STORAGE_KEYS.catalogs, getArray<Catalog>(STORAGE_KEYS.catalogs).filter(c => c.id !== id));
  },

  // Collections
  async getCollections(): Promise<Collection[]> {
    return getArray<Collection>(STORAGE_KEYS.collections);
  },
  async saveCollection(collection: Collection): Promise<void> {
    setArray(STORAGE_KEYS.collections, upsertById(getArray<Collection>(STORAGE_KEYS.collections), collection));
  },
  async deleteCollection(id: string): Promise<void> {
    setArray(STORAGE_KEYS.collections, getArray<Collection>(STORAGE_KEYS.collections).filter(c => c.id !== id));
  },

  // Invoices
  async getInvoices(): Promise<Invoice[]> {
    return getArray<Invoice>(STORAGE_KEYS.invoices).sort((a, b) => b.date - a.date);
  },
  async saveInvoice(invoice: Invoice): Promise<void> {
    setArray(STORAGE_KEYS.invoices, upsertById(getArray<Invoice>(STORAGE_KEYS.invoices), invoice));
  },
  async deleteInvoice(id: string): Promise<void> {
    setArray(STORAGE_KEYS.invoices, getArray<Invoice>(STORAGE_KEYS.invoices).filter(i => i.id !== id));
  },

  // Inquiries
  async getInquiries(): Promise<Inquiry[]> {
    return getArray<Inquiry>(STORAGE_KEYS.inquiries).sort((a, b) => b.date - a.date);
  },
  async saveInquiry(inquiry: Inquiry): Promise<void> {
    setArray(STORAGE_KEYS.inquiries, upsertById(getArray<Inquiry>(STORAGE_KEYS.inquiries), inquiry));
  },
  async deleteInquiry(id: string): Promise<void> {
    setArray(STORAGE_KEYS.inquiries, getArray<Inquiry>(STORAGE_KEYS.inquiries).filter(i => i.id !== id));
  },

  // Conversations
  async getConversations(): Promise<Conversation[]> {
    return getArray<Conversation>(STORAGE_KEYS.conversations).sort((a, b) => b.lastMessageTime - a.lastMessageTime);
  },
  async saveConversation(conv: Conversation): Promise<void> {
    setArray(STORAGE_KEYS.conversations, upsertById(getArray<Conversation>(STORAGE_KEYS.conversations), conv));
  },
  async deleteConversation(id: string): Promise<void> {
    setArray(STORAGE_KEYS.conversations, getArray<Conversation>(STORAGE_KEYS.conversations).filter(c => c.id !== id));
  },

  // Messages
  async getMessages(): Promise<Message[]> {
    return getArray<Message>(STORAGE_KEYS.messages).sort((a, b) => a.timestamp - b.timestamp);
  },
  async getMessagesByConversation(conversationId: string): Promise<Message[]> {
    return getArray<Message>(STORAGE_KEYS.messages)
      .filter(m => m.conversationId === conversationId)
      .sort((a, b) => a.timestamp - b.timestamp);
  },
  async saveMessage(msg: Message): Promise<void> {
    setArray(STORAGE_KEYS.messages, upsertById(getArray<Message>(STORAGE_KEYS.messages), msg));
  },

  // Inquiry Messages
  async getInquiryMessages(): Promise<InquiryMessage[]> {
    return getArray<InquiryMessage>(STORAGE_KEYS.inquiryMessages).sort((a, b) => a.timestamp - b.timestamp);
  },
  async saveInquiryMessage(msg: InquiryMessage): Promise<void> {
    setArray(STORAGE_KEYS.inquiryMessages, upsertById(getArray<InquiryMessage>(STORAGE_KEYS.inquiryMessages), msg));
  },

  // Team Members
  async getTeamMembers(): Promise<UserProfile[]> {
    return getArray<UserProfile>(STORAGE_KEYS.team);
  },
  async saveTeamMember(member: UserProfile): Promise<void> {
    setArray(STORAGE_KEYS.team, upsertById(getArray<UserProfile>(STORAGE_KEYS.team), member));
  },
};
