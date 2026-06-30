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
        const res = await fetch('/api/upload', {
            method: 'POST',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            body: formData,
        });
        const data = await res.json();
        if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Upload failed');
        return data as UploadResult;
    },

    async delete(key: string): Promise<void> {
        const token = localStorage.getItem(TOKEN_KEY);
        const res = await fetch(`/api/files/${encodeURIComponent(key)}`, {
            method: 'DELETE',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({ error: 'Delete failed' }));
            throw new Error((data as { error?: string }).error ?? 'Delete failed');
        }
    },
};

export default storageService;