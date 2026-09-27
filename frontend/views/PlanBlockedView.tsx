import React, { useState } from 'react';
import { CreditCard, LogOut, Repeat } from 'lucide-react';
import { PageRoot, PageHeader, PageBody, EmptyState, Button } from '../components/ui';
import { PlanPanel } from '../components/PlanPanel';
import { authService } from '../services/authService';
import { currentWorkspace, setWorkspace } from '../services/workspace';

/**
 * The whole app while the workspace's plan isn't active (payment needed,
 * trial over, renewal overdue): owners and admins see the plan and pay for it
 * here; everyone else is told who can. Paying opens the workspace again.
 */
export const PlanBlockedView: React.FC = () => {
    const workspace = currentWorkspace();
    const canPay = workspace?.role === 'owner' || workspace?.role === 'admin';
    const [leaving, setLeaving] = useState(false);

    const reopen = () => globalThis.location.reload();
    const switchWorkspace = () => { setWorkspace(null); reopen(); };
    const signOut = async () => {
        setLeaving(true);
        try { await authService.logout(); } finally { reopen(); }
    };

    return (
        <div className="h-full overflow-y-auto bg-[var(--neu-bg)]">
            <PageRoot width="default">
                <PageHeader
                    title={workspace?.name ?? 'Your workspace'}
                    subtitle={canPay ? 'Renew or choose a plan to open the workspace again' : 'This workspace is waiting on its plan'}
                />
                <PageBody>
                    {canPay ? (
                        <PlanPanel onActive={reopen} />
                    ) : (
                        <EmptyState
                            icon={<CreditCard size={22} strokeWidth={1.5} />}
                            title="The plan needs renewing"
                            message="Everything is kept safe. The workspace opens again as soon as an owner or admin renews its plan in the app."
                            action={<Button onClick={reopen}>Try again</Button>}
                        />
                    )}
                    <div className="mt-6 flex flex-wrap justify-center gap-2">
                        <Button onClick={switchWorkspace} icon={<Repeat size={14} />}>Switch workspace</Button>
                        <Button onClick={() => void signOut()} disabled={leaving} icon={<LogOut size={14} />}>Sign out</Button>
                    </div>
                </PageBody>
            </PageRoot>
        </div>
    );
};
