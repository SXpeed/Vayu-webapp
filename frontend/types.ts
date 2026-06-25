export type ArtworkStatus = 'Available' | 'Sold' | 'Reserved';

export interface Artwork {
    id: string;
    customId: string; // User defined ID
    title: string;
    description: string;
    dimensions: string;
    medium: string;
    status: ArtworkStatus;
    location: string;
    price: number;
    imageUrls: string[]; // Changed from imageUrl to imageUrls array
    createdAt: number;
}

export interface Collection {
    id: string;
    name: string;
    description: string;
    artworkIds: string[];
}

export interface Catalog {
    id: string;
    name: string;
    description: string;
    artworkIds: string[];
    coverImageUrl: string;
    createdAt: number;
}

export interface InvoiceItem {
    artworkId: string;
    title: string;
    price: number;
}

export interface Invoice {
    id: string;
    invoiceNumber: string;
    customerName: string;
    customerEmail: string;
    items: InvoiceItem[];
    subtotal: number;
    taxRate: number;
    total: number;
    date: number;
    status: 'Draft' | 'Sent' | 'Paid';
}

export interface Inquiry {
    id: string;
    inquiryNumber: string;
    customerName: string;
    customerPhone: string;
    customerEmail: string;
    artworkIds: string[];
    notes: string;
    source: 'Walk-in' | 'Phone' | 'Email' | 'Social Media' | 'Referral' | 'Other';
    status: 'New' | 'Contacted' | 'Interested' | 'Converted' | 'Closed';
    catalogShared: boolean;
    date: number;
}

export interface UserProfile {
    id: string;
    name: string;
    email: string;
    phone: string;
    address: string;
    password?: string; // Added for local auth simulation
    theme?: 'light' | 'dark';
    isOnline?: boolean;
}

export type MessageTag = 'General' | 'Urgent' | 'Follow-up' | 'Artwork' | 'Inquiry' | 'Invoice';

export type MessageStatus = 'sent' | 'delivered' | 'read';

export interface MessageReplyTo {
    id: string;
    senderName: string;
    text: string;
}

export interface MessageAttachment {
    type: 'image' | 'file';
    url: string; // data URL
    name: string;
}

export interface Message {
    id: string;
    conversationId: string;
    senderId: string;
    senderName: string;
    text: string;
    tags: MessageTag[];
    timestamp: number;
    status?: MessageStatus;
    replyTo?: MessageReplyTo;
    attachment?: MessageAttachment;
}

export interface Conversation {
    id: string;
    participantIds: string[];
    participantNames: string[];
    lastMessage: string;
    lastMessageTime: number;
    unreadCount: number;
    title?: string;
    reason?: string;
    note?: string;
    isGroup?: boolean;
    groupName?: string;
    isPinned?: boolean;
    isArchived?: boolean;
}

export interface ConversationDetails {
    title?: string;
    reason?: string;
    note?: string;
}

export interface InquiryMessage {
    id: string;
    inquiryId: string;
    senderId: string;
    senderName: string;
    text: string;
    tags: MessageTag[];
    timestamp: number;
    status?: MessageStatus;
    replyTo?: MessageReplyTo;
    attachment?: MessageAttachment;
}

export type ViewState = 'login' | 'home' | 'artworks' | 'collections' | 'catalogs' | 'invoice' | 'inquiry' | 'messaging' | 'profile';
