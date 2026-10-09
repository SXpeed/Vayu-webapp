import React, { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { ChevronLeft, ChevronRight, Clock, Loader2, LogIn, LogOut, MapPin, RefreshCw, TriangleAlert, XCircle } from 'lucide-react';
import { AttendanceRecord, StoreConfig } from '../../types';
import { attendanceService } from '../../services/attendanceService';
import {
    FLAG_META, GpsFix, MAX_GPS_ACCURACY, MONTHS, WEEKDAYS, detectConnectionType, fmtDay, fmtDistance, fmtDuration, fmtWorked,
    fmtTime, getPosition, haversineMeters, locationAlreadyGranted, monthGrid, monthRange, recordFlags, startOfDay,
    storeName, workedMs,
} from './attendanceUtils';

interface MyAttendanceProps {
    userId: string;
    stores: StoreConfig[];
    openRecord: AttendanceRecord | null;
    assignedStoreId: string | null;
    canManage: boolean;
    /** Reload the shared attendance state after a check-in/out. */
    onChanged: () => Promise<void>;
}

/** The location pin's colour: inside the store's radius, outside it, or not known yet. */
function insideClass(inside: boolean | null | undefined): string {
    if (inside) return 'text-emerald-600 dark:text-emerald-400';
    return inside === false ? 'text-red-600 dark:text-red-400' : 'text-[var(--neu-text-dim)]';
}

function checkLabel(working: boolean, locating: boolean, checkedIn: boolean): string {
    if (working) return 'Verifying…';
    if (locating) return 'Getting location…';
    return checkedIn ? 'Check out' : 'Check in';
}

/** A day in the month strip: chosen, worked, or neither. */
function dayClass(selected: boolean, worked: boolean): string {
    if (selected) return 'neu-inset text-[var(--neu-gold)] font-bold';
    return worked ? 'bg-gold-500/15 text-gold-700 dark:text-gold-300 font-semibold' : 'text-[var(--neu-text-dim)]';
}
/** The clock while checked in, ticking every 30 seconds for the live timer. */
function useClock(running: boolean): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!running) return;
        const t = setInterval(() => setNow(Date.now()), 30_000);
        return () => clearInterval(t);
    }, [running]);
    return now;
}

/** Checked in or not, the time so far, and a warning for a check-in left open from an earlier day. */
const OpenStatus: React.FC<{ openRecord: AttendanceRecord | null; stores: StoreConfig[]; now: number }> = ({ openRecord, stores, now }) => {
    const staleOpen = !!openRecord?.checkInAt && startOfDay(openRecord.checkInAt) < startOfDay(now);
    return (
        <>
            <div className="flex items-center justify-between gap-3">
                <h3 className="neu-label !mb-0">Today</h3>
                <span className={`neu-status px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${openRecord ? 'text-emerald-700 dark:text-emerald-400' : 'text-[var(--neu-text-dim)]'}`}>
                    <span className="w-1.5 h-1.5 rounded-full bg-current" />
                    {openRecord ? 'Checked in' : 'Not checked in'}
                </span>
            </div>

            {openRecord?.checkInAt ? (
                <div className="neu-inset rounded-2xl px-4 py-3.5">
                    <p className="text-3xl font-semibold tabular-nums text-[var(--neu-text)]">{fmtWorked(openRecord, now)}</p>
                    <p className="text-xs text-[var(--neu-text-dim)] mt-0.5">
                        since {fmtTime(openRecord.checkInAt)}{staleOpen ? ` on ${fmtDay(openRecord.checkInAt)}` : ''} · {storeName(stores, openRecord.storeId)}
                    </p>
                </div>
            ) : null}

            {staleOpen && (
                <p className="neu-inset rounded-2xl px-3.5 py-3 text-xs text-red-600 dark:text-red-400 flex gap-2">
                    <TriangleAlert size={14} className="shrink-0 mt-0.5" />
                    <span>You're still checked in from {fmtDay(openRecord!.checkInAt!)}. Check out at {storeName(stores, openRecord!.storeId)}, or ask an admin to close it for you.</span>
                </p>
            )}
        </>
    );
};

