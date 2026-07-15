import React, { useState, useEffect, useCallback } from 'react';
import { X, UserPlus, Trash2, Shield, User, Eye, EyeOff, Edit2, Check, Bell, BellOff } from 'lucide-react';
import { authService, AuthUser } from '../services/authService';
import { ConfirmDialog } from './ConfirmDialog';

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
  const [deleteTarget, setDeleteTarget] = useState<AuthUser | null>(null);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editRole, setEditRole] = useState<'user' | 'admin'>('user');
  const [editPassword, setEditPassword] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

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

  const startEdit = (u: AuthUser) => {
    setEditingId(u.id);
    setEditName(u.name);
    setEditEmail(u.email);
    setEditRole(u.role);
    setEditPassword('');
    setEditError('');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName('');
    setEditEmail('');
    setEditRole('user');
    setEditPassword('');
    setEditError('');
  };

  const handleEditSave = async (id: string) => {
    setEditError('');
    if (!editName.trim() || !editEmail.trim()) {
      setEditError('Name and email are required.');
      return;
    }
    if (editPassword && editPassword.length < 6) {
      setEditError('Password must be at least 6 characters.');
      return;
    }
    setEditSaving(true);
    try {
      const data: { name?: string; email?: string; role?: 'admin' | 'user'; password?: string } = {
        name: editName.trim(),
        email: editEmail.trim(),
        role: editRole,
      };
      if (editPassword) data.password = editPassword;
      const updated = await authService.updateUser(id, data);
      setUsers(prev => prev.map(u => u.id === id ? updated : u));
      cancelEdit();
    } catch (e) {
      setEditError((e as Error).message);
    } finally {
      setEditSaving(false);
    }
  };

  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-[#faf9f6] dark:bg-[#121212] animate-fade-in-up">
      {/* Header */}
      <div className="bg-white dark:bg-[#1a1a1a] px-[6px] pt-[calc(2rem+env(safe-area-inset-top,0px))] pb-4 shadow-sm border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
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

      <div className="flex-1 overflow-y-auto p-[6px] space-y-5 no-scrollbar">
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
                className="bg-white dark:bg-[#1e1e1e] rounded-[6px] border border-gray-100 dark:border-gray-800 p-[6px] shadow-sm"
              >
                {editingId === u.id ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">Edit User</span>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleEditSave(u.id)}
                          disabled={editSaving}
                          className="p-1.5 text-green-500 hover:bg-green-50 dark:hover:bg-green-900/20 rounded-full transition-colors active-scale disabled:opacity-40 shrink-0"
                          title="Save changes"
                        >
                          <Check size={14} />
                        </button>
                        <button
                          onClick={cancelEdit}
                          disabled={editSaving}
                          className="p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale disabled:opacity-40 shrink-0"
                          title="Cancel"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </div>
                    {editError && (
                      <p className="text-[11px] text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-900/20 px-[6px] py-2 rounded-[6px]">{editError}</p>
                    )}
                    <input
                      type="text"
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      placeholder="Name"
                      className="w-full bg-gray-50 dark:bg-[#2a2a2a] border border-gray-200 dark:border-gray-700 rounded-[6px] py-1.5 px-2.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors"
                    />
                    <input
                      type="email"
                      value={editEmail}
                      onChange={e => setEditEmail(e.target.value)}
                      placeholder="Email"
                      className="w-full bg-gray-50 dark:bg-[#2a2a2a] border border-gray-200 dark:border-gray-700 rounded-[6px] py-1.5 px-2.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors"
                    />
                    <input
                      type="password"
                      value={editPassword}
                      onChange={e => setEditPassword(e.target.value)}
                      placeholder="New password (leave blank to keep)"
                      className="w-full bg-gray-50 dark:bg-[#2a2a2a] border border-gray-200 dark:border-gray-700 rounded-[6px] py-1.5 px-2.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors"
                    />
                    <select
                      value={editRole}
                      onChange={e => setEditRole(e.target.value as 'user' | 'admin')}
                      className="w-full bg-gray-50 dark:bg-[#2a2a2a] border border-gray-200 dark:border-gray-700 rounded-[6px] py-1.5 px-2.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors"
                    >
                      <option value="user">User</option>
                      <option value="admin">Admin</option>
                    </select>
                  </div>
                ) : (
                  <div className="flex items-center gap-[6px]">
                    <div className="w-9 h-9 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center shrink-0 text-brand-900 dark:text-gold-400">
                      {u.role === 'admin' ? <Shield size={16} strokeWidth={1.5} /> : <User size={16} strokeWidth={1.5} />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-serif text-gray-900 dark:text-gray-100 truncate flex items-center gap-1.5">
                        {u.name}
                        {u.notificationsEnabled ? (
                          <Bell size={12} className="text-gold-500 shrink-0" title="Notifications Enabled" />
                        ) : (
                          <BellOff size={12} className="text-gray-400 dark:text-gray-600 shrink-0" title="Notifications Disabled" />
                        )}
                      </p>
                      <p className="text-[10px] text-gray-400 dark:text-gray-500 truncate">{u.email}</p>
                    </div>
                    <span className={`text-[8px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full shrink-0 ${u.role === 'admin'
                      ? 'bg-gold-100 dark:bg-gold-900/30 text-gold-700 dark:text-gold-400'
                      : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400'
                      }`}>
                      {u.role}
                    </span>
                    <button
                      onClick={() => startEdit(u)}
                      className="p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale shrink-0"
                      title="Edit user"
                    >
                      <Edit2 size={14} />
                    </button>
                    {u.id !== currentUserId && (
                      <button
                        onClick={() => setDeleteTarget(u)}
                        disabled={removingId === u.id}
                        className="p-1.5 text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-full transition-colors active-scale disabled:opacity-40 shrink-0"
                        title="Remove user"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
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
          <form onSubmit={handleAdd} className="bg-white dark:bg-[#1e1e1e] rounded-[6px] border border-gray-100 dark:border-gray-800 p-[6px] space-y-4 shadow-sm">
            {addError && (
              <p className="text-[11px] text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-900/20 px-[6px] py-2 rounded-[6px]">
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
                className="w-full bg-gray-50 dark:bg-[#2a2a2a] border border-gray-200 dark:border-gray-700 rounded-[6px] py-2 px-[6px] text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
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
                className="w-full bg-gray-50 dark:bg-[#2a2a2a] border border-gray-200 dark:border-gray-700 rounded-[6px] py-2 px-[6px] text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
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
                  className="w-full bg-gray-50 dark:bg-[#2a2a2a] border border-gray-200 dark:border-gray-700 rounded-[6px] py-2 px-[6px] pr-9 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
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
                className="w-full bg-gray-50 dark:bg-[#2a2a2a] border border-gray-200 dark:border-gray-700 rounded-[6px] py-2 px-[6px] text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </div>

            <button
              type="submit"
              disabled={adding}
              className="w-full bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 rounded-[6px] py-2.5 text-sm font-medium tracking-wide hover:bg-brand-800 dark:hover:bg-gold-400 transition-colors shadow-sm active-scale disabled:opacity-50 flex items-center justify-center gap-2"
            >
              <UserPlus size={16} />
              {adding ? 'Adding…' : 'Add User'}
            </button>
          </form>
        </section>
      </div>

      <ConfirmDialog
        isOpen={!!deleteTarget}
        title="Remove User"
        message={`Are you sure you want to remove "${deleteTarget?.name}"? This action cannot be undone.`}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) handleRemove(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />
    </div>
  );
};

export default UserManagementPanel;
