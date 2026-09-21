import { AttendanceRecord, StoreConfig } from '../types';

import { apiCall as call } from './apiClient';

export interface AttendanceMe {
    open: AttendanceRecord | null;
    recent: AttendanceRecord[];
    assignedStoreId: string | null;
}

export interface CheckInPayload {
    storeId: string;
    lat: number;
    lng: number;
    accuracy: number;
    connectionType: 'wifi' | 'mobile' | 'unknown';
    /** Wi-Fi network the device is on — validated server-side when required. */
    wifiSsid?: string;
}

export interface CheckInResponse {
    record: AttendanceRecord;
    message: string;
}

export const attendanceService = {
    async getStores(): Promise<StoreConfig[]> {
        return call<StoreConfig[]>('/attendance/stores');
    },

    async saveStore(store: Omit<StoreConfig, 'id' | 'createdAt'> & { id?: string }): Promise<StoreConfig> {
        if (store.id) {
            return call<StoreConfig>(`/attendance/stores/${store.id}`, {
                method: 'PUT',
                body: JSON.stringify(store),
            });
        }
        return call<StoreConfig>('/attendance/stores', {
            method: 'POST',
            body: JSON.stringify(store),
        });
    },

    async deleteStore(id: string): Promise<void> {
        await call<{ success: boolean }>(`/attendance/stores/${id}`, { method: 'DELETE' });
    },

    async getMe(): Promise<AttendanceMe> {
        return call<AttendanceMe>('/attendance/me');
    },

    async checkIn(payload: CheckInPayload): Promise<CheckInResponse> {
        return call<CheckInResponse>('/attendance/check-in', {
            method: 'POST',
            body: JSON.stringify(payload),
        });
    },

    async checkOut(payload: CheckInPayload): Promise<CheckInResponse> {
        return call<CheckInResponse>('/attendance/check-out', {
            method: 'POST',
            body: JSON.stringify(payload),
        });
    },

    /**
     * Records, newest first. Admins get everyone's; employees their own. The
     * filters are applied server-side when supported. Callers still filter
     * client-side too, because older servers ignore everything but storeId.
     */
    async getRecords(filter: RecordsFilter = {}): Promise<AttendanceRecord[]> {
        const params = new URLSearchParams();
        if (filter.storeId) params.set('storeId', filter.storeId);
        if (filter.employeeId) params.set('employeeId', filter.employeeId);
        if (filter.from != null) params.set('from', String(filter.from));
        if (filter.to != null) params.set('to', String(filter.to));
        const query = params.toString();
        return call<AttendanceRecord[]>(query ? '/attendance/records?' + query : '/attendance/records');
    },

    /** Admin: close a check-in someone forgot to check out of. */
    async closeRecord(id: string, checkOutAt: number): Promise<AttendanceRecord> {
        return call<AttendanceRecord>(`/attendance/records/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ checkOutAt }),
        });
    },
};

export interface RecordsFilter {
    storeId?: string;
    employeeId?: string;
    /** Epoch ms, inclusive — matched against check-in time. */
    from?: number;
    /** Epoch ms, exclusive. */
    to?: number;
}