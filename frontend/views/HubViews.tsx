// My Space and Social: two Home tiles, each a short list of its items. Items
// not built yet read "Coming soon" (docs/IMPLEMENTATION_PLAN.md Step 8).
import React, { useState } from 'react';
import { ChevronRight, ClipboardList, Leaf, Mail, MessageCircle, NotebookPen, Wallet } from 'lucide-react';
import { useBackClose } from '../hooks/useBackClose';
import { PageRoot, PageHeader, PageBody, Badge } from '../components/ui';
import { useAppChrome } from '../components/Layout';
import { TaskBoard } from './tasks/TaskList';
import { StaffRosterView } from './StaffRosterView';
import { ExpensesView } from './ExpensesView';
import { currentWorkspace } from '../services/workspace';
import { useBranding } from '../useBranding';
import type { CalendarEvent, UserProfile } from '../types';

interface Item { title: string; line: string; Icon: React.ElementType; onOpen?: () => void }

const HubRow: React.FC<Item> = ({ title, line, Icon, onOpen }) => (
    <li className="task-row">
        <button type="button" onClick={onOpen} disabled={!onOpen}
            className="w-full flex items-center gap-3 px-2 py-3 text-left rounded-xl active-scale disabled:cursor-default disabled:active:scale-100">
            <span className="w-10 h-10 shrink-0 rounded-full neu-inset flex items-center justify-center text-brand-900 dark:text-gold-400">
                <Icon size={18} strokeWidth={1.5} />
            </span>
            <span className="flex-1 min-w-0">
                <span className="block font-serif text-[15.5px] leading-snug truncate text-gray-900 dark:text-white">{title}</span>
                <span className="block mt-0.5 text-[11.5px] text-[var(--neu-text-dim)] truncate">{line}</span>
            </span>
            {onOpen ? <ChevronRight size={16} className="shrink-0 text-[var(--neu-text-dim)]" aria-hidden /> : <Badge>Coming soon</Badge>}
        </button>
    </li>
);

const Hub: React.FC<{ title: string; subtitle: string; items: (Item | false)[] }> = ({ title, subtitle, items }) => {
    const { navigate } = useAppChrome();
    return (
    <PageRoot>
        <PageHeader title={title} subtitle={subtitle} onBack={() => navigate('home')} />
        <PageBody>
            <ul className="neu-card px-2 py-1">
                {items.filter((i): i is Item => !!i).map(i => <HubRow key={i.title} {...i} />)}
            </ul>
        </PageBody>
    </PageRoot>
    );
};

export const MySpaceView: React.FC<{
    events: CalendarEvent[]; teamMembers: UserProfile[]; currentUserId: string; userName: string; onUpdateEvent: (ev: CalendarEvent) => void;
}> = ({ events, teamMembers, currentUserId, userName, onUpdateEvent }) => {
    const { can } = useAppChrome();
    const branding = useBranding();
    const [open, setOpen] = useState<'expenses' | 'tasks' | 'leave' | null>(null);
    const close = () => setOpen(null);
    useBackClose(open !== null, close);

    if (open === 'expenses') return <ExpensesView person={userName} workspace={currentWorkspace()?.name ?? branding.appName} onBack={close} />;
    if (open === 'leave') return <StaffRosterView initialView="requests" onBack={close} />;
    if (open === 'tasks') {
        return (
            <PageRoot>
                <PageHeader title="My tasks" onBack={close} />
                <PageBody>
                    <TaskBoard events={events} teamMembers={teamMembers} currentUserId={currentUserId}
                        canEdit={can('calendar', 'edit')} onUpdateEvent={onUpdateEvent} initialFilter="mine" />
                </PageBody>
            </PageRoot>
        );
    }
    // Tasks live on calendar events and leave in the Staff roster, so each follows that section's access.
    return (
        <Hub title="My Space" subtitle="Your own work, claims and notes" items={[
            { title: 'Expenses', line: 'Record with receipts, share as a PDF', Icon: Wallet, onOpen: () => setOpen('expenses') },
            can('calendar') && { title: 'Tasks', line: 'Your to-do list from the calendar', Icon: ClipboardList, onOpen: () => setOpen('tasks') },
            can('schedule') && { title: 'Leave request', line: 'Ask for leave and see the decision', Icon: Leaf, onOpen: () => setOpen('leave') },
            { title: 'My Notes', line: 'Private notes only you can see', Icon: NotebookPen },
        ]} />
    );
};

/** Admin: things managers decide. Opens for Staff roster "Manage" (the Home tile checks it). */
export const AdminHubView: React.FC = () => {
    const [open, setOpen] = useState<'leave' | null>(null);
    const close = () => setOpen(null);
    useBackClose(open !== null, close);
    if (open === 'leave') return <StaffRosterView initialView="requests" onBack={close} />;
    return (
        <Hub title="Admin" subtitle="Decisions waiting on you" items={[
            { title: 'Leave requests', line: 'Approve or decline your team’s leave', Icon: Leaf, onOpen: () => setOpen('leave') },
        ]} />
    );
};

export const SocialView: React.FC = () => (
    <Hub title="Social" subtitle="Invites to your contacts" items={[
        { title: 'WhatsApp invites', line: 'Send event invites on WhatsApp', Icon: MessageCircle },
        { title: 'Email invites', line: 'Event invites with RSVP', Icon: Mail },
    ]} />
);
