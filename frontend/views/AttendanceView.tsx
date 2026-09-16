import React, { useCallback, useEffect, useState } from 'react';
import { AuthUser } from '../services/authService';
import { AttendanceRecord, StoreConfig } from '../types';
import { attendanceService } from '../services/attendanceService';
import { FullScreenPortal } from '../components/FullScreenPortal';
import { TypeDeleteDialog } from '../components/TypeDeleteDialog';
import toast from 'react-hot-toast';
import {
    ArrowLeft, Clock, Loader2, MapPin, RefreshCw, Settings,
    CheckCircle2, Wifi, Store as StoreIcon, Plus, Pencil, Trash2, LogIn, LogOut, History, XCircle, Users as UsersIcon,
} from 'lucide-react';

interface AttendanceViewProps {
    authUser: AuthUser;
    isAdmin: boolean;
    onBack: () => void;
}

interface GpsFix {
    lat: number;
    lng: number;
    accuracy: number;
}

const fmtTime = (ms: number | null): string =>
    ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';

const fmtDate = (ms: number | null): string =>
    ms ? new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '—';

/**
 * Browsers expose limited network info. Best effort: Network Information API
 * when available, otherwise 'unknown'. Wi-Fi enforcement relies on the SSID
 * check performed by the server.
 */
function detectConnectionType(): 'wifi' | 'mobile' | 'unknown' {
    const conn = (navigator as unknown as { connection?: { type?: string } }).connection;
    if (conn?.type === 'wifi') return 'wifi';
    if (conn?.type === 'cellular') return 'mobile';
    return 'unknown';
}

function getPosition(): Promise<GpsFix> {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            reject(new Error('GPS is not available on this device'));
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (pos) => resolve({
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
                accuracy: pos.coords.accuracy,
            }),
            (err) => reject(new Error(
                err.code === err.PERMISSION_DENIED
                    ? 'Location permission denied — allow location access to check in'
                    : 'Could not get your location — try again near a window or open area'
            )),
            { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
        );
    });
}

const inputCls = 'w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2.5 px-3.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors';
const labelCls = 'block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wider';

