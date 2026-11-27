import React, { useCallback, useEffect, useState } from 'react';
import { useBackClose } from '../hooks/useBackClose';
import { useIsDesktop } from '../hooks/useMediaQuery';
import { FullScreenPortal } from './FullScreenPortal';
import { TypeDeleteDialog } from './TypeDeleteDialog';
import UserManagementPanel from './UserManagementPanel';
import { RolesPanel } from './RolesPanel';
import { PlanPanel } from './PlanPanel';
import { useAppChrome } from './Layout';
import { isPlatformSession } from '../services/workspace';
import { apiCall } from '../services/apiClient';
import { DeletedItem } from '../types';
import { PageRoot, PageHeader } from './ui';
import {
    Archive, Boxes, ChevronRight, Gauge, History, KeyRound, Leaf, Users as UsersIcon, Trash2, Loader2, FileText,
    CalendarDays, Phone, MessageCircle, User as UserIcon, FolderOpen, BookOpen, Undo2,
} from 'lucide-react';
import toast from 'react-hot-toast';

const ActivityLogView = React.lazy(() => import('../views/ActivityLogView').then(m => ({ default: m.ActivityLogView })));
const InventorySettingsPanel = React.lazy(() => import('../views/inventoryTools').then(m => ({ default: m.InventorySettingsPanel })));
const StaffRosterView = React.lazy(() => import('../views/StaffRosterView').then(m => ({ default: m.StaffRosterView })));

interface AdminPanelProps {
    currentUserId: string;
    onClose: () => void;
}

type SectionId = 'leave' | 'users' | 'roles' | 'inventory' | 'plan' | 'activity' | 'deleted';
type Icon = React.FC<{ size?: number; className?: string; strokeWidth?: number }>;
interface Section { id: SectionId; label: string; line: string; Icon: Icon }

/** Every Admin section, in groups. Who sees each is decided in AdminPanel. */
const GROUPS: Array<{ title: string; sections: Section[] }> = [
    { title: 'Decisions', sections: [
        { id: 'leave', label: 'Leave requests', line: 'Approve or decline your team’s leave', Icon: Leaf },
    ] },
    { title: 'Team', sections: [
        { id: 'users', label: 'Users', line: 'Add people, reset passwords, devices', Icon: UsersIcon },
        { id: 'roles', label: 'Roles', line: 'Who can see and change what', Icon: KeyRound },
    ] },
    { title: 'Workspace', sections: [
        { id: 'inventory', label: 'Inventory', line: 'Stock locations and statuses', Icon: Boxes },
        { id: 'plan', label: 'Plan', line: 'Your plan and what you use of it', Icon: Gauge },
    ] },
    { title: 'Records', sections: [
        { id: 'activity', label: 'Activity', line: 'Everything that changed, and who did it', Icon: History },
        { id: 'deleted', label: 'Deleted items', line: 'Restore or purge what was deleted', Icon: Archive },
    ] },
];

