import { currentWorkspace } from './workspace';
import { Artwork, CalendarEvent, Catalog, Collection, Contact, Invoice, Inquiry, Conversation, Message, InquiryMessage, UserProfile } from '../types';
import type { Sale, SaleInput, SalesSummary } from '../salesRules';

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
  events: 'vayu_events',
  contacts: 'vayu_contacts',
  salesPages: 'vayu_sales_pages',
  salesPending: 'vayu_sales_pending',
  syncMark: 'vayu_sync_mark',
  seedVersion: 'vayu_seed_version',
  lastSaleTags: 'vayu.sales.lastTags',
};

// Bumped to 3: mock/dummy data removed. Migration cleans old mock IDs
// while preserving any real user-created data.
const SEED_VERSION = 3;

// Known mock IDs from the old seed data — removed during migration.
const MOCK_IDS_TO_CLEAR = {
  artworks: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'],
  catalogs: ['c1'],
  collections: ['col1', 'col2', 'col3'],
  invoices: ['inv1'],
  inquiries: ['inq1', 'inq2', 'inq3', 'inq4'],
  conversations: ['conv_general'],
  messages: ['msg_general_1', 'msg_1', 'msg_2', 'msg_3', 'msg_4', 'msg_5'],
};

// Each workspace keeps its own offline copy, so two organizations used on
// one device never mix. The original app's copy keeps its original keys.
function scoped(key: string): string {
  const workspace = currentWorkspace();
  return workspace ? `${key}@${workspace.id}` : key;
}

function getArray<T>(key: string): T[] {
  const raw = localStorage.getItem(scoped(key));
  return raw ? JSON.parse(raw) : [];
}

function setArray<T>(key: string, data: T[]): void {
  localStorage.setItem(scoped(key), JSON.stringify(data));
}

/** One date range of the sales ledger, as last loaded (shown when offline). */
export interface SavedSalesPage { from: string; to: string; sales: Sale[]; summary: SalesSummary; allTags?: string[]; savedAt: number }

/** A sale recorded while offline: uploaded, and given its number, when the server can be reached. */
export interface PendingSale { id: string; input: SaleInput; savedAt: number; /** Why the server refused it, if it did. */ error?: string }

const MAX_SAVED_SALES_PAGES = 6;

function upsertById<T extends { id: string }>(arr: T[], item: T): T[] {
  const idx = arr.findIndex(x => x.id === item.id);
  if (idx >= 0) arr[idx] = item;
  else arr.push(item);
  return arr;
}

/**
 * Where the saved copy is up to in the server's change log, so a start-up
 * only asks for what changed since (useEntityData). `identity`: who it was
 * taken for, with which access; `fullCopyAt`: when it was last taken whole.
 */
export interface SyncMark { identity: string; cursor: number; fullCopyAt: number }

/** Lists the device keeps a full offline copy of, replaced wholesale from the server. */
export type SavedList = 'artworks' | 'catalogs' | 'collections' | 'inquiries' | 'conversations'
  | 'messages' | 'inquiryMessages' | 'events' | 'contacts';

