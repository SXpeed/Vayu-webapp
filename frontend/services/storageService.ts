import { parseApiResponse } from './apiClient';

const TOKEN_KEY = 'vayu_token';

export interface UploadResult {
    key: string;
    url: string;
}

const storageService = {
    async upload(file: File): Promise<UploadResult> {
        const token = localStorage.getItem(TOKEN_KEY);
        const formData = new FormData();
        formData.append('file', file);
        // No Content-Type header here — the browser sets the multipart boundary.
        const res = await fetch('/api/upload', {
            method: 'POST',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            body: formData,
        });
        return parseApiResponse<UploadResult>(res);
    },

    async delete(key: string): Promise<void> {
        const token = localStorage.getItem(TOKEN_KEY);
        const res = await fetch(`/api/files/${encodeURIComponent(key)}`, {
            method: 'DELETE',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        await parseApiResponse<{ success?: boolean }>(res);
    },
};

export default storageService;