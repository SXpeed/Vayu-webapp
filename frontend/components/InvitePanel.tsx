import React, { useCallback, useEffect, useState } from 'react';
import { Copy, MailPlus, Send, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from './ui';
import { authService, type Invitation } from '../services/authService';
import type { RoleDef } from '../permissions';

// Inside a workspace, people join by invitation: an email with a link that
// works once, for that address, for 7 days. They choose their own password
// or sign in with Google (platform/invitations.ts).

const whenLeft = (expiresAt: number) => {
    const days = Math.ceil((expiresAt - Date.now()) / 86_400_000);
    if (days <= 0) return 'expired';
    return days === 1 ? 'runs out tomorrow' : `runs out in ${days} days`;
};

async function copy(text: string) {
    try {
        await navigator.clipboard.writeText(text);
        toast.success('Link copied');
    } catch {
        toast.error('Copy did not work. Select the link and copy it.');
    }
}

export const InvitePanel: React.FC<{ roles: RoleDef[]; RoleSelect: React.FC<{ value: string; roles: RoleDef[]; onChange: (v: string) => void; id?: string }> }> = ({ roles, RoleSelect }) => {
    const [email, setEmail] = useState('');
    const [role, setRole] = useState('user');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    /** When email isn't set up, the link to pass on by hand. */
    const [manualLink, setManualLink] = useState<{ email: string; link: string } | null>(null);
    const [invitations, setInvitations] = useState<Invitation[]>([]);

    const load = useCallback(() => {
        authService.getInvitations().then(setInvitations).catch(() => setInvitations([]));
    }, []);
    useEffect(load, [load]);

    const send = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setManualLink(null);
        if (!email.trim()) { setError('Enter their email address.'); return; }
        setBusy(true);
        try {
            const result = await authService.invite(email.trim(), role);
            if (result.emailSent) toast.success(`Invitation sent to ${result.invitation.email}`);
            else if (result.link) setManualLink({ email: result.invitation.email, link: result.link });
            setEmail('');
            setRole('user');
            load();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    };

    const withdraw = async (inv: Invitation) => {
        try {
            await authService.withdrawInvitation(inv.id);
            toast.success('Invitation withdrawn');
            load();
        } catch (err) {
            toast.error((err as Error).message);
        }
    };

    const open = invitations.filter(i => i.status === 'pending');
    const roleName = (id: string) => roles.find(r => r.id === id)?.name ?? id;

    return (
        <section className="lg:sticky lg:top-0 space-y-6">
            <div>
                <h3 className="neu-label px-1">Invite someone</h3>
                <form onSubmit={send} className="neu-card p-4 space-y-4">
                    <div className="flex items-center gap-3">
                        <span className="w-10 h-10 rounded-full neu-inset flex items-center justify-center shrink-0 text-[var(--neu-gold)]">
                            <MailPlus size={17} />
                        </span>
                        <p className="text-xs text-[var(--neu-text-dim)] leading-relaxed">We email them a link. They choose their own password or use Google.</p>
                    </div>
                    {error && <p className="neu-inset rounded-xl text-[11px] text-red-600 dark:text-red-400 px-3 py-2">{error}</p>}
                    {manualLink && (
                        <div className="neu-inset rounded-xl px-3 py-2.5 space-y-2">
                            <p className="text-[11px] text-[var(--neu-text)]">Email isn't set up yet, so send {manualLink.email} this link yourself:</p>
                            <p className="text-[11px] font-mono break-all select-all text-[var(--neu-text-dim)]">{manualLink.link}</p>
                            <Button type="button" onClick={() => copy(manualLink.link)} icon={<Copy size={13} />}>Copy link</Button>
                        </div>
                    )}
                    <div>
                        <label htmlFor="inv-email" className="neu-label">Email</label>
                        <input id="inv-email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="jane@example.com" className="neu-field" />
                    </div>
                    <div>
                        <label htmlFor="inv-role" className="neu-label">Role</label>
                        <RoleSelect id="inv-role" value={role} roles={roles} onChange={setRole} />
                    </div>
                    <Button type="submit" variant="primary" block disabled={busy} icon={<Send size={15} />}>
                        {busy ? 'Sending…' : 'Send invitation'}
                    </Button>
                </form>
            </div>

            {open.length > 0 && (
                <div>
                    <h3 className="neu-label px-1">Waiting to join · {open.length}</h3>
                    <ul className="neu-card px-1.5 py-1">
                        {open.map((inv, index) => (
                            <li key={inv.id}>
                                {index > 0 && <div className="neu-divider mx-2.5" />}
                                <div className="flex items-center gap-3 px-2.5 py-3">
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm text-[var(--neu-text)] truncate">{inv.email}</p>
                                        <p className="text-[11px] text-[var(--neu-text-dim)]">{roleName(inv.appRole)} · {whenLeft(inv.expiresAt)}</p>
                                    </div>
                                    <button type="button" onClick={() => withdraw(inv)} aria-label={`Withdraw the invitation to ${inv.email}`} title="Withdraw"
                                        className="neu-icon-btn neu-btn active-scale">
                                        <X size={14} />
                                    </button>
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </section>
    );
};