const ENTITY_META: Record<string, { label: string; Icon: Icon }> = {
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

const Spinner = () => (
    <div className="py-12 flex justify-center">
        <Loader2 size={20} className="animate-spin text-gold-500" />
    </div>
);

/** One section in the menu (phone) or the left rail (desktop). */
const SectionRow: React.FC<{ section: Section; active?: boolean; compact?: boolean; onOpen: () => void }> = ({ section, active, compact, onOpen }) => {
    const { Icon, label, line } = section;
    return (
        <li>
            <button
                type="button"
                onClick={onOpen}
                aria-current={active ? 'page' : undefined}
                className={`w-full flex items-center gap-3 text-left rounded-2xl active-scale transition-colors ${compact ? 'px-2.5 py-2' : 'px-2 py-3'} ${active ? 'neu-inset' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'}`}
            >
                <span className={`shrink-0 rounded-full flex items-center justify-center ${compact ? 'w-8 h-8' : 'w-10 h-10'} ${active ? 'text-gold-700 dark:text-gold-300' : 'neu-inset text-brand-900 dark:text-gold-400'}`}>
                    <Icon size={compact ? 15 : 18} strokeWidth={1.5} />
                </span>
                <span className="flex-1 min-w-0">
                    <span className={`block truncate ${compact ? 'text-[13.5px] font-medium' : 'font-serif text-[15.5px] leading-snug'} ${active ? 'text-gold-700 dark:text-gold-300' : 'text-gray-900 dark:text-white'}`}>{label}</span>
                    {!compact && <span className="block mt-0.5 text-[11.5px] text-[var(--neu-text-dim)] truncate">{line}</span>}
                </span>
                {!compact && <ChevronRight size={16} className="shrink-0 text-[var(--neu-text-dim)]" aria-hidden />}
            </button>
        </li>
    );
};

/** The sections, grouped. */
const SectionList: React.FC<{ groups: typeof GROUPS; active?: SectionId | null; compact?: boolean; onOpen: (id: SectionId) => void }> = ({ groups, active, compact, onOpen }) => (
    <nav aria-label="Admin sections" className={compact ? 'space-y-4' : 'space-y-5'}>
        {groups.map(g => (
            <div key={g.title}>
                <p className="neu-label px-2">{g.title}</p>
                <ul className={compact ? 'space-y-0.5' : 'neu-card px-2 py-1 divide-y divide-[var(--neu-line)]'}>
                    {g.sections.map(s => <SectionRow key={s.id} section={s} active={active === s.id} compact={compact} onOpen={() => onOpen(s.id)} />)}
                </ul>
            </div>
        ))}
    </nav>
);

/** Deleted items: everything deleted waits here to be restored or purged. */
const DeletedItems: React.FC = () => {
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

    useEffect(() => { void loadItems(); }, [loadItems]);

    const doPurge = async () => {
        const target = purgeTarget;
        const all = purgeAll;
        setPurgeTarget(null);
        setPurgeAll(false);
        setIsPurging(true);
        try {
            await apiCall(`/deleted-items${all || !target ? '' : '/' + target.id}`, { method: 'DELETE' });
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

    if (isLoading) return <Spinner />;
    return (
        <div className="space-y-3 animate-fade-in">
            {error && <p className="neu-inset rounded-2xl text-xs text-red-600 dark:text-red-400 px-4 py-3">{error}</p>}
            {!error && items.length > 0 && (
                <>
                    <div className="flex items-center justify-between px-1">
                        <p className="neu-label !mb-0">{items.length} archived · newest first</p>
                        <button
                            type="button"
                            onClick={() => setPurgeAll(true)}
                            disabled={isPurging}
                            className="neu-raised-sm neu-btn rounded-full px-3.5 py-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-red-600 dark:text-red-400 active-scale disabled:opacity-40"
                        >
                            <Trash2 size={12} /> Clear all
                        </button>
                    </div>
                    <div className="grid gap-3 xl:grid-cols-2">
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
                </>
            )}
            {!error && items.length === 0 && (
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
    );
};

/**
 * Admin: the one place to run the workspace, opened from the sidebar (desktop)
 * or the shield at the top of Home (phone). Phone: a grouped menu, each section opens on its own. Desktop:
 * the menu on the left, the open section on the right.
 * Admins see everything; whoever manages the Staff roster sees Leave requests.
 */
export const AdminPanel: React.FC<AdminPanelProps> = ({ currentUserId, onClose }) => {
    const { isAdmin, can } = useAppChrome();
    const isDesktop = useIsDesktop();
    const allowed = (id: SectionId) => {
        if (id === 'leave') return can('schedule', 'edit');
        if (id === 'plan') return isAdmin && isPlatformSession(); // the original app on its own has no plan
        return isAdmin;
    };
    const groups = GROUPS
        .map(g => ({ ...g, sections: g.sections.filter(s => allowed(s.id)) }))
        .filter(g => g.sections.length > 0);
    const visible = groups.flatMap(g => g.sections);

    // Phone starts on the menu; desktop opens the first section that sits in the pane
    // (Leave requests covers the whole screen, so it only opens when picked).
    const [picked, setPicked] = useState<SectionId | null>(null);
    const section = picked ?? (isDesktop ? visible.find(s => s.id !== 'leave')?.id ?? null : null);
    const current = visible.find(s => s.id === section);
    const toMenu = () => setPicked(null);

    useBackClose(true, onClose);
    // Back from an open section returns to the menu (phone) or leaves Leave requests (it covers the menu).
    useBackClose(!!picked && (!isDesktop || picked === 'leave'), toMenu);

    if (section === 'leave') {
        return (
            <FullScreenPortal>
                <div className="neu-sheet-wide z-50 animate-fade-in-up">
                    <React.Suspense fallback={<Spinner />}>
                        <StaffRosterView initialView="requests" onBack={toMenu} />
                    </React.Suspense>
                </div>
            </FullScreenPortal>
        );
    }

    const body = (() => {
        switch (section) {
            case 'users': return <UserManagementPanel currentUserId={currentUserId} />;
            case 'roles': return <RolesPanel />;
            case 'plan': return <PlanPanel />;
            case 'inventory': return <InventorySettingsPanel />;
            case 'activity': return <ActivityLogView embedded onBack={toMenu} />;
            case 'deleted': return <DeletedItems />;
            default: return null;
        }
    })();

    const onPhoneSection = !isDesktop && !!current;
    return (
        <FullScreenPortal>
            <div className="neu-sheet-wide z-50 animate-fade-in-up">
                <PageRoot width="wide">
                    <PageHeader
                        title={onPhoneSection ? current.label : 'Admin'}
                        subtitle={onPhoneSection ? current.line : 'Run your workspace'}
                        onBack={onPhoneSection ? toMenu : onClose}
                    />

                    <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar neu-scroll-fade px-5 md:px-8 lg:px-10 pt-[calc(0.75rem+var(--page-tools-h,0px))] pb-[calc(1.5rem+var(--safe-bottom-ui))]">
                        <div className="w-full max-w-6xl mx-auto lg:grid lg:grid-cols-[15rem_1fr] lg:gap-8">
                            {isDesktop && (
                                <aside className="lg:sticky lg:top-0 lg:self-start">
                                    <SectionList groups={groups} active={section} compact onOpen={setPicked} />
                                </aside>
                            )}
                            {!isDesktop && !current && <SectionList groups={groups} onOpen={setPicked} />}
                            {current && (
                                <section aria-label={current.label} className="min-w-0 animate-fade-in" key={current.id}>
                                    {isDesktop && (
                                        <header className="mb-4 px-1">
                                            <h2 className="font-serif text-xl text-[var(--neu-text)]">{current.label}</h2>
                                            <p className="text-[12px] text-[var(--neu-text-dim)] mt-0.5">{current.line}</p>
                                        </header>
                                    )}
                                    <React.Suspense fallback={<Spinner />}>{body}</React.Suspense>
                                </section>
                            )}
                            {visible.length === 0 && <p className="text-sm text-[var(--neu-text-dim)]">Nothing here for your role.</p>}
                        </div>
                    </div>
                </PageRoot>
            </div>
        </FullScreenPortal>
    );
};
