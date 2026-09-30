// Login & security → Original app sign-in: the original app's own accounts,
// open until everyone signs in with a platform account, then closed here
// (platform/originalSignIn.ts). Closing is reversible: nothing is deleted.

import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { History } from 'lucide-react';
import { Button } from '../components/ui';
import { api, type ApiError, type Reauth } from './api';
import { Section, SkeletonRows, StatusPill, useDialogs } from './kit';

interface Status {
    open: boolean;
    connectedOrg: { id: string; name: string } | null;
    people: { total: number; withAccount: number; withoutAccount: string[] };
}

export const OriginalSignInPanel: React.FC<{ reauth: Reauth }> = ({ reauth }) => {
    const dialogs = useDialogs();
    const [status, setStatus] = useState<Status | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        try { setStatus(await api<Status>('/admin/settings/original-signin')); } catch (e) { toast.error((e as ApiError).message); }
    }, []);
    useEffect(() => { load(); }, [load]);

    if (!status) return <Section title="Original app sign-in"><SkeletonRows rows={3} /></Section>;

    /** Sends the change, asking for a fresh sign-in or confirmation to go ahead when the server wants one. */
    const send = async (open: boolean, force = false): Promise<void> => {
        try {
            setStatus(await api<Status>('/admin/settings/original-signin', { method: 'PUT', body: JSON.stringify({ open, force }) }));
            toast.success(open ? 'Original sign-in reopened' : 'Original sign-in closed');
        } catch (e) {
            const err = e as ApiError;
            if (err.code === 'reauth_required' && await reauth()) return send(open, force);
            if (err.code === 'people_without_accounts' && await dialogs.confirm({
                title: 'Close it anyway?',
                body: `${err.message} They would have to use "Forgot password?" with an account made for them, or be invited.`,
                confirmLabel: 'Close anyway', danger: true,
            })) return send(open, true);
            if (err.code !== 'people_without_accounts') toast.error(err.message);
        }
    };

    const change = async (open: boolean) => {
        if (!open && !(await dialogs.confirm({
            title: 'Close the original sign-in?',
            body: 'Everyone signed in the original way is signed out and signs in again with their email account (same email, same password). Reopening brings the old sign-in back.',
            confirmLabel: 'Close it',
        }))) return;
        setBusy(true);
        await send(open);
        setBusy(false);
    };

    const { people } = status;
    const missing = people.total - people.withAccount;

    return (
        <Section
            title="Original app sign-in"
            description="The original app's own accounts, from before organizations. Close it once its people sign in with their email account."
            actions={<StatusPill tone={status.open ? 'warn' : 'ok'}>{status.open ? 'Open' : 'Closed'}</StatusPill>}
        >
            <div className="space-y-3 text-sm">
                <div className="flex items-start gap-3">
                    <History size={16} className="ac-faint mt-0.5 shrink-0" />
                    <div className="min-w-0 space-y-1">
                        <p>
                            {status.connectedOrg
                                ? <>Its data belongs to <span className="font-medium">{status.connectedOrg.name}</span>.</>
                                : <>No organization uses its data yet. Connect one first (Organizations → App data).</>}
                        </p>
                        <p className="ac-muted text-[12px]">
                            {people.total === 0
                                ? 'No original accounts found.'
                                : `${people.withAccount} of ${people.total} people have an email account${missing ? `; ${missing} still need one (bring in the original app's people).` : '.'}`}
                        </p>
                        {missing > 0 && (
                            <p className="ac-muted text-[12px] break-all">Still to come: {people.withoutAccount.join(', ')}{missing > people.withoutAccount.length ? '…' : ''}</p>
                        )}
                    </div>
                </div>
                <div className="flex justify-end">
                    {status.open
                        ? <Button variant="danger" disabled={busy || !status.connectedOrg} onClick={() => change(false)}>{busy ? 'Closing…' : 'Close original sign-in'}</Button>
                        : <Button disabled={busy} onClick={() => change(true)}>{busy ? 'Opening…' : 'Reopen original sign-in'}</Button>}
                </div>
            </div>
        </Section>
    );
};
