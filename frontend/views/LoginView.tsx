import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Building2, ChevronRight, Eye, EyeOff, LogOut } from 'lucide-react';
import { authService, AuthUser } from '../services/authService';
import { authClient, myWorkspaces, platformUser, type Workspace } from '../services/workspace';
import { SITE_ORIGIN } from '../brand';
import { useBranding } from '../useBranding';

interface LoginViewProps {
  onLogin: (user: AuthUser) => void;
}

// Signing in to the app:
//   - With a platform account (email and password, or Google): the same
//     account as the website. The person then works in one of their
//     organizations; with several, they choose.
//   - Anyone not on the platform yet (the original app's own accounts, before
//     their organization is connected) signs in with the same form: when the
//     platform doesn't know the email and password, the original sign-in is
//     tried, so nobody is locked out during the move.
type Screen = 'checking' | 'setup' | 'signin' | 'forgot' | 'workspaces' | 'none';

interface LoginMethods { emailPassword: { signIn: boolean }; google: { signIn: boolean } }

const field = 'neu-field';
const label = 'block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider';
const primary = 'w-full neu-raised-sm neu-btn text-gold-700 dark:text-gold-300 rounded-full py-3 text-sm font-medium tracking-wide active-scale disabled:opacity-50';

function googleErrorText(code: string): string {
  if (/not_linked|link/i.test(code)) return 'This email already has an account with a password. Sign in with your email and password; you can link Google afterwards.';
  if (/signup_disabled|sign_up_disabled/i.test(code)) return 'There is no account for that Google address. Ask your team for an invitation.';
  if (/access_denied/i.test(code)) return 'Google sign-in was cancelled.';
  return 'Google sign-in did not work. Please try again.';
}

const GoogleMark = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
    <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
    <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
  </svg>
);

export const LoginView: React.FC<LoginViewProps> = ({ onLogin }) => {
  const branding = useBranding();
  const [screen, setScreen] = useState<Screen>('checking');
  const [methods, setMethods] = useState<LoginMethods | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [account, setAccount] = useState<string>('');
  const [error, setError] = useState(() => {
    const code = new URLSearchParams(location.search).get('error');
    return code ? googleErrorText(code) : '';
  });

  /** Signed in on the platform: open the only workspace, or let them choose. */
  const continueWithPlatform = useCallback(async (email: string) => {
    setAccount(email);
    const list = await myWorkspaces();
    setWorkspaces(list);
    if (list.length === 1) {
      try {
        onLogin(await authService.enterWorkspace(list[0]));
      } catch (e) {
        setError((e as Error).message);
        setScreen('workspaces');
      }
      return;
    }
    setScreen(list.length === 0 ? 'none' : 'workspaces');
  }, [onLogin]);

  // Once, on arrival (the app re-renders this screen as it loads).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    fetch('/api/v2/public/login-methods').then(r => (r.ok ? r.json() : null)).then(setMethods).catch(() => setMethods(null));
    (async () => {
      // Back from Google, or signed in on the website already.
      const user = await platformUser();
      if (user) { await continueWithPlatform(user.email); return; }
      const needsSetup = await authService.needsSetup().catch(() => false);
      setScreen(needsSetup ? 'setup' : 'signin');
    })().catch(() => setScreen('signin'));
  }, [continueWithPlatform]);

  if (screen === 'checking') {
    return (
      <div className="h-full flex items-center justify-center bg-[var(--neu-bg)]">
        <div className="animate-pulse text-gold-500 font-serif text-xl">{branding.appName}</div>
      </div>
    );
  }

  let body: React.ReactNode;
  if (screen === 'workspaces') {
    body = <WorkspacePicker account={account} workspaces={workspaces} error={error} onPick={async (w) => {
      setError('');
      try { onLogin(await authService.enterWorkspace(w)); } catch (e) { setError((e as Error).message); }
    }} />;
  } else if (screen === 'none') {
    body = <NoWorkspace account={account} />;
  } else if (screen === 'forgot') {
    body = <ForgotPassword onBack={() => { setError(''); setScreen('signin'); }} />;
  } else if (screen === 'setup') {
    body = <FirstRunSetup onLogin={onLogin} />;
  } else {
    body = <SignInForm methods={methods} error={error} setError={setError} onForgot={() => setScreen('forgot')}
      onPlatform={continueWithPlatform} onOriginal={onLogin} />;
  }

  return (
    <div className="h-full overflow-y-auto flex flex-col bg-[var(--neu-bg)] items-center justify-center p-6 transition-colors duration-500 animate-fade-in">
      <div className="w-full max-w-sm space-y-9 py-6">
        <div className="text-center space-y-1 animate-fade-in-up">
          {branding.logoUrl && <img src={branding.logoUrl} alt="" className="w-20 h-20 mx-auto mb-2 rounded-2xl object-contain" />}
          <h1 className="text-5xl font-serif text-gold-500 tracking-wide">{branding.appName}</h1>
          {branding.tagline && <p className="text-sm text-gold-400 tracking-widest uppercase">{branding.tagline}</p>}
        </div>
        <div className="neu-raised rounded-3xl p-7 sm:p-8 animate-fade-in-up" style={{ animationDelay: '100ms' }}>
          {body}
        </div>
      </div>
    </div>
  );
};

