const TOKEN_KEY = 'vayu_token';

export function authHeaders(): Record<string, string> {
    const token = localStorage.getItem(TOKEN_KEY);
    const base: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) base['Authorization'] = `Bearer ${token}`;
    return base;
}

/**
 * Parse an API response without assuming the body is JSON. When the backend
 * is briefly unavailable (dev proxy down, deploy in progress, Cloudflare
 * error page) the body is HTML/text — surface a readable message instead of
 * a raw parse error like "Failed to execute 'json' on 'Response'".
 */
export async function parseApiResponse<T>(res: Response): Promise<T> {
    const text = await res.text();
    let data: unknown = null;
    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            throw new Error(res.ok
                ? 'Unexpected server response. Please try again.'
                : `Server error (${res.status}). Please try again.`);
        }
    }
    if (!res.ok) {
        throw new Error((data as { error?: string } | null)?.error ?? `Request failed (${res.status})`);
    }
    return data as T;
}

export async function apiCall<T>(path: string, options?: RequestInit): Promise<T> {
    let res: Response;
    try {
        res = await fetch(`/api${path}`, {
            ...options,
            headers: { ...authHeaders(), ...(options?.headers ?? {}) },
        });
    } catch {
        throw new Error('Cannot reach the server. Check your connection and try again.');
    }
    return parseApiResponse<T>(res);
}
