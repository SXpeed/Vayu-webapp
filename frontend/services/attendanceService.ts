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

    async getRecords(storeId?: string): Promise<AttendanceRecord[]> {
        const query = storeId ? `?storeId=${encodeURIComponent(storeId)}` : '';
        return call<AttendanceRecord[]>(`/attendance/records${query}`);
    },
};