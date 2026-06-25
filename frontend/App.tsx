import React, { useState, useEffect, useCallback } from 'react';
import { ViewState, Artwork, Catalog, Invoice, Collection, Inquiry, Conversation, ConversationDetails, Message, MessageTag, MessageReplyTo, MessageAttachment, InquiryMessage, UserProfile } from './types';
import { BottomNav } from './components/BottomNav';
import Layout from './components/Layout';
import { LoginView } from './views/LoginView';
import { HomeView } from './views/HomeView';
import { ArtworksView } from './views/ArtworksView';
import { CatalogsView } from './views/CatalogsView';
import { InvoiceView } from './views/InvoiceView';
import { CollectionsView } from './views/CollectionsView';
import { ProfileView } from './views/ProfileView';
import { ArtworkDetailView } from './views/ArtworkDetailView';
import { InquiryView } from './views/InquiryView';
import { MessagingView } from './views/MessagingView';
import { db } from './services/db';

const App: React.FC = () => {
    const [currentView, setCurrentView] = useState<ViewState>('login');
    const [theme, setTheme] = useState<'light' | 'dark'>('light');
    const [isLoading, setIsLoading] = useState(true);
    const [selectedArtwork, setSelectedArtwork] = useState<Artwork | null>(null);
    
    // Global State
    const [artworks, setArtworks] = useState<Artwork[]>([]);
    const [catalogs, setCatalogs] = useState<Catalog[]>([]);
    const [collections, setCollections] = useState<Collection[]>([]);
    const [invoices, setInvoices] = useState<Invoice[]>([]);
    const [inquiries, setInquiries] = useState<Inquiry[]>([]);
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [allMessages, setAllMessages] = useState<Message[]>([]);
    const [inquiryMessages, setInquiryMessages] = useState<InquiryMessage[]>([]);
    const [teamMembers, setTeamMembers] = useState<UserProfile[]>([]);
    const [userProfile, setUserProfile] = useState<UserProfile | null>(null);

    const loadData = useCallback(async () => {
        const loadedArtworks = await db.getArtworks();
        const loadedCatalogs = await db.getCatalogs();
        const loadedCollections = await db.getCollections();
        const loadedInvoices = await db.getInvoices();
        const loadedInquiries = await db.getInquiries();
        const loadedConversations = await db.getConversations();
        const loadedMessages = await db.getMessages();
        const loadedInquiryMessages = await db.getInquiryMessages();
        const loadedTeam = await db.getTeamMembers();

        setArtworks(loadedArtworks);
        setCatalogs(loadedCatalogs);
        setCollections(loadedCollections);
        setInvoices(loadedInvoices);
        setInquiries(loadedInquiries);
        setConversations(loadedConversations);
        setAllMessages(loadedMessages);
        setInquiryMessages(loadedInquiryMessages);
        setTeamMembers(loadedTeam);
    }, []);

    // Initialize DB and load data
    useEffect(() => {
        const initApp = async () => {
            try {
                await db.init();

                // Check for logged in user session
                const sessionPhone = localStorage.getItem('vayu_session');
                if (sessionPhone) {
                    const user = await db.getUser(sessionPhone);
                    if (user) {
                        setUserProfile(user);
                        setTheme(user.theme || 'light');
                        setCurrentView('home');
                        // Push initial state to history for back button handling
                        window.history.pushState({ view: 'home' }, '');
                    }
                } else {
                    window.history.pushState({ view: 'login' }, '');
                }

                await loadData();
            } catch (err) {
                console.error('App initialization error:', err);
            } finally {
                setIsLoading(false);
            }
        };
        initApp();
    }, [loadData]);

    // Handle Browser/Phone Back Button
    useEffect(() => {
        const handlePopState = (event: PopStateEvent) => {
            // If an artwork is selected, close it first
            if (selectedArtwork) {
                setSelectedArtwork(null);
                // Push the current view back to history so we don't actually go back
                window.history.pushState({ view: currentView }, '');
                return;
            }

            // If we are not on home or login, go back to home
            if (currentView !== 'home' && currentView !== 'login') {
                setCurrentView('home');
                // Push home to history
                window.history.pushState({ view: 'home' }, '');
                return;
            }
        };

        window.addEventListener('popstate', handlePopState);
        return () => window.removeEventListener('popstate', handlePopState);
    }, [currentView, selectedArtwork]);

    // Custom navigation handler to manage history
    const navigateTo = (view: ViewState) => {
        setCurrentView(view);
        window.history.pushState({ view }, '');
    };

    // Listen for Cloud Sync events (BroadcastChannel)
    useEffect(() => {
        const channel = new BroadcastChannel('vayu_cloud_sync');
        channel.onmessage = (event) => {
            if (event.data.type === 'SYNC_REQUIRED') {
                console.log('Cloud sync triggered, reloading data...');
                loadData();
            }
        };
        return () => channel.close();
    }, [loadData]);

    // Apply Theme
    useEffect(() => {
        if (theme === 'dark') {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
    }, [theme]);

    // Handlers
    const handleLogin = async (user: UserProfile) => {
        setUserProfile(user as UserProfile);
        setTheme((user.theme as 'light' | 'dark') || 'light');
        localStorage.setItem('vayu_session', user.phone);
        navigateTo('home');
    };

    const handleUpdateProfile = async (updatedProfile: UserProfile) => {
        setUserProfile(updatedProfile);
        await db.saveUser(updatedProfile);
    };

    const handleToggleTheme = async () => {
        const newTheme = theme === 'light' ? 'dark' : 'light';
        setTheme(newTheme);
        if (userProfile) {
            const updated = { ...userProfile, theme: newTheme };
            setUserProfile(updated);
            await db.saveUser(updated);
        }
    };

    const handleAddArtwork = async (newArt: Omit<Artwork, 'id' | 'createdAt'>) => {
        const artwork: Artwork = {
            ...newArt,
            id: `art_${Date.now()}`,
            createdAt: Date.now(),
        };
        await db.saveArtwork(artwork);
        setArtworks((prev: Artwork[]) => [artwork, ...prev]);
    };

    const handleUpdateArtwork = async (updatedArt: Artwork) => {
        await db.saveArtwork(updatedArt);
        setArtworks((prev: Artwork[]) => prev.map((a: Artwork) => a.id === updatedArt.id ? updatedArt : a));
        if (selectedArtwork?.id === updatedArt.id) {
            setSelectedArtwork(updatedArt);
        }
    };

    const handleDeleteArtwork = async (id: string) => {
        await db.deleteArtwork(id);
        setArtworks((prev: Artwork[]) => prev.filter((a: Artwork) => a.id !== id));
        if (selectedArtwork?.id === id) {
            setSelectedArtwork(null);
        }
    };

    const handleAddCatalog = async (newCat: Omit<Catalog, 'id' | 'createdAt'>) => {
        const catalog: Catalog = {
            ...newCat,
            id: `cat_${Date.now()}`,
            createdAt: Date.now(),
        };
        await db.saveCatalog(catalog);
        setCatalogs((prev: Catalog[]) => [catalog, ...prev]);
    };

    const handleUpdateCatalog = async (updatedCat: Catalog) => {
        await db.saveCatalog(updatedCat);
        setCatalogs((prev: Catalog[]) => prev.map((c: Catalog) => c.id === updatedCat.id ? updatedCat : c));
    };

    const handleDeleteCatalog = async (id: string) => {
        await db.deleteCatalog(id);
        setCatalogs((prev: Catalog[]) => prev.filter((c: Catalog) => c.id !== id));
    };

    const handleAddCollection = async (newCol: Omit<Collection, 'id'>) => {
        const collection: Collection = {
            ...newCol,
            id: `col_${Date.now()}`
        };
        await db.saveCollection(collection);
        setCollections((prev: Collection[]) => [collection, ...prev]);
    };

    const handleUpdateCollection = async (updatedCol: Collection) => {
        await db.saveCollection(updatedCol);
        setCollections((prev: Collection[]) => prev.map((c: Collection) => c.id === updatedCol.id ? updatedCol : c));
    };

    const handleDeleteCollection = async (id: string) => {
        await db.deleteCollection(id);
        setCollections((prev: Collection[]) => prev.filter((c: Collection) => c.id !== id));
    };

    const handleAddInvoice = async (newInv: Omit<Invoice, 'id' | 'date'>) => {
        const invoice: Invoice = {
            ...newInv,
            id: `inv_${Date.now()}`,
            date: Date.now(),
        };
        await db.saveInvoice(invoice);
        setInvoices((prev: Invoice[]) => [invoice, ...prev]);
        
        const invoicedArtIds = new Set(invoice.items.map(item => item.artworkId));
        
        // Update artwork status in DB and state
        const updatedArtworks = artworks.map(art => {
            if (invoicedArtIds.has(art.id)) {
                const updatedArt = { ...art, status: 'Sold' as const };
                db.saveArtwork(updatedArt); // Fire and forget
                return updatedArt;
            }
            return art;
        });
        setArtworks(updatedArtworks);
    };

    const handleUpdateInvoice = async (updatedInv: Invoice) => {
        await db.saveInvoice(updatedInv);
        setInvoices((prev: Invoice[]) => prev.map((i: Invoice) => i.id === updatedInv.id ? updatedInv : i));
    };

    const handleDeleteInvoice = async (id: string) => {
        await db.deleteInvoice(id);
        setInvoices((prev: Invoice[]) => prev.filter((i: Invoice) => i.id !== id));
    };

    const handleAddInquiry = async (newInq: Omit<Inquiry, 'id' | 'date'>) => {
        const inquiry: Inquiry = {
            ...newInq,
            id: `inq_${Date.now()}`,
            date: Date.now(),
        };
        await db.saveInquiry(inquiry);
        setInquiries((prev: Inquiry[]) => [inquiry, ...prev]);
    };

    const handleUpdateInquiry = async (updatedInq: Inquiry) => {
        await db.saveInquiry(updatedInq);
        setInquiries((prev: Inquiry[]) => prev.map((i: Inquiry) => i.id === updatedInq.id ? updatedInq : i));
    };

    const handleDeleteInquiry = async (id: string) => {
        await db.deleteInquiry(id);
        setInquiries((prev: Inquiry[]) => prev.filter((i: Inquiry) => i.id !== id));
    };

    const handleSendInquiryMessage = async (inquiryId: string, text: string, tags: MessageTag[], replyTo?: MessageReplyTo, attachment?: MessageAttachment) => {
        const msg: InquiryMessage = {
            id: `inqmsg_${Date.now()}`,
            inquiryId,
            senderId: userProfile?.id || 'user_1',
            senderName: userProfile?.name || 'You',
            text,
            tags,
            timestamp: Date.now(),
            status: 'sent',
            replyTo,
            attachment,
        };
        await db.saveInquiryMessage(msg);
        setInquiryMessages((prev: InquiryMessage[]) => [...prev, msg]);

        // Simulate delivery + read receipts
        setTimeout(() => {
            setInquiryMessages((prev: InquiryMessage[]) => prev.map(m => m.id === msg.id ? { ...m, status: 'delivered' } : m));
        }, 700);
        setTimeout(() => {
            setInquiryMessages((prev: InquiryMessage[]) => prev.map(m => m.id === msg.id ? { ...m, status: 'read' } : m));
        }, 2200);
    };

    const handleLogout = () => {
        localStorage.removeItem('vayu_session');
        setUserProfile(null);
        navigateTo('login');
    };

    const handleArtworkClick = (artwork: Artwork) => {
        setSelectedArtwork(artwork);
        window.history.pushState({ view: currentView, modal: 'artwork' }, '');
    };

    const handleCloseArtwork = () => {
        setSelectedArtwork(null);
    };

    const handleSendMessage = async (conversationId: string, text: string, tags: MessageTag[], replyTo?: MessageReplyTo, attachment?: MessageAttachment) => {
        const msg: Message = {
            id: `msg_${Date.now()}`,
            conversationId,
            senderId: userProfile?.id || 'user_1',
            senderName: userProfile?.name || 'You',
            text,
            tags,
            timestamp: Date.now(),
            status: 'sent',
            replyTo,
            attachment,
        };
        await db.saveMessage(msg);
        setAllMessages((prev: Message[]) => [...prev, msg]);

        // Simulate delivery + read receipts
        setTimeout(() => {
            setAllMessages((prev: Message[]) => prev.map(m => m.id === msg.id ? { ...m, status: 'delivered' } : m));
        }, 700);
        setTimeout(() => {
            setAllMessages((prev: Message[]) => prev.map(m => m.id === msg.id ? { ...m, status: 'read' } : m));
        }, 2200);

        // Update conversation's last message
        const conv = conversations.find(c => c.id === conversationId);
        if (conv) {
            const lastMessagePreview = attachment ? (attachment.type === 'image' ? '📷 Photo' : `📎 ${attachment.name}`) : text;
            const updatedConv = { ...conv, lastMessage: lastMessagePreview, lastMessageTime: Date.now(), unreadCount: 0 };
            await db.saveConversation(updatedConv);
            setConversations((prev: Conversation[]) => prev.map(c => c.id === conversationId ? updatedConv : c).sort((a, b) => b.lastMessageTime - a.lastMessageTime));
        }
    };

    const handleTogglePinConversation = async (conversationId: string) => {
        const conv = conversations.find(c => c.id === conversationId);
        if (!conv) return;
        const updatedConv = { ...conv, isPinned: !conv.isPinned };
        await db.saveConversation(updatedConv);
        setConversations((prev: Conversation[]) => prev.map(c => c.id === conversationId ? updatedConv : c));
    };

    const handleToggleArchiveConversation = async (conversationId: string) => {
        const conv = conversations.find(c => c.id === conversationId);
        if (!conv) return;
        const updatedConv = { ...conv, isArchived: !conv.isArchived };
        await db.saveConversation(updatedConv);
        setConversations((prev: Conversation[]) => prev.map(c => c.id === conversationId ? updatedConv : c));
    };

    const handleCreateConversation = async (participantId: string, details?: ConversationDetails): Promise<Conversation> => {
        // Check if conversation already exists
        const existing = conversations.find(c => c.participantIds.includes(participantId) && c.participantIds.includes(userProfile?.id || 'user_1'));
        if (existing) return existing;

        const otherMember = teamMembers.find(m => m.id === participantId);
        const conv: Conversation = {
            id: `conv_${Date.now()}`,
            participantIds: [userProfile?.id || 'user_1', participantId],
            participantNames: [userProfile?.name || 'You', otherMember?.name || 'Team Member'],
            lastMessage: '',
            lastMessageTime: Date.now(),
            unreadCount: 0,
            title: details?.title,
            reason: details?.reason,
            note: details?.note,
        };
        await db.saveConversation(conv);
        setConversations((prev: Conversation[]) => [conv, ...prev]);
        return conv;
    };

    const handleCreateGroup = async (participantIds: string[], groupName: string): Promise<Conversation> => {
        const selfId = userProfile?.id || 'user_1';
        const allParticipantIds = Array.from(new Set([selfId, ...participantIds]));
        const allParticipantNames = allParticipantIds.map(id =>
            id === selfId ? (userProfile?.name || 'You') : (teamMembers.find(m => m.id === id)?.name || 'Team Member')
        );
        const conv: Conversation = {
            id: `conv_${Date.now()}`,
            participantIds: allParticipantIds,
            participantNames: allParticipantNames,
            lastMessage: '',
            lastMessageTime: Date.now(),
            unreadCount: 0,
            isGroup: true,
            groupName,
        };
        await db.saveConversation(conv);
        setConversations((prev: Conversation[]) => [conv, ...prev]);
        return conv;
    };

    const handleUpdateConversationDetails = async (conversationId: string, details: ConversationDetails) => {
        const conv = conversations.find(c => c.id === conversationId);
        if (!conv) return;
        const updatedConv = { ...conv, ...details };
        await db.saveConversation(updatedConv);
        setConversations((prev: Conversation[]) => prev.map(c => c.id === conversationId ? updatedConv : c));
    };

    if (isLoading) {
        return (
            <div className="min-h-screen bg-black flex items-center justify-center">
                <div className="animate-pulse flex flex-col items-center justify-center">
                    <svg viewBox="0 0 400 400" className="w-48 h-48">
                        <rect width="400" height="400" fill="#000000" rx="20" />
                        <text x="200" y="210" fontFamily="Playfair Display, serif" fontSize="90" fill="#d4af37" textAnchor="middle" fontWeight="bold">VAYU</text>
                        <text x="200" y="260" fontFamily="Inter, sans-serif" fontSize="18" fill="#d4af37" textAnchor="middle" letterSpacing="4">DESIGN FOR LIVING</text>
                    </svg>
                </div>
            </div>
        );
    }

    const renderView = () => {
        switch (currentView) {
            case 'login':
                return <LoginView onLogin={handleLogin} />;
            case 'home':
                return userProfile ? <HomeView artworks={artworks} catalogs={catalogs} invoices={invoices} onNavigate={navigateTo} userProfile={userProfile} onArtworkClick={handleArtworkClick} onCatalogClick={() => navigateTo('catalogs')} /> : null;
            case 'artworks':
                return <ArtworksView artworks={artworks} onAddArtwork={handleAddArtwork} onArtworkClick={handleArtworkClick} />;
            case 'collections':
                return <CollectionsView collections={collections} artworks={artworks} onAddCollection={handleAddCollection} onUpdateCollection={handleUpdateCollection} onDeleteCollection={handleDeleteCollection} onArtworkClick={handleArtworkClick} />;
            case 'catalogs':
                return <CatalogsView catalogs={catalogs} artworks={artworks} onAddCatalog={handleAddCatalog} onUpdateCatalog={handleUpdateCatalog} onDeleteCatalog={handleDeleteCatalog} onArtworkClick={handleArtworkClick} />;
            case 'invoice':
                return <InvoiceView invoices={invoices} artworks={artworks} onAddInvoice={handleAddInvoice} onUpdateInvoice={handleUpdateInvoice} onDeleteInvoice={handleDeleteInvoice} onArtworkClick={handleArtworkClick} />;
            case 'inquiry':
                return (
                    <InquiryView
                        inquiries={inquiries}
                        artworks={artworks}
                        onAddInquiry={handleAddInquiry}
                        onUpdateInquiry={handleUpdateInquiry}
                        onDeleteInquiry={handleDeleteInquiry}
                        onArtworkClick={handleArtworkClick}
                        inquiryMessages={inquiryMessages}
                        currentUserId={userProfile?.id || 'user_1'}
                        currentUserName={userProfile?.name || 'You'}
                        onSendInquiryMessage={handleSendInquiryMessage}
                    />
                );
            case 'messaging':
                return (
                    <MessagingView
                        conversations={conversations}
                        messages={allMessages}
                        teamMembers={teamMembers}
                        currentUserId={userProfile?.id || 'user_1'}
                        currentUserName={userProfile?.name || 'You'}
                        onSendMessage={handleSendMessage}
                        onCreateConversation={handleCreateConversation}
                        onCreateGroup={handleCreateGroup}
                        onUpdateConversationDetails={handleUpdateConversationDetails}
                        onTogglePinConversation={handleTogglePinConversation}
                        onToggleArchiveConversation={handleToggleArchiveConversation}
                    />
                );
            case 'profile':
                return userProfile ? (
                    <ProfileView 
                        profile={userProfile}
                        onUpdateProfile={handleUpdateProfile}
                        theme={theme}
                        onToggleTheme={handleToggleTheme}
                        onLogout={handleLogout}
                    />
                ) : null;
            default:
                return <LoginView onLogin={handleLogin} />;
        }
    };

    return (
        <Layout currentView={currentView} onNavigate={navigateTo}>
            {renderView()}
            {selectedArtwork && (
                <ArtworkDetailView artwork={selectedArtwork} onClose={handleCloseArtwork} onUpdateArtwork={handleUpdateArtwork} onDeleteArtwork={handleDeleteArtwork} />
            )}
        </Layout>
    );
};

export default App;
