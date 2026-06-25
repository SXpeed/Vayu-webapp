import { Artwork, Catalog, Invoice, Collection, Inquiry, Conversation, Message, UserProfile } from './types';

export const MOCK_ARTWORKS: Artwork[] = [
    {
        id: 'a1',
        customId: 'ART-001',
        title: 'Midnight Serenade',
        description: 'Abstract expression of night colors.',
        dimensions: '24" x 36"',
        medium: 'Oil on Canvas',
        status: 'Available',
        location: 'Studio A',
        price: 120000,
        imageUrls: [
            'https://picsum.photos/seed/art1/400/400',
            'https://picsum.photos/seed/art1_detail/400/400'
        ],
        createdAt: Date.now() - 100000,
    },
    {
        id: 'a2',
        customId: 'ART-002',
        title: 'Urban Decay',
        description: 'Textured mixed media piece.',
        dimensions: '40" x 40"',
        medium: 'Mixed Media',
        status: 'Sold',
        location: 'Gallery Main',
        price: 250000,
        imageUrls: [
            'https://picsum.photos/seed/art2/400/500'
        ],
        createdAt: Date.now() - 200000,
    },
    {
        id: 'a3',
        customId: 'ART-003',
        title: 'Whispering Pines',
        description: 'Landscape study.',
        dimensions: '18" x 24"',
        medium: 'Watercolor',
        status: 'Available',
        location: 'Storage B',
        price: 85000,
        imageUrls: [
            'https://picsum.photos/seed/art3/500/400',
            'https://picsum.photos/seed/art3_frame/500/400',
            'https://picsum.photos/seed/art3_wall/500/400'
        ],
        createdAt: Date.now() - 300000,
    },
    {
        id: 'a4',
        customId: 'ART-004',
        title: 'Golden Horizon',
        description: 'Sunset over the Western Ghats, rendered in warm gold tones.',
        dimensions: '30" x 40"',
        medium: 'Acrylic on Canvas',
        status: 'Available',
        location: 'Gallery Main',
        price: 165000,
        imageUrls: [
            'https://picsum.photos/seed/art4/400/400',
            'https://picsum.photos/seed/art4_detail/400/400'
        ],
        createdAt: Date.now() - 400000,
    },
    {
        id: 'a5',
        customId: 'ART-005',
        title: 'Silent Monsoon',
        description: 'Moody, rain-washed cityscape in muted blues.',
        dimensions: '20" x 30"',
        medium: 'Oil on Canvas',
        status: 'Reserved',
        location: 'Studio A',
        price: 140000,
        imageUrls: [
            'https://picsum.photos/seed/art5/450/450'
        ],
        createdAt: Date.now() - 500000,
    },
    {
        id: 'a6',
        customId: 'ART-006',
        title: 'Terracotta Dreams',
        description: 'Sculptural study of traditional Indian pottery forms.',
        dimensions: '15" x 20"',
        medium: 'Terracotta & Mixed Media',
        status: 'Available',
        location: 'Storage B',
        price: 95000,
        imageUrls: [
            'https://picsum.photos/seed/art6/420/420',
            'https://picsum.photos/seed/art6_detail/420/420'
        ],
        createdAt: Date.now() - 600000,
    }
];

export const MOCK_CATALOGS: Catalog[] = [
    {
        id: 'c1',
        name: 'Spring Exhibition 2024',
        description: 'A collection of new works for the spring show.',
        artworkIds: ['a1', 'a3'],
        coverImageUrl: 'https://picsum.photos/seed/cat1/600/400',
        createdAt: Date.now() - 50000,
    }
];

export const MOCK_COLLECTIONS: Collection[] = [
    {
        id: 'col1',
        name: 'Modern Abstracts',
        description: 'Contemporary abstract pieces focusing on color and texture.',
        artworkIds: ['a1', 'a2']
    },
    {
        id: 'col2',
        name: 'Earth & Clay',
        description: 'Sculptural and textured works inspired by traditional craft.',
        artworkIds: ['a6', 'a3']
    },
    {
        id: 'col3',
        name: 'Monsoon Moods',
        description: 'Cool-toned pieces capturing the rains and quiet city life.',
        artworkIds: ['a5', 'a2']
    }
];

export const MOCK_INVOICES: Invoice[] = [
    {
        id: 'inv1',
        invoiceNumber: 'INV-2024-001',
        customerName: 'Jane Doe',
        customerEmail: 'jane@example.com',
        items: [
            { artworkId: 'a2', title: 'Urban Decay', price: 250000 }
        ],
        subtotal: 250000,
        taxRate: 0.18, // 18% GST typical for art in India
        total: 295000,
        date: Date.now() - 86400000,
        status: 'Paid'
    }
];

