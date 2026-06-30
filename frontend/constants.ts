import { Artwork, Catalog, Invoice, Collection, Inquiry, Conversation, Message } from './types';

// All mock/dummy data has been removed.
// The app now starts with empty state. Real data is created by users
// and persisted via db.ts (localStorage). Auth users come from the Worker (KV).

export const MOCK_ARTWORKS: Artwork[] = [];
export const MOCK_CATALOGS: Catalog[] = [];
export const MOCK_COLLECTIONS: Collection[] = [];
export const MOCK_INVOICES: Invoice[] = [];
export const MOCK_INQUIRIES: Inquiry[] = [];
export const MOCK_CONVERSATIONS: Conversation[] = [];
export const MOCK_MESSAGES: Message[] = [];