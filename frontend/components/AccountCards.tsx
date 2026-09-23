import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { ArrowLeftRight, Building2, KeyRound } from 'lucide-react';
import { Button, Card, Field, Input, SectionTitle } from './ui';
import { authClient, currentWorkspace, setWorkspace } from '../services/workspace';

// Profile cards for a platform sign-in: which workspace this is (and a way to
// switch), and the account's password. The original sign-in has neither.

/** Opens the workspace chooser: the sign-in screen lists this account's workspaces. */
function switchWorkspace() {
    setWorkspace(null);
    location.replace('/');
}

export const WorkspaceCard: React.FC = () => {
    const workspace = currentWorkspace();
    if (!workspace) return null;
    return (
        <Card className="animate-fade-in-up">
            <SectionTitle>Workspace</SectionTitle>
            <div className="flex items-center gap-3">
                <span className="w-10 h-10 rounded-xl neu-inset flex items-center justify-center text-gold-600 dark:text-gold-300 shrink-0"><Building2 size={17} /></span>
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{workspace.name}</p>
                    <p className="text-[11px] text-gray-600 dark:text-gray-400 capitalize">{workspace.role}</p>
                </div>
                <Button onClick={switchWorkspace} icon={<ArrowLeftRight size={14} />}>Switch</Button>
            </div>
        </Card>
    );
};

export const PasswordCard: React.FC = () => {
    const [open, setOpen] = useState(false);
    const [current, setCurrent] = useState('');
    const [next, setNext] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    if (!currentWorkspace()) return null;

    const save = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        if (next.length < 10) { setError('Choose a new password of at least 10 characters.'); return; }
        setBusy(true);
        const { error: changeError } = await authClient.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true });
        setBusy(false);
        if (changeError) {
            // Accounts made with Google have no password to change.
            setError(changeError.status === 400 && /credential/i.test(changeError.message ?? '')
                ? 'This account signs in with Google. To add a password, use "Forgot password?" on the sign-in page.'
                : (changeError.message || 'That did not work. Check your current password.'));
            return;
        }
        toast.success('Password changed. Your other devices were signed out.');
        setOpen(false);
        setCurrent('');
        setNext('');
    };

    return (
        <Card className="animate-fade-in-up">
            <SectionTitle actions={!open && <Button onClick={() => setOpen(true)} icon={<KeyRound size={14} />}>Change</Button>}>Password</SectionTitle>
            {!open ? (
                <p className="text-xs text-gray-600 dark:text-gray-400">The same password works on the website and in the app.</p>
            ) : (
                <form onSubmit={save} className="space-y-3">
                    {error && <p role="alert" className="neu-inset rounded-xl text-[11px] text-red-600 dark:text-red-400 px-3 py-2">{error}</p>}
                    <Field label="Current password" htmlFor="pw-current">
                        <Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} />
                    </Field>
                    <Field label="New password" htmlFor="pw-new" hint="At least 10 characters. Other devices are signed out.">
                        <Input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} />
                    </Field>
                    <div className="flex gap-2">
                        <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Saving…' : 'Save password'}</Button>
                        <Button type="button" onClick={() => { setOpen(false); setError(''); }}>Cancel</Button>
                    </div>
                </form>
            )}
        </Card>
    );
};