/** How far you are from the store, whether that is inside its zone, and how precise the fix is. */
const LocationRow: React.FC<{ store: StoreConfig; distance: number | null; inside: boolean | null; accuracy: number; gpsTooRough: boolean; locating: boolean; onLocate: () => void }> = ({ store, distance, inside, accuracy, gpsTooRough, locating, onLocate }) => (
    <div className="flex items-center gap-3">
        <span className={`w-9 h-9 rounded-full neu-inset flex items-center justify-center shrink-0 ${insideClass(inside)}`}>
            <MapPin size={15} />
        </span>
        <p className="flex-1 min-w-0 text-xs leading-snug">
            {distance === null ? (
                <span className="text-[var(--neu-text-dim)]">Location not checked yet</span>
            ) : (
                <>
                    <span className={`font-semibold ${inside ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                        {fmtDistance(distance)} away · {inside ? 'inside' : 'outside'} the {store.gpsRadius} m zone
                    </span>
                    <span className="block text-[11px] text-[var(--neu-text-dim)]">
                        GPS accuracy ±{Math.round(accuracy)} m{gpsTooRough ? ' — too rough, move near a window' : ''}
                    </span>
                </>
            )}
        </p>
        <button type="button" onClick={onLocate} disabled={locating} aria-label="Check my location" className="neu-icon-btn neu-btn active-scale">
            <RefreshCw size={14} className={locating ? 'animate-spin' : ''} />
        </button>
    </div>
);

/** Check in or out at a store: a fresh GPS fix each time, checked by the server against the store's zone. */
const CheckInCard: React.FC<{ stores: StoreConfig[]; openRecord: AttendanceRecord | null; assignedStoreId: string | null; canManage: boolean; now: number; onChecked: () => Promise<void> }> = ({ stores, openRecord, assignedStoreId, canManage, now, onChecked }) => {
    const [selectedStoreId, setSelectedStoreId] = useState('');
    const [gps, setGps] = useState<GpsFix | null>(null);
    const [locating, setLocating] = useState(false);
    const [working, setWorking] = useState(false);
    const [error, setError] = useState('');

    // Checked in: you must check out at the same store. Assigned: only that
    // store is allowed. Otherwise the employee picks.
    const lockedStoreId = openRecord?.storeId || assignedStoreId || '';
    const storeId = lockedStoreId || selectedStoreId || stores[0]?.id || '';
    const store = stores.find(s => s.id === storeId) || null;

    const locate = useCallback(async () => {
        setLocating(true);
        setError('');
        try {
            const fix = await getPosition();
            setGps(fix);
            return fix;
        } catch (e) {
            setError((e as Error).message);
            return null;
        } finally {
            setLocating(false);
        }
    }, []);

    // Show the distance straight away if location is already allowed — never
    // pop a permission prompt just for opening the page.
    useEffect(() => {
        let cancelled = false;
        void locationAlreadyGranted().then(granted => { if (granted && !cancelled) void locate(); });
        return () => { cancelled = true; };
    }, [locate]);

    const distance = gps && store ? haversineMeters(gps.lat, gps.lng, store.latitude, store.longitude) : null;
    const inside = distance !== null && store ? distance <= store.gpsRadius : null;
    const gpsTooRough = gps ? gps.accuracy > MAX_GPS_ACCURACY : false;

    const act = async () => {
        if (!store) { toast.error('No store to check in at'); return; }
        setError('');
        // Always take a fresh fix for the actual check-in/out.
        const fix = await locate();
        if (!fix) return;
        setWorking(true);
        try {
            const payload = {
                storeId: store.id, lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy,
                connectionType: detectConnectionType(),
            };
            const res = openRecord ? await attendanceService.checkOut(payload) : await attendanceService.checkIn(payload);
            toast.success(res.message);
            await onChecked();
        } catch (e) {
            const message = (e as Error).message || 'Something went wrong';
            setError(message);
            toast.error(message);
        } finally {
            setWorking(false);
        }
    };

    return (
        <section className="neu-card p-4 lg:p-5 space-y-4">
            <OpenStatus openRecord={openRecord} stores={stores} now={now} />

            {/* Store */}
            <div>
                <label htmlFor="att-store" className="neu-label">Store</label>
                {lockedStoreId || stores.length <= 1 ? (
                    <p className="neu-value">
                        {stores.length === 0 ? 'No stores set up yet' : storeName(stores, storeId)}
                        {!openRecord && assignedStoreId && <span className="text-[11px] text-[var(--neu-text-dim)]"> · your assigned store</span>}
                    </p>
                ) : (
                    <select id="att-store" value={storeId} onChange={e => setSelectedStoreId(e.target.value)} className="neu-field">
                        {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                )}
            </div>

            {store && <LocationRow store={store} distance={distance} inside={inside} accuracy={gps?.accuracy ?? 0} gpsTooRough={gpsTooRough} locating={locating} onLocate={() => { void locate(); }} />}


            {store?.wifiRequired && (
                <p className="neu-inset rounded-2xl px-3.5 py-3 text-xs text-amber-700 dark:text-amber-400 flex gap-2">
                    <TriangleAlert size={14} className="shrink-0 mt-0.5" />
                    <span>This store has "Require Wi-Fi" switched on. Browsers can't read Wi-Fi names, so check-ins here will be refused. {canManage ? 'Turn it off in the Stores tab.' : 'Ask an admin to turn it off.'}</span>
                </p>
            )}

            {error && (
                <p className="text-xs text-red-600 dark:text-red-400 flex items-start gap-1.5">
                    <XCircle size={13} className="mt-0.5 shrink-0" /> {error}
                </p>
            )}

            <button
                type="button"
                disabled={!store || working || locating}
                onClick={() => { void act(); }}
                className={`w-full rounded-2xl py-3.5 text-sm font-bold uppercase tracking-widest flex items-center justify-center gap-2 active-scale disabled:opacity-50 ${openRecord
                    ? 'neu-raised-sm neu-btn text-red-600 dark:text-red-400'
                    : 'neu-accent'}`}
            >
                {(working || locating) && <Loader2 size={17} className="animate-spin" />}
                {!working && !locating && (openRecord ? <LogOut size={17} /> : <LogIn size={17} />)}
                {checkLabel(working, locating, !!openRecord)}
            </button>
            {stores.length === 0 && (
                <p className="text-[11px] text-[var(--neu-text-dim)] text-center">
                    {canManage ? 'Add a store in the Stores tab first.' : 'Ask an admin to set up your store.'}
                </p>
            )}
        </section>
    );
};

/** A month of your check-ins as a calendar: gold = worked. Tap a day to see just that day. */
const MonthCalendar: React.FC<{ year: number; month: number; byDay: Map<number, AttendanceRecord[]>; selectedDay: number | null; isCurrentMonth: boolean; onSelect: (day: number | null) => void }> = ({ year, month, byDay, selectedDay, isCurrentMonth, onSelect }) => {
    const todayDate = new Date();
    return (
        <div className="grid grid-cols-7 gap-1 mb-4">
            {WEEKDAYS.map(d => <div key={d} className="text-center text-[10px] font-semibold text-[var(--neu-text-dim)] py-0.5">{d}</div>)}
            {monthGrid(year, month).map((day, i) => {
                if (!day) return <div key={`pad-${i}`} />; // NOSONAR: blank cells before the 1st; only their position tells them apart
                const worked = byDay.has(day);
                const isToday = isCurrentMonth && day === todayDate.getDate();
                const isSel = selectedDay === day;
                return (
                    <button
                        key={day}
                        type="button"
                        disabled={!worked}
                        onClick={() => onSelect(isSel ? null : day)}
                        aria-pressed={isSel}
                        aria-label={`${day} ${MONTHS[month]}${worked ? ', worked' : ''}`}
                        className={`aspect-square rounded-xl text-xs flex items-center justify-center transition-colors ${dayClass(isSel, !!worked)} ${isToday && !isSel ? 'ring-1 ring-gold-500/70' : ''}`}
                    >
                        {day}
                    </button>
                );
            })}
        </div>
    );
};

/** The check-ins shown (a day's, or the month's), each with its hours and any flag. */
const RecordList: React.FC<{ loading: boolean; shown: AttendanceRecord[]; selectedDay: number | null; stores: StoreConfig[]; now: number }> = ({ loading: loadingMonth, shown, selectedDay, stores, now }) => (
    <>
        {loadingMonth && (
            <div className="py-8 flex justify-center"><Loader2 size={18} className="animate-spin text-gold-500" /></div>
        )}
        {!loadingMonth && shown.length === 0 && (
            <p className="text-xs text-[var(--neu-text-dim)] px-1 py-4">No check-ins {selectedDay ? 'that day' : 'this month'}.</p>
        )}
        {!loadingMonth && shown.length > 0 && (
            <div>
                {shown.map((r, i) => {
                    const flag = recordFlags(r, now)[0];
                    return (
                        <React.Fragment key={r.id}>
                            {i > 0 && <div className="neu-divider mx-1" />}
                            <div className="flex items-center gap-3 px-1 py-2.5">
                                <div className="flex-1 min-w-0">
                                    <p className="text-[13px] font-medium text-[var(--neu-text)]">{fmtDay(r.checkInAt as number)}</p>
                                    <p className="text-[11px] text-[var(--neu-text-dim)] truncate flex items-center gap-1">
                                        <Clock size={10} className="shrink-0" />
                                        {fmtTime(r.checkInAt)} – {r.checkOutAt ? fmtTime(r.checkOutAt) : 'now'} · {storeName(stores, r.storeId)}
                                    </p>
                                </div>
                                <div className="text-right shrink-0">
                                    <p className="text-[13px] font-semibold tabular-nums text-[var(--neu-text)]">{fmtWorked(r, now)}</p>
                                    {flag && <p className={`text-[10px] font-semibold ${FLAG_META[flag].cls}`}>{FLAG_META[flag].label}</p>}
                                </div>
                            </div>
                        </React.Fragment>
                    );
                })}
            </div>
        )}
    </>
);

/** Your month: totals, the calendar, and the check-ins. Reloads when `version` changes (after a check-in/out). */
const MonthHistory: React.FC<{ userId: string; stores: StoreConfig[]; now: number; version: number }> = ({ userId, stores, now, version }) => {
    const [year, setYear] = useState(() => new Date().getFullYear());
    const [month, setMonth] = useState(() => new Date().getMonth());
    const [records, setRecords] = useState<AttendanceRecord[]>([]);
    const [loadingMonth, setLoadingMonth] = useState(true);
    const [selectedDay, setSelectedDay] = useState<number | null>(null);

    const loadMonth = useCallback(async () => {
        setLoadingMonth(true);
        const { from, to } = monthRange(year, month);
        try {
            const all = await attendanceService.getRecords({ employeeId: userId, from, to });
            // Admins get everyone's records from this endpoint; keep only mine,
            // and only this month (older servers ignore the range).
            setRecords(all.filter(r => r.employeeId === userId && r.checkInAt && r.checkInAt >= from && r.checkInAt < to));
        } catch (e) {
            toast.error((e as Error).message || 'Failed to load your attendance');
        } finally {
            setLoadingMonth(false);
        }
    }, [userId, year, month]);

    useEffect(() => { void loadMonth(); }, [loadMonth, version]);
    useEffect(() => { setSelectedDay(null); }, [year, month]);

    const shiftMonth = (dir: number) => {
        const d = new Date(year, month + dir, 1);
        setYear(d.getFullYear());
        setMonth(d.getMonth());
    };
    const isCurrentMonth = year === new Date().getFullYear() && month === new Date().getMonth();

    const byDay = useMemo(() => {
        const map = new Map<number, AttendanceRecord[]>();
        for (const r of records) {
            const day = new Date(r.checkInAt as number).getDate();
            map.set(day, [...(map.get(day) || []), r]);
        }
        return map;
    }, [records]);

    const totals = useMemo(() => {
        const worked = records.reduce((sum, r) => sum + workedMs(r, now), 0);
        return { days: byDay.size, worked, avg: byDay.size ? worked / byDay.size : 0 };
    }, [records, byDay, now]);

    const shown = selectedDay ? byDay.get(selectedDay) || [] : records;
    const onSelect = setSelectedDay;

    return (
        <section className="neu-card p-4 lg:p-5">
            <div className="flex items-center justify-between gap-2 mb-4">
                <button type="button" onClick={() => shiftMonth(-1)} aria-label="Previous month" className="neu-icon-btn neu-btn active-scale">
                    <ChevronLeft size={16} />
                </button>
                <p className="font-serif text-lg text-[var(--neu-text)]">{MONTHS[month]} {year}</p>
                <button type="button" onClick={() => shiftMonth(1)} disabled={isCurrentMonth} aria-label="Next month" className="neu-icon-btn neu-btn active-scale disabled:opacity-30">
                    <ChevronRight size={16} />
                </button>
            </div>

            <div className="grid grid-cols-3 gap-2.5 mb-4">
                {[
                    { label: 'Days worked', value: String(totals.days) },
                    { label: 'Total hours', value: fmtDuration(totals.worked) },
                    { label: 'Avg per day', value: totals.days ? fmtDuration(totals.avg) : '—' },
                ].map(t => (
                    <div key={t.label} className="neu-inset rounded-2xl px-2 py-2.5 text-center">
                        <p className="text-sm font-semibold tabular-nums text-[var(--neu-text)]">{t.value}</p>
                        <p className="text-[9.5px] uppercase tracking-wider text-[var(--neu-text-dim)] mt-0.5">{t.label}</p>
                    </div>
                ))}
            </div>

            <MonthCalendar year={year} month={month} byDay={byDay} selectedDay={selectedDay} isCurrentMonth={isCurrentMonth} onSelect={setSelectedDay} />

            <div className="flex items-center justify-between mb-1.5 px-1">
                <p className="neu-label !mb-0">{selectedDay ? fmtDay(new Date(year, month, selectedDay).getTime()) : 'All this month'}</p>
                {selectedDay !== null && (
                    <button type="button" onClick={() => onSelect(null)} className="text-[11px] font-semibold text-[var(--neu-gold)]">Show all</button>
                )}
            </div>
            <RecordList loading={loadingMonth} shown={shown} selectedDay={selectedDay} stores={stores} now={now} />
        </section>
    );
};

/** The signed-in person's own attendance: check in/out, then their month. */
export const MyAttendance: React.FC<MyAttendanceProps> = ({ userId, stores, openRecord, assignedStoreId, canManage, onChanged }) => {
    const now = useClock(!!openRecord);
    const [historyVersion, setHistoryVersion] = useState(0);
    const checked = async () => {
        await onChanged();
        setHistoryVersion(v => v + 1);
    };
    return (
        <div className="grid gap-4 lg:gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start">
            <CheckInCard stores={stores} openRecord={openRecord} assignedStoreId={assignedStoreId} canManage={canManage} now={now} onChecked={checked} />
            <MonthHistory userId={userId} stores={stores} now={now} version={historyVersion} />
        </div>
    );
};
