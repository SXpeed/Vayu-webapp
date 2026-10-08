import type { StaffLeave, StaffShift } from '../staffRosterRules';
import { apiCall as call } from './apiClient';

export type WeekStatus = 'draft' | 'published' | 'changed';
export interface WeekInfo { status: WeekStatus; publishedAt: number | null; publishedByName: string }

export interface StaffRosterData {
    /** The Staff roster "Manage" permission: planning, leave decisions, publishing. */
    canManage: boolean;
    me: string;
    people: { id: string; name: string; title: string }[];
    /** People these shifts and leave belong to who are no longer on the team (absent from an older server). */
    formerPeople?: { id: string; name: string }[];
    stores: { id: string; name: string }[];
    jobTitles: string[];
    /** Managers: the live plan. Everyone else: the published weeks only. */
    shifts: StaffShift[];
    leaves: StaffLeave[];
    weeks: Record<string, WeekInfo>;
}

export type ShiftInput = Omit<StaffShift, 'id'>;

export const staffRosterService = {
    load(from: string, to: string): Promise<StaffRosterData> {
        return call<StaffRosterData>(`/staff-roster?from=${from}&to=${to}`);
    },
    createShifts(shifts: ShiftInput[]): Promise<StaffShift[]> {
        return call<StaffShift[]>('/staff-roster/shifts', { method: 'POST', body: JSON.stringify({ shifts }) });
    },
    updateShift(id: string, shift: ShiftInput): Promise<StaffShift> {
        return call<StaffShift>(`/staff-roster/shifts/${id}`, { method: 'PUT', body: JSON.stringify(shift) });
    },
    async deleteShift(id: string): Promise<void> {
        await call(`/staff-roster/shifts/${id}`, { method: 'DELETE' });
    },
    publish(weekStart: string, notify: boolean): Promise<{ status: WeekStatus; publishedAt: number; notified: number }> {
        return call('/staff-roster/publish', { method: 'POST', body: JSON.stringify({ weekStart, notify }) });
    },
    requestLeave(input: { employeeId?: string; from: string; to: string; type: string; reason: string }): Promise<StaffLeave> {
        return call<StaffLeave>('/staff-roster/leaves', { method: 'POST', body: JSON.stringify(input) });
    },
    decideLeave(id: string, status: 'approved' | 'declined'): Promise<StaffLeave> {
        return call<StaffLeave>(`/staff-roster/leaves/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    },
    async deleteLeave(id: string): Promise<void> {
        await call(`/staff-roster/leaves/${id}`, { method: 'DELETE' });
    },
    setTitle(employeeId: string, title: string): Promise<{ title: string }> {
        return call(`/staff-roster/titles/${encodeURIComponent(employeeId)}`, { method: 'PUT', body: JSON.stringify({ title }) });
    },
};
