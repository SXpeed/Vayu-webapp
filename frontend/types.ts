export type ArtworkStatus = 'Available' | 'Sold' | 'Reserved';

export interface Artwork {
    id: string;
    customId: string; // User defined ID
    title: string;
    artist?: string;
    artworkYear?: string;
    descriptionTitle?: string;
    description: string;
    dimensions: string;
    medium: string;
    status: ArtworkStatus;
    location: string;
    price: number;
    plusGst?: boolean;
    imageUrls: string[]; // Changed from imageUrl to imageUrls array
    createdAt: number;
}

export interface Collection {
    id: string;
    name: string;
    description: string;
    artworkIds: string[];
    coverImageUrl?: string;
    createdAt?: number;
}

export interface Catalog {
    id: string;
    name: string;
    description: string;
    artworkIds: string[];
    coverImageUrl: string;
    createdAt: number;
}

export interface PdfOptions {
    showCatalogName: boolean;
    showTitle: boolean;
    showTitleNote: boolean;
    showDimensions: boolean;
    showPrice: boolean;
    showDescription: boolean;
    logoSelection: 'Select 1' | 'Select 2';
    logoPlacement: 'Top Left' | 'Top Right';
    pageOptions: string[];
    customLogo1?: string;
    customLogo2?: string;
    removeBackground?: boolean;
    imageShadow?: boolean;
    /** 'Default' (follow theme), a hex color like '#0f172a', or a legacy named palette. */
    colorPalette?: string;
    /** Hue (0–330) of the last main color picked in the studio. */
    colorHue?: number;
    /** Intensity (0–100) of the color intensity slider. */
    colorIntensity?: number;
    /** Up to 6 most recently used page colors. */
    recentColors?: string[];
    gradientStyle?: 'Solid' | 'Linear' | 'Radial' | 'Diagonal' | 'Vignette' | 'Spotlight';
}

export type CatalogTheme = 1 | 2 | 3 | 4 | 5;

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

export type ViewState = 'login' | 'home' | 'artworks' | 'collections' | 'catalogs' | 'invoice' | 'inquiry' | 'messaging' | 'profile' | 'activity' | 'payments';

export interface PaymentLink {
    id: string;
    shortUrl: string;
    amount: number; // paise
    description: string;
    customerName: string;
    customerPhone: string;
    customerEmail: string;
    status: 'created' | 'paid' | 'partially_paid' | 'expired' | 'cancelled' | string;
    createdAt: number;
    createdBy: string;
    createdByName: string;
    paidAt?: number;
    paymentId?: string;
    paymentMethod?: string;
}
