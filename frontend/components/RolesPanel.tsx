import React, { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Loader2, Lock, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { authService, AuthUser } from '../services/authService';
import { TypeDeleteDialog } from './TypeDeleteDialog';
import {
    ADMIN_ROLE_ID, SECTIONS, SECTION_IDS, normalizePermissions,
    type AccessLevel, type Permissions, type RoleDef,
} from '../permissions';

const LEVELS: AccessLevel[] = ['none', 'view', 'edit'];
const LEVEL_DEFAULT_LABEL: Record<AccessLevel, string> = { none: 'No access', view: 'View', edit: 'Edit' };

const fill = (level: AccessLevel): Permissions =>
    Object.fromEntries(SECTION_IDS.map(id => [id, level])) as Permissions;

/** One-line summary for the role list: "6 edit · 3 view · 2 hidden". */
function summarize(p: Permissions): string {
    const counts = { edit: 0, view: 0, none: 0 };
    for (const id of SECTION_IDS) counts[p[id]] += 1;
    const parts = [];
    if (counts.edit) parts.push(`${counts.edit} edit`);
    if (counts.view) parts.push(`${counts.view} view`);
    if (counts.none) parts.push(`${counts.none} hidden`);
    return parts.join(' · ');
}

/** Admin: define roles and what each one can see and change. */
export const RolesPanel: React.FC = () => {
    const [roles, setRoles] = useState<RoleDef[]>([]);
    const [users, setUsers] = useState<AuthUser[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    // The role being edited: an existing id, or 'new'.
    const [selectedId, setSelectedId] = useState<string | 'new' | null>(null);
    const [draftName, setDraftName] = useState('');
    const [draft, setDraft] = useState<Permissions>(fill('none'));
    const [saving, setSaving] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<RoleDef | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const [roleList, userList] = await Promise.all([authService.getRoles(), authService.getUsers()]);
            setRoles(roleList);
            setUsers(userList);
        } catch (e) {
            const msg = (e as Error).message;
            setError(msg === 'Not found'
                ? 'Roles need the latest server update. Deploy the Worker, then reload.'
                : msg || 'Could not load roles');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { void load(); }, [load]);

    const memberCount = useMemo(() => {
        const counts = new Map<string, number>();
        for (const u of users) counts.set(u.role, (counts.get(u.role) || 0) + 1);
        return counts;
    }, [users]);

    const selected = selectedId && selectedId !== 'new' ? roles.find(r => r.id === selectedId) ?? null : null;
    const isAdminRole = selected?.id === ADMIN_ROLE_ID;

    const select = (role: RoleDef) => {
        setSelectedId(role.id);
        setDraftName(role.name);
        setDraft(normalizePermissions(role.permissions));
    };
    const startNew = () => {
        setSelectedId('new');
        setDraftName('');
        // Start from Staff's access: usually closest to what a new role needs.
        setDraft(normalizePermissions(roles.find(r => r.id === 'user')?.permissions));
    };

    const dirty = selectedId === 'new'
        || (!!selected && !isAdminRole && (draftName.trim() !== selected.name
            || SECTION_IDS.some(id => draft[id] !== selected.permissions[id])));

    const save = async () => {
        if (!dirty || saving) return;
        if (!draftName.trim()) { toast.error('Give the role a name'); return; }
        setSaving(true);
        try {
            if (selectedId === 'new') {
                const created = await authService.createRole(draftName.trim(), draft);
                toast.success(`Role "${created.name}" created`);
                await load();
                select(created);
            } else if (selected) {
                const updated = await authService.updateRole(selected.id, { name: draftName.trim(), permissions: draft });
                toast.success('Role saved. Menus update the next time people open the app.');
                await load();
                select(updated);
            }
        } catch (e) {
            toast.error((e as Error).message || 'Could not save the role');
        } finally {
            setSaving(false);
        }
    };

    const remove = async () => {
        const target = deleteTarget;
        setDeleteTarget(null);
        if (!target) return;
        try {
            await authService.deleteRole(target.id);
            toast.success(`Role "${target.name}" deleted`);
            setSelectedId(null);
            await load();
        } catch (e) {
            toast.error((e as Error).message || 'Could not delete the role');
        }
    };

    if (loading && roles.length === 0) {
        return <div className="py-12 flex justify-center"><Loader2 size={20} className="animate-spin text-gold-500" /></div>;
    }
    if (error) {
        return <p className="neu-inset rounded-2xl text-xs text-red-600 dark:text-red-400 px-4 py-3 max-w-xl">{error}</p>;
    }

    return (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start animate-fade-in">
            {/* Role list */}
            <section className="space-y-3">
                <div className="flex items-center justify-between px-1">
                    <h3 className="neu-label !mb-0">{roles.length} roles</h3>
                    <button type="button" onClick={startNew} className="neu-raised-sm neu-btn rounded-full px-3.5 py-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--neu-gold)] active-scale">
                        <Plus size={13} /> New role
                    </button>
                </div>
                <div className="neu-card px-1.5 py-1">
                    {roles.map((r, i) => {
                        const count = memberCount.get(r.id) || 0;
                        const active = selectedId === r.id;
                        return (
                            <React.Fragment key={r.id}>
                                {i > 0 && <div className="neu-divider mx-2.5" />}
                                <button
                                    type="button"
                                    onClick={() => select(r)}
                                    aria-pressed={active}
                                    className={`w-full text-left flex items-center gap-3 px-2.5 py-3 my-0.5 rounded-2xl transition-shadow ${active ? 'neu-inset' : ''}`}
                                >
                                    <span className={`w-10 h-10 rounded-full neu-inset flex items-center justify-center shrink-0 ${r.id === ADMIN_ROLE_ID ? 'text-[var(--neu-gold)]' : 'text-[var(--neu-text-dim)]'}`}>
                                        {r.id === ADMIN_ROLE_ID ? <ShieldCheck size={16} /> : <span className="font-serif">{r.name.charAt(0).toUpperCase()}</span>}
                                    </span>
                                    <span className="flex-1 min-w-0">
                                        <span className="flex items-center gap-1.5 text-sm font-medium text-[var(--neu-text)]">
                                            <span className="truncate">{r.name}</span>
                                            {r.builtIn && <span className="text-[9px] font-bold uppercase tracking-wider text-[var(--neu-text-dim)]">Built-in</span>}
                                        </span>
                                        <span className="block text-[11px] text-[var(--neu-text-dim)] truncate">
                                            {r.id === ADMIN_ROLE_ID ? 'Everything, plus users, roles and the archive' : summarize(r.permissions)}
                                        </span>
                                    </span>
                                    <span className="text-[11px] text-[var(--neu-text-dim)] shrink-0">{count} {count === 1 ? 'person' : 'people'}</span>
                                </button>
                            </React.Fragment>
                        );
                    })}
                </div>
                <p className="text-[11px] text-[var(--neu-text-dim)] px-1 leading-relaxed">
                    Give people a role in the Users tab. The server enforces roles, so a hidden section's data can't be fetched either. Changes take effect within about 15 seconds; menus update the next time someone opens the app.
                </p>
            </section>

            {/* Editor */}
            {selectedId === null ? (
                <p className="neu-card text-xs text-[var(--neu-text-dim)] text-center py-10 px-6">Pick a role to see or change what it can access, or create a new one.</p>
            ) : (
                <section className="neu-card p-4 space-y-4 lg:sticky lg:top-0">
                    <div>
                        <label htmlFor="role-name" className="neu-label">Role name</label>
                        <input
                            id="role-name"
                            value={draftName}
                            onChange={e => setDraftName(e.target.value)}
                            disabled={isAdminRole}
                            maxLength={40}
                            placeholder="e.g. Sales, Store manager"
                            className="neu-field disabled:opacity-60"
                        />
                    </div>

                    {isAdminRole ? (
                        <p className="neu-inset rounded-2xl px-3.5 py-3 text-xs text-[var(--neu-text-dim)] flex gap-2">
                            <Lock size={14} className="shrink-0 mt-0.5 text-[var(--neu-gold)]" />
                            Admin always has full access to every section, plus users, roles and the deleted-items archive. It can't be changed.
                        </p>
                    ) : (
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="neu-label !mb-0 mr-1">Set all</span>
                            {([['edit', 'Full access'], ['view', 'View only'], ['none', 'Nothing']] as const).map(([lvl, label]) => (
                                <button key={lvl} type="button" onClick={() => setDraft(fill(lvl))} className="neu-raised-sm neu-btn rounded-full px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--neu-text)] active-scale">
                                    {label}
                                </button>
                            ))}
                        </div>
                    )}

                    <div className="space-y-3">
                        {SECTIONS.map(section => {
                            const raw = isAdminRole ? 'edit' : draft[section.id];
                            // Activity is read-only by nature: "edit" there means the same as "view".
                            const current = section.id === 'activity' && raw === 'edit' ? 'view' : raw;
                            return (
                                <div key={section.id} className="sm:flex sm:items-center sm:gap-3">
                                    <div className="flex-1 min-w-0 mb-1.5 sm:mb-0">
                                        <p className="text-[13px] font-medium text-[var(--neu-text)]">{section.label}</p>
                                        <p className="text-[11px] text-[var(--neu-text-dim)]">{section.description}</p>
                                    </div>
                                    <div role="radiogroup" aria-label={`${section.label} access`} className="flex gap-1.5 sm:w-[252px] shrink-0">
                                        {LEVELS.map(level => {
                                            // Activity has nothing to edit, so it only offers No access / View.
                                            if (section.id === 'activity' && level === 'edit') return null;
                                            const on = current === level;
                                            const label = section.levelLabels?.[level] ?? LEVEL_DEFAULT_LABEL[level];
                                            return (
                                                <button
                                                    key={level}
                                                    type="button"
                                                    role="radio"
                                                    aria-checked={on}
                                                    disabled={isAdminRole}
                                                    onClick={() => setDraft(d => ({ ...d, [section.id]: level }))}
                                                    className={`flex-1 rounded-full py-1.5 text-[10.5px] font-bold uppercase tracking-wider transition-colors disabled:cursor-default ${on
                                                        ? `neu-inset ${level === 'none' ? 'text-red-600 dark:text-red-400' : 'text-gold-700 dark:text-gold-300'}`
                                                        : 'neu-raised-sm text-gray-600 dark:text-gray-300 disabled:opacity-40'}`}
                                                >
                                                    {label}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {!isAdminRole && (
                        <div className="flex gap-2 pt-1">
                            <button type="button" onClick={() => { void save(); }} disabled={!dirty || saving} className="neu-button neu-button-primary flex-1 disabled:opacity-50">
                                {saving && <Loader2 size={14} className="animate-spin" />}
                                {selectedId === 'new' ? 'Create role' : 'Save changes'}
                            </button>
                            {selected && !selected.builtIn && (
                                <button type="button" onClick={() => setDeleteTarget(selected)} className="neu-button text-red-600 dark:text-red-400" aria-label={`Delete role ${selected.name}`}>
                                    <Trash2 size={14} /> Delete
                                </button>
                            )}
                        </div>
                    )}
                    {selected && !selected.builtIn && (memberCount.get(selected.id) || 0) > 0 && (
                        <p className="text-[11px] text-[var(--neu-text-dim)]">
                            To delete this role, first move its {memberCount.get(selected.id)} {memberCount.get(selected.id) === 1 ? 'person' : 'people'} to another role in the Users tab.
                        </p>
                    )}
                </section>
            )}

            <TypeDeleteDialog
                isOpen={!!deleteTarget}
                title="Delete role"
                itemName={deleteTarget?.name || ''}
                message="the role is removed; nobody currently has it"
                onClose={() => setDeleteTarget(null)}
                onConfirm={() => { void remove(); }}
            />
        </div>
    );
};