const ErrorNote: React.FC<{ text: string }> = ({ text }) => (
  text ? <div role="alert" className="neu-inset text-red-600 dark:text-red-400 p-3 rounded-lg text-xs text-center">{text}</div> : null
);

const SignInForm: React.FC<{
  methods: LoginMethods | null;
  error: string;
  setError: (s: string) => void;
  onForgot: () => void;
  onPlatform: (email: string) => Promise<void>;
  onOriginal: (user: AuthUser) => void;
}> = ({ methods, error, setError, onForgot, onPlatform, onOriginal }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState<'email' | 'google' | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!email.trim() || !password) { setError('Enter your email and password.'); return; }
    setBusy('email');
    try {
      const { error: platformError } = await authClient.signIn.email({ email: email.trim(), password });
      if (!platformError) { await onPlatform(email.trim()); return; }
      if (platformError.status !== 401) { setError(platformError.message || 'Sign-in did not work. Please try again.'); return; }
      // Not a platform account (yet): the original app's own sign-in.
      try {
        onOriginal(await authService.login(email.trim(), password));
      } catch {
        setError('Wrong email or password.');
      }
    } finally {
      setBusy(null);
    }
  };

  const google = async () => {
    setError('');
    setBusy('google');
    const { error: googleError } = await authClient.signIn.social({ provider: 'google', callbackURL: '/', errorCallbackURL: '/' });
    if (googleError) { setBusy(null); setError(googleError.message || googleErrorText('')); }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-center text-lg font-serif text-gray-800 dark:text-gray-200">Welcome back</h2>
      <ErrorNote text={error} />
      {methods?.google.signIn && (
        <>
          <button type="button" onClick={google} disabled={busy !== null}
            className="w-full h-12 rounded-full neu-raised-sm neu-btn flex items-center justify-center gap-3 text-sm font-medium text-gray-800 dark:text-gray-100 active-scale disabled:opacity-50">
            <GoogleMark /> {busy === 'google' ? 'Opening Google…' : 'Continue with Google'}
          </button>
          <div className="flex items-center gap-3 text-[11px] text-gray-500 dark:text-gray-400" aria-hidden="true">
            <span className="h-px flex-1 bg-gray-300/70 dark:bg-white/10" /> or with your email <span className="h-px flex-1 bg-gray-300/70 dark:bg-white/10" />
          </div>
        </>
      )}
      <form onSubmit={submit} className="space-y-5">
        <div>
          <label htmlFor="login-email" className={label}>Email</label>
          <input id="login-email" type="email" value={email} onChange={e => setEmail(e.target.value)} className={field} placeholder="you@example.com" autoComplete="email" />
        </div>
        <div>
          <label htmlFor="login-password" className={label}>Password</label>
          <div className="relative">
            <input id="login-password" type={show ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} className={`${field} !pr-11`} placeholder="••••••••" autoComplete="current-password" />
            <button type="button" onClick={() => setShow(v => !v)} aria-label={show ? 'Hide password' : 'Show password'}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 w-9 h-9 rounded-lg flex items-center justify-center text-gray-500 hover:text-gray-800 dark:hover:text-gray-100">
              {show ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <div className="mt-2 text-right">
            <button type="button" onClick={onForgot} className="text-[12px] text-gray-600 dark:text-gray-400 underline underline-offset-2">Forgot password?</button>
          </div>
        </div>
        <button type="submit" disabled={busy !== null} className={primary}>{busy === 'email' ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
};

/** The reset link lands on the website's page for choosing a new password. */
const ForgotPassword: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState('');
  const [error, setError] = useState('');
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const redirectTo = import.meta.env.DEV ? `${location.origin}/signup.html?mode=reset` : `${SITE_ORIGIN}/signup?mode=reset`;
    const { error: resetError } = await authClient.requestPasswordReset({ email: email.trim(), redirectTo });
    setBusy(false);
    if (resetError) setError(resetError.message || 'That did not work. Try again in a minute.');
    else setSentTo(email.trim());
  };
  return (
    <div className="space-y-5">
      <h2 className="text-center text-lg font-serif text-gray-800 dark:text-gray-200">Reset your password</h2>
      {sentTo ? (
        <p className="text-sm text-gray-700 dark:text-gray-300 text-center">
          If there is an account for <strong className="font-medium break-all">{sentTo}</strong>, we have emailed it a link to choose a new password. The link works for one hour.
        </p>
      ) : (
        <form onSubmit={send} className="space-y-5">
          <p className="text-xs text-gray-600 dark:text-gray-400 text-center">Enter the email you sign in with. We'll send you a link to choose a new password.</p>
          <ErrorNote text={error} />
          <div>
            <label htmlFor="forgot-email" className={label}>Email</label>
            <input id="forgot-email" type="email" required value={email} onChange={e => setEmail(e.target.value)} className={field} autoComplete="email" />
          </div>
          <button type="submit" disabled={busy} className={primary}>{busy ? 'Sending…' : 'Send reset link'}</button>
        </form>
      )}
      <button type="button" onClick={onBack} className="w-full flex items-center justify-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
        <ArrowLeft size={14} /> Back to sign in
      </button>
    </div>
  );
};