export const db = {
  /**
   * Removes every saved copy from the device — every workspace's and the
   * original app's — when signing out, so the next person at this device
   * finds no organization's data. Sales recorded offline that still couldn't
   * be uploaded stay: they exist nowhere else, and upload at the next sign-in
   * to their workspace.
   */
  clearSavedCopies(): void {
    const names = Object.values(STORAGE_KEYS).filter(k => k !== STORAGE_KEYS.salesPending && k !== STORAGE_KEYS.seedVersion);
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && names.some(name => key === name || key.startsWith(`${name}@`))) localStorage.removeItem(key);
      }
    } catch { /* unavailable */ }
  },

  /** The tags of the last sale recorded in this workspace (an event's sales share its tag). */
  getLastSaleTags(): unknown {
    try { return JSON.parse(localStorage.getItem(scoped(STORAGE_KEYS.lastSaleTags)) ?? '[]'); } catch { return []; }
  },
  setLastSaleTags(tags: string[]): void {
    try { localStorage.setItem(scoped(STORAGE_KEYS.lastSaleTags), JSON.stringify(tags)); } catch { /* private mode */ }
  },

  /**
   * Replace a saved list with the server's copy. Only artworks used to be
   * mirrored, so e.g. the saved inquiries could be months old — and a
   * fallback to them looked like inquiries had vanished.
   */
  async replaceSaved(list: SavedList, items: unknown[]): Promise<boolean> {
    try {
      setArray(STORAGE_KEYS[list], items);
      return true;
    } catch {
      /* storage full or unavailable — the offline copy just stays older */
      return false;
    }
  },

  /** Brings a saved list up to date in place; false when the device couldn't store it. */
  mergeSaved<T>(list: SavedList, update: (items: T[]) => T[]): boolean {
    try {
      const items = getArray<T>(STORAGE_KEYS[list]);
      const next = update(items);
      if (next !== items) setArray(STORAGE_KEYS[list], next);
      return true;
    } catch {
      return false;
    }
  },

  getSyncMark(): SyncMark | null {
    try {
      const raw = localStorage.getItem(scoped(STORAGE_KEYS.syncMark));
      const mark = raw ? JSON.parse(raw) as SyncMark : null;
      return mark && Number.isSafeInteger(mark.cursor) ? mark : null;
    } catch {
      return null;
    }
  },

  setSyncMark(mark: SyncMark | null): void {
    try {
      if (mark) localStorage.setItem(scoped(STORAGE_KEYS.syncMark), JSON.stringify(mark));
      else localStorage.removeItem(scoped(STORAGE_KEYS.syncMark));
    } catch { /* unavailable: the next start takes a full copy */ }
  },

  async init() {
    const storedVersion = Number(localStorage.getItem(STORAGE_KEYS.seedVersion) ?? 0);

    if (storedVersion < SEED_VERSION) {
      // Migration: remove old mock seed data while preserving real user-created data.
      setArray(STORAGE_KEYS.artworks, getArray<Artwork>(STORAGE_KEYS.artworks).filter(a => !MOCK_IDS_TO_CLEAR.artworks.includes(a.id)));
      setArray(STORAGE_KEYS.catalogs, getArray<Catalog>(STORAGE_KEYS.catalogs).filter(c => !MOCK_IDS_TO_CLEAR.catalogs.includes(c.id)));
      setArray(STORAGE_KEYS.collections, getArray<Collection>(STORAGE_KEYS.collections).filter(c => !MOCK_IDS_TO_CLEAR.collections.includes(c.id)));
      setArray(STORAGE_KEYS.invoices, getArray<Invoice>(STORAGE_KEYS.invoices).filter(i => !MOCK_IDS_TO_CLEAR.invoices.includes(i.id)));
      setArray(STORAGE_KEYS.inquiries, getArray<Inquiry>(STORAGE_KEYS.inquiries).filter(i => !MOCK_IDS_TO_CLEAR.inquiries.includes(i.id)));
      setArray(STORAGE_KEYS.conversations, getArray<Conversation>(STORAGE_KEYS.conversations).filter(c => !MOCK_IDS_TO_CLEAR.conversations.includes(c.id)));
      setArray(STORAGE_KEYS.messages, getArray<Message>(STORAGE_KEYS.messages).filter(m => !MOCK_IDS_TO_CLEAR.messages.includes(m.id)));
      // Team members now come from the auth service (Worker/KV), clear old local cache.
      localStorage.removeItem('vayu_team');
      localStorage.setItem(STORAGE_KEYS.seedVersion, String(SEED_VERSION));
    }
  },

  // Users (local cache — auth truth lives in KV via worker)
  async saveUser(user: UserProfile): Promise<void> {
    const users = getArray<UserProfile>(STORAGE_KEYS.users);
    const idx = users.findIndex(u => u.email === user.email);
    if (idx >= 0) users[idx] = user;
    else users.push(user);
    setArray(STORAGE_KEYS.users, users);
  },
  async getUser(phone: string): Promise<UserProfile | null> {
    return getArray<UserProfile>(STORAGE_KEYS.users).find(u => u.phone === phone) ?? null;
  },
  async getUserByEmail(email: string): Promise<UserProfile | null> {
    return getArray<UserProfile>(STORAGE_KEYS.users).find(u => u.email?.toLowerCase() === email.toLowerCase()) ?? null;
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

  // Sales ledger: the last few ranges loaded, and sales waiting to upload.
  getSavedSalesPage(from: string, to: string): SavedSalesPage | null {
    try { return getArray<SavedSalesPage>(STORAGE_KEYS.salesPages).find(p => p.from === from && p.to === to) ?? null; } catch { return null; }
  },
  saveSalesPage(page: SavedSalesPage): void {
    try {
      const others = getArray<SavedSalesPage>(STORAGE_KEYS.salesPages).filter(p => p.from !== page.from || p.to !== page.to);
      setArray(STORAGE_KEYS.salesPages, [page, ...others].slice(0, MAX_SAVED_SALES_PAGES));
    } catch { /* storage full or unavailable — the offline copy just stays older */ }
  },
  getPendingSales(): PendingSale[] {
    try { return getArray<PendingSale>(STORAGE_KEYS.salesPending); } catch { return []; }
  },
  /** Throws when the device can't store it, so the caller can say the sale wasn't saved. */
  setPendingSales(list: PendingSale[]): void {
    setArray(STORAGE_KEYS.salesPending, list);
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

  // Calendar Events
  async getEvents(): Promise<CalendarEvent[]> {
    return getArray<CalendarEvent>(STORAGE_KEYS.events).sort((a, b) => a.date - b.date);
  },
  async saveEvent(event: CalendarEvent): Promise<void> {
    setArray(STORAGE_KEYS.events, upsertById(getArray<CalendarEvent>(STORAGE_KEYS.events), event));
  },
  async deleteEvent(id: string): Promise<void> {
    setArray(STORAGE_KEYS.events, getArray<CalendarEvent>(STORAGE_KEYS.events).filter(e => e.id !== id));
  },

  // Contacts
  async getContacts(): Promise<Contact[]> {
    return getArray<Contact>(STORAGE_KEYS.contacts).sort((a, b) => b.createdAt - a.createdAt);
  },
  async saveContact(contact: Contact): Promise<void> {
    setArray(STORAGE_KEYS.contacts, upsertById(getArray<Contact>(STORAGE_KEYS.contacts), contact));
  },
  async deleteContact(id: string): Promise<void> {
    setArray(STORAGE_KEYS.contacts, getArray<Contact>(STORAGE_KEYS.contacts).filter(c => c.id !== id));
  },

};
