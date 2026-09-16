import React, { useCallback, useEffect, useState } from 'react';
import { FullScreenPortal } from './FullScreenPortal';
import { TypeDeleteDialog } from './TypeDeleteDialog';
import UserManagementPanel from './UserManagementPanel';
import { apiCall } from '../services/apiClient';
import { DeletedItem } from '../types';
import { ArrowLeft, Archive, History, Users as UsersIcon, Trash2, Loader2, ChevronRight, ShieldCheck, FileText, CalendarDays, Phone, MessageCircle, User as UserIcon, FolderOpen, BookOpen, Undo2 } from 'lucide-react';
import toast from 'react-hot-toast';

const ActivityLogView = React.lazy(() => import('../views/ActivityLogView').then(m => ({ default: m.ActivityLogView })));

interface AdminPanelProps {
    currentUserId: string;
    onClose: () => void;
}

type AdminTab = 'deleted' | 'users' | 'activity';

const ENTITY_META: Record<string, { label: string; Icon: React.FC<{ size?: number; className?: string }> }> = {
    artwork: { label: 'Artwork', Icon: FileText },
    collection: { label: 'Collection', Icon: FolderOpen },
    catalog: { label: 'Catalog', Icon: BookOpen },
    inquiry: { label: 'Inquiry', Icon: Phone },
    event: { label: 'Event', Icon: CalendarDays },
    contact: { label: 'Contact', Icon: Phone },
    conversation: { label: 'Chat', Icon: MessageCircle },
    user: { label: 'User', Icon: UserIcon },
};

const relTime = (ms: number): string => {
    const diff = Date.now() - ms;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });
};

const TABS: Array<{ id: AdminTab; label: string; Icon: React.FC<{ size?: number }> }> = [
    { id: 'deleted', label: 'Deleted', Icon: Archive },
    { id: 'users', label: 'Users', Icon: UsersIcon },
    { id: 'activity', label: 'Activity', Icon: History },
];

/** Admin hub — deleted-items archive, user management and activity logs
 *  behind a single shield button on the home header (admins only). */
