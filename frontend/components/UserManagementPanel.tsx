import React, { useState, useEffect, useCallback } from 'react';
import { X, UserPlus, Trash2, Eye, EyeOff, Edit2, Check, Bell, BellOff } from 'lucide-react';
import { Button } from './ui';
import { authService, AuthUser } from '../services/authService';
import { TypeDeleteDialog } from './TypeDeleteDialog';
import { StoreConfig } from '../types';
import { apiCall } from '../services/apiClient';
import { ADMIN_ROLE_ID, BUILT_IN_ROLES, type RoleDef } from '../permissions';

/** Matches DEFAULT_MAX_DEVICES in deviceSessions.ts (server). */
const DEFAULT_MAX_DEVICES = 2;

function timeAgo(ts: number): string {
  if (!ts) return 'a while ago';
  const minutes = Math.round((Date.now() - ts) / 60_000);
  if (minutes < 60) return minutes <= 1 ? 'just now' : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/** Devices a person is signed in on, most recently used first. */
const DeviceList: React.FC<{ devices?: AuthUser['devices'] }> = ({ devices }) => {
  if (!devices) return null;
  return (
    <div>
      <p className="neu-label">Signed in on</p>
      {devices.length === 0 ? (
        <p className="text-[11px] text-[var(--neu-text-dim)]">No devices.</p>
      ) : (
        <ul className="space-y-1">
          {devices.map((d, i) => (
            <li key={`${d.label}-${d.createdAt}-${i}`} className="text-[11px] text-[var(--neu-text)] flex justify-between gap-3">
              <span className="truncate">{d.label}</span>
              <span className="text-[var(--neu-text-dim)] shrink-0">used {timeAgo(d.lastUsedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

interface Props {
  currentUserId: string;
}

/** "Jane Doe" → "JD" for the avatar disc. */
const initials = (name: string): string =>
  name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('') || '?';

/** Role picker — Admin, Staff and any custom roles from the Roles tab. */
const RoleSelect: React.FC<{ value: string; roles: RoleDef[]; onChange: (v: string) => void; id?: string }> = ({ value, roles, onChange, id }) => (
  <select id={id} value={value} onChange={e => onChange(e.target.value)} aria-label="Role" className="neu-field">
    {!roles.some(r => r.id === value) && <option value={value}>Unknown role</option>}
    {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
  </select>
);

/** Team members and the add-user form — the Admin sheet's Users tab. */
const UserManagementPanel: React.FC<Props> = ({ currentUserId }) => {
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('user');
  const [showPassword, setShowPassword] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AuthUser | null>(null);
  const [stores, setStores] = useState<StoreConfig[]>([]);
  const [editStoreId, setEditStoreId] = useState('');

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editRole, setEditRole] = useState('user');
  const [editPassword, setEditPassword] = useState('');
  /** '' = default limit; otherwise '1'..'10'. */
  const [editMaxDevices, setEditMaxDevices] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  // Roles for the pickers. A server from before roles existed has no
  // /auth/roles, so fall back to the two built-ins.
  const [roles, setRoles] = useState<RoleDef[]>(BUILT_IN_ROLES);
  const roleName = (id: string) => roles.find(r => r.id === id)?.name ?? 'Unknown role';

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [list, roleList] = await Promise.all([
        authService.getUsers(),
        authService.getRoles().catch(() => BUILT_IN_ROLES),
      ]);
      setUsers(list);
      setRoles(roleList);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  // Stores for the attendance assignment dropdown (best effort — absent if none exist).
  useEffect(() => {
    apiCall<StoreConfig[]>('/attendance/stores')
      .then(setStores)
      .catch(() => setStores([]));
  }, []);

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
    } catch (err) {
      setAddError((err as Error).message);
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
    setEditStoreId(u.storeId || '');
    setEditMaxDevices(u.maxDevices ? String(u.maxDevices) : '');
    setEditPassword('');
    setEditError('');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName('');
    setEditEmail('');
    setEditRole('user');
    setEditStoreId('');
    setEditMaxDevices('');
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
      const data: { name?: string; email?: string; role?: string; password?: string; storeId?: string; maxDevices?: number | null } = {
        name: editName.trim(),
        email: editEmail.trim(),
        role: editRole,
        storeId: editStoreId,
      };
      if (editRole !== ADMIN_ROLE_ID) data.maxDevices = editMaxDevices ? Number(editMaxDevices) : null;
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
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start animate-fade-in">
      {/* Members */}
      <section>
        <h3 className="neu-label px-1">
          Members{!loading && !error ? ` · ${users.length}` : ''}
        </h3>
        {loading && (
          <p className="neu-card text-xs text-[var(--neu-text-dim)] text-center py-8">Loading…</p>
        )}
        {error && (
          <p className="neu-inset rounded-2xl text-xs text-red-600 dark:text-red-400 px-4 py-3">{error}</p>
        )}
        {!loading && !error && users.length === 0 && (
          <p className="neu-card text-xs text-[var(--neu-text-dim)] text-center py-8">No users yet.</p>
        )}
        {users.length > 0 && (
          <div className="neu-card px-1.5 py-1">
            {users.map((u, index) => (
              <React.Fragment key={u.id}>
                {index > 0 && <div className="neu-divider mx-2.5" />}
                {editingId === u.id ? (
                  <div className="neu-inset rounded-2xl p-4 my-1.5 space-y-3">
                    <p className="neu-label !mb-0">Edit {u.name}</p>
                    {editError && (
                      <p className="text-[11px] text-red-600 dark:text-red-400">{editError}</p>
                    )}
                    <div>
                      <label htmlFor={`um-edit-name-${u.id}`} className="neu-label">Name</label>
                      <input id={`um-edit-name-${u.id}`} type="text" value={editName} onChange={e => setEditName(e.target.value)} className="neu-field" />
                    </div>
                    <div>
                      <label htmlFor={`um-edit-email-${u.id}`} className="neu-label">Email</label>
                      <input id={`um-edit-email-${u.id}`} type="email" value={editEmail} onChange={e => setEditEmail(e.target.value)} className="neu-field" />
                    </div>
                    <div>
                      <label htmlFor={`um-edit-pw-${u.id}`} className="neu-label">New password</label>
                      <input id={`um-edit-pw-${u.id}`} type="password" autoComplete="new-password" value={editPassword} onChange={e => setEditPassword(e.target.value)} placeholder="Leave blank to keep" className="neu-field" />
                    </div>
                    <div>
                      <label htmlFor={`um-edit-role-${u.id}`} className="neu-label">Role</label>
                      <RoleSelect id={`um-edit-role-${u.id}`} value={editRole} roles={roles} onChange={setEditRole} />
                    </div>
                    {editRole !== ADMIN_ROLE_ID ? (
                      <div>
                        <label htmlFor={`um-edit-devices-${u.id}`} className="neu-label">Max devices signed in</label>
                        <select
                          id={`um-edit-devices-${u.id}`}
                          value={editMaxDevices}
                          onChange={e => setEditMaxDevices(e.target.value)}
                          className="neu-field"
                        >
                          <option value="">Default ({DEFAULT_MAX_DEVICES})</option>
                          {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
                            <option key={n} value={String(n)}>{n} {n === 1 ? 'device' : 'devices'}</option>
                          ))}
                        </select>
                        <p className="text-[11px] text-[var(--neu-text-dim)] mt-1.5 leading-relaxed">
                          Signing in on one more device signs out the one used longest ago.
                        </p>
                      </div>
                    ) : (
                      <p className="text-[11px] text-[var(--neu-text-dim)]">Admins can sign in on any number of devices.</p>
                    )}
                    <DeviceList devices={u.devices} />
                    {stores.length > 0 && (
                      <div>
                        <label htmlFor={`um-edit-store-${u.id}`} className="neu-label">Attendance store</label>
                        <select
                          id={`um-edit-store-${u.id}`}
                          value={editStoreId}
                          onChange={e => setEditStoreId(e.target.value)}
                          className="neu-field"
                        >
                          <option value="">No assigned store</option>
                          {stores.map(s => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div className="flex gap-2 pt-1">
                      <Button type="button" variant="primary" className="flex-1" onClick={() => handleEditSave(u.id)} disabled={editSaving} icon={<Check size={14} />}>
                        {editSaving ? 'Saving…' : 'Save'}
                      </Button>
                      <Button type="button" className="flex-1" onClick={cancelEdit} disabled={editSaving} icon={<X size={14} />}>
                        Cancel
                      </Button>
                    </div>
                    {u.id !== currentUserId && (
                      <Button type="button" variant="danger" block onClick={() => setDeleteTarget(u)} disabled={removingId === u.id} icon={<Trash2 size={13} />}>
                        Delete user
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-3 px-2.5 py-3">
                    <span className={`w-10 h-10 rounded-full neu-inset flex items-center justify-center shrink-0 text-[12px] font-semibold tracking-wide ${u.role === ADMIN_ROLE_ID ? 'text-[var(--neu-gold)]' : 'text-[var(--neu-text-dim)]'}`}>
                      {initials(u.name)}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[var(--neu-text)] truncate flex items-center gap-1.5">
                        {u.name}
                        {u.id === currentUserId && <span className="text-[10px] font-normal text-[var(--neu-text-dim)]">(you)</span>}
                        {u.notificationsEnabled ? (
                          <span title="Notifications enabled" className="shrink-0 inline-flex"><Bell size={12} className="text-gold-500" aria-hidden="true" /><span className="sr-only">Notifications enabled</span></span>
                        ) : (
                          <span title="Notifications disabled" className="shrink-0 inline-flex"><BellOff size={12} className="text-[var(--neu-text-dim)]" aria-hidden="true" /><span className="sr-only">Notifications disabled</span></span>
                        )}
                      </p>
                      <p className="text-[11px] text-[var(--neu-text-dim)] truncate">
                        {u.email}
                        {u.devices && (
                          <span> · {u.devices.length}{u.deviceLimit ? ` of ${u.deviceLimit}` : ''} {u.devices.length === 1 && !u.deviceLimit ? 'device' : 'devices'}</span>
                        )}
                      </p>
                    </div>
                    <span className={`neu-status text-[10px] font-bold uppercase tracking-widest px-2.5 py-1 shrink-0 ${u.role === ADMIN_ROLE_ID ? 'text-gold-700 dark:text-gold-300' : 'text-[var(--neu-text-dim)]'}`}>
                      {roleName(u.role)}
                    </span>
                    <button
                      onClick={() => startEdit(u)}
                      aria-label={`Edit ${u.name}`}
                      title="Edit user"
                      className="neu-icon-btn neu-btn active-scale"
                    >
                      <Edit2 size={14} />
                    </button>
                  </div>
                )}
              </React.Fragment>
            ))}
          </div>
        )}
      </section>

      {/* Add user */}
      <section className="lg:sticky lg:top-0">
        <h3 className="neu-label px-1">Add user</h3>
        <form onSubmit={handleAdd} className="neu-card p-4 space-y-4">
          <div className="flex items-center gap-3">
            <span className="w-10 h-10 rounded-full neu-inset flex items-center justify-center shrink-0 text-[var(--neu-gold)]">
              <UserPlus size={17} />
            </span>
            <p className="text-xs text-[var(--neu-text-dim)] leading-relaxed">They sign in with this email and the temporary password, then change it.</p>
          </div>

          {addError && (
            <p className="neu-inset rounded-xl text-[11px] text-red-600 dark:text-red-400 px-3 py-2">{addError}</p>
          )}

          <div>
            <label htmlFor="um-name" className="neu-label">Full name</label>
            <input id="um-name" type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Jane Doe" className="neu-field" />
          </div>

          <div>
            <label htmlFor="um-email" className="neu-label">Email</label>
            <input id="um-email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="jane@vayu.com" className="neu-field" />
          </div>

          <div>
            <label htmlFor="um-password" className="neu-label">Temporary password</label>
            <div className="relative">
              <input
                id="um-password"
                autoComplete="new-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Min 6 characters"
                className="neu-field pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword(s => !s)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--neu-text-dim)] hover:text-[var(--neu-text)]"
              >
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          <div>
            <label htmlFor="um-role" className="neu-label">Role</label>
            <RoleSelect id="um-role" value={role} roles={roles} onChange={setRole} />
          </div>

          <Button type="submit" variant="primary" block disabled={adding} icon={<UserPlus size={16} />}>
            {adding ? 'Adding…' : 'Add user'}
          </Button>
        </form>
      </section>

      <TypeDeleteDialog
        isOpen={!!deleteTarget}
        title="Remove user"
        itemName={deleteTarget?.name || ''}
        message="their account and login access are archived for admin review"
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
