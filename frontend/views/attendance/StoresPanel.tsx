import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { Crosshair, Loader2, MapPin, Pencil, Plus, Store as StoreIcon, Trash2, TriangleAlert, Users } from 'lucide-react';
import { AuthUser } from '../../services/authService';
import { StoreConfig } from '../../types';
import { attendanceService } from '../../services/attendanceService';
import { TypeDeleteDialog } from '../../components/TypeDeleteDialog';
import { getPosition } from './attendanceUtils';

interface StoresPanelProps {
    stores: StoreConfig[];
    team: AuthUser[];
    onChanged: () => Promise<void>;
}

const EMPTY_FORM = { name: '', latitude: '', longitude: '', gpsRadius: '150', wifiRequired: false, wifiSsid: '' };

/** Admin: the stores people check in at — geofence centre, radius, Wi-Fi. */
export const StoresPanel: React.FC<StoresPanelProps> = ({ stores, team, onChanged }) => {
    // null = form closed, 'new' = adding, otherwise the store being edited.
    const [editing, setEditing] = useState<StoreConfig | 'new' | null>(stores.length === 0 ? 'new' : null);
    const [form, setForm] = useState({ ...EMPTY_FORM });
    const [saving, setSaving] = useState(false);
    const [locating, setLocating] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<StoreConfig | null>(null);

    const openAdd = () => { setEditing('new'); setForm({ ...EMPTY_FORM }); };
    const openEdit = (s: StoreConfig) => {
        setEditing(s);
        setForm({
            name: s.name, latitude: String(s.latitude), longitude: String(s.longitude),
            gpsRadius: String(s.gpsRadius), wifiRequired: s.wifiRequired, wifiSsid: s.wifiSsid,
        });
    };
    const close = () => { setEditing(null); setForm({ ...EMPTY_FORM }); };

    const useMyLocation = async () => {
        setLocating(true);
        try {
            const fix = await getPosition();
            setForm(f => ({ ...f, latitude: fix.lat.toFixed(6), longitude: fix.lng.toFixed(6) }));
            toast.success(`Location set (±${Math.round(fix.accuracy)} m)`);
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setLocating(false);
        }
    };

    const save = async () => {
        if (saving || !editing) return;
        const latitude = Number.parseFloat(form.latitude);
        const longitude = Number.parseFloat(form.longitude);
        const gpsRadius = Number.parseInt(form.gpsRadius, 10);
        if (!form.name.trim()) { toast.error('Give the store a name'); return; }
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) { toast.error('Set the store location'); return; }
        if (!Number.isFinite(gpsRadius) || gpsRadius < 20 || gpsRadius > 5000) { toast.error('Radius must be 20–5000 m'); return; }
        setSaving(true);
        try {
            await attendanceService.saveStore({
                id: editing === 'new' ? undefined : editing.id,
                name: form.name.trim(), latitude, longitude, gpsRadius,
                wifiRequired: form.wifiRequired, wifiSsid: form.wifiSsid.trim(),
            });
            toast.success(editing === 'new' ? 'Store added' : 'Store updated');
            close();
            await onChanged();
        } catch (e) {
            toast.error((e as Error).message || 'Failed to save store');
        } finally {
            setSaving(false);
        }
    };

    const remove = async () => {
        if (!deleteTarget) return;
        const target = deleteTarget;
        setDeleteTarget(null);
        try {
            await attendanceService.deleteStore(target.id);
            toast.success('Store deleted');
            if (editing !== 'new' && editing?.id === target.id) close();
            await onChanged();
        } catch (e) {
            toast.error((e as Error).message || 'Failed to delete store');
        }
    };

    const assigned = (id: string) => team.filter(u => u.storeId === id);
    const unassignedCount = team.filter(u => !u.storeId).length;

    return (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start">
            {/* Store list */}
            <section className="space-y-3">
                <div className="flex items-center justify-between px-1">
                    <h3 className="neu-label !mb-0">{stores.length} {stores.length === 1 ? 'store' : 'stores'}</h3>
                    {editing === null && (
                        <button type="button" onClick={openAdd} className="neu-raised-sm neu-btn rounded-full px-3.5 py-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--neu-gold)] active-scale">
                            <Plus size={13} /> Add store
                        </button>
                    )}
                </div>

                {stores.length === 0 && (
                    <p className="neu-card text-xs text-[var(--neu-text-dim)] text-center py-8 px-6">No stores yet. Add one so people can check in.</p>
                )}

                {stores.map(s => {
                    const people = assigned(s.id);
                    return (
                        <div key={s.id} className="neu-card p-4">
                            <div className="flex items-start gap-3">
                                <span className="w-10 h-10 rounded-full neu-inset flex items-center justify-center shrink-0 text-[var(--neu-gold)]">
                                    <StoreIcon size={16} />
                                </span>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium text-[var(--neu-text)] truncate">{s.name}</p>
                                    <p className="text-[11px] text-[var(--neu-text-dim)]">
                                        Check-in zone {s.gpsRadius} m ·{' '}
                                        <a href={`https://maps.google.com/?q=${s.latitude},${s.longitude}`} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted hover:text-[var(--neu-gold)]">
                                            Open in Maps
                                        </a>
                                    </p>
                                </div>
                                <button type="button" onClick={() => openEdit(s)} aria-label={`Edit ${s.name}`} className="neu-icon-btn neu-btn active-scale"><Pencil size={14} /></button>
                                <button type="button" onClick={() => setDeleteTarget(s)} aria-label={`Delete ${s.name}`} className="neu-icon-btn neu-btn active-scale text-red-600 dark:text-red-400"><Trash2 size={14} /></button>
                            </div>
                            <p className="mt-3 text-[11px] text-[var(--neu-text-dim)] flex items-start gap-1.5">
                                <Users size={12} className="shrink-0 mt-px" />
                                {people.length ? people.map(u => u.name).join(', ') : 'No one assigned — anyone can check in here'}
                            </p>
                            {s.wifiRequired && (
                                <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-400 flex items-start gap-1.5">
                                    <TriangleAlert size={12} className="shrink-0 mt-px" />
                                    "Require Wi-Fi" is on — nobody can check in here until it's turned off.
                                </p>
                            )}
                        </div>
                    );
                })}

                {team.length > 0 && (
                    <p className="text-[11px] text-[var(--neu-text-dim)] px-1 leading-relaxed">
                        {unassignedCount === team.length
                            ? 'Nobody is assigned to a store yet, so anyone can check in at any store. '
                            : `${unassignedCount} of ${team.length} people can check in at any store. `}
                        Assign people in Admin → Users → edit a person → Attendance store.
                    </p>
                )}
            </section>

            {/* Add / edit */}
            {editing !== null && (
                <section className="neu-card p-4 space-y-4 lg:sticky lg:top-0">
                    <h3 className="neu-label !mb-0">{editing === 'new' ? 'New store' : `Edit ${editing.name}`}</h3>
                    <div>
                        <label htmlFor="store-name" className="neu-label">Name</label>
                        <input id="store-name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Vayu Flagship Store" className="neu-field" />
                    </div>

                    <div>
                        <p className="neu-label">Location</p>
                        <button type="button" onClick={() => { void useMyLocation(); }} disabled={locating} className="neu-button w-full mb-2.5">
                            {locating ? <Loader2 size={14} className="animate-spin" /> : <Crosshair size={14} />}
                            Use my current location
                        </button>
                        <div className="grid grid-cols-2 gap-2">
                            <input value={form.latitude} onChange={e => setForm(f => ({ ...f, latitude: e.target.value }))} placeholder="Latitude" aria-label="Latitude" inputMode="decimal" className="neu-field" />
                            <input value={form.longitude} onChange={e => setForm(f => ({ ...f, longitude: e.target.value }))} placeholder="Longitude" aria-label="Longitude" inputMode="decimal" className="neu-field" />
                        </div>
                        <p className="text-[11px] text-[var(--neu-text-dim)] mt-1.5 flex items-center gap-1">
                            <MapPin size={11} /> Stand inside the store and tap the button, or paste coordinates from Google Maps.
                        </p>
                    </div>

                    <div>
                        <label htmlFor="store-radius" className="neu-label">Check-in zone (meters)</label>
                        <input id="store-radius" value={form.gpsRadius} onChange={e => setForm(f => ({ ...f, gpsRadius: e.target.value }))} inputMode="numeric" className="neu-field" />
                        <p className="text-[11px] text-[var(--neu-text-dim)] mt-1.5">How far from the location people can be. 100–200 m works for most shops; phones are rarely more precise than ±30 m indoors.</p>
                    </div>

                    <div className="neu-inset rounded-2xl p-3 space-y-2">
                        <label className="flex items-center justify-between gap-3 cursor-pointer text-xs font-medium text-[var(--neu-text)]">
                            Require store Wi-Fi
                            <button type="button" role="switch" aria-checked={form.wifiRequired} onClick={() => setForm(f => ({ ...f, wifiRequired: !f.wifiRequired }))} className="neu-toggle" data-on={form.wifiRequired}>
                                <span className="neu-toggle-knob" />
                            </button>
                        </label>
                        <p className="text-[11px] text-amber-700 dark:text-amber-400 leading-relaxed">
                            Leave this off. Web browsers can't read the Wi-Fi network name, so with it on every check-in here is refused. The GPS zone is what's checked.
                        </p>
                        {form.wifiRequired && (
                            <input value={form.wifiSsid} onChange={e => setForm(f => ({ ...f, wifiSsid: e.target.value }))} placeholder="Wi-Fi name (SSID)" aria-label="Wi-Fi name" autoComplete="off" spellCheck={false} className="neu-field" />
                        )}
                    </div>

                    <div className="flex gap-2">
                        <button type="button" onClick={() => { void save(); }} disabled={saving} className="neu-button neu-button-primary flex-1">
                            {saving && <Loader2 size={14} className="animate-spin" />}
                            {editing === 'new' ? 'Add store' : 'Save changes'}
                        </button>
                        {(stores.length > 0 || editing !== 'new') && (
                            <button type="button" onClick={close} disabled={saving} className="neu-button flex-1">Cancel</button>
                        )}
                    </div>
                </section>
            )}

            <TypeDeleteDialog
                isOpen={!!deleteTarget}
                title="Delete store"
                itemName={deleteTarget?.name || ''}
                message="attendance records are kept, but the store config is archived for admin review"
                onClose={() => setDeleteTarget(null)}
                onConfirm={() => { void remove(); }}
            />
        </div>
    );
};
