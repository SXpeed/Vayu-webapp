import { Artwork, Catalog, Collection, Invoice, Inquiry, Conversation, Message, InquiryMessage, UserProfile } from '../types';

// Base API path (the Worker will serve under /api)
const API_BASE = '/api';

/** Helper to attach auth token if present */
function getAuthHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const token = localStorage.getItem('auth_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** No-op init for compatibility */
export const db = {
  async init() {
    // No local initialization needed for KV backend
  },

  // Users
  async saveUser(user: UserProfile): Promise<void> {
    await fetch(`${API_BASE}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(user),
    });
  },
  async getUser(phone: string): Promise<UserProfile | null> {
    const resp = await fetch(`${API_BASE}/users/${encodeURIComponent(phone)}`, {
      headers: getAuthHeaders(),
    });
    if (!resp.ok) return null;
    return resp.json();
  },

  // Artworks
  async getArtworks(): Promise<Artwork[]> {
    const resp = await fetch(`${API_BASE}/artworks`, { headers: getAuthHeaders() });
    if (!resp.ok) return [];
    return resp.json();
  },
  async saveArtwork(artwork: Artwork): Promise<void> {
    await fetch(`${API_BASE}/artworks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(artwork),
    });
  },
  async deleteArtwork(id: string): Promise<void> {
    await fetch(`${API_BASE}/artworks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
  },

  // Catalogs
  async getCatalogs(): Promise<Catalog[]> {
    const resp = await fetch(`${API_BASE}/catalogs`, { headers: getAuthHeaders() });
    if (!resp.ok) return [];
    return resp.json();
  },
  async saveCatalog(catalog: Catalog): Promise<void> {
    await fetch(`${API_BASE}/catalogs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(catalog),
    });
  },
  async deleteCatalog(id: string): Promise<void> {
    await fetch(`${API_BASE}/catalogs/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
  },

  // Collections
  async getCollections(): Promise<Collection[]> {
    const resp = await fetch(`${API_BASE}/collections`, { headers: getAuthHeaders() });
    if (!resp.ok) return [];
    return resp.json();
  },
  async saveCollection(collection: Collection): Promise<void> {
    await fetch(`${API_BASE}/collections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(collection),
    });
  },
  async deleteCollection(id: string): Promise<void> {
    await fetch(`${API_BASE}/collections/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
  },

  // Invoices
  async getInvoices(): Promise<Invoice[]> {
    const resp = await fetch(`${API_BASE}/invoices`, { headers: getAuthHeaders() });
    if (!resp.ok) return [];
    return resp.json();
  },
  async saveInvoice(invoice: Invoice): Promise<void> {
    await fetch(`${API_BASE}/invoices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(invoice),
    });
  },
  async deleteInvoice(id: string): Promise<void> {
    await fetch(`${API_BASE}/invoices/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
  },

  // Inquiries
  async getInquiries(): Promise<Inquiry[]> {
    const resp = await fetch(`${API_BASE}/inquiries`, { headers: getAuthHeaders() });
    if (!resp.ok) return [];
    return resp.json();
  },
  async saveInquiry(inquiry: Inquiry): Promise<void> {
    await fetch(`${API_BASE}/inquiries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(inquiry),
    });
  },
  async deleteInquiry(id: string): Promise<void> {
    await fetch(`${API_BASE}/inquiries/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
  },

  // Conversations
  async getConversations(): Promise<Conversation[]> {
    const resp = await fetch(`${API_BASE}/conversations`, { headers: getAuthHeaders() });
    if (!resp.ok) return [];
    return resp.json();
  },
  async saveConversation(conv: Conversation): Promise<void> {
    await fetch(`${API_BASE}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(conv),
    });
  },
  async deleteConversation(id: string): Promise<void> {
    await fetch(`${API_BASE}/conversations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
  },

  // Messages
  async getMessages(): Promise<Message[]> {
    const resp = await fetch(`${API_BASE}/messages`, { headers: getAuthHeaders() });
    if (!resp.ok) return [];
    return resp.json();
  },
  async getMessagesByConversation(conversationId: string): Promise<Message[]> {
    const resp = await fetch(`${API_BASE}/messages?conversationId=${encodeURIComponent(conversationId)}`, { headers: getAuthHeaders() });
    if (!resp.ok) return [];
    return resp.json();
  },
  async saveMessage(msg: Message): Promise<void> {
    await fetch(`${API_BASE}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(msg),
    });
  },

  // Inquiry Messages
  async getInquiryMessages(): Promise<InquiryMessage[]> {
    const resp = await fetch(`${API_BASE}/inquiry-messages`, { headers: getAuthHeaders() });
    if (!resp.ok) return [];
    return resp.json();
  },
  async saveInquiryMessage(msg: InquiryMessage): Promise<void> {
    await fetch(`${API_BASE}/inquiry-messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(msg),
    });
  },

  // Team Members
  async getTeamMembers(): Promise<UserProfile[]> {
    const resp = await fetch(`${API_BASE}/team`, { headers: getAuthHeaders() });
    if (!resp.ok) return [];
    return resp.json();
  },
  async saveTeamMember(member: UserProfile): Promise<void> {
    await fetch(`${API_BASE}/team`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(member),
    });
  },
};
