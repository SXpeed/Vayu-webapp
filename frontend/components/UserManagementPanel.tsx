import React, { useState, useEffect, useCallback } from 'react';
import { X, UserPlus, Trash2, Shield, User, Eye, EyeOff } from 'lucide-react';
import { authService, AuthUser } from '../services/authService';

interface Props {
  currentUserId: string;
  onClose: () => void;
}

const UserManagementPanel: React.FC<Props> = ({ currentUserId, onClose }) => {
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [showPassword, setShowPassword] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const [removingId, setRemovingId] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setUsers(await authService.getUsers());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  const handleAdd = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    setAddError('');
    if (!name.trim() || !email.trim() || !password) {
      setAddError('All fields are required.');
      return;
    }
    if (password.length < 6) {
      setAddError('Password must be at least 6 characters.');
      return;
    }
    setAdding(true);
    try {
      const newUser = await authService.addUser(name.trim(), email.trim(), password, role);
      setUsers(prev => [...prev, newUser]);
      setName('');
      setEmail('');
      setPassword('');
      setRole('user');
    } catch (e) {
      setAddError((e as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (id: string) => {
    setRemovingId(id);
    try {
      await authService.removeUser(id);
      setUsers(prev => prev.filter(u => u.id !== id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-[#faf9f6] dark:bg-[#121212] animate-fade-in-up">
      {/* Header */}
      <div className="bg-white dark:bg-[#1a1a1a] px-4 pt-8 pb-4 shadow-sm border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
        <div>
          <h2 className="text-base font-serif text-gray-900 dark:text-white">User Management</h2>
          <p className="text-[10px] text-gray-400 dark:text-gray-500 uppercase tracking-widest mt-0.5">
            {users.length} {users.length === 1 ? 'member' : 'members'}
          </p>
        </div>
        <button
          onClick={onClose}
          className="p-2 text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale"
        >
          <X size={20} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-5 no-scrollbar">
        {/* Current users */}
        <section>
          <h3 className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-2 px-1">
            Current Users
          </h3>
          {loading && (
            <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-4">Loading…</p>
          )}
          {error && (
            <p className="text-xs text-red-500 text-center py-2">{error}</p>
          )}
          {!loading && !error && users.length === 0 && (
            <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-4">No users yet.</p>
          )}
          <div className="space-y-2">
            {users.map(u => (
              <div
                key={u.id}
                className="bg-white dark:bg-[#1e1e1e] rounded-[7px] border border-gray-100 dark:border-gray-800 p-3 flex items-center gap-3 shadow-sm"
              >
                <div className="w-9 h-9 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center shrink-0 text-brand-900 dark:text-gold-400">
                  {u.role === 'admin' ? <Shield size={16} strokeWidth={1.5} /> : <User size={16} strokeWidth={1.5} />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-serif text-gray-900 dark:text-gray-100 truncate">{u.name}</p>
                  <p className="text-[10px] text-gray-400 dark:text-gray-500 truncate">{u.email}</p>
                </div>
                <span className={`text-[8px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full shrink-0 ${
                  u.role === 'admin'
                    ? 'bg-gold-100 dark:bg-gold-900/30 text-gold-700 dark:text-gold-400'
                    : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400'
                }`}>
                  {u.role}
                </span>
                {u.id !== currentUserId && (
                  <button
                    onClick={() => handleRemove(u.id)}
                    disabled={removingId === u.id}
                    className="p-1.5 text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-full transition-colors active-scale disabled:opacity-40 shrink-0"
                    title="Remove user"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Add user form */}
        <section>
          <h3 className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-2 px-1 flex items-center gap-1">
            <UserPlus size={11} /> Add User
          </h3>
          <form onSubmit={handleAdd} className="bg-white dark:bg-[#1e1e1e] rounded-[7px] border border-gray-100 dark:border-gray-800 p-4 space-y-4 shadow-sm">
            {addError && (
              <p className="text-[11px] text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded-[7px]">
                {addError}
              </p>
            )}

            <div>
              <label htmlFor="um-name" className="block text-[10px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">
                Full Name
              </label>
              <input
                id="um-name"
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Jane Doe"
                className="w-full bg-gray-50 dark:bg-[#2a2a2a] border border-gray-200 dark:border-gray-700 rounded-[7px] py-2 px-3 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
              />
            </div>

            <div>
              <label htmlFor="um-email" className="block text-[10px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">
                Email
              </label>
              <input
                id="um-email"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="jane@vayu.com"
                className="w-full bg-gray-50 dark:bg-[#2a2a2a] border border-gray-200 dark:border-gray-700 rounded-[7px] py-2 px-3 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
              />
            </div>

            <div>
              <label htmlFor="um-password" className="block text-[10px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">
                Temporary Password
              </label>
              <div className="relative">
                <input
                  id="um-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Min 6 characters"
                  className="w-full bg-gray-50 dark:bg-[#2a2a2a] border border-gray-200 dark:border-gray-700 rounded-[7px] py-2 px-3 pr-9 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(s => !s)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                >
                  {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>

            <div>
              <label htmlFor="um-role" className="block text-[10px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">
                Role
              </label>
              <select
                id="um-role"
                value={role}
                onChange={e => setRole(e.target.value as 'user' | 'admin')}
                className="w-full bg-gray-50 dark:bg-[#2a2a2a] border border-gray-200 dark:border-gray-700 rounded-[7px] py-2 px-3 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </div>

            <button
              type="submit"
              disabled={adding}
              className="w-full bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 rounded-[7px] py-2.5 text-sm font-medium tracking-wide hover:bg-brand-800 dark:hover:bg-gold-400 transition-colors shadow-sm active-scale disabled:opacity-50 flex items-center justify-center gap-2"
            >
              <UserPlus size={16} />
              {adding ? 'Adding…' : 'Add User'}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
};

export default UserManagementPanel;