export const AttendanceView: React.FC<AttendanceViewProps> = ({ authUser, isAdmin, onBack }) => {
    const [stores, setStores] = useState<StoreConfig[]>([]);
    const [openRecord, setOpenRecord] = useState<AttendanceRecord | null>(null);
    const [recent, setRecent] = useState<AttendanceRecord[]>([]);
    const [allRecords, setAllRecords] = useState<AttendanceRecord[]>([]);
    const [assignedStoreId, setAssignedStoreId] = useState<string | null>(null);
    const [selectedStoreId, setSelectedStoreId] = useState('');
    const [gps, setGps] = useState<GpsFix | null>(null);
    const [locating, setLocating] = useState(false);
    const [wifiSsid, setWifiSsid] = useState('');
    const [actionError, setActionError] = useState('');
    const [isWorking, setIsWorking] = useState(false);
    const [showManage, setShowManage] = useState(false);
    const [isLoading, setIsLoading] = useState(true);

    const selectedStore = stores.find(s => s.id === selectedStoreId) || null;

    const load = useCallback(async () => {
        setIsLoading(true);
        try {
            const [storeList, me] = await Promise.all([
                attendanceService.getStores(),
                attendanceService.getMe(),
            ]);
            setStores(storeList);
            setOpenRecord(me.open);
            setRecent(me.recent);
            setAssignedStoreId(me.assignedStoreId);
            setSelectedStoreId(prev => prev || me.assignedStoreId || me.open?.storeId || storeList[0]?.id || '');
            if (isAdmin) {
                try { setAllRecords(await attendanceService.getRecords()); } catch { /* non-fatal */ }
            }
        } catch (e) {
            toast.error((e as Error).message || 'Failed to load attendance');
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => { void load(); }, [load]);

    const refreshGps = useCallback(async () => {
        setLocating(true);
        setActionError('');
        try {
            setGps(await getPosition());
        } catch (e) {
            setActionError((e as Error).message);
        } finally {
            setLocating(false);
        }
    }, []);

    const doAction = useCallback(async (kind: 'check-in' | 'check-out') => {
        if (!selectedStore) { toast.error('Select a store first'); return; }
        setActionError('');
        let fix = gps;
        if (!fix) {
            setLocating(true);
            try {
                fix = await getPosition();
                setGps(fix);
            } catch (e) {
                setLocating(false);
                setActionError((e as Error).message);
                return;
            }
            setLocating(false);
        }
        setIsWorking(true);
        try {
            const payload = {
                storeId: selectedStore.id, lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy,
                connectionType: detectConnectionType(), wifiSsid: wifiSsid || undefined,
            };
            const res = kind === 'check-in'
                ? await attendanceService.checkIn(payload)
                : await attendanceService.checkOut(payload);
            toast.success(res.message);
            setOpenRecord(res.record);
            await load();
        } catch (e) {
            const message = (e as Error).message || 'Something went wrong';
            setActionError(message);
            toast.error(message);
        } finally {
            setIsWorking(false);
        }
    }, [selectedStore, gps, wifiSsid, load]);

    const fmtTime = (ms: number | null): string =>
        ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';

    const fmtDate = (ms: number | null): string =>
        ms ? new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '—';

    return (
        <div className="h-full flex flex-col bg-[#faf9f6] dark:bg-[#121212] transition-colors duration-500 animate-fade-in">
            {/* Header */}
            <div className="bg-white dark:bg-[#1a1a1a] px-[6px] pt-[calc(1.75rem+env(safe-area-inset-top,0px))] pb-[6px] shadow-sm z-10 border-b border-gray-100 dark:border-gray-800">
                <div className="flex items-center gap-[6px]">
                    <button
                        onClick={onBack}
                        className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale"
                        aria-label="Back to home"
                    >
                        <ArrowLeft size={20} />
                    </button>
                    <h1 className="flex-1 text-xl font-serif text-gray-900 dark:text-white truncate">Attendance</h1>
                    {isAdmin && (
                        <button
                            onClick={() => setShowManage(true)}
                            aria-label="Manage stores"
                            title="Manage stores"
                            className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale"
                        >
                            <Settings size={18} />
                        </button>
                    )}
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-[6px] space-y-2 no-scrollbar pb-20">
                {isLoading && (
                    <div className="py-12 flex justify-center">
                        <Loader2 size={22} className="animate-spin text-gold-500" />
                    </div>
                )}

                {!isLoading && (
                    <>
                        {/* Status / action card */}
                        <div className="bg-white dark:bg-[#1e1e1e] rounded-[6px] shadow-sm border border-gray-100 dark:border-gray-800 p-4 animate-fade-in-up">
                            <div className="flex items-center gap-2 mb-3">
                                <Clock size={16} className="text-gold-500" />
                                <h2 className="text-[10px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest flex-1">
                                    {openRecord ? 'You are checked in' : 'You are checked out'}
                                </h2>
                                {openRecord && (
                                    <span className="text-[9px] text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                                        since {fmtTime(openRecord.checkInAt)}
                                    </span>
                                )}
                            </div>

                            <div className="mb-3">
                                <label htmlFor="att-store" className={labelCls}>Store</label>
                                <select
                                    id="att-store"
                                    value={selectedStoreId}
                                    onChange={(e) => { setSelectedStoreId(e.target.value); setActionError(''); }}
                                    disabled={!!assignedStoreId || !!openRecord}
                                    className={`${inputCls} disabled:opacity-60`}
                                >
                                    <option value="">Select a store…</option>
                                    {stores.map(s => (
                                        <option key={s.id} value={s.id}>{s.name}</option>
                                    ))}
                                </select>
                                {assignedStoreId && (
                                    <p className="text-[9px] text-gray-400 dark:text-gray-500 mt-1">
                                        Your assigned store — managed by an admin.
                                    </p>
                                )}
                            </div>


                            {selectedStore?.wifiRequired && !openRecord && (
                                <div className="mb-3">
                                    <label htmlFor="att-wifi" className={labelCls}>
                                        <span className="inline-flex items-center gap-1"><Wifi size={10} /> Store Wi-Fi name (SSID)</span>
                                    </label>
                                    <input
                                        id="att-wifi"
                                        type="text"
                                        value={wifiSsid}
                                        onChange={(e) => setWifiSsid(e.target.value)}
                                        placeholder="e.g. Vayu-Store-5G"
                                        autoComplete="off"
                                        spellCheck={false}
                                        className={inputCls}
                                    />
                                    <p className="text-[9px] text-gray-400 dark:text-gray-500 mt-1">
                                        This store requires the approved Wi-Fi — type the network name exactly as shown on the router.
                                    </p>
                                </div>
                            )}

                            <div className="flex items-center justify-between gap-2 mb-3 bg-gray-50 dark:bg-[#191919] rounded-[6px] px-3 py-2">
                                <div className="min-w-0">
                                    <p className="text-[10px] font-medium text-gray-700 dark:text-gray-200 flex items-center gap-1.5">
                                        <MapPin size={11} className="text-gold-500 shrink-0" /> GPS fix
                                    </p>
                                    <p className="text-[9px] text-gray-400 dark:text-gray-500 mt-0.5">
                                        {gps
                                            ? `±${Math.round(gps.accuracy)}m accuracy · ${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)}`
                                            : 'Not captured yet'}
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => { void refreshGps(); }}
                                    disabled={locating}
                                    className="p-2 rounded-full bg-white dark:bg-[#2a2a2a] border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 transition-colors active-scale disabled:opacity-50 shrink-0"
                                    aria-label="Refresh GPS"
                                >
                                    {locating ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                                </button>
                            </div>


                            {actionError && (
                                <div className="flex items-start gap-2 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-900/40 rounded-[6px] px-3 py-2 mb-3 animate-fade-in">
                                    <XCircle size={14} className="text-red-500 shrink-0 mt-0.5" />
                                    <p className="text-xs text-red-600 dark:text-red-400">{actionError}</p>
                                </div>
                            )}

                            <button
                                type="button"
                                onClick={() => { void doAction(openRecord ? 'check-out' : 'check-in'); }}
                                disabled={isWorking || locating || !selectedStore}
                                className={`w-full rounded-[6px] py-3 text-sm font-medium tracking-wide transition-colors shadow-md active-scale flex items-center justify-center gap-2 text-white ${openRecord
                                    ? 'bg-red-500 hover:bg-red-600'
                                    : 'bg-green-600 hover:bg-green-700'
                                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                            >
                                {isWorking || locating ? <Loader2 size={16} className="animate-spin" /> : openRecord ? <LogOut size={16} /> : <LogIn size={16} />}
                                {isWorking ? 'Verifying…' : locating ? 'Getting GPS…' : openRecord ? 'Check Out' : 'Check In'}
                            </button>
                            {!selectedStore && stores.length === 0 && (
                                <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-2 text-center">
                                    No stores configured yet{isAdmin ? ' — tap the gear to add one' : ''}.
                                </p>
                            )}
                        </div>


                        {/* Recent records */}
                        <div className="bg-white dark:bg-[#1e1e1e] rounded-[6px] shadow-sm border border-gray-100 dark:border-gray-800 p-4 animate-fade-in-up" style={{ animationDelay: '80ms' }}>
                            <h2 className="text-[10px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest mb-3 flex items-center gap-2">
                                <History size={13} className="text-gold-500" /> Recent records
                            </h2>
                            {recent.length === 0 && (
                                <p className="text-[10px] text-gray-400 dark:text-gray-500 font-light">No attendance records yet.</p>
                            )}
                            <div className="space-y-2">
                                {recent.map(rec => {
                                    const store = stores.find(s => s.id === rec.storeId);
                                    return (
                                        <div key={rec.id} className="flex items-center gap-2.5 text-xs">
                                            <CheckCircle2 size={13} className={rec.status === 'checked-in' ? 'text-gold-500 shrink-0' : 'text-green-600 shrink-0'} />
                                            <div className="flex-1 min-w-0">
                                                <p className="text-gray-900 dark:text-gray-100 truncate">{store?.name || rec.storeId}</p>
                                                <p className="text-[9px] text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                                                    {fmtDate(rec.checkInAt)} · in {fmtTime(rec.checkInAt)} · out {fmtTime(rec.checkOutAt)}
                                                </p>
                                            </div>
                                            <span className={`text-[8px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded-full shrink-0 ${rec.status === 'checked-in'
                                                ? 'bg-gold-100 dark:bg-gold-900/30 text-gold-700 dark:text-gold-400'
                                                : 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400'}`}>
                                                {rec.status}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Admin: everyone's check-ins — employees only ever see their own (server-enforced) */}
                        {isAdmin && (
                            <div className="bg-white dark:bg-[#1e1e1e] rounded-[6px] shadow-sm border border-gray-100 dark:border-gray-800 p-4 animate-fade-in-up" style={{ animationDelay: '120ms' }}>
                                <h2 className="text-[10px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest mb-3 flex items-center gap-2">
                                    <UsersIcon size={13} className="text-gold-500" /> All employees
                                </h2>
                                {allRecords.length === 0 && (
                                    <p className="text-[10px] text-gray-400 dark:text-gray-500 font-light">No attendance records yet.</p>
                                )}
                                <div className="space-y-2">
                                    {allRecords.map(rec => (
                                        <div key={rec.id} className="flex items-center gap-2.5 text-xs">
                                            <div className="w-7 h-7 rounded-full bg-gray-100 dark:bg-[#2a2a2a] flex items-center justify-center shrink-0 text-[9px] font-bold text-gray-500 dark:text-gray-400">
                                                {(rec.employeeName || '?').trim().charAt(0).toUpperCase()}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className="text-gray-900 dark:text-gray-100 truncate">{rec.employeeName || rec.employeeId}</p>
                                                <p className="text-[9px] text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                                                    {fmtDate(rec.checkInAt)} · in {fmtTime(rec.checkInAt)} · out {fmtTime(rec.checkOutAt)}
                                                </p>
                                            </div>
                                            <span className={`text-[8px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded-full shrink-0 ${rec.status === 'checked-in'
                                                ? 'bg-gold-100 dark:bg-gold-900/30 text-gold-700 dark:text-gold-400'
                                                : 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400'}`}>
                                                {rec.status}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* Admin store manager */}
            {showManage && (
                <StoreManager
                    stores={stores}
                    onChanged={async () => { await load(); }}
                    onClose={() => setShowManage(false)}
                />
            )}
        </div>
    );
};

interface StoreManagerProps {
    stores: StoreConfig[];
    onChanged: () => Promise<void>;
    onClose: () => void;
}

const EMPTY_STORE_FORM = { name: '', latitude: '', longitude: '', gpsRadius: '150', wifiRequired: false, wifiSsid: '' };

/** Admin-only store geofence + Wi-Fi configuration. */
const StoreManager: React.FC<StoreManagerProps> = ({ stores, onChanged, onClose }) => {
    const [editing, setEditing] = useState<StoreConfig | null>(null);
    const [form, setForm] = useState({ ...EMPTY_STORE_FORM });
    const [isSaving, setIsSaving] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<StoreConfig | null>(null);

    const openEdit = (store: StoreConfig) => {
        setEditing(store);
        setForm({
            name: store.name,
            latitude: String(store.latitude),
            longitude: String(store.longitude),
            gpsRadius: String(store.gpsRadius),
            wifiRequired: store.wifiRequired,
            wifiSsid: store.wifiSsid,
        });
    };

    const startAdd = () => {
        setEditing(null);
        setForm({ ...EMPTY_STORE_FORM });
    };

    const handleSave = async () => {
        if (isSaving) return;
        setIsSaving(true);
        try {
            await attendanceService.saveStore({
                id: editing?.id,
                name: form.name.trim(),
                latitude: Number.parseFloat(form.latitude),
                longitude: Number.parseFloat(form.longitude),
                gpsRadius: Number.parseInt(form.gpsRadius, 10),
                wifiRequired: form.wifiRequired,
                wifiSsid: form.wifiSsid.trim(),
            });
            toast.success(editing ? 'Store updated' : 'Store added');
            setEditing(null);
            setForm({ ...EMPTY_STORE_FORM });
            await onChanged();
        } catch (e) {
            toast.error((e as Error).message || 'Failed to save store');
        } finally {
            setIsSaving(false);
        }
    };

    const handleDelete = async () => {
        if (!deleteTarget) return;
        const target = deleteTarget;
        setDeleteTarget(null);
        try {
            await attendanceService.deleteStore(target.id);
            toast.success('Store deleted');
            if (editing?.id === target.id) { setEditing(null); setForm({ ...EMPTY_STORE_FORM }); }
            await onChanged();
        } catch (e) {
            toast.error((e as Error).message || 'Failed to delete store');
        }
    };

    return (
        <FullScreenPortal>
            <div className="absolute inset-0 bg-[#faf9f6] dark:bg-[#121212] z-50 flex flex-col animate-fade-in-up">
                <div className="bg-white dark:bg-[#1a1a1a] flex justify-between items-center p-[6px] border-b border-gray-100 dark:border-gray-800 pt-[calc(1.75rem+env(safe-area-inset-top,0px))] shadow-sm z-10">
                    <button
                        onClick={onClose}
                        className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale"
                        aria-label="Close store manager"
                    >
                        <ArrowLeft size={20} />
                    </button>
                    <h2 className="flex items-center gap-1.5 text-base font-serif text-gray-900 dark:text-white">
                        <StoreIcon size={16} className="text-gold-500" /> Stores
                    </h2>
                    <button
                        onClick={startAdd}
                        aria-label="Add store"
                        className="bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 p-1.5 rounded-full shadow-md transition-colors active-scale mr-1"
                    >
                        <Plus size={18} />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-[6px] space-y-2 no-scrollbar">
                    {/* Add / edit form */}
                    <div className="bg-white dark:bg-[#1e1e1e] rounded-[6px] shadow-sm border border-gray-100 dark:border-gray-800 p-4 space-y-4 animate-fade-in-up">
                        <h3 className="text-[10px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest flex items-center gap-2">
                            <Pencil size={12} className="text-gold-500" />
                            {editing ? `Edit "${editing.name}"` : 'Add a store'}
                        </h3>
                        <div>
                            <label htmlFor="store-name" className={labelCls}>Store name *</label>
                            <input id="store-name" value={form.name} onChange={(e) => setForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Vayu Flagship Store" className={inputCls} />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label htmlFor="store-lat" className={labelCls}>Latitude *</label>
                                <input id="store-lat" value={form.latitude} onChange={(e) => setForm(p => ({ ...p, latitude: e.target.value }))} placeholder="19.0760" inputMode="decimal" className={inputCls} />
                            </div>
                            <div>
                                <label htmlFor="store-lng" className={labelCls}>Longitude *</label>
                                <input id="store-lng" value={form.longitude} onChange={(e) => setForm(p => ({ ...p, longitude: e.target.value }))} placeholder="72.8777" inputMode="decimal" className={inputCls} />
                            </div>
                        </div>
                        <div>
                            <label htmlFor="store-radius" className={labelCls}>GPS radius (meters, 20–5000)</label>
                            <input id="store-radius" value={form.gpsRadius} onChange={(e) => setForm(p => ({ ...p, gpsRadius: e.target.value }))} inputMode="numeric" className={inputCls} />
                        </div>
                        <label className="flex items-center justify-between gap-3 bg-gray-50 dark:bg-[#191919] rounded-[6px] px-3 py-2.5 cursor-pointer">
                            <span className="flex items-center gap-2 text-xs font-medium text-gray-700 dark:text-gray-200">
                                <Wifi size={13} className={form.wifiRequired ? 'text-green-600' : 'text-gray-400'} />
                                Require Store Wi-Fi
                            </span>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={form.wifiRequired}
                                onClick={() => setForm(p => ({ ...p, wifiRequired: !p.wifiRequired }))}
                                className={`w-11 h-6 rounded-full relative transition-colors ${form.wifiRequired ? 'bg-green-600' : 'bg-gray-300 dark:bg-gray-700'}`}
                            >
                                <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${form.wifiRequired ? 'left-[22px]' : 'left-0.5'}`} />
                            </button>
                        </label>
                        {form.wifiRequired && (
                            <div>
                                <label htmlFor="store-ssid" className={labelCls}>Approved Wi-Fi name (SSID) *</label>
                                <input id="store-ssid" value={form.wifiSsid} onChange={(e) => setForm(p => ({ ...p, wifiSsid: e.target.value }))} placeholder="e.g. Vayu-Store-5G" autoComplete="off" spellCheck={false} className={inputCls} />
                            </div>
                        )}
                        <button
                            type="button"
                            onClick={() => { void handleSave(); }}
                            disabled={isSaving}
                            className="w-full rounded-[6px] py-3 text-sm font-medium tracking-wide bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 hover:bg-brand-800 dark:hover:bg-gold-400 transition-colors shadow-md active-scale flex items-center justify-center gap-2 disabled:opacity-50"
                        >
                            {isSaving && <Loader2 size={14} className="animate-spin" />}
                            {editing ? 'Save Changes' : 'Add Store'}
                        </button>
                    </div>


                    {/* Store list */}
                    {stores.map(store => (
                        <div key={store.id} className="bg-white dark:bg-[#1e1e1e] rounded-[6px] shadow-sm border border-gray-100 dark:border-gray-800 p-[6px] flex items-center gap-2.5 animate-fade-in-up">
                            <div className="w-9 h-9 rounded-full bg-gray-100 dark:bg-[#2a2a2a] flex items-center justify-center shrink-0">
                                <StoreIcon size={15} className="text-gray-500 dark:text-gray-400" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-xs text-gray-900 dark:text-gray-100 font-medium truncate">{store.name}</p>
                                <p className="text-[9px] text-gray-400 dark:text-gray-500 uppercase tracking-wider mt-0.5 flex items-center gap-1.5">
                                    <span>{store.gpsRadius}m radius</span>
                                    {store.wifiRequired && (
                                        <span className="inline-flex items-center gap-0.5 text-green-600 dark:text-green-400">
                                            <Wifi size={8} /> Wi-Fi: {store.wifiSsid || 'not set'}
                                        </span>
                                    )}
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => openEdit(store)}
                                aria-label={`Edit ${store.name}`}
                                className="p-1.5 text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale shrink-0"
                            >
                                <Pencil size={14} />
                            </button>
                            <button
                                type="button"
                                onClick={() => setDeleteTarget(store)}
                                aria-label={`Delete ${store.name}`}
                                className="p-1.5 text-gray-300 dark:text-gray-600 hover:text-red-500 rounded-full transition-colors active-scale shrink-0"
                            >
                                <Trash2 size={14} />
                            </button>
                        </div>
                    ))}
                </div>

                <TypeDeleteDialog
                    isOpen={!!deleteTarget}
                    title="Delete store"
                    itemName={deleteTarget?.name || ''}
                    message="attendance records are kept, but the store config is archived for admin review"
                    onClose={() => setDeleteTarget(null)}
                    onConfirm={() => { void handleDelete(); }}
                />
            </div>
        </FullScreenPortal>
    );
};
