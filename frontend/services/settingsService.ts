import { apiCall as call } from './apiClient';

export const settingsService = {
    async getSettings(): Promise<Record<string, any>> {
        return call<Record<string, any>>('/settings');
    },
    async updateSettings(settings: Record<string, any>): Promise<Record<string, any>> {
        return call<Record<string, any>>('/settings', {
            method: 'POST',
            body: JSON.stringify(settings)
        });
    }
};
