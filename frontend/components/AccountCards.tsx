import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { ArrowLeftRight, AtSign, Building2, KeyRound } from 'lucide-react';
import { Button, Card, Field, Input, SectionTitle } from './ui';
import { authClient, currentWorkspace, setWorkspace } from '../services/workspace';
import { startEmailChange } from '../services/emailChange';

// Profile cards for a platform sign-in: which workspace this is (and a way to
// switch), and the account's email and password. The original sign-in has
// none of these.

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

    const save = async (e: React.SubmitEvent<HTMLFormElement>) => {
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

/** The email you sign in with, and changing it (confirmed by email links; services/emailChange.ts). */
export const EmailCard: React.FC = () => {
    const { data } = authClient.useSession();
    const [open, setOpen] = useState(false);
    const [next, setNext] = useState('');
    const [password, setPassword] = useState('');
    const [needsPassword, setNeedsPassword] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [sent, setSent] = useState('');
    if (!currentWorkspace() || !data) return null;
    const email = data.user.email;

    const close = () => { setOpen(false); setError(''); setNext(''); setPassword(''); setNeedsPassword(false); };

    const save = async (e: React.SubmitEvent<HTMLFormElement>) => {
        e.preventDefault();
        setError('');
        setBusy(true);
        const result = await startEmailChange(authClient, { email, verified: data.user.emailVerified }, next, password);
        setBusy(false);
        if (!result.ok) {
            if (result.needsPassword) setNeedsPassword(true);
            setError(result.message);
            return;
        }
        setSent(result.message);
        close();
    };

    return (
        <Card className="animate-fade-in-up">
            <SectionTitle actions={!open && <Button onClick={() => { setOpen(true); setSent(''); }} icon={<AtSign size={14} />}>Change</Button>}>Email</SectionTitle>
            {!open ? (
                <div className="space-y-2">
                    <p className="text-sm text-gray-900 dark:text-gray-100 break-all">{email}</p>
                    <p className="text-xs text-gray-600 dark:text-gray-400">You sign in with this address, on the website and in the app.</p>
                    {sent && <p role="status" className="neu-inset rounded-xl text-[11px] text-gray-700 dark:text-gray-300 px-3 py-2">{sent}</p>}
                </div>
            ) : (
                <form onSubmit={save} className="space-y-3">
                    {error && <p role="alert" className="neu-inset rounded-xl text-[11px] text-red-600 dark:text-red-400 px-3 py-2">{error}</p>}
                    <Field label="New email" htmlFor="em-new" hint="We send a link to confirm it. Your password stays the same.">
                        <Input id="em-new" type="email" autoComplete="off" value={next} onChange={e => setNext(e.target.value)} />
                    </Field>
                    {needsPassword && (
                        <Field label="Current password" htmlFor="em-password" hint="Asked when you signed in more than 30 minutes ago.">
                            <Input id="em-password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />
                        </Field>
                    )}
                    <div className="flex gap-2">
                        <Button type="submit" variant="primary" disabled={busy || !next.trim()}>{busy ? 'Sending…' : 'Send confirmation'}</Button>
                        <Button type="button" onClick={close}>Cancel</Button>
                    </div>
                </form>
            )}
        </Card>
    );
};
