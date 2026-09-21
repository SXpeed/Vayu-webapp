import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { CalendarDays, CalendarRange, Loader2, RefreshCw, Store as StoreIcon, User as UserIcon } from 'lucide-react';
import { AuthUser, authService } from '../services/authService';
import { AttendanceRecord, StoreConfig } from '../types';
import { attendanceService } from '../services/attendanceService';
import { PageRoot, PageHeader, PageBody, GhostIconButton } from '../components/ui';
import { MyAttendance } from './attendance/MyAttendance';
import { DayView } from './attendance/DayView';
import { MonthRegister } from './attendance/MonthRegister';
import { startOfDay } from './attendance/attendanceUtils';
import { StoresPanel } from './attendance/StoresPanel';

interface AttendanceViewProps {
    authUser: AuthUser;
    /** Attendance "Manage" access: team day, all records and store setup. */
    canManage: boolean;
    onBack: () => void;
}

type Tab = 'day' | 'month' | 'mine' | 'stores';

const ADMIN_TABS: { id: Tab; label: string; Icon: React.ElementType }[] = [
    { id: 'day', label: 'Day', Icon: CalendarDays },
    { id: 'month', label: 'Month', Icon: CalendarRange },
    { id: 'mine', label: 'Mine', Icon: UserIcon },
    { id: 'stores', label: 'Stores', Icon: StoreIcon },
];

/**
 * Attendance. Everyone: check in/out at a store (GPS geofence, validated on
 * the server) and see their own month. People whose role can manage
 * attendance (admins, or a custom role) also get the team's day, every
 * record with totals and export, and store setup.
 *
 * Everything shown comes from real server records; there is no sample data.
 */
export const AttendanceView: React.FC<AttendanceViewProps> = ({ authUser, canManage, onBack }) => {
    const [tab, setTab] = useState<Tab>(canManage ? 'day' : 'mine');
    /** Day shown in the Day tab; the month grid opens days here. */
    const [day, setDay] = useState(() => startOfDay(Date.now()));
    const [stores, setStores] = useState<StoreConfig[]>([]);
    const [openRecord, setOpenRecord] = useState<AttendanceRecord | null>(null);
    const [assignedStoreId, setAssignedStoreId] = useState<string | null>(null);
    const [team, setTeam] = useState<AuthUser[]>([]);
    const [loading, setLoading] = useState(true);
    /** Bumped after any change so the admin panels reload their records. */
    const [refreshKey, setRefreshKey] = useState(0);

    const load = useCallback(async () => {
        try {
            const [storeList, me, people] = await Promise.all([
                attendanceService.getStores(),
                attendanceService.getMe(),
                canManage ? authService.getTeamMembers() : Promise.resolve([] as AuthUser[]),
            ]);
            setStores(storeList);
            setOpenRecord(me.open);
            setAssignedStoreId(me.assignedStoreId);
            setTeam(people);
        } catch (e) {
            toast.error((e as Error).message || 'Failed to load attendance');
        } finally {
            setLoading(false);
        }
    }, [canManage]);

    useEffect(() => { void load(); }, [load]);

    const reload = useCallback(async () => {
        await load();
        setRefreshKey(k => k + 1);
    }, [load]);

    const [refreshing, setRefreshing] = useState(false);
    const refresh = async () => {
        setRefreshing(true);
        await reload();
        setRefreshing(false);
    };

    return (
        <PageRoot width="wide">
            <PageHeader
                title="Attendance"
                subtitle={openRecord ? 'You are checked in' : canManage ? 'Team attendance by day and month' : 'Check in and your history'}
                onBack={onBack}
                actions={<GhostIconButton onClick={() => { void refresh(); }} label="Refresh" icon={<RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />} disabled={refreshing} />}
            >
                {canManage && (
                    <div className="flex gap-2 lg:w-fit">
                        {ADMIN_TABS.map(({ id, label, Icon }) => (
                            <button
                                key={id}
                                type="button"
                                onClick={() => setTab(id)}
                                aria-pressed={tab === id}
                                className={`flex-1 min-w-0 lg:flex-none lg:px-6 px-2 py-2 flex items-center justify-center gap-1 lg:gap-1.5 rounded-full text-[10.5px] lg:text-[11px] font-bold uppercase tracking-wider lg:tracking-widest transition-colors active-scale ${tab === id
                                    ? 'neu-inset text-gold-700 dark:text-gold-300'
                                    : 'neu-raised-sm neu-btn text-gray-700 dark:text-gray-300'}`}
                            >
                                <Icon size={12} className="shrink-0 hidden sm:block" /> <span className="truncate">{label}</span>
                            </button>
                        ))}
                    </div>
                )}
            </PageHeader>

            <PageBody space="none">
                {loading ? (
                    <div className="py-16 flex justify-center"><Loader2 size={22} className="animate-spin text-gold-500" /></div>
                ) : (
                    <div className="animate-fade-in">
                        {tab === 'mine' && (
                            <MyAttendance
                                userId={authUser.id}
                                stores={stores}
                                openRecord={openRecord}
                                assignedStoreId={assignedStoreId}
                                canManage={canManage}
                                onChanged={reload}
                            />
                        )}
                        {canManage && tab === 'day' && <DayView team={team} stores={stores} refreshKey={refreshKey} day={day} onDayChange={setDay} />}
                        {canManage && tab === 'month' && (
                            <MonthRegister team={team} refreshKey={refreshKey} onOpenDay={d => { setDay(d); setTab('day'); }} />
                        )}
                        {canManage && tab === 'stores' && <StoresPanel stores={stores} team={team} onChanged={reload} />}
                    </div>
                )}
            </PageBody>
        </PageRoot>
    );
};
