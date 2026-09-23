import React, { useCallback, useEffect, useState } from 'react';
import { Building2, Eye, EyeOff, LogOut } from 'lucide-react';
import { Toaster } from 'react-hot-toast';
import { authClient, platformUser, setWorkspace } from '../services/workspace';
import { useBranding } from '../useBranding';

// app.ateliersupport.com/join/<token>: the link in an invitation email.
//
// The invitation names one email address. Whoever opens the link either
// signs in with that address (email and password, or Google) or, if they have
// no account yet, creates one right here, then joins the workspace and lands
// in the app. Signed in as someone else, they are told so and can switch.

interface Invitation {
  orgName: string;
  email: string;
  invitedBy: string | null;
  state: 'open' | 'expired' | 'used' | 'closed';
  hasAccount: boolean;
}

const field = 'neu-field';
const label = 'block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider';
const primary = 'w-full neu-raised-sm neu-btn text-gold-700 dark:text-gold-300 rounded-full py-3 text-sm font-medium tracking-wide active-scale disabled:opacity-50';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v2${path}`, { ...init, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || 'Something went wrong. Please try again.');
  return body as T;
}

const STATE_TEXT: Record<Exclude<Invitation['state'], 'open'>, string> = {
  expired: 'This invitation has run out. Ask whoever invited you to send a new one.',
  used: 'This invitation has already been used. If it was you, just sign in.',
  closed: 'This invitation is no longer open. Ask whoever invited you to send a new one.',
};

export const JoinView: React.FC = () => {
  const branding = useBranding();
  const token = location.pathname.split('/join/')[1]?.split('/')[0] ?? '';
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [signedInAs, setSignedInAs] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  /** Joins as the signed-in account and opens the workspace. */
  const join = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const joined = await api<{ orgId: string; orgName: string }>(`/invitations/${token}/accept`, { method: 'POST', body: '{}' });
      setWorkspace({ id: joined.orgId, name: joined.orgName, role: 'staff' });
      location.replace('/');
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }, [token]);

  useEffect(() => {
    (async () => {
      const info = await api<Invitation>(`/invitations/${token}`);
      setInvitation(info);
      const user = await platformUser();
      setSignedInAs(user?.email ?? null);
      // Back from Google (or already signed in) with the right account: join straight away.
      if (user && info.state === 'open' && user.email.toLowerCase() === info.email) await join();
    })().catch(e => setError((e as Error).message));
  }, [token, join]);

  let body: React.ReactNode = <p className="text-center text-sm text-gray-600 dark:text-gray-400 animate-pulse">Opening your invitation…</p>;
  if (invitation && invitation.state !== 'open') {
    body = (
      <div className="space-y-5 text-center">
        <p className="text-sm text-gray-700 dark:text-gray-300">{STATE_TEXT[invitation.state]}</p>
        <a href="/" className={`${primary} block`}>Go to sign in</a>
      </div>
    );
  } else if (invitation && signedInAs && signedInAs.toLowerCase() !== invitation.email) {
    body = (
      <div className="space-y-5 text-center">
        <p className="text-sm text-gray-700 dark:text-gray-300">
          You're signed in as <strong className="font-medium break-all">{signedInAs}</strong>, but this invitation is for <strong className="font-medium break-all">{invitation.email}</strong>.
        </p>
        <button type="button" className={primary} onClick={async () => { await authClient.signOut(); setSignedInAs(null); }}>
          <LogOut size={14} className="inline -mt-0.5 mr-1.5" /> Sign out and continue
        </button>
      </div>
    );
  } else if (invitation && signedInAs) {
    body = <button type="button" className={primary} disabled={busy} onClick={join}>{busy ? 'Joining…' : `Join ${invitation.orgName}`}</button>;
  } else if (invitation?.hasAccount) {
    body = <SignInToJoin invitation={invitation} token={token} onSignedIn={join} setError={setError} />;
  } else if (invitation) {
    body = <CreateAccountToJoin invitation={invitation} token={token} setError={setError} />;
  }

  return (
    <div className="h-full overflow-y-auto flex flex-col bg-[var(--neu-bg)] items-center justify-center p-6">
      <Toaster position="top-center" />
      <div className="w-full max-w-sm space-y-8 py-6">
        <div className="text-center">
          <h1 className="text-4xl font-serif text-gold-500 tracking-wide">{branding.appName}</h1>
        </div>
        <div className="neu-raised rounded-3xl p-7 sm:p-8 space-y-6">
          {invitation && (
            <div className="text-center space-y-2">
              <span className="mx-auto w-11 h-11 rounded-2xl neu-inset flex items-center justify-center text-gold-600 dark:text-gold-300"><Building2 size={19} /></span>
              <h2 className="text-xl font-serif text-gray-900 dark:text-gray-100">Join {invitation.orgName}</h2>
              <p className="text-xs text-gray-600 dark:text-gray-400">
                {invitation.invitedBy ? `${invitation.invitedBy} invited ` : 'You were invited as '}
                <span className="[overflow-wrap:anywhere]">{invitation.email}</span>
              </p>
            </div>
          )}
          {error && <div role="alert" className="neu-inset text-red-600 dark:text-red-400 p-3 rounded-lg text-xs text-center">{error}</div>}
          {body}
        </div>
      </div>
    </div>
  );
};

const PasswordInput: React.FC<{ id: string; value: string; onChange: (v: string) => void; autoComplete: string }> = ({ id, value, onChange, autoComplete }) => {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input id={id} type={show ? 'text' : 'password'} value={value} onChange={e => onChange(e.target.value)} className={`${field} !pr-11`} autoComplete={autoComplete} />
      <button type="button" onClick={() => setShow(v => !v)} aria-label={show ? 'Hide password' : 'Show password'}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 w-9 h-9 rounded-lg flex items-center justify-center text-gray-500">
        {show ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
};

interface GoogleSwitches { signIn: boolean; signUp: boolean }

/** Which Google buttons the control centre allows (sign-in, and new accounts). */
function useGoogle(): GoogleSwitches {
  const [google, setGoogle] = useState<GoogleSwitches>({ signIn: false, signUp: false });
  useEffect(() => {
    fetch('/api/v2/public/login-methods').then(r => (r.ok ? r.json() : null))
      .then((m: { google?: GoogleSwitches } | null) => { if (m?.google) setGoogle(m.google); })
      .catch(() => undefined);
  }, []);
  return google;
}

const GoogleButton: React.FC<{ token: string }> = ({ token }) => (
  <button type="button" onClick={() => authClient.signIn.social({ provider: 'google', callbackURL: `/join/${token}`, errorCallbackURL: `/join/${token}` })}
    className="w-full h-12 rounded-full neu-raised-sm neu-btn text-sm font-medium text-gray-800 dark:text-gray-100 active-scale">
    Continue with Google
  </button>
);

const SignInToJoin: React.FC<{ invitation: Invitation; token: string; onSignedIn: () => Promise<void>; setError: (s: string) => void }> = ({ invitation, token, onSignedIn, setError }) => {
  const google = useGoogle();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const { error } = await authClient.signIn.email({ email: invitation.email, password });
    if (error) { setBusy(false); setError(error.status === 401 ? 'Wrong password.' : (error.message || 'Sign-in did not work.')); return; }
    await onSignedIn();
  };
  return (
    <div className="space-y-5">
      {google.signIn && <GoogleButton token={token} />}
      <form onSubmit={submit} className="space-y-4">
        <p className="text-xs text-gray-600 dark:text-gray-400 text-center">{google.signIn ? 'Or sign in' : 'Sign in'} with your password for {invitation.email}</p>
        <div><label htmlFor="join-password" className={label}>Password</label><PasswordInput id="join-password" value={password} onChange={setPassword} autoComplete="current-password" /></div>
        <button type="submit" disabled={busy || !password} className={primary}>{busy ? 'Joining…' : 'Sign in and join'}</button>
      </form>
    </div>
  );
};

const CreateAccountToJoin: React.FC<{ invitation: Invitation; token: string; setError: (s: string) => void }> = ({ invitation, token, setError }) => {
  const google = useGoogle();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 10) { setError('Choose a password of at least 10 characters.'); return; }
    setBusy(true);
    try {
      const joined = await api<{ orgId: string; orgName: string }>(`/invitations/${token}/create-account`, {
        method: 'POST', body: JSON.stringify({ name: name.trim(), password }),
      });
      const { error } = await authClient.signIn.email({ email: invitation.email, password });
      if (error) throw new Error('Your account is ready. Sign in to continue.');
      setWorkspace({ id: joined.orgId, name: joined.orgName, role: 'staff' });
      location.replace('/');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="space-y-5">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-xs text-gray-600 dark:text-gray-400 text-center">Create your account for {invitation.email}</p>
        <div><label htmlFor="join-name" className={label}>Your name</label><input id="join-name" required value={name} onChange={e => setName(e.target.value)} className={field} autoComplete="name" /></div>
        <div><label htmlFor="join-new-password" className={label}>Choose a password</label><PasswordInput id="join-new-password" value={password} onChange={setPassword} autoComplete="new-password" /></div>
        <p className="text-[11px] text-gray-500 dark:text-gray-400 -mt-1">At least 10 characters.</p>
        <button type="submit" disabled={busy} className={primary}>{busy ? 'Creating your account…' : 'Create account and join'}</button>
      </form>
      {google.signIn && google.signUp && (
        <>
          <div className="flex items-center gap-3 text-[11px] text-gray-500 dark:text-gray-400" aria-hidden="true">
            <span className="h-px flex-1 bg-gray-300/70 dark:bg-white/10" /> or <span className="h-px flex-1 bg-gray-300/70 dark:bg-white/10" />
          </div>
          <GoogleButton token={token} />
        </>
      )}
    </div>
  );
};
