import React, { useCallback, useEffect, useState } from 'react';
import { FullScreenPortal } from './FullScreenPortal';
import { TypeDeleteDialog } from './TypeDeleteDialog';
import UserManagementPanel from './UserManagementPanel';
import { RolesPanel } from './RolesPanel';
import { apiCall } from '../services/apiClient';
import { DeletedItem } from '../types';
import { PageRoot, PageHeader } from './ui';
import { Archive, History, KeyRound, Users as UsersIcon, Trash2, Loader2, FileText, CalendarDays, Phone, MessageCircle, User as UserIcon, FolderOpen, BookOpen, Undo2 } from 'lucide-react';
import toast from 'react-hot-toast';

const ActivityLogView = React.lazy(() => import('../views/ActivityLogView').then(m => ({ default: m.ActivityLogView })));

interface AdminPanelProps {
    currentUserId: string;
    onClose: () => void;
}

type AdminTab = 'deleted' | 'users' | 'roles' | 'activity';

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

const TABS: Array<{ id: AdminTab; label: string; Icon: React.FC<{ size?: number; className?: string }> }> = [
    { id: 'deleted', label: 'Deleted', Icon: Archive },
    { id: 'users', label: 'Users', Icon: UsersIcon },
    { id: 'roles', label: 'Roles', Icon: KeyRound },
    { id: 'activity', label: 'Activity', Icon: History },
];

/** Admin hub — deleted-items archive, user management and activity logs
 *  behind a single shield button on the home header (admins only). */
