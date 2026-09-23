import React, { useState, useEffect } from 'react';
import { authService, AuthUser } from '../services/authService';
import { useBranding } from '../useBranding';

interface LoginViewProps {
  onLogin: (user: AuthUser) => void;
}

type Screen = 'checking' | 'setup' | 'login';

export const LoginView: React.FC<LoginViewProps> = ({ onLogin }) => {
  const branding = useBranding();
  const [screen, setScreen] = useState<Screen>('checking');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    authService.needsSetup()
      .then(needs => setScreen(needs ? 'setup' : 'login'))
      .catch(() => setScreen('login'));
  }, []);

  const handleSetup = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    setError('');
    if (!name.trim() || !email.trim() || !password) {
      setError('All fields are required.');
      return;
    }
    if (password.length < 10) {
      setError('Password must be at least 10 characters.');
      return;
    }
    setLoading(true);
    try {
      await authService.setup(name.trim(), email.trim(), password);
      const user = await authService.login(email.trim(), password);
      onLogin(user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    setError('');
    if (!email.trim() || !password) {
      setError('Email and password are required.');
      return;
    }
    setLoading(true);
    try {
      const user = await authService.login(email.trim(), password);
      onLogin(user);
    } catch (err) {
      setError((err as Error).message || 'Invalid email or password.');
    } finally {
      setLoading(false);
    }
  };

  if (screen === 'checking') {
    return (
      <div className="h-full flex items-center justify-center bg-[var(--neu-bg)]">
        <div className="animate-pulse text-gold-500 font-serif text-xl">{branding.appName}</div>
      </div>
    );
  }

  const isSetup = screen === 'setup';
  const loadingLabel = isSetup ? 'Setting up…' : 'Signing in…';
  const idleLabel = isSetup ? 'Create Account & Sign In' : 'Sign In';
  const submitLabel = loading ? loadingLabel : idleLabel;

  return (
    <div className="h-full flex flex-col bg-[var(--neu-bg)] items-center justify-center p-6 transition-colors duration-500 animate-fade-in">
      <div className="w-full max-w-sm space-y-10">
        <div className="text-center space-y-1 animate-fade-in-up">
          {branding.logoUrl && <img src={branding.logoUrl} alt="" className="w-20 h-20 mx-auto mb-2 rounded-2xl object-contain" />}
          <h1 className="text-5xl font-serif text-gold-500 tracking-wide">{branding.appName}</h1>
          {branding.tagline && <p className="text-sm text-gold-400 tracking-widest uppercase">{branding.tagline}</p>}
        </div>

        <form
          onSubmit={isSetup ? handleSetup : handleLogin}
          className="space-y-6 neu-raised rounded-3xl p-8 animate-fade-in-up"
          style={{ animationDelay: '100ms' }}
        >
          <div className="text-center mb-6">
            <h2 className="text-lg font-serif text-gray-800 dark:text-gray-200">
              {isSetup ? 'Create Admin Account' : 'Welcome Back'}
            </h2>
            {isSetup && (
              <p className="text-[11px] text-gray-600 dark:text-gray-300 mt-1">
                First-run setup — set your admin credentials
              </p>
            )}
          </div>

          {error && (
            <div className="neu-inset text-red-600 dark:text-red-400 p-3 rounded-lg text-xs text-center">
              {error}
            </div>
          )}

          {isSetup && (
            <div className="animate-fade-in">
              <label htmlFor="setup-name" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">
                Full Name
              </label>
              <input
                id="setup-name"
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                className="neu-field"
                placeholder="Vivek Sahni"
                autoComplete="name"
              />
            </div>
          )}

          <div>
            <label htmlFor="login-email" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">
              Email
            </label>
            <input
              id="login-email"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="neu-field"
              placeholder="you@example.com"
              autoComplete="email"
            />
          </div>

          <div>
            <label htmlFor="login-password" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">
              Password
            </label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="neu-field"
              placeholder="••••••••"
              autoComplete={isSetup ? 'new-password' : 'current-password'}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full neu-raised-sm neu-btn text-gold-700 dark:text-gold-300 rounded-full py-3 text-sm font-medium tracking-wide mt-8 active-scale disabled:opacity-50"
          >
            {submitLabel}
          </button>
        </form>
      </div>
    </div>
  );
};