export const AdminPanel: React.FC<AdminPanelProps> = ({ currentUserId, onClose }) => {
    const [tab, setTab] = useState<AdminTab>('deleted');
    const [items, setItems] = useState<DeletedItem[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState('');
    const [showUsers, setShowUsers] = useState(false);
    const [purgeTarget, setPurgeTarget] = useState<DeletedItem | null>(null);
    const [purgeAll, setPurgeAll] = useState(false);
    const [isPurging, setIsPurging] = useState(false);
    const [restoringId, setRestoringId] = useState<string | null>(null);

    const loadItems = useCallback(async () => {
        setIsLoading(true);
        setError('');
        try {
            setItems(await apiCall<DeletedItem[]>('/deleted-items'));
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        if (tab === 'deleted') void loadItems();
    }, [tab, loadItems]);

    const doPurge = async () => {
        const target = purgeTarget;
        const all = purgeAll;
        setPurgeTarget(null);
        setPurgeAll(false);
        setIsPurging(true);
        try {
            await apiCall(`/deleted-items${all || !target ? '' : `/${target.id}`}`, { method: 'DELETE' });
            setItems(prev => (all ? [] : prev.filter(i => i.id !== target?.id)));
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setIsPurging(false);
        }
    };

    const handleRestore = async (item: DeletedItem) => {
        setRestoringId(item.id);
        try {
            await apiCall(`/deleted-items/${item.id}/restore`, { method: 'POST' });
            setItems(prev => prev.filter(i => i.id !== item.id));
            toast.success('Restored');
        } catch (e) {
            toast.error((e as Error).message || 'Restore failed');
        } finally {
            setRestoringId(null);
        }
    };

    return (
        <FullScreenPortal>
            <div className="absolute inset-0 bg-[#faf9f6] dark:bg-[#121212] z-50 flex flex-col animate-fade-in-up">
                {/* Header */}
                <div className="bg-white dark:bg-[#1a1a1a] flex justify-between items-center p-[6px] border-b border-gray-100 dark:border-gray-800 pt-[calc(1.75rem+env(safe-area-inset-top,0px))] shadow-sm z-10">
                    <button
                        onClick={onClose}
                        className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale"
                        aria-label="Close admin panel"
                    >
                        <ArrowLeft size={20} />
                    </button>
                    <h2 className="flex items-center gap-1.5 text-base font-serif text-gray-900 dark:text-white">
                        <ShieldCheck size={16} className="text-gold-500" /> Admin
                    </h2>
                    <div className="w-9"></div>
                </div>

                {/* Tabs */}
                <div className="flex gap-1.5 px-[6px] py-2 bg-white dark:bg-[#1a1a1a] border-b border-gray-100 dark:border-gray-800">
                    {TABS.map(({ id, label, Icon }) => (
                        <button
                            key={id}
                            type="button"
                            onClick={() => { setTab(id); setShowUsers(false); }}
                            className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-full text-[9px] font-bold uppercase tracking-widest transition-colors active-scale ${tab === id
                                ? 'bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950'
                                : 'bg-gray-100 dark:bg-[#2a2a2a] text-gray-500 dark:text-gray-400'
                                }`}
                        >
                            <Icon size={11} /> {label}
                        </button>
                    ))}
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto p-[6px] no-scrollbar">

                    {tab === 'deleted' && (
                        <div className="space-y-[6px] animate-fade-in">
                            <div className="flex items-center justify-between px-1 pb-1">
                                <p className="text-[9px] uppercase tracking-widest text-gray-400 dark:text-gray-500">
                                    {items.length} archived item{items.length === 1 ? '' : 's'}
                                </p>
                                {items.length > 0 && (
                                    <button
                                        type="button"
                                        onClick={() => setPurgeAll(true)}
                                        disabled={isPurging}
                                        className="text-[9px] font-medium text-red-500 dark:text-red-400 uppercase tracking-wider active-scale disabled:opacity-40"
                                    >
                                        Clear all
                                    </button>
                                )}
                            </div>
                            {isLoading && (
                                <div className="py-10 flex justify-center">
                                    <Loader2 size={20} className="animate-spin text-gold-500" />
                                </div>
                            )}
                            {!isLoading && error && (
                                <p className="text-[11px] text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-900/20 px-[6px] py-2 rounded-[6px]">{error}</p>
                            )}
                            {!isLoading && !error && items.map(item => {
                                const { label, Icon } = ENTITY_META[item.entity] || { label: item.entity, Icon: Archive };
                                return (
                                    <div
                                        key={item.id}
                                        className="bg-white dark:bg-[#1e1e1e] rounded-[6px] shadow-sm border border-gray-100 dark:border-gray-800 p-[6px] flex items-center gap-2.5 animate-fade-in-up"
                                    >
                                        <div className="w-8 h-8 rounded-full bg-gray-100 dark:bg-[#2a2a2a] flex items-center justify-center shrink-0">
                                            <Icon size={14} className="text-gray-500 dark:text-gray-400" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-xs text-gray-900 dark:text-gray-100 font-medium line-clamp-2">{item.summary || `${label} ${item.entityId}`}</p>
                                            <p className="text-[9px] text-gray-400 dark:text-gray-500 uppercase tracking-wider mt-0.5">
                                                {label} • {relTime(item.deletedAt)}{item.deletedByName ? ` • by ${item.deletedByName}` : ''}
                                            </p>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => { void handleRestore(item); }}
                                            disabled={isPurging || restoringId === item.id}
                                            aria-label={`Restore archived ${label}`}
                                            title="Undo — put this item back"
                                            className="p-1.5 text-gray-400 dark:text-gray-500 hover:text-gold-600 dark:hover:text-gold-400 rounded-full transition-colors active-scale disabled:opacity-40 shrink-0"
                                        >
                                            {restoringId === item.id ? <Loader2 size={14} className="animate-spin" /> : <Undo2 size={14} />}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setPurgeTarget(item)}
                                            disabled={isPurging}
                                            aria-label={`Permanently delete archived ${label}`}
                                            title="Delete permanently"
                                            className="p-1.5 text-gray-300 dark:text-gray-600 hover:text-red-500 rounded-full transition-colors active-scale shrink-0"
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                );

                            })}
                            {!isLoading && !error && items.length === 0 && (
                                <div className="text-center py-12 px-6 bg-white dark:bg-[#1e1e1e] rounded-[6px] border border-gray-100 dark:border-gray-800 mt-2">
                                    <Archive size={28} strokeWidth={1.25} className="mx-auto text-gray-300 dark:text-gray-600 mb-3" />
                                    <p className="text-sm font-serif text-gray-700 dark:text-gray-200 mb-1.5">Nothing deleted yet</p>
                                    <p className="text-xs text-gray-400 dark:text-gray-500 font-light leading-relaxed">
                                        Every deleted artwork, catalog, collection, inquiry, event, contact or chat is archived here for review.
                                    </p>
                                </div>
                            )}
                        </div>
                    )}

                    {tab === 'users' && !showUsers && (
                        <div className="p-4 space-y-3 animate-fade-in">
                            <button
                                type="button"
                                onClick={() => setShowUsers(true)}
                                className="w-full bg-white dark:bg-[#1e1e1e] rounded-[6px] border border-gray-100 dark:border-gray-800 p-4 flex items-center justify-between active-scale transition-transform"
                            >
                                <span className="flex items-center gap-2.5">
                                    <UsersIcon size={16} className="text-gold-500" />
                                    <span className="text-sm text-gray-900 dark:text-gray-100 font-medium">Manage users</span>
                                </span>
                                <ChevronRight size={16} className="text-gray-400" />
                            </button>
                            <p className="text-[10px] text-gray-400 dark:text-gray-500 font-light px-1">
                                Add teammates, reset roles and manage accounts.
                            </p>
                        </div>
                    )}

                    {tab === 'users' && showUsers && (
                        <UserManagementPanel currentUserId={currentUserId} onClose={() => setShowUsers(false)} />
                    )}

                    {tab === 'activity' && (
                        <React.Suspense fallback={
                            <div className="py-10 flex justify-center">
                                <Loader2 size={20} className="animate-spin text-gold-500" />
                            </div>
                        }>
                            <ActivityLogView onBack={() => setTab('deleted')} />
                        </React.Suspense>
                    )}
                </div>

                {/* Purge confirmations (type "Delete") */}
                <TypeDeleteDialog
                    isOpen={!!purgeTarget}
                    title="Purge archived item"
                    itemName={purgeTarget?.summary || 'item'}
                    message="this permanently removes it from the archive"
                    onClose={() => setPurgeTarget(null)}
                    onConfirm={() => { void doPurge(); }}
                />
                <TypeDeleteDialog
                    isOpen={purgeAll}
                    title="Clear the archive"
                    itemName={`all ${items.length} archived item${items.length === 1 ? '' : 's'}`}
                    message="this permanently removes them from the archive"
                    onClose={() => setPurgeAll(false)}
                    onConfirm={() => { void doPurge(); }}
                />
            </div>
        </FullScreenPortal>
    );
};