export const MOCK_INQUIRIES: Inquiry[] = [
    {
        id: 'inq1',
        inquiryNumber: 'INQ-2024-001',
        customerName: 'Rajesh Sharma',
        customerPhone: '+91 98765 43210',
        customerEmail: 'rajesh@example.com',
        artworkIds: ['a1', 'a3'],
        notes: 'Interested in abstract pieces for new office space. Budget around 2-3 lakhs.',
        source: 'Walk-in',
        status: 'Interested',
        catalogShared: true,
        date: Date.now() - 172800000,
    },
    {
        id: 'inq2',
        inquiryNumber: 'INQ-2024-002',
        customerName: 'Priya Mehta',
        customerPhone: '+91 91234 56789',
        customerEmail: 'priya.mehta@example.com',
        artworkIds: ['a1'],
        notes: 'Saw the artwork on Instagram. Wants to visit the gallery this weekend.',
        source: 'Social Media',
        status: 'New',
        catalogShared: false,
        date: Date.now() - 43200000,
    },
    {
        id: 'inq3',
        inquiryNumber: 'INQ-2024-003',
        customerName: 'Vikram Malhotra',
        customerPhone: '+91 99887 66554',
        customerEmail: 'vikram.malhotra@example.com',
        artworkIds: ['a4'],
        notes: 'Looking for a statement piece for his new office lobby.',
        source: 'Referral',
        status: 'Contacted',
        catalogShared: true,
        date: Date.now() - 259200000,
    },
    {
        id: 'inq4',
        inquiryNumber: 'INQ-2024-004',
        customerName: 'Ananya Iyer',
        customerPhone: '+91 98123 45670',
        customerEmail: 'ananya.iyer@example.com',
        artworkIds: ['a5', 'a6'],
        notes: 'Renovating her home and wants pieces that match a terracotta and blue palette.',
        source: 'Email',
        status: 'New',
        catalogShared: false,
        date: Date.now() - 21600000,
    }
];

export const MOCK_TEAM_MEMBERS: UserProfile[] = [
    {
        id: 'user_1',
        name: 'Arjun Kapoor',
        email: 'arjun@vayu.com',
        phone: '1234567890',
        address: 'Mumbai, India',
        isOnline: true,
    },
    {
        id: 'user_2',
        name: 'Meera Patel',
        email: 'meera@vayu.com',
        phone: '9876543210',
        address: 'Delhi, India',
        isOnline: true,
    },
    {
        id: 'user_3',
        name: 'Rohan Singh',
        email: 'rohan@vayu.com',
        phone: '5551234567',
        address: 'Bangalore, India',
        isOnline: false,
    },
    {
        id: 'user_4',
        name: 'Priya Sharma',
        email: 'priya@vayu.com',
        phone: '5559876543',
        address: 'Jaipur, India',
        isOnline: false,
    },
];

export const MOCK_CONVERSATIONS: Conversation[] = [
    {
        id: 'conv_general',
        participantIds: ['user_1', 'user_2', 'user_3', 'user_4'],
        participantNames: ['Arjun Kapoor', 'Meera Patel', 'Rohan Singh', 'Priya Sharma'],
        lastMessage: 'The new collection looks great, let\'s finalize the pricing.',
        lastMessageTime: Date.now() - 600000,
        unreadCount: 3,
        isGroup: true,
        groupName: 'General',
    },
];

export const MOCK_MESSAGES: Message[] = [
    {
        id: 'msg_general_1',
        conversationId: 'conv_general',
        senderId: 'user_1',
        senderName: 'Arjun Kapoor',
        text: 'Welcome to the team chat! Use this space for updates that concern everyone.',
        tags: ['General'],
        timestamp: Date.now() - 7200000,
    },
    {
        id: 'msg_4',
        conversationId: 'conv_general',
        senderId: 'user_3',
        senderName: 'Rohan Singh',
        text: 'Client wants to see Midnight Serenade in person.',
        tags: ['Inquiry', 'Urgent'],
        timestamp: Date.now() - 3600000,
    },
    {
        id: 'msg_5',
        conversationId: 'conv_general',
        senderId: 'user_4',
        senderName: 'Priya Sharma',
        text: 'Invoice #INV-2024-001 has been paid!',
        tags: ['Invoice'],
        timestamp: Date.now() - 1800000,
    },
    {
        id: 'msg_1',
        conversationId: 'conv_general',
        senderId: 'user_2',
        senderName: 'Meera Patel',
        text: 'Hi! I\'ve uploaded the new artwork photos to the catalog.',
        tags: ['Artwork'],
        timestamp: Date.now() - 1200000,
    },
    {
        id: 'msg_2',
        conversationId: 'conv_general',
        senderId: 'user_1',
        senderName: 'Arjun Kapoor',
        text: 'Great work! Can you also update the dimensions for Golden Horizon?',
        tags: ['Artwork', 'Follow-up'],
        timestamp: Date.now() - 900000,
    },
    {
        id: 'msg_3',
        conversationId: 'conv_general',
        senderId: 'user_2',
        senderName: 'Meera Patel',
        text: 'The new collection looks great, let\'s finalize the pricing.',
        tags: ['General'],
        timestamp: Date.now() - 600000,
    },
];
