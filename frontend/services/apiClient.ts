const TOKEN_KEY = 'vayu_token';

export function authHeaders(): Record<string, string> {
    const token = localStorage.getItem(TOKEN_KEY);
    const base: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) base['Authorization'] = `Bearer ${token}`;
    return base;
}

/** Fired on window when the server says this device was signed out. */
export const SIGNED_OUT_EVENT = 'vayu:signed-out';

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
        // Signed out elsewhere (e.g. the per-person device limit): tell the
        // app so it can return to the login screen with an explanation.
        const reason = (data as { reason?: string } | null)?.reason;
        if (res.status === 401 && reason && typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent(SIGNED_OUT_EVENT, { detail: { reason } }));
        }
        throw new Error((data as { error?: string } | null)?.error ?? `Request failed (${res.status})`);
    }
    return data as T;
}

/**
 * Reads are cancelled after this long. A request the server never answers
 * otherwise holds its connection open forever: the 15-second refresh kept
 * adding hung requests until the browser's few connections per server were
 * all stuck and nothing in the app could load. Writes are left alone (a large
 * upload can legitimately take longer).
 */
const READ_TIMEOUT_MS = 20_000;

export async function apiCall<T>(path: string, options?: RequestInit): Promise<T> {
    const isRead = !options?.method || options.method.toUpperCase() === 'GET';
    let res: Response;
    try {
        res = await fetch(`/api${path}`, {
            ...options,
            signal: options?.signal ?? (isRead ? AbortSignal.timeout(READ_TIMEOUT_MS) : undefined),
            headers: { ...authHeaders(), ...options?.headers },
        });
    } catch (e) {
        if ((e as Error).name === 'TimeoutError') {
            throw new Error('The server took too long to answer. Please try again.');
        }
        throw new Error('Cannot reach the server. Check your connection and try again.');
    }
    return parseApiResponse<T>(res);
}