const signOutAndReload = async () => {
  await authClient.signOut().catch(() => undefined);
  location.replace('/');
};

const WorkspacePicker: React.FC<{ account: string; workspaces: Workspace[]; error: string; onPick: (w: Workspace) => Promise<void> }> = ({ account, workspaces, error, onPick }) => {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="space-y-5">
      <div className="text-center">
        <h2 className="text-lg font-serif text-gray-800 dark:text-gray-200">Choose a workspace</h2>
        <p className="mt-1 text-[11px] text-gray-600 dark:text-gray-400 break-all">Signed in as {account}</p>
      </div>
      <ErrorNote text={error} />
      <ul className="space-y-3">
        {workspaces.map(w => (
          <li key={w.id}>
            <button type="button" disabled={busy !== null} onClick={async () => { setBusy(w.id); await onPick(w); setBusy(null); }}
              className="w-full neu-raised-sm neu-btn rounded-2xl px-4 py-3 flex items-center gap-3 text-left active-scale disabled:opacity-60">
              <span className="w-9 h-9 rounded-xl neu-inset flex items-center justify-center text-gold-600 dark:text-gold-300"><Building2 size={17} /></span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{w.name}</span>
                <span className="block text-[11px] text-gray-600 dark:text-gray-400 capitalize">{busy === w.id ? 'Opening…' : w.role}</span>
              </span>
              <ChevronRight size={16} className="text-gray-400" />
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={signOutAndReload} className="w-full flex items-center justify-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
        <LogOut size={14} /> Use another account
      </button>
    </div>
  );
};

const NoWorkspace: React.FC<{ account: string }> = ({ account }) => (
  <div className="space-y-4 text-center">
    <h2 className="text-lg font-serif text-gray-800 dark:text-gray-200">No workspace yet</h2>
    <p className="text-sm text-gray-700 dark:text-gray-300">
      You're signed in as <strong className="font-medium break-all">{account}</strong>, but this account isn't part of a workspace.
    </p>
    <ul className="text-xs text-gray-600 dark:text-gray-400 space-y-2 text-left">
      <li>• Invited by your team? Open the link in their email.</li>
      <li>• Applied for your business? <a className="underline underline-offset-2" href={`${SITE_ORIGIN}/signup?mode=signin`}>See where your application stands</a>.</li>
    </ul>
    <button type="button" onClick={signOutAndReload} className="w-full flex items-center justify-center gap-1.5 text-xs text-gray-600 dark:text-gray-400 pt-2">
      <LogOut size={14} /> Use another account
    </button>
  </div>
);

/** The original app's first run: its very first admin (before any organizations). */
const FirstRunSetup: React.FC<{ onLogin: (user: AuthUser) => void }> = ({ onLogin }) => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!name.trim() || !email.trim() || !password) { setError('All fields are required.'); return; }
    if (password.length < 10) { setError('Password must be at least 10 characters.'); return; }
    setBusy(true);
    try {
      await authService.setup(name.trim(), email.trim(), password);
      onLogin(await authService.login(email.trim(), password));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="text-center">
        <h2 className="text-lg font-serif text-gray-800 dark:text-gray-200">Create Admin Account</h2>
        <p className="text-[11px] text-gray-600 dark:text-gray-300 mt-1">First-run setup: set your admin credentials</p>
      </div>
      <ErrorNote text={error} />
      <div><label htmlFor="setup-name" className={label}>Full Name</label><input id="setup-name" value={name} onChange={e => setName(e.target.value)} className={field} autoComplete="name" /></div>
      <div><label htmlFor="setup-email" className={label}>Email</label><input id="setup-email" type="email" value={email} onChange={e => setEmail(e.target.value)} className={field} autoComplete="email" /></div>
      <div><label htmlFor="setup-password" className={label}>Password</label><input id="setup-password" type="password" value={password} onChange={e => setPassword(e.target.value)} className={field} autoComplete="new-password" /></div>
      <button type="submit" disabled={busy} className={primary}>{busy ? 'Setting up…' : 'Create Account & Sign In'}</button>
    </form>
  );
};
