import React, { useState, useEffect } from 'react';
import { authService, AuthUser } from '../services/authService';

interface LoginViewProps {
  onLogin: (user: AuthUser) => void;
}

type Screen = 'checking' | 'setup' | 'login';

export const LoginView: React.FC<LoginViewProps> = ({ onLogin }) => {
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
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
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
      <div className="h-full flex items-center justify-center bg-[#faf9f6] dark:bg-[#121212]">
        <div className="animate-pulse text-gold-500 font-serif text-xl">Vayu</div>
      </div>
    );
  }

  const isSetup = screen === 'setup';
  const loadingLabel = isSetup ? 'Setting up…' : 'Signing in…';
  const idleLabel = isSetup ? 'Create Account & Sign In' : 'Sign In';
  const submitLabel = loading ? loadingLabel : idleLabel;

  return (
    <div className="h-full flex flex-col bg-[#faf9f6] dark:bg-[#121212] items-center justify-center p-6 transition-colors duration-500 animate-fade-in">
      <div className="w-full max-w-sm space-y-10">
        <div className="text-center space-y-1 animate-fade-in-up">
          <h1 className="text-5xl font-serif text-gold-500 tracking-wide">Vayu</h1>
          <h2 className="text-lg font-serif text-gold-400 tracking-widest uppercase">Design for living</h2>
        </div>

        <form
          onSubmit={isSetup ? handleSetup : handleLogin}
          className="space-y-6 bg-white dark:bg-[#1e1e1e] p-8 rounded-[6px] shadow-sm border border-gray-100 dark:border-gray-800 animate-fade-in-up"
          style={{ animationDelay: '100ms' }}
        >
          <div className="text-center mb-6">
            <h2 className="text-lg font-serif text-gray-800 dark:text-gray-200">
              {isSetup ? 'Create Admin Account' : 'Welcome Back'}
            </h2>
            {isSetup && (
              <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1">
                First-run setup — set your admin credentials
              </p>
            )}
          </div>

          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 p-[6px] rounded-[6px] text-xs text-center">
              {error}
            </div>
          )}

          {isSetup && (
            <div className="animate-fade-in">
              <label htmlFor="setup-name" className="block text-[10px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">
                Full Name
              </label>
              <input
                id="setup-name"
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-400 transition-colors"
                placeholder="Vivek Sahni"
                autoComplete="name"
              />
            </div>
          )}

          <div>
            <label htmlFor="login-email" className="block text-[10px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">
              Email
            </label>
            <input
              id="login-email"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-400 transition-colors"
              placeholder="you@vayu.com"
              autoComplete="email"
            />
          </div>

          <div>
            <label htmlFor="login-password" className="block text-[10px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">
              Password
            </label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-400 transition-colors"
              placeholder="••••••••"
              autoComplete={isSetup ? 'new-password' : 'current-password'}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 rounded-[6px] py-3 text-sm font-medium tracking-wide hover:bg-brand-800 dark:hover:bg-gold-400 transition-colors mt-8 shadow-md active-scale disabled:opacity-50"
          >
            {submitLabel}
          </button>
        </form>
      </div>
    </div>
  );
};