export const AdminPanel: React.FC<AdminPanelProps> = ({ currentUserId, onClose }) => {
    const [tab, setTab] = useState<AdminTab>('deleted');
    const [items, setItems] = useState<DeletedItem[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState('');
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

    const subtitle = {
        deleted: `${items.length} archived item${items.length === 1 ? '' : 's'}`,
        users: 'Team members',
        roles: 'Who can see and change what',
        activity: 'Everything that changed',
    }[tab];

    return (
        <FullScreenPortal>
            <div className="neu-sheet-wide z-50 animate-fade-in-up">
                {/* Same header and body rhythm as every other page, so the
                    sheet reads as one surface rather than a bar over a pane. */}
                <PageRoot width="default">
                    <PageHeader title="Admin" subtitle={subtitle} onBack={onClose}>
                        <div className="flex gap-2 lg:w-fit">
                            {TABS.map(({ id, label, Icon }) => (
                                <button
                                    key={id}
                                    type="button"
                                    onClick={() => setTab(id)}
                                    aria-pressed={tab === id}
                                    className={`flex-1 min-w-0 lg:flex-none px-2 lg:px-7 py-2 flex items-center justify-center gap-1 lg:gap-1.5 rounded-full text-[10.5px] lg:text-[11px] font-bold uppercase tracking-wider lg:tracking-widest transition-colors active-scale ${tab === id
                                        ? 'neu-inset text-gold-700 dark:text-gold-300'
                                        : 'neu-raised-sm neu-btn text-gray-700 dark:text-gray-300'
                                        }`}
                                >
                                    <Icon size={13} className="shrink-0 hidden sm:block" /> <span className="truncate">{label}</span>
                                </button>
                            ))}
                        </div>
                    </PageHeader>

                    <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar neu-scroll-fade px-5 md:px-8 lg:px-10 pt-[calc(0.75rem+var(--page-tools-h,0px))] pb-[calc(1.5rem+var(--safe-bottom-ui))]">
                        <div className="w-full max-w-6xl mx-auto">

                            {tab === 'deleted' && (
                                <div className="space-y-3 animate-fade-in">
                                    {items.length > 0 && !isLoading && (
                                        <div className="flex items-center justify-between px-1">
                                            <p className="neu-label !mb-0">Newest first</p>
                                            <button
                                                type="button"
                                                onClick={() => setPurgeAll(true)}
                                                disabled={isPurging}
                                                className="neu-raised-sm neu-btn rounded-full px-3.5 py-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-red-600 dark:text-red-400 active-scale disabled:opacity-40"
                                            >
                                                <Trash2 size={12} /> Clear all
                                            </button>
                                        </div>
                                    )}
                                    {isLoading && (
                                        <div className="py-12 flex justify-center">
                                            <Loader2 size={20} className="animate-spin text-gold-500" />
                                        </div>
                                    )}
                                    {!isLoading && error && (
                                        <p className="neu-inset rounded-2xl text-xs text-red-600 dark:text-red-400 px-4 py-3">{error}</p>
                                    )}
                                    {!isLoading && !error && items.length > 0 && (
                                        <div className="grid gap-3 lg:grid-cols-2">
                                            {items.map(item => {
                                                const { label, Icon } = ENTITY_META[item.entity] || { label: item.entity, Icon: Archive };
                                                return (
                                                    <div key={item.id} className="neu-card p-3 flex items-center gap-3 animate-fade-in-up">
                                                        <span className="w-10 h-10 rounded-full neu-inset flex items-center justify-center shrink-0 text-[var(--neu-text-dim)]">
                                                            <Icon size={15} />
                                                        </span>
                                                        <div className="flex-1 min-w-0">
                                                            <p className="text-[13px] text-[var(--neu-text)] font-medium line-clamp-2">{item.summary || `${label} ${item.entityId}`}</p>
                                                            <p className="text-[11px] text-[var(--neu-text-dim)] mt-0.5 truncate">
                                                                <span className="uppercase tracking-wider text-[var(--neu-gold)] font-medium">{label}</span>
                                                                {' · '}{relTime(item.deletedAt)}{item.deletedByName ? ` · by ${item.deletedByName}` : ''}
                                                            </p>
                                                        </div>
                                                        <button
                                                            type="button"
                                                            onClick={() => { void handleRestore(item); }}
                                                            disabled={isPurging || restoringId === item.id}
                                                            aria-label={`Restore archived ${label}`}
                                                            title="Undo — put this item back"
                                                            className="neu-icon-btn neu-btn active-scale text-gold-700 dark:text-gold-300 disabled:opacity-40"
                                                        >
                                                            {restoringId === item.id ? <Loader2 size={15} className="animate-spin" /> : <Undo2 size={15} />}
                                                        </button>
                                                        <button
                                                            type="button"
                                                            onClick={() => setPurgeTarget(item)}
                                                            disabled={isPurging}
                                                            aria-label={`Permanently delete archived ${label}`}
                                                            title="Delete permanently"
                                                            className="neu-icon-btn neu-btn active-scale text-red-600 dark:text-red-400 disabled:opacity-40"
                                                        >
                                                            <Trash2 size={15} />
                                                        </button>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                    {!isLoading && !error && items.length === 0 && (
                                        <div className="neu-card text-center py-12 px-6 max-w-xl mx-auto">
                                            <span className="w-14 h-14 rounded-full neu-inset mx-auto mb-4 flex items-center justify-center text-[var(--neu-gold)]">
                                                <Archive size={22} strokeWidth={1.5} />
                                            </span>
                                            <p className="text-base font-serif text-[var(--neu-text)] mb-1.5">Nothing deleted yet</p>
                                            <p className="text-xs text-[var(--neu-text-dim)] leading-relaxed">
                                                Every deleted artwork, catalog, collection, inquiry, event, contact or chat is archived here for review.
                                            </p>
                                        </div>
                                    )}
                                </div>
                            )}

                            {tab === 'users' && (
                                <UserManagementPanel currentUserId={currentUserId} />
                            )}

                            {tab === 'roles' && <RolesPanel />}

                            {tab === 'activity' && (
                                <React.Suspense fallback={
                                    <div className="py-12 flex justify-center">
                                        <Loader2 size={20} className="animate-spin text-gold-500" />
                                    </div>
                                }>
                                    <ActivityLogView embedded onBack={() => setTab('deleted')} />
                                </React.Suspense>
                            )}
                        </div>
                    </div>
                </PageRoot>

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
